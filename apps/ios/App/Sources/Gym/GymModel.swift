import Foundation
import Observation
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncSchema
import SyncStore

// UI tracks use this engine-backed model and add GymModel extensions only in their own Routines, Log, Coach or Workout folders.
@Observable @MainActor
final class GymModel {
  let runner: ActionRunner
  let runtime: AppRuntime?
  let telemetry: any Telemetry
  let rest: GymRESTClient
  var log: TrainingLog?
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
  var accountTransition = false {
    didSet { existingWorkoutActivity?.schedule(); rest.blocked = accountTransition; if accountTransition { rest.cancel() } }
  }
  var refusal: GymRefusal?
  var error: String?
  var readFailed = false
  var undoOffers: [UndoOffer] = []
  var notices: [DomainNotice<GymRefusal>] = []
  var adoptionWorkouts: [SignedOutWorkout] = []
  @ObservationIgnored var observationTask: Task<Void, Never>?
  @ObservationIgnored var scopeViews: [RecordsView] = []
  @ObservationIgnored var observationGeneration = 0
  @ObservationIgnored var proposalReadReplica: String?
  var coachRemovalReceipts: [RoutineRemovalReceipt] = []
  @ObservationIgnored var shownCoachRemovals: [String: Proposal] = [:]

  init(runner: ActionRunner, runtime: AppRuntime? = nil, telemetry: any Telemetry = NoopTelemetry()) {
    self.runner = runner; self.runtime = runtime; self.telemetry = telemetry
    rest = GymRESTClient(runtime: runtime, telemetry: telemetry)
    runtime?.workoutActivityBinding.gym = self
    refresh()
  }

  var sessions: [Session] { log?.drawnSessions ?? [] }
  var sets: [TrainingSet] { log?.sets ?? [] }
  var openSession: Session? { log?.open }
  var hasData: Bool { personalCounts.values.contains { $0 > 0 } }
  var phoneSummary: String {
    let kinds = [(Session.type, "workout", "workouts"), (Routine.type, "routine", "routines"),
                 (TrainingSet.type, "set", "sets"), (Note.type, "note", "notes"),
                 (WeighIn.type, "weigh-in", "weigh-ins"), (Exercise.type, "custom movement", "custom movements"),
                 (ExerciseName.type, "movement name", "movement names"), (Proposal.type, "proposal", "proposals"),
                 (GymPreferences.type, "preference record", "preference records")]
    let lines = kinds.compactMap { type, singular, plural -> String? in
      let count = personalCounts[type] ?? 0
      return count == 0 ? nil : "\(count) \(count == 1 ? singular : plural)"
    }
    return lines.isEmpty ? "No Gym data on this phone yet." : lines.joined(separator: " · ")
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
    refresh()
  }

