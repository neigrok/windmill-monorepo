@preconcurrency import ActivityKit
import Foundation
import UIKit
import DomainKit
import GymDomain
import SyncCore
import SyncAPI
import SyncEngine
import SyncSchema

nonisolated struct WorkoutActivityRecord: Equatable, Sendable {
  var ownerID: String
  var replica: String
  var sessionID: String
  var anonymous: Bool
  var offer: WorkoutActivityOffer?
  var baseline: JSON?
  var dismissed = false
  var activityID: String?
  static let key = "rack:liveactivity"
  static func snapshot(session: Session, sets: [TrainingSet]) -> JSON {
    .object(["session": .object(omittingNil: session.fields), "sets": .array(sets.sorted { $0.id < $1.id }.map { .object(omittingNil: $0.fields) })])
  }
  init(sessionID: String, replica: String, anonymous: Bool) {
    self.sessionID = sessionID; self.replica = replica; self.anonymous = anonymous
    ownerID = replica + ":" + (anonymous ? "anon:" : "bound:") + sessionID
  }
  init(_ json: JSON) throws {
    ownerID = try json.member("ownerID").asString(); replica = try json.member("replica").asString()
    sessionID = try json.member("sessionID").asString(); anonymous = try json.member("anonymous").asBool()
    if let value = json["offer"], !value.isNull {
      offer = WorkoutActivityOffer(ownerID: try value.member("ownerID").asString(), sessionID: try value.member("sessionID").asString(),
        movementID: try value.member("movementID").asString(), weightKg: try value.member("weightKg").asDouble(),
        reps: Int(try value.member("reps").asInteger()), kind: try value.member("kind").asString(), setID: try value.member("setID").asString())
    }
    baseline = json["baseline"]
    dismissed = try json["dismissed"]?.asBool() ?? false
    activityID = try json["activityID"].flatMap { $0.isNull ? nil : try $0.asString() }
  }
  nonisolated var json: JSON {
    .object(["ownerID": .string(ownerID), "replica": .string(replica), "sessionID": .string(sessionID), "anonymous": .bool(anonymous), "offer": offer?.json ?? .null,
      "baseline": baseline ?? .null, "dismissed": .bool(dismissed), "activityID": activityID.map(JSON.string) ?? .null])
  }
}

extension WorkoutActivityOffer {
  nonisolated var json: JSON {
    .object(["ownerID": .string(ownerID), "sessionID": .string(sessionID), "movementID": .string(movementID),
      "weightKg": .of(weightKg), "reps": JSON(reps), "kind": .string(kind), "setID": .string(setID)])
  }
}

struct KeepWorkoutActivity: Action {
  let sessionID: ID<Session>
  let record: WorkoutActivityRecord
  let walk: WorkoutWalk
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws -> (Session?, WorkoutActivityRecord?, String, WorkoutWalk) {
    (try read.repository(Session.self).find(sessionID, in: .drawn),
     try read.device(WorkoutActivityRecord.key).map(WorkoutActivityRecord.init), read.replica, try WorkoutWalk(read.device(WorkoutWalk.key(sessionID))))
  }
  func decide(_ loaded: (Session?, WorkoutActivityRecord?, String, WorkoutWalk), ids: IDSource) -> Decision<Void, GymRefusal> {
    guard loaded.0 != nil, loaded.1?.sessionID == record.sessionID, loaded.2 == record.replica else { return .refuse(.stale(sessionID.ref, .predicted)) }
    if loaded.1 == record && loaded.3 == walk { return .unchanged(()) }
    var plan = Plan(); plan.device(WorkoutActivityRecord.key, record.json)
    plan.device(WorkoutWalk.key(sessionID), walk.json); return .write(plan)
  }
}

struct RestoreWorkoutActivity: Action {
  let sessionID: ID<Session>
  let replica: String
  let anonymous: Bool
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws -> (Session?, String, Bool, WorkoutActivityRecord?) {
    (try TrainingLog(read).open, read.replica, read.isAnonymous,
     try read.device(WorkoutActivityRecord.key).map(WorkoutActivityRecord.init))
  }
  func decide(_ loaded: (Session?, String, Bool, WorkoutActivityRecord?), ids: IDSource) -> Decision<Void, GymRefusal> {
    guard loaded.0?.id == sessionID, !replica.isEmpty, loaded.1 == replica, loaded.2 == anonymous else {
      return .refuse(.stale(sessionID.ref, .predicted))
    }
    var record = WorkoutActivityRecord(sessionID: sessionID.description, replica: replica, anonymous: anonymous)
    if let previous = loaded.3, previous.ownerID == record.ownerID, previous.replica == replica,
       previous.sessionID == record.sessionID, previous.anonymous == anonymous { record = previous }
    record.dismissed = false; record.activityID = nil
    if record == loaded.3 { return .unchanged(()) }
    var plan = Plan(); plan.device(WorkoutActivityRecord.key, record.json); return .write(plan)
  }
}

