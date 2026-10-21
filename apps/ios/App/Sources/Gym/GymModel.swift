import Foundation
import Observation
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import SyncStore

// The room's engine-backed model. An extension one track reads lives in that track's folder; a rule several read lives here.
@Observable @MainActor
final class GymModel {
  let runner: ActionRunner
  let runtime: AppRuntime?
  let telemetry: any Telemetry
  let rest: GymRESTClient
  let locale: Locale
  var log: TrainingLog? { didSet { logRecordsRead = nil } }
  // The log's records, worked out on the first read after the log changes (Log/LogPresentation.swift).
  @ObservationIgnored var logRecordsRead: ProgressRecords?
  var catalogue = Catalogue(custom: [], names: [])
  var routines: [Routine] = []
  var notes: [Note] = []
  var bodyweight: Bodyweight?
  var preferences = GymPreferences()
  var proposals: [Proposal] = []
  var personalCounts: [String: Int] = [:]
  var workoutHidden = false
  var coachUnavailable = false
  var isAnonymous = true
  var account: String?
  var authPaused = false
  var accountChanging = false { didSet { accountTransitionChanged() } }
  var replicaChanging = false { didSet { accountTransitionChanged() } }
  var refusal: GymRefusal?
  var error: String?
  var readFailed = false
  // The room's refusals: undismissed, and none a saved workout owns, since that one is its row's on The log.
  var notices: [DomainNotice<GymRefusal>] = []
  // Every gym notice the replica keeps, dismissed ones too: the saved workouts' review reads their reasons here.
  var recoveryNotices: [DomainNotice<GymRefusal>] = []
  var adoptionWorkouts: [SignedOutWorkout] = []
  @ObservationIgnored var observationTask: Task<Void, Never>?
  @ObservationIgnored var clockTask: Task<Void, Never>?
  @ObservationIgnored var scopeViews: [RecordsView] = []
  @ObservationIgnored var observationGeneration = 0
  @ObservationIgnored var readThrough: UInt64?
  @ObservationIgnored var adoptionReadThrough: UInt64?
  @ObservationIgnored var proposalReadReplica: String?
  var coachRemovalReceipts: [RoutineRemovalReceipt] = []
  var outOfDateProposals: Set<ID<Proposal>> = []
  @ObservationIgnored var shownCoachRemovals: [String: Proposal] = [:]
  @ObservationIgnored var awaitedCoachDecisions: [ID<Proposal>: CoachQueuedDecision] = [:]
  @ObservationIgnored var stalledCoachDecisions: Set<ID<Proposal>> = []
  @ObservationIgnored var awaitedRecoveries: [ID<Session>: RecoveryAction] = [:]

  init(runner: ActionRunner, runtime: AppRuntime? = nil, telemetry: any Telemetry = NoopTelemetry(), locale: Locale = .autoupdatingCurrent, rest: GymRESTClient? = nil) {
    self.runner = runner; self.runtime = runtime; self.telemetry = telemetry; self.locale = locale
    self.rest = rest ?? GymRESTClient(runtime: runtime, telemetry: telemetry)
    runtime?.gymBinding.gym = self
    refresh()
  }

  var sessions: [Session] { log?.drawnSessions ?? [] }
  var sets: [TrainingSet] { log?.sets ?? [] }
  var openSession: Session? { log?.open }
  // Every date the room shows, in its locale, read at the log's moment, or at the device's before the log is read.
  var dates: GymDate { log.map { GymDate($0.moment, locale: locale) } ?? GymDate(locale: locale) }
  // When the log took a proposal: its record's server stamp, none while the phone has not yet sent it.
  func proposalCreatedAt(_ proposal: Proposal) -> Instant? {
    do { return try runner.read(Gym.scope) { try $0.repository(Proposal.self).record(proposal.id, in: .stored)?.rc }.map { Instant(ms: $0) } }
    catch { report("gym_read", error); return nil }
  }
  var accountTransition: Bool { accountChanging || replicaChanging }
  func accountTransitionChanged() {
    existingWorkoutActivity?.schedule()
    rest.blocked = accountTransition
    if accountTransition { rest.cancel() }
  }
  var hasData: Bool { personalCounts.values.contains { $0 > 0 } }
  var phoneSummary: String? {
    let kinds = [(Routine.type, "routine"), (Session.type, "workout"), (WeighIn.type, "weigh-in"), (Note.type, "note"),
                 (Exercise.type, "custom movement")]
    let lines = kinds.compactMap { type, noun -> String? in
      let count = personalCounts[type] ?? 0
      return count == 0 ? nil : GymCount.of(count, noun)
    }
    return lines.isEmpty ? nil : lines.joined(separator: " · ")
  }