  func observeScopes(_ generation: Int) {
    guard observationGeneration == generation, let runtime else { return }
    withObservationTracking {
      for view in scopeViews { _ = view.state }
      let status = runtime.engine.status
      _ = status.account; _ = status.authPaused; _ = status.pendingSignIn; _ = status.ready; _ = status.sent
      _ = status.failedPushes
      _ = runtime.engine.notices("gym").notices
      _ = runtime.engine.undoOffers.offers
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.observationGeneration == generation else { return }
        self.observeScopes(generation); self.refresh()
      }
    }
  }

  func stop() {
    observationGeneration += 1; scopeViews = []
    observationTask?.cancel(); observationTask = nil; rest.cancel()
  }

  func refresh() {
    defer { existingWorkoutActivity?.schedule() }
    let wasReadFailed = readFailed
    let previousAccount = account, previousAnonymous = isAnonymous
    do {
      adoptionWorkouts = try runner.read(Gym.scope) { try SignedOutWorkout.read($0) }
      if !adoptionWorkouts.isEmpty {
        _ = try runner.run(ReconcileAdoptedWorkouts())
        adoptionWorkouts = try runner.read(Gym.scope) { try SignedOutWorkout.read($0) }
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
        return (training, try Catalogue(read),
         Routine.ordered(try read.repository(Routine.self).all(in: .drawn)),
         try read.repository(Note.self).all(in: .drawn), try Bodyweight(read),
         try read.repository(GymPreferences.self).find(ID("prefs"), in: .drawn) ?? GymPreferences(),
         coach: try Self.readCoachProposals(read), read.isAnonymous, counts, hidden,
         planUnreadable: storedSessions.contains(where: \.planUnreadable) || training.sessions.contains(where: \.planUnreadable))
      }
      (log, catalogue, routines, notes, bodyweight, preferences, _, isAnonymous, personalCounts, workoutHidden, _) = snapshot
      if snapshot.planUnreadable { telemetry.failure("gym_read", kind: "unexpected") }
      updateCoachProposals(replica: snapshot.coach.replica, receipts: snapshot.coach.receipts, proposals: snapshot.coach.proposals)
      if let runtime {
        let replica = try runtime.storageRead { try $0.device().activeReplica }
        account = replica.meta.state == .bound ? replica.meta.account : nil
        authPaused = replica.meta.authPaused
        let incoming = replica.notices.filter { $0.scope == Gym.scope && !$0.isDismissed }
          .map { DomainNotice<GymRefusal>($0, registry: SyncSchema.registry) }
        if let latest = incoming.last, !notices.contains(where: { $0.id == latest.id }) {
          refusal = latest.refusal; error = message(latest.refusal)
        }
        notices = incoming
        let outbox = replica.outbox.filter { $0.scope == Gym.scope }
        undoOffers = []
        for entry in outbox where !undoOffers.contains(where: { $0.id == entry.gestureId }) {
          let gesture = outbox.filter { $0.gestureId == entry.gestureId }
          if gesture.allSatisfy({ $0.state == .held }) {
            undoOffers.append(UndoOffer(id: entry.gestureId, scope: entry.scope, releaseAt: entry.releaseAt))
          }
        }
      } else {
        let now = (try? runner.moment().now.ms) ?? 0
        undoOffers.removeAll { $0.releaseAt <= now }
      }
      if previousAccount != account || previousAnonymous != isAnonymous { coachUnavailable = false }
      readFailed = false
      if wasReadFailed, error == "Gym could not be read from this phone. Try again." { error = nil }
    } catch {
      readFailed = true; self.error = "Gym could not be read from this phone. Try again."
      report("gym_read", error)
    }
  }

  @discardableResult
  func run<A: Action>(_ action: A) -> Outcome<A.Result, GymRefusal>? where A.Refusal == GymRefusal {
    guard !accountTransition else { error = "Wait for the account change to finish."; return nil }
    precondition(action.scope == Gym.scope, "Gym runs actions in its own scope")
    refusal = nil; error = nil
    do {
      let outcome = try runner.run(action)
      if let refused = outcome.refusal { refusal = refused; error = message(refused) }
      if let receipt = outcome.receipt, let releaseAt = receipt.releaseAt {
        undoOffers.append(UndoOffer(id: receipt.gestureId, scope: action.scope, releaseAt: releaseAt))
      }
      telemetry.event("gym_action", properties: ["screen": "gym", "outcome": outcome.refusal == nil ? "ok" : "refused"])
      refresh()
      return outcome
    } catch {
      self.error = "Gym could not save this change. Try again."
      telemetry.event("gym_action", properties: ["screen": "gym", "outcome": "failed"])
      report("gym_action", error)
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
  func undo(_ gestureId: String) -> Bool {
    guard !accountTransition else { error = "Wait for the account change to finish."; return false }
    do {
      let undone = try runner.undo(gestureId)
      undoOffers.removeAll { $0.id == gestureId }
      error = undone ? nil : "That change has already been kept."
      telemetry.event("gym_undo", properties: ["screen": "gym", "outcome": undone ? "ok" : "refused"])
      refresh(); return undone
    } catch {
      self.error = "Gym could not undo this change. Try again."
      telemetry.event("gym_undo", properties: ["screen": "gym", "outcome": "failed"]); report("gym_undo", error)
      return false
    }
  }

  @discardableResult
  func flush() -> Bool {
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
    do { try runtime?.engine.leave(); undoOffers = []; refresh() }
    catch { self.error = "Gym could not keep pending changes. Try again."; report("gym_flush", error) }
  }

  func report(_ operation: String, _ error: any Error) {
    guard Store.failureKind(error) == nil else { return }
    let kind = (error as? CommitFailure)?.kind == .storeFailure ? "storage" : "unexpected"
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
    let id = UUID(), task = Task { try await session.data(for: request) }
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
        expectedRefusal = [400, 401, 403, 404, 409, 410, 422, 429].contains(response.statusCode) || refusal["code"] as? String == "ask-busy"
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
}

nonisolated struct GymRESTFailure: Error, LocalizedError {
  let status: Int
  let body: Data
  let message: String
  var errorDescription: String? { message }
}