extension WorkoutState {
  var activityIdentityResolved: Bool {
    guard let runtime = gym.runtime else { return true }
    do { return try runtime.storageRead { try $0.device().meta.pendingSignIn == nil } }
    catch { gym.report("gym_activity_update", error); return false }
  }
  func activityRecord() throws -> WorkoutActivityRecord? {
    guard let sessionId else { return nil }
    return try gym.runner.read(Gym.scope) { read in
      guard !read.replica.isEmpty, let record = try read.device(WorkoutActivityRecord.key).map(WorkoutActivityRecord.init), record.replica == read.replica, record.sessionID == sessionId.description, record.anonymous == read.isAnonymous else { return nil }
      return record
    }
  }
  @discardableResult func restoreActivityAuthority() -> Bool {
    guard !gym.accountTransition, !gym.readFailed, activityIdentityResolved, let sessionId else { return false }
    do {
      let replica = try gym.runner.read(Gym.scope) { $0.replica }
      let result = try gym.runner.run(RestoreWorkoutActivity(sessionID: sessionId, replica: replica, anonymous: gym.isAnonymous))
      if let refusal = result.refusal { gym.refusal = refusal; gym.error = gym.message(refusal); return false }
      return true
    } catch { gym.error = "Gym could not restore this workout. Try again."; gym.report("gym_activity_update", error); return false }
  }
  var activityBaseline: JSON? {
    guard let session else { return nil }
    return WorkoutActivityRecord.snapshot(session: session, sets: sets)
  }
  func keepActivity(_ record: WorkoutActivityRecord) -> Bool {
    guard !gym.readFailed, let sessionId else { return false }
    do { return try gym.runner.run(KeepWorkoutActivity(sessionID: sessionId, record: record, walk: walk)).refusal == nil }
    catch { gym.report("gym_activity_update", error); return false }
  }
  func activityOffer() -> WorkoutActivityOffer? {
    do {
      guard var record = try activityRecord() else { return nil }
      guard canLog, activityIdentityResolved, walk.pending == nil, !rackEditing, !gym.workoutHidden, weightKg.isFinite, abs(weightKg) <= 500, (1...99).contains(reps),
            let session, offerSession == session, offerSets == sets, let selected else {
        if record.offer != nil { record.offer = nil; _ = keepActivity(record) }
        return nil
      }
      let candidate = WorkoutActivityOffer(ownerID: record.ownerID, sessionID: session.id.description, movementID: selected.description,
        weightKg: weightKg, reps: reps, kind: kind.rawValue, setID: record.offer?.setID ?? gym.runner.mint(TrainingSet.self).description)
      if record.offer == candidate && record.baseline == activityBaseline { return candidate }
      record.offer = WorkoutActivityOffer(ownerID: candidate.ownerID, sessionID: candidate.sessionID, movementID: candidate.movementID,
        weightKg: candidate.weightKg, reps: candidate.reps, kind: candidate.kind, setID: gym.runner.mint(TrainingSet.self).description)
      record.baseline = activityBaseline
      return keepActivity(record) ? record.offer : nil
    } catch { gym.report("gym_activity_update", error); return nil }
  }
  func restoreActivityDraft() {
    guard let record = try? activityRecord(), record.baseline == activityBaseline, let offer = record.offer,
          offer.movementID == selected?.description else { return }
    restoreRack(weightKg: offer.weightKg, reps: offer.reps, kind: SetKind(rawValue: offer.kind))
  }
  @discardableResult func logActivityOffer(_ offer: WorkoutActivityOffer) -> Bool {
    gym.refresh()
    if gym.openSession != nil { reconcile() }
    guard !gym.accountTransition, activityIdentityResolved, !gym.readFailed, let record = try? activityRecord(), record.ownerID == offer.ownerID,
          let session, session.isOpen, session.id.description == offer.sessionID else { return refuseActivityOffer() }
    if let existing = sets.first(where: { $0.id.description == offer.setID }) {
      guard existing.exerciseId.description == offer.movementID, existing.weightKg == offer.weightKg, existing.reps == offer.reps, existing.kind == offer.kind else { return refuseActivityOffer() }
      return true
    }
    guard activityOffer() == offer else { return refuseActivityOffer() }
    let logged = logSet(offered: offer)
    if !logged, case .stale = gym.refusal { return refuseActivityOffer() }
    return logged
  }
  func refuseActivityOffer() -> Bool {
    gym.telemetry.event("gym_activity_offer_refused")
    return false
  }
  func activityChanged() { gym.existingWorkoutActivity?.schedule() }
}