  // The sets the log has not confirmed as this phone holds them: absent there, hidden or changed since.
  func unconfirmedSets(_ sets: [TrainingSet]) -> Set<ID<TrainingSet>> {
    if isAnonymous { return Set(sets.map(\.id)) }
    do {
      return try runner.read(Gym.scope) { read in
        var pending = Set<ID<TrainingSet>>()
        for set in sets {
          guard let confirmed = try read.confirmed(TrainingSet.self, set.id), confirmed.isVisible,
                try TrainingSet(Fields(confirmed)) == set else { pending.insert(set.id); continue }
        }
        return pending
      }
    } catch { report("gym_read", error); return Set(sets.map(\.id)) }
  }

  // Signed out nothing is unsent: there is no account to send to. Signed in, what the log has not confirmed is unsent
  // only while something holds it back — no connection, a paused session, the update the server requires or its own
  // refused push — never in flight.
  func unsentSets(_ sets: [TrainingSet]) -> Set<ID<TrainingSet>> {
    let held = isAnonymous ? [] : sets.filter { heldBack($0.id.ref) }
    return held.isEmpty ? [] : unconfirmedSets(held)
  }

  // A workout is unsent while its own record or any of its sets is.
  func sessionIsUnsent(_ id: ID<Session>) -> Bool {
    guard !isAnonymous else { return false }
    if heldBack(id.ref), (try? runner.read(Gym.scope) { try $0.confirmed(Session.self, id) == nil }) == true { return true }
    return !unsentSets(log?.sets(session: id) ?? []).isEmpty
  }

  func heldBack(_ record: RecordRef) -> Bool {
    guard let status = runtime?.engine.status else { return authPaused }
    return authPaused || !status.online || status.upgradeRequired || status.failedPushes[Gym.scope]?.contains(record.key) == true
  }