@MainActor final class WorkoutActivityBinding: ProductBinding {
  nonisolated let product = "gym"
  weak var gym: GymModel?
  func seatWillChange() async {
    guard let controller = gym?.existingWorkoutActivity else { return }
    controller.seatChanging = true
    defer { controller.seatChanging = false }
    while controller.reconciling { await Task.yield() }
    await controller.end()
    controller.requestedSession = nil
  }
}

@MainActor final class WorkoutActivityController {
  weak var gym: GymModel?
  var task: Task<Void, Never>?
  var monitor: Task<Void, Never>?
  var activity: Activity<WorkoutActivityAttributes>?
  var rendered: WorkoutActivityAttributes.ContentState?
  var requestedSession: ID<Session>?
  var owner: String?
  var ownerKnown = false
  var reconciling = false
  var seatChanging = false
  var pending = false
  init(gym: GymModel) { self.gym = gym }
  func schedule() {
    guard task == nil else { return }
    task = Task { [weak self] in
      await Task.yield()
      guard let self else { return }; self.task = nil; await self.reconcile()
    }
  }
  func restore() {
    guard let gym else { return }
    guard var record = try? gym.workout.activityRecord() else { return }
    record.dismissed = false; record.activityID = nil
    if gym.workout.keepActivity(record) {
      requestedSession = nil; rendered = nil
      if activity?.activityState == .dismissed || activity?.activityState == .ended { activity = nil }
      schedule()
    }
  }
  func reconcile() async {
    guard !seatChanging else { return }
    if reconciling { pending = true; return }
    reconciling = true
    repeat { pending = false; await apply() } while pending
    reconciling = false
  }
  func apply() async {
    guard let gym else { return }
    let workout = gym.workout
    if gym.openSession != nil { workout.reconcile() }
    let currentOwner = (try? gym.runtime?.engine.activeReplica()).map { $0 + ":" + (gym.account ?? (gym.isAnonymous ? "anon" : "unresolved")) }
    if ownerKnown && owner != currentOwner { await end(); requestedSession = nil }
    owner = currentOwner; ownerKnown = true
    guard !gym.readFailed, !gym.workoutHidden, let session = gym.openSession,
          session.id == workout.sessionId, var record = try? workout.activityRecord() else { await end(); return }
    let candidates = Activity<WorkoutActivityAttributes>.activities
    for other in candidates where other.attributes.sessionID != session.id.description { await other.end(nil, dismissalPolicy: .immediate) }
    if activity == nil {
      activity = candidates.first { $0.attributes.sessionID == session.id.description && $0.activityState != .dismissed && $0.activityState != .ended }
      if let activity { observe(activity) }
    }
    if record.activityID != nil && (activity == nil || activity?.activityState == .dismissed) {
      record.dismissed = true; record.activityID = nil; _ = workout.keepActivity(record); activity = nil
    }
    guard !record.dismissed else { return }
    let offer = workout.activityOffer()
    let content: ActivityContent<WorkoutActivityAttributes.ContentState>
    do { content = try self.content(session: session, offer: offer) }
    catch { gym.report("gym_activity_update", error); return }
    let state = content.state
    guard rendered != state else { return }
    if let activity {
      await activity.update(content)
      rendered = state
    } else if !gym.accountTransition, UIApplication.shared.applicationState == .active, ActivityAuthorizationInfo().areActivitiesEnabled, requestedSession != session.id {
      requestedSession = session.id
      do {
        let created = try Activity.request(attributes: WorkoutActivityAttributes(sessionID: session.id.description), content: content, pushType: nil)
        activity = created; rendered = state
        record = (try? workout.activityRecord()) ?? record
        record.activityID = created.id
        guard workout.keepActivity(record) else {
          await created.end(nil, dismissalPolicy: .immediate)
          activity = nil; rendered = nil
          return
        }
        observe(created)
      } catch { gym.telemetry.failure("gym_activity_request", kind: "unexpected") }
    }
  }
  func content(session: Session, offer: WorkoutActivityOffer?) throws -> ActivityContent<WorkoutActivityAttributes.ContentState> {
    guard let gym else { throw AppFailure(message: "Workout is unavailable.") }
    let workout = gym.workout
    let correction = Double(try gym.runtime?.storageRead { try $0.device().activeReplica.meta.serverOffsetMs } ?? 0)
    let latest = workout.sets.map(\.completedAt).max()
    let last = latest ?? session.startedAt
    let state = WorkoutActivityAttributes.ContentState(title: session.name ?? Readout.noRoutine,
      movement: workout.selected.flatMap { gym.catalogue.find($0)?.name } ?? "Choose a movement",
      load: Readout.weight(workout.weightKg) + " kg", reps: workout.reps, setKind: workout.kind.rawValue,
      workingSetOrdinal: workout.currentSets.filter { $0.kind == "working" }.count + 1,
      plannedWorkingSetCount: workout.entry?.sets?.count, startedAt: Date(timeIntervalSince1970: (Double(session.startedAt.ms) - correction) / 1000),
      lastSetAt: latest.map { Date(timeIntervalSince1970: (Double($0.ms) - correction) / 1000) },
      staleAt: Date(timeIntervalSince1970: (Double(last.ms) - correction + Double(SessionRules.staleAfterMs)) / 1000),
      unsyncedSetCount: gym.workoutDeviceSets(workout.sets).count, offer: offer)
    return ActivityContent(state: state, staleDate: state.staleAt)
  }
  func observe(_ value: Activity<WorkoutActivityAttributes>) {
    monitor?.cancel()
    monitor = Task { [weak self] in
      for await status in value.activityStateUpdates {
        guard !Task.isCancelled, let self else { return }
        if status == .dismissed { self.schedule() }
      }
    }
  }
  func end() async {
    let all = Activity<WorkoutActivityAttributes>.activities
    if let gym, var record = try? gym.workout.activityRecord(), record.activityID != nil {
      if !all.contains(where: { $0.id == record.activityID && $0.activityState != .dismissed && $0.activityState != .ended }) { record.dismissed = true }
      record.activityID = nil; _ = gym.workout.keepActivity(record)
    }
    monitor?.cancel(); monitor = nil
    for value in all { await value.end(nil, dismissalPolicy: .immediate) }
    activity = nil; rendered = nil
  }
}