  func start() {
    guard observationTask == nil, let runtime else { return }
    do {
      let types = [Routine.type, Exercise.type, ExerciseName.type, Session.type, TrainingSet.type,
                   Note.type, WeighIn.type, GymPreferences.type, Proposal.type]
      scopeViews = try types.flatMap { type in
        [try runtime.engine.records(Gym.scope, type, .drawn), try runtime.engine.records(Gym.scope, type, .stored)]
      }
    } catch { readFailed = true; self.error = "Gym could not be read from this phone. Try again."; report("gym_read", error); return }
    observationGeneration += 1
    observeScopes(observationGeneration)
    let events = runtime.engine.events()
    observationTask = Task { [weak self] in
      for await _ in events {
        guard !Task.isCancelled else { return }
        self?.refresh()
      }
    }
    // Day labels, record windows and a stale workout's close move with the clock, never faster than a minute.
    clockTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(60))
        guard let self, !Task.isCancelled else { return }
        self.refresh()
      }
    }
    refresh()
  }

  func observeScopes(_ generation: Int) {
    guard observationGeneration == generation, let runtime else { return }
    withObservationTracking {
      for view in scopeViews { _ = view.state }
      let status = runtime.engine.status
      _ = status.account; _ = status.authPaused; _ = status.pendingSignIn; _ = status.ready; _ = status.sent
      _ = status.failedPushes; _ = status.online; _ = status.upgradeRequired
      _ = runtime.engine.notices("gym").notices
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.observationGeneration == generation else { return }
        self.observeScopes(generation)
        // The views land a change one by one, after the store holds it; the first landing reads it all. A status the
        // store does not hold (the connection, a failed push, the update) moves only what is unsent: the views read it
        // as they draw, and the lock screen is redrawn here.
        if self.runtime?.engine.lastChange != self.readThrough { self.refresh() } else { self.existingWorkoutActivity?.schedule() }
      }
    }
  }

  func stop() {
    observationGeneration += 1; scopeViews = []
    observationTask?.cancel(); observationTask = nil; clockTask?.cancel(); clockTask = nil; rest.cancel()
  }

  func refresh() {
    readThrough = runtime?.engine.lastChange
    defer { existingWorkoutActivity?.schedule() }
    let wasReadFailed = readFailed
    let previousAccount = account, previousAnonymous = isAnonymous
    do {
      // The saved workouts are parsed, and the ones the account took dropped, once per change, not per refresh.
      if runtime == nil || adoptionReadThrough != readThrough {
        adoptionReadThrough = readThrough
        var saved = try runner.read(Gym.scope) { try SignedOutWorkout.read($0) }
        if !saved.isEmpty, try runner.run(ReconcileAdoptedWorkouts()).receipt != nil {
          saved = try runner.read(Gym.scope) { try SignedOutWorkout.read($0) }
        }
        publish(\.adoptionWorkouts, saved)
      }
      let snapshot = try runner.read(Gym.scope) { read in
        let storedSessions = try read.repository(Session.self).all(in: .stored)
        let counts = [Session.type: storedSessions.count,
                      Routine.type: try read.repository(Routine.self).all(in: .stored).count,
                      TrainingSet.type: try read.repository(TrainingSet.self).all(in: .stored).count,
                      Note.type: try read.repository(Note.self).all(in: .stored).count,
                      WeighIn.type: try read.repository(WeighIn.self).all(in: .stored).count,
                      Exercise.type: try read.repository(Exercise.self).all(in: .stored).count,
                      ExerciseName.type: try read.repository(ExerciseName.self).all(in: .stored).count,
                      Proposal.type: try read.repository(Proposal.self).all(in: .stored).count,
                      GymPreferences.type: try read.repository(GymPreferences.self).all(in: .stored).count]
        let training = try TrainingLog(read)
        let hidden = try training.open.map { try WorkoutWalk(read.device(WorkoutWalk.key($0.id))).hidden } ?? false
        return (log: training, catalogue: try Catalogue(read),
                routines: Routine.ordered(try read.repository(Routine.self).all(in: .drawn)),
                notes: try read.repository(Note.self).all(in: .drawn), bodyweight: try Bodyweight(read),
                preferences: try read.repository(GymPreferences.self).find(ID("prefs"), in: .drawn) ?? GymPreferences(),
                coach: try Self.readCoachProposals(read), anonymous: read.isAnonymous, counts: counts, hidden: hidden,
                planUnreadable: storedSessions.contains(where: \.planUnreadable) || training.sessions.contains(where: \.planUnreadable))
      }
      if log.map({ !$0.drawsTheSame(as: snapshot.log) }) ?? true { log = snapshot.log }
      publish(\.catalogue, snapshot.catalogue); publish(\.routines, snapshot.routines); publish(\.notes, snapshot.notes)
      publish(\.bodyweight, snapshot.bodyweight); publish(\.preferences, snapshot.preferences)
      publish(\.isAnonymous, snapshot.anonymous); publish(\.personalCounts, snapshot.counts); publish(\.workoutHidden, snapshot.hidden)
      if snapshot.planUnreadable { report("gym_read", UnreadablePlan()) }
      updateCoachProposals(snapshot.coach)
      if let runtime {
        let replica = try runtime.storageRead { try $0.device().activeReplica }
        publish(\.account, replica.meta.state == .bound ? replica.meta.account : nil)
        publish(\.authPaused, replica.meta.authPaused)
        publish(\.recoveryNotices, replica.notices.filter { $0.scope == Gym.scope }.map { DomainNotice<GymRefusal>($0, registry: SyncSchema.registry) })
        let incoming = recoveryNotices.filter { notice in !notice.notice.isDismissed && !adoptionWorkouts.contains { $0.owns(notice) } }
        if let latest = incoming.last, !notices.contains(where: { $0.id == latest.id }) {
          refusal = latest.refusal; error = message(latest.refusal)
        }
        publish(\.notices, incoming)
      }
      recordAnsweredRecoveries()
      if previousAccount != account || previousAnonymous != isAnonymous { publish(\.coachUnavailable, false) }
      publish(\.readFailed, false)
      if wasReadFailed, error == "Gym could not be read from this phone. Try again." { error = nil }
    } catch {
      readFailed = true; readThrough = nil; self.error = "Gym could not be read from this phone. Try again."
      report("gym_read", error)
    }
  }

  // `failure` names the static operation an unexpected failure reports under; a feature with its own names passes one.
  @discardableResult
  func run<A: Action>(_ action: A, failure operation: String = "gym_action") -> Outcome<A.Result, GymRefusal>? where A.Refusal == GymRefusal {
    guard !accountTransition else { error = "Wait for the account change to finish."; return nil }
    precondition(action.scope == Gym.scope, "Gym runs actions in its own scope")
    refusal = nil; error = nil
    do {
      let outcome = try runner.run(action)
      if let refused = outcome.refusal { refusal = refused; error = message(refused) }
      telemetry.event("gym_action", properties: ["screen": "gym", "outcome": outcome.refusal == nil ? "ok" : "refused"])
      refresh()
      return outcome
    } catch {
      self.error = "Gym could not save this change. Try again."
      telemetry.event("gym_action", properties: ["screen": "gym", "outcome": "failed"])
      report(operation, error)
      return nil
    }
  }

  @discardableResult
  func save<E: Draftable>(_ draft: inout Draft<E>) -> SaveResult<GymRefusal> {
    guard !accountTransition else {
      error = "Wait for the account change to finish."
      return .failed(AppFailure(message: error!))
    }
    precondition(E.scope == Gym.scope, "Gym saves drafts in its own scope")
    refusal = nil; error = nil
    let result = runner.save(&draft, SaveDraft<E, GymRefusal>.self)
    switch result {
    case .saved:
      telemetry.event("gym_action", properties: ["screen": "gym", "outcome": "ok"]); refresh()
    case .refused(let refused):
      refusal = refused; error = message(refused)
      telemetry.event("gym_action", properties: ["screen": "gym", "outcome": "refused"])
    case .failed(let failure):
      error = "Gym could not save this change. Try again."
      telemetry.event("gym_action", properties: ["screen": "gym", "outcome": "failed"]); report("gym_action", failure)
    }
    return result
  }

  @discardableResult
  func flush() -> Bool {
    guard workout.flushRack() else { return false }
    rest.cancel()
    refresh()
    guard !readFailed else { return false }
    guard let runtime else { return !readFailed }
    defer { runtime.engine.foreground() }
    do { try runtime.engine.leave(); error = nil; refresh(); return !readFailed }
    catch { self.error = "Gym could not keep pending changes. Try again."; report("gym_flush", error); return false }
  }

  func dismissNotice(_ id: String) {
    do {
      try runtime?.engine.dismissNotice(id)
      notices.removeAll { $0.id == id }; refusal = nil; error = nil; refresh()
    } catch { self.error = "Gym could not dismiss this message. Try again."; report("gym_action", error) }
  }

  func background() {
    rest.cancel()
    do { try runtime?.engine.leave(); refresh() }
    catch { self.error = "Gym could not keep pending changes. Try again."; report("gym_flush", error) }
  }

  // A refresh sets what it read only where it changed, so an engine event or the clock that changes nothing redraws
  // nothing: a screen redrawn under an open menu rebuilds the menu and drops the tap on it.
  func publish<Value: Equatable>(_ keyPath: ReferenceWritableKeyPath<GymModel, Value>, _ value: Value) {
    if self[keyPath: keyPath] != value { self[keyPath: keyPath] = value }
  }

  // A read failure reports once per launch, since views read on every render; every failed write reports.
  @ObservationIgnored var reportedReadFailures: Set<String> = []
  func report(_ operation: String, _ error: any Error) {
    guard Store.failureKind(error) == nil else { return }
    let kind = (error as? CommitFailure)?.kind == .storeFailure ? "storage" : "unexpected"
    if operation == "gym_read" { guard reportedReadFailures.insert("\(kind) \(String(reflecting: error))").inserted else { return } }
    telemetry.failure(operation, kind: kind)
  }

  func message(_ refusal: GymRefusal) -> String {
    switch refusal {
    case .invalid: "Check the values and try again."
    case .stale: "This changed elsewhere. Review the latest version."
    case .gone: "This is no longer available."
    case .taken: "This change already exists."
    case .full(_, let cap, _): "There is room for \(cap). Remove one before adding another."
    case .future: "Choose today or an earlier day."
    case .sessionFinished: "This workout has already finished."
    case .sessionOpen: "Finish the open workout first."
    case .sessionOverlap: "This workout overlaps another workout."
    case .payloadConflict: "This workout changed elsewhere. Review the latest version."
    case .unknownExercise: "This movement is no longer available."
    case .badInstant: "Check the workout's start and finish times."
    case .proposalSettled: "This proposal has already been answered."
    case .proposalSuperseded: "A newer proposal is available."
    case .other: "Gym could not accept this change. Try again."
    }
  }
}