extension GymModel {
  private static let workoutActivities = NSMapTable<AnyObject, WorkoutActivityController>.weakToStrongObjects()
  var existingWorkoutActivity: WorkoutActivityController? { Self.workoutActivities.object(forKey: self) }
  func startWorkoutActivity() {
    guard runtime != nil else { return }
    if existingWorkoutActivity == nil { Self.workoutActivities.setObject(WorkoutActivityController(gym: self), forKey: self) }
    existingWorkoutActivity?.schedule()
  }
}

@MainActor enum WorkoutActivityIntentHandler {
  static var model: AppModel?
  static var telemetry: AppTelemetry?
  static func logSet(offer: WorkoutActivityOffer) async -> Bool {
    do {
      let app: AppModel
      if let model { app = model }
      else {
        let settings = AppSettings()
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        let telemetry = Self.telemetry ?? AppTelemetry(info: settings.telemetryInfo, baseURL: settings.baseURL,
          directory: URL.applicationSupportDirectory.appending(path: "WindmillTelemetry"), debug: debug)
        Self.telemetry = telemetry
        let runtime = try AppRuntime(settings: settings, telemetry: telemetry)
        app = try AppModel(runner: runtime.runner, preferences: .standard, runtime: runtime, telemetry: runtime.telemetry)
        model = app; app.gym.startWorkoutActivity()
      }
      app.refresh(); app.runtime?.updateTelemetryIdentity()
      guard !app.editorReadOnly, app.pendingSignIn == nil else { app.openActivityWorkout(); return app.gym.workout.refuseActivityOffer() }
      let logged = app.gym.workout.logActivityOffer(offer)
      if !logged { app.openActivityWorkout() }
      await app.gym.existingWorkoutActivity?.reconcile()
      if logged { app.runtime?.engine.foreground(); Task { await app.start() } }
      return logged
    } catch {
      telemetry?.failure("gym_activity_update", kind: "unexpected")
      telemetry?.event("gym_activity_offer_refused")
      return false
    }
  }
}


extension AppModel {
  func openActivityWorkout() {
    selectedRoom = .gym; welcome = false
    guard !editorReadOnly, gym.openSession != nil else { return }
    gym.workout.restore()
    if gym.workoutHidden {
      var walk = gym.workout.walk; walk.hidden = false; _ = gym.workout.keep(walk)
    }
  }
}