@MainActor final class GymRESTClient {
  let runtime: AppRuntime?
  let telemetry: any Telemetry
  let session: URLSession
  var tasks: [UUID: Task<(Data, URLResponse), any Error>] = [:]
  var generation = 0
  var blocked = false

  init(runtime: AppRuntime?, telemetry: any Telemetry, session: URLSession? = nil) {
    self.runtime = runtime; self.telemetry = telemetry; self.session = session ?? NativeAuth.nativeSession()
  }

  func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
    guard !blocked else { throw AppFailure(message: "Wait for the account change to finish.") }
    guard let runtime, let baseURL = runtime.settings.baseURL,
          let account = try runtime.account(), !runtime.engine.status.authPaused,
          let token = runtime.tokens.token(for: account) else { throw AppFailure(message: "Sign in to use this part of Gym.") }
    guard path.hasPrefix("/v1/gym/"), !path.contains(".."),
          let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
          url.host == baseURL.host, url.scheme == baseURL.scheme, url.port == baseURL.port else { throw AppFailure(message: "Gym could not open this request.") }
    var request = URLRequest(url: url)
    request.httpMethod = method; request.httpBody = body
    request.setValue("Bearer \(token.value)", forHTTPHeaderField: "Authorization")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    let id = UUID(), task = Task { try await NativeAuth.data(for: request, session: session) }
    let requestGeneration = generation
    tasks[id] = task
    defer { tasks[id] = nil }
    let started = ContinuousClock.now
    var kind = "transport"
    var status: Int?
    var expectedRefusal = false
    do {
      let (data, response) = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
      try Task.checkCancellation()
      guard generation == requestGeneration else { throw CancellationError() }
      guard try runtime.account() == account, runtime.tokens.token(for: account) == token else { throw CancellationError() }
      guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
      status = response.statusCode
      guard (200..<300).contains(response.statusCode) else {
        kind = "http"
        let refusal = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        expectedRefusal = ExpectedStatuses.contains(response.statusCode) || refusal["code"] as? String == "ask-busy" ||
          (response.statusCode == 503 && AiAllowance.refusalCodes.contains(refusal["code"] as? String ?? ""))
        let message = refusal["error"] as? String ?? "Gym could not complete this request. Try again."
        let detail = refusal["detail"] as? String ?? ""
        throw GymRESTFailure(status: response.statusCode, body: data, message: message + (detail.isEmpty ? "" : ". " + detail))
      }
      return data
    } catch {
      if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
      if let failure = error as? URLError {
        if [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost].contains(failure.code) { kind = "offline" }
        if failure.code == .timedOut { kind = "timeout" }
        if [.secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired].contains(failure.code) { kind = "tls" }
      }
      let elapsed = started.duration(to: .now).components
      let ms = elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000
      var properties = ["method": method, "route": "/v1/gym", "operation": "gym_rest", "failure_kind": kind]
      if let status { properties["status"] = String(status) }
      telemetry.event("api_request_failed", properties: properties, durationMs: ms)
      if kind != "offline", !expectedRefusal { telemetry.failure("gym_rest", kind: kind, properties: properties, durationMs: ms) }
      throw error
    }
  }

  func cancel() { generation += 1; for task in tasks.values { task.cancel() }; tasks = [:] }

  nonisolated static func needsConnection(_ error: any Error) -> Bool {
    guard let error = error as? URLError else { return false }
    return [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
            .cannotFindHost, .dnsLookupFailed, .timedOut].contains(error.code)
  }
}

// A session whose saved plan this build cannot read: the session still draws, and the read reports it once.
nonisolated struct UnreadablePlan: Error {}

nonisolated struct GymRESTFailure: Error, LocalizedError {
  let status: Int
  let body: Data
  let message: String
  var errorDescription: String? { message }
}
