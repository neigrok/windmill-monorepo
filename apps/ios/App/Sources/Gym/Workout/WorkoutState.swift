import Foundation
import SwiftUI
import Observation
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema

// The workout clock counts from the start; the second clock exists once a set does, and counts from the latest one.
struct WorkoutClocks: Equatable {
  let workoutMs: Int64
  let sinceSetMs: Int64?
  init(session: Session, sets: [TrainingSet], now: Instant) {
    let latest = sets.filter { $0.sessionId == session.id }.map(\.completedAt).max()
    let until = session.finishedAt ?? now
    workoutMs = max(0, until.ms - session.startedAt.ms)
    sinceSetMs = latest.map { max(0, until.ms - $0.ms) }
  }
  static func reading(_ ms: Int64) -> String {
    let seconds = max(0, ms / 1_000), tail = String(format: "%02lld", seconds % 60)
    if seconds < 3_600 { return "\(seconds / 60):\(tail)" }
    return "\(seconds / 3_600):\(String(format: "%02lld", seconds / 60 % 60)):\(tail)"
  }
  // A clock in words, its empty parts left out: *2 minutes 14 seconds*.
  static func spoken(_ ms: Int64) -> String {
    let seconds = Int(max(0, ms / 1_000))
    let parts = [(seconds / 3_600, "hour"), (seconds / 60 % 60, "minute"), (seconds % 60, "second")].filter { $0.0 > 0 }
    return parts.isEmpty ? "0 seconds" : parts.map { GymCount.of($0.0, $0.1) }.joined(separator: " ")
  }
}

// One movement in this workout: its sets in the order they were logged, then the current set and the plan still ahead.
// A row keeps its place as sets are logged, so the set a lifter logs takes over the current row and the next one moves up.
nonisolated struct MovementLedger: Equatable {
  enum Place: Equatable { case logged(TrainingSet), current, planned }
  struct Row: Identifiable, Equatable {
    let id: Int
    let marker: String
    let reading: String
    // What the plan asks of a current or planned row; nil where it asks nothing, and on a logged row.
    let target: SetTarget?
    // The load the rack will offer for a current or planned row; nil on a logged row and while it waits on last time.
    var offered: Double? = nil
    let place: Place
    var set: TrainingSet? { if case .logged(let set) = place { set } else { nil } }
  }
  let sets: [TrainingSet]
  let plan: RoutineEntry?
  let lastTime: LastTime

  var targets: [SetTarget] { plan?.sets ?? [] }
  var performed: Int { sets.count }
  // The current row's offer, then each planned row's.
  var offers: [Double?] { Prefill.offeredLoads(todaySets: sets, planEntry: plan, lastTime: lastTime) }
  var current: Row {
    let target = performed < targets.count ? targets[performed] : nil, offered = offers.first ?? nil
    return Row(id: sets.count, marker: "\(performed + 1)", reading: target.map { Self.reading($0, offered: offered) } ?? Readout.openTarget,
               target: target, offered: offered, place: .current)
  }
  var rows: [Row] {
    let logged = sets.enumerated().map { index, set in
      Row(id: index, marker: SetRow.marker(set, in: sets), reading: Readout.effort(weightKg: set.weightKg, reps: set.reps), target: nil, place: .logged(set))
    }
    let offers = offers
    let ahead = targets.indices.dropFirst(performed + 1).map { index in
      let offered = offers[index - performed]
      return Row(id: sets.count + index - performed, marker: "\(index + 1)", reading: Self.reading(targets[index], offered: offered),
                 target: targets[index], offered: offered, place: .planned)
    }
    return logged + [current] + ahead
  }
  // A row still to lift reads the load the rack will offer, or a dash while there is none to name, by the plan's reps.
  static func reading(_ target: SetTarget, offered: Double?) -> String {
    "\(offered.map { Readout.weight($0) } ?? "—") × \(Readout.repTarget(target.reps))"
  }
  // Planned rows state the plan, so the line under the name speaks only for a planned movement that holds no targets.
  var planLine: String? { plan != nil && targets.isEmpty ? "plan \(Readout.openTarget)" : nil }
  // This workout's count: the sets against the plan's, or alone where the movement has no targets.
  var tally: String { targets.isEmpty ? GymCount.of(performed, "set") : "\(performed) of \(GymCount.of(targets.count, "set"))" }
  var complete: Bool { !targets.isEmpty && performed >= targets.count }
}

nonisolated struct WorkoutWalk: Equatable, Sendable {
  var order: [ID<Exercise>] = []
  var selected: ID<Exercise>?
  var hidden = false
  static func key(_ session: ID<Session>) -> String { "rack:\(session.record)" }
  init() {}
  init(_ json: JSON?) throws {
    guard let json else { return }
    let object = try json.asObject()
    order = try object["order"]?.asArray().map { ID<Exercise>(RecordID(try $0.asString())) } ?? []
    selected = try object["selected"].flatMap { $0.isNull ? nil : ID<Exercise>(RecordID(try $0.asString())) }
    hidden = try object["hidden"]?.asBool() ?? false
  }
  var json: JSON {
    .object(["order": .array(order.map(\.json)), "selected": selected?.json ?? .null, "hidden": .bool(hidden)])
  }
  mutating func merge(session: Session, sets: [TrainingSet]) {
    for id in (session.plan?.entries.map(\.exerciseId) ?? []) + sets.map(\.exerciseId) where !order.contains(id) { order.append(id) }
    if selected == nil || !order.contains(selected!) { selected = sets.last?.exerciseId ?? order.first }
  }
}

struct KeepWorkoutWalk: Action {
  let sessionId: ID<Session>
  let walk: WorkoutWalk
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws -> Session? { try read.repository(Session.self).find(sessionId, in: .drawn) }
  func decide(_ loaded: Session?, ids: IDSource) -> Decision<Void, GymRefusal> {
    guard loaded != nil else { return .refuse(.gone(sessionId.ref, .predicted)) }
    var plan = Plan(); plan.device(WorkoutWalk.key(sessionId), walk.json); return .write(plan)
  }
}

// One edit of this workout's plan and the walk it leaves, in one gesture: a movement the plan gains, loses or swaps does the
// same in the walk.
struct ReviseWorkout: Action {
  let revision: ReviseWorkoutPlan
  let walk: WorkoutWalk?
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws -> OpenWorkout { try revision.load(read) }
  func decide(_ loaded: OpenWorkout, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    switch try revision.decide(loaded, ids: ids) {
    case .write(var plan, _):
      if let walk { plan.device(WorkoutWalk.key(revision.sessionId), walk.json) }
      return .write(plan)
    case let decision: return decision
    }
  }
}

extension WorkoutPlan.Operation {
  // The label `gym_workout_plan_changed` reports the operation under.
  var action: String {
    switch self {
    case .retarget: "retarget"
    case .addSet: "add_set"
    case .removeSet: "remove_set"
    case .swap: "swap"
    case .addMovement: "add_movement"
    case .removeMovement: "remove_movement"
    case .setRest: "rest"
    }
  }
}

struct StartWorkoutCommand: ServerCommand {
  static let name = Gym.Commands.start
  static let specs: [any ValueSpec] = []
  let args: [String: JSON]
  init(id: ID<Session>, routineId: ID<Routine>, at: Instant) {
    args = ["id": id.json, "routineId": routineId.json, "startedAt": .of(at), "joinOpenSession": false]
  }
}

// Every workout this phone starts follows a routine; one without arrives only from elsewhere, as a connected agent's.
struct StartWorkout: Action {
  let id: ID<Session>
  let routineId: ID<Routine>
  var scope: ScopeRef { Gym.scope }
  typealias Loaded = (state: TrainingState, routine: Routine?, prior: Bool, replica: String, anonymous: Bool)
  func load(_ read: Reader) throws -> Loaded {
    let loaded = try StartSession(id: id, routineId: routineId).load(read)
    return (loaded.state, loaded.routine, loaded.prior, read.replica, read.isAnonymous)
  }
  func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<ID<Session>, GymRefusal> {
    if loaded.prior { return .unchanged(id) }
    guard let routine = loaded.routine else { return .refuse(.gone(routineId.ref, .predicted)) }
    if loaded.state.drawn.contains(where: { SessionRules.drawn($0, sets: loaded.state.sets, now: loaded.state.moment.now).isOpen }) {
      return .refuse(.sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted)))
    }
    let at = loaded.state.moment.now
    let value = Session(id: id, startedAt: at, routineId: routine.id, plan: SessionPlan(routine))
    var plan = try Plan(running: StartWorkoutCommand(id: id, routineId: routine.id, at: at),
                        predicting: [.create(Session.self, id, value.fields)])
    plan.device(WorkoutActivityRecord.key, WorkoutActivityRecord(sessionID: id.description, replica: loaded.replica, anonymous: loaded.anonymous).json)
    return .write(plan, id)
  }
}

struct LogWorkoutSet: Action {
  let value: TrainingSet
  let session: Session
  let previousSets: [TrainingSet]
  var offer: WorkoutActivityOffer? = nil
  var scope: ScopeRef { Gym.scope }
  // Logged order is completion order: a clock that has not moved past the latest set still puts the new set after it.
  nonisolated static func completedAt(_ now: Instant, after sets: [TrainingSet]) -> Instant {
    guard let latest = sets.map(\.completedAt.ms).max(), latest >= now.ms else { return now }
    return Instant(ms: latest + 1)
  }
  nonisolated static func matchesOfferedSets(_ current: [TrainingSet], _ offered: [TrainingSet]) -> Bool {
    guard current.count == offered.count else { return false }
    return zip(current.sorted { $0.id < $1.id }, offered.sorted { $0.id < $1.id }).allSatisfy {
      $0.0.id == $0.1.id && $0.0.fields == $0.1.fields
    }
  }
  func load(_ read: Reader) throws -> (TrainingState, WorkoutActivityRecord?, String, WorkoutWalk, Bool, Bool) {
    (try TrainingState(read), try read.device(WorkoutActivityRecord.key).map(WorkoutActivityRecord.init), read.replica,
     try WorkoutWalk(read.device(WorkoutWalk.key(session.id))), try read.commands().contains { $0.command.name == Gym.Commands.finish && $0.command.args["sessionId"] == session.id.json }, read.isAnonymous)
  }
  func decide(_ input: (TrainingState, WorkoutActivityRecord?, String, WorkoutWalk, Bool, Bool), ids: IDSource) throws(Violation) -> Decision<ID<TrainingSet>, GymRefusal> {
    let loaded = input.0
    let current = loaded.drawnSets.filter { $0.sessionId == session.id }.sorted { $0.id < $1.id }
    if let offer {
      guard let record = input.1, record.ownerID == offer.ownerID, record.replica == input.2, record.anonymous == input.5,
            !input.3.hidden, !input.4, input.3.selected?.description == offer.movementID,
            record.baseline == WorkoutActivityRecord.snapshot(session: session, sets: current),
            record.offer == offer, value.id.description == offer.setID,
            value.sessionId.description == offer.sessionID, value.exerciseId.description == offer.movementID,
            value.weightKg == offer.weightKg, value.reps == offer.reps,
            SessionRules.autoCloseAt(session, sets: loaded.sets, now: loaded.moment.now) == nil else { return .refuse(.stale(session.id.ref, .predicted)) }
    }
    guard loaded.drawn.first(where: { $0.id == session.id }) == session,
          Self.matchesOfferedSets(current, previousSets) else {
      return .refuse(.stale(session.id.ref, .predicted))
    }
    return try AppendSet(value).decide(loaded, ids: ids)
  }
}

struct FinishWorkout: Action {
  struct Loaded: Sendable { let training: TrainingState; let serverHeld: Bool; let stranded: Bool }
  let id: ID<Session>
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws -> Loaded {
    let training = try TrainingState(read)
    let held = try read.confirmed(Session.self, id) != nil || read.commands().contains {
      $0.isAdmitted && $0.command.name == Gym.Commands.start && $0.command.args["id"] == id.json
    }
    var stranded = false
    if held {
      for set in training.sets where set.sessionId == id {
        guard training.drawnSets.contains(where: { $0.id == set.id }) else { stranded = true; break }
        guard let confirmed = try read.confirmed(TrainingSet.self, set.id), confirmed.isVisible,
              try TrainingSet(Fields(confirmed)) == set else { stranded = true; break }
      }
    }
    return Loaded(training: training, serverHeld: held, stranded: stranded)
  }
  func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard !loaded.stranded else { return .refuse(.sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted))) }
    let action = FinishSession(id: id)
    let decision = try action.decide(loaded.training, ids: ids)
    guard loaded.serverHeld, case .write = decision, let session = loaded.training.session(id) else { return decision }
    let at = SessionRules.finishAt(session, sets: loaded.training.sets, now: loaded.training.moment.now)
    return .write(try Plan(running: FinishSessionCommand(id: id, finishedAt: at)))
  }
}

@Observable @MainActor final class WorkoutState {
  nonisolated deinit {}
  unowned let gym: GymModel
  var sessionId: ID<Session>?
  var walk = WorkoutWalk()
  // The rack drafts load and reps only: a new set is Working, and the Fix sheet is where a kind changes.
  private var rackWeightKg = Prefill.emptyBarKg
  private var rackReps = Prefill.emptyBarReps
  @ObservationIgnored private var rackSave: Task<Void, Never>?
  @ObservationIgnored private var rackBase: Prefill?
  var weightKg: Double {
    get { rackWeightKg }
    set { adjustRack(weightKg: newValue, reps: reps) }
  }
  var reps: Int {
    get { rackReps }
    set { adjustRack(weightKg: weightKg, reps: newValue) }
  }
  // The load the rack's numeral stands for while it is a field, nil while the numeral shows. It lands when the field lets
  // go and before the lifter changes movement; a movement the walk changes under it, another workout or another account
  // drops it.
  var typedLoad: Double?
  func typeLoad() { if typedLoad == nil { typedLoad = weightKg } }
  func landTypedLoad() {
    guard let load = typedLoad else { return }
    typedLoad = nil
    adjustRack(weightKg: load, reps: reps)
  }
  // How often the lifter changed load or reps; a prefill or a restored value is not theirs and leaves it.
  private(set) var adjustments = 0
  // The rack holds what the last prefill put there: a plan edit moves the rack only while the lifter has not touched it, nor
  // brought back numbers of their own, since.
  @ObservationIgnored private var rackPrefilled = true
  var paging = false { didSet { if oldValue != paging { activityChanged() } } }
  var message: String?
  var finishing = false { didSet { if oldValue != finishing { activityChanged() } } }
  var finishQueued = false { didSet { if oldValue != finishQueued { activityChanged() } } }
  var receipt: WorkoutReceiptData?
  // Finish was taken: its receipt is owed until the log shows the finish, however late the confirmation lands.
  @ObservationIgnored var receiptOwed = false
  var handoff: WorkoutHandoff?
  var rackEditing = false {
    didSet {
      if oldValue != rackEditing {
        if rackEditing { _ = activityOffer() }
        activityChanged()
      }
    }
  }
  var coachAvailable = false
  var syncFailed: Bool { gym.runtime?.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
  @ObservationIgnored var offerSession: Session?
  @ObservationIgnored var offerSets: [TrainingSet] = []
  @ObservationIgnored var drafts: [ID<Exercise>: Prefill] = [:]
  // The set whose rest last reached its target, so each rest is reached once; each reach the lifter may feel counts here.
  @ObservationIgnored var restReachedAfter: ID<TrainingSet>?
  private(set) var restReaches = 0

  init(gym: GymModel) { self.gym = gym; restore() }
  func restoreRack(weightKg: Double, reps: Int) {
    rackSave?.cancel(); rackSave = nil; rackBase = nil
    rackWeightKg = weightKg; rackReps = reps
    activityChanged()
  }
  func adjustRack(weightKg: Double, reps: Int) {
    guard weightKg != self.weightKg || reps != self.reps else { return }
    editRack(weightKg: weightKg, reps: reps)
    adjustments += 1
  }
  func editRack(weightKg: Double, reps: Int) {
    guard weightKg != self.weightKg || reps != self.reps else { return }
    rackPrefilled = false
    if rackBase == nil { rackBase = Prefill(weightKg: self.weightKg, reps: self.reps) }
    rackWeightKg = weightKg; rackReps = reps
    rackSave?.cancel()
    rackSave = Task { @MainActor [weak gym] in
      do { try await Task.sleep(for: .milliseconds(45)) } catch { return }
      gym?.workout.flushRack()
    }
  }
  static let rackUnchanged = "The rack could not be changed. Try again."
  // One save per burst of taps, reported once; an account change flushes first, so a burst that meets one is refused aloud.
  @discardableResult func flushRack() -> Bool {
    guard let previous = rackBase else { return true }
    rackSave?.cancel(); rackSave = nil; rackBase = nil
    let weightKg = self.weightKg, reps = self.reps
    let adjusted = { (outcome: String) in
      self.gym.telemetry.event("gym_workout_adjusted", properties: ["screen": "workout", "field": weightKg != previous.weightKg ? "weight" : "reps", "outcome": outcome])
    }
    guard !gym.accountTransition else {
      message = Self.rackUnchanged; gym.error = message
      restoreRack(weightKg: previous.weightKg, reps: previous.reps); adjusted("refused"); return false
    }
    var revoke: WorkoutActivityRecord?
    do {
      if let sessionId, var record = try activityRecord() {
        record.offer = nil; revoke = record
        if canLog, !rackEditing, !gym.workoutHidden,
           weightKg.isFinite, SetRules.loggedReps.contains(reps),
           let session, session.holdsRack(of: offerSession), LogWorkoutSet.matchesOfferedSets(sets, offerSets), let selected {
          record.offer = WorkoutActivityOffer(ownerID: record.ownerID, sessionID: session.id.description,
            movementID: selected.description, weightKg: weightKg, reps: reps, setID: gym.runner.mint(TrainingSet.self).description)
          record.baseline = activityBaseline
        }
        let result = try gym.runner.run(KeepWorkoutActivity(sessionID: sessionId, record: record, walk: walk))
        if let refusal = result.refusal {
          gym.refusal = refusal; message = gym.message(refusal); gym.error = message
          restoreRack(weightKg: previous.weightKg, reps: previous.reps); adjusted("refused")
          return false
        }
      }
    } catch {
      gym.report("gym_activity_update", error)
      if let revoke, let sessionId {
        do {
          if try gym.runner.run(KeepWorkoutActivity(sessionID: sessionId, record: revoke, walk: walk)).refusal != nil {
            gym.readFailed = true
          }
        } catch { gym.readFailed = true; gym.report("gym_activity_update", error) }
      } else { gym.readFailed = true }
      message = Self.rackUnchanged; gym.error = message
      restoreRack(weightKg: previous.weightKg, reps: previous.reps); adjusted("failed")
      return false
    }
    restoreRack(weightKg: weightKg, reps: reps); adjusted("ok")
    if message == Self.rackUnchanged {
      message = nil
      if gym.error == Self.rackUnchanged { gym.error = nil }
    }
    return true
  }
  var session: Session? { gym.sessions.first { $0.id == sessionId } ?? receipt?.session }
  var sets: [TrainingSet] { gym.log?.sets(session: sessionId ?? ID("missing")) ?? [] }
  var selected: ID<Exercise>? { walk.selected }
  var currentSets: [TrainingSet] { sets.filter { $0.exerciseId == selected } }
  var entry: RoutineEntry? { session?.plan?.entries.first { $0.exerciseId == selected } }
  func planIndex(_ id: ID<Exercise>) -> Int? { session?.plan?.entries.firstIndex { $0.exerciseId == id } }
  // A movement with a logged set keeps its plan; one with nothing logged takes edits while the workout is open.
  func canEditPlan(_ id: ID<Exercise>) -> Bool {
    session?.isOpen == true && planIndex(id) != nil && !sets.contains { $0.exerciseId == id }
  }
  func restTarget(_ id: ID<Exercise>) -> RestTarget? {
    RestTarget.of(session?.plan?.entries.first { $0.exerciseId == id }, rest: gym.restSettings)
  }
  func reachRest() {
    guard let latest = sets.max(by: { $0.completedAt.ms < $1.completedAt.ms })?.id, latest != restReachedAfter else { return }
    restReachedAfter = latest
    restReaches += 1
    gym.telemetry.event("gym_rest_target_reached", properties: ["screen": "workout"])
  }
  // With no log read yet, the movement's last time is not known.
  func ledger(_ id: ID<Exercise>) -> MovementLedger {
    MovementLedger(sets: sets.filter { $0.exerciseId == id }, plan: session?.plan?.entries.first { $0.exerciseId == id },
                   lastTime: gym.log?.lastTime(for: id) ?? LastTime(exerciseId: id, isComplete: false))
  }
  // The clocks read the log's time, which stamped the start and the sets; this phone's time stands in when it cannot be read.
  var clocks: WorkoutClocks? {
    guard let session else { return nil }
    let now = (try? gym.runner.moment().now) ?? Instant(Date.now)
    return WorkoutClocks(session: session, sets: sets, now: now)
  }
  var isPresented: Bool { (!gym.workoutHidden && gym.openSession != nil) || finishing || receipt != nil }
  var canLog: Bool { session?.isOpen == true && selected != nil && !paging && !finishing && !finishQueued && !gym.accountTransition && !gym.readFailed }

  func restore() {
    if gym.readFailed { gym.refresh(); guard !gym.readFailed else { finishQueued = true; return } }
    guard let open = gym.openSession else { return }
    let restored: (WorkoutWalk, Bool)
    do {
      restored = try gym.runner.read(Gym.scope) { read in
        (try WorkoutWalk(read.device(WorkoutWalk.key(open.id))),
         try read.commands().contains { $0.command.name == Gym.Commands.finish && $0.command.args["sessionId"] == open.id.json })
      }
    }
    catch {
      finishQueued = true; message = Self.orderUnread
      gym.failRead(error); return
    }
    if sessionId != open.id { drafts = [:]; receipt = nil; receiptOwed = false; handoff = nil; typedLoad = nil }
    sessionId = open.id; (walk, finishQueued) = restored
    if message == Self.orderUnread { message = nil }
    walk.merge(session: open, sets: sets)
    prefill(); restoreActivityDraft()
  }
  func reconcile() {
    if gym.readFailed { gym.refresh(); guard !gym.readFailed else { finishQueued = true; return } }
    if let open = gym.openSession, open.id != sessionId { restore() }
    guard !gym.readFailed, let session else { return }
    let awaitingReceipt = finishing || finishQueued || receiptOwed, previousSelected = selected
    do {
      (walk, finishQueued) = try gym.runner.read(Gym.scope) { read in
        (try WorkoutWalk(read.device(WorkoutWalk.key(session.id))),
         try read.commands().contains { $0.command.name == Gym.Commands.finish && $0.command.args["sessionId"] == session.id.json })
      }
    } catch {
      finishQueued = true; gym.failRead(error); return
    }
    if message == Self.orderUnread { message = nil }
    walk.merge(session: session, sets: sets)
    if previousSelected != selected { typedLoad = nil; prefill(); restoreActivityDraft() }
    else if let previous = offerSession, previous.plan != session.plan, LogWorkoutSet.matchesOfferedSets(sets, offerSets),
            !rackFollows(from: previous, to: session) {
      // The plan changed and the rack's numbers stand: they are offered against the plan as it is now.
      offerSession = session; activityChanged()
    } else if !session.holdsRack(of: offerSession) || !LogWorkoutSet.matchesOfferedSets(sets, offerSets) {
      let pending = rackBase.map { _ in Prefill(weightKg: weightKg, reps: reps) }
      prefill()
      if let pending { editRack(weightKg: pending.weightKg, reps: pending.reps) }
    }
    if awaitingReceipt && session.closedBy == "finish" { completeFinish(session) }
  }
  func retryRead() { gym.refresh(); reconcile() }
  func prefill() {
    guard let session, let selected else { offerSession = nil; return }
    let value = Prefill.of(todaySets: currentSets, planEntry: entry, lastTime: gym.log?.lastTime(for: selected))
    restoreRack(weightKg: value.weightKg, reps: min(SetRules.loggedReps.upperBound, value.reps))
    offerSession = session; offerSets = sets; rackPrefilled = true
  }
  // Numbers the lifter left on the rack come back as theirs: a draft kept for the movement, or the offer outside the app.
  func restoreDraft(_ draft: Prefill) {
    guard draft.weightKg != weightKg || draft.reps != reps else { return }
    restoreRack(weightKg: draft.weightKg, reps: draft.reps)
    rackPrefilled = false
  }
  // A plan edit prefills the rack again only when it changed the selected movement's current slot and the lifter has not
  // touched the rack since its last prefill.
  func rackFollows(from previous: Session, to next: Session) -> Bool {
    guard let selected, rackBase == nil, rackPrefilled else { return false }
    let slot = { (session: Session) in
      MovementLedger(sets: self.currentSets, plan: session.plan?.entries.first { $0.exerciseId == selected },
                     lastTime: LastTime(exerciseId: selected, isComplete: false)).current.target
    }
    return slot(previous) != slot(next)
  }
  @discardableResult func keep(_ next: WorkoutWalk) -> Bool {
    guard !gym.readFailed, let sessionId, gym.run(KeepWorkoutWalk(sessionId: sessionId, walk: next))?.refusal == nil,
          gym.error == nil else { message = gym.error; return false }
    walk = next; activityChanged(); return true
  }
  func select(_ id: ID<Exercise>) {
    guard walk.order.contains(id), id != selected, !finishing else { return }
    landTypedLoad()
    guard flushRack() else { return }
    if let selected { drafts[selected] = Prefill(weightKg: weightKg, reps: reps) }
    var next = walk; next.selected = id
    guard keep(next) else { return }
    prefill()
    if let draft = drafts[id] { restoreDraft(draft) }
  }
  @discardableResult func add(_ id: ID<Exercise>) -> Bool {
    guard session?.isOpen == true, !walk.order.contains(id), gym.catalogue.find(id) != nil,
          !finishing, !finishQueued, !paging, !gym.accountTransition, !gym.readFailed else { return false }
    landTypedLoad()
    guard flushRack() else { return false }
    var next = walk; next.order.append(id); next.selected = id
    let prior = selected, draft = Prefill(weightKg: weightKg, reps: reps)
    // A workout that follows a plan takes the movement into it, with no targets; one with no plan holds it in the walk.
    guard session?.plan == nil ? keep(next) : revise([.addMovement(id)], walk: next, against: session?.plan) else { return false }
    if let prior { drafts[prior] = draft }
    prefill()
    return true
  }
  func move(from: IndexSet, to: Int) {
    var next = walk; next.order.move(fromOffsets: from, toOffset: to); _ = keep(next)
  }
  func canRemove(_ id: ID<Exercise>) -> Bool { !sets.contains { $0.exerciseId == id } }
  func remove(_ id: ID<Exercise>) {
    landTypedLoad()
    guard flushRack() else { return }
    guard canRemove(id) else { message = "A movement with a logged set stays in this workout."; return }
    var next = walk; next.order.removeAll { $0 == id }
    let leaving = selected == id
    if leaving { next.selected = next.order.first }
    // A routine may name a movement twice: it leaves whole, each of its entries last to first so every earlier place stands.
    let entries = (session?.plan?.entries ?? []).enumerated().filter { $0.element.exerciseId == id }.map(\.offset)
    let removals = entries.reversed().map { WorkoutPlan.Operation.removeMovement(index: $0) }
    guard removals.isEmpty ? keep(next) : revise(removals, walk: next, against: session?.plan) else { return }
    drafts[id] = nil
    // The rack moves only when the movement it stood at left.
    guard leaving else { return }
    prefill()
    if let selected, let draft = drafts[selected] { restoreDraft(draft) }
  }
  // The movement takes `id`'s place, its planned sets and rest, after the edits `operations` stage, in one save.
  @discardableResult func swap(_ id: ID<Exercise>, to replacement: ID<Exercise>, after operations: [WorkoutPlan.Operation] = [],
                               against base: SessionPlan?) -> Bool {
    guard let index = planIndex(id) else { return false }
    var next = walk
    if let place = next.order.firstIndex(of: id) { next.order[place] = replacement }
    if next.selected == id { next.selected = replacement }
    return revise(operations + [.swap(index: index, exerciseId: replacement)], walk: next, against: base)
  }
  // One edit of this workout's plan, saved with the walk it leaves, against the plan its editor opened on; each kind of
  // change it makes is reported once. The durable offer is minted again over the new plan, and the rack follows it only
  // as `rackFollows` says.
  @discardableResult func revise(_ operations: [WorkoutPlan.Operation], walk next: WorkoutWalk? = nil, against base: SessionPlan?) -> Bool {
    let report = { (outcome: String) in
      for action in operations.map(\.action).reduce(into: [String](), { if !$0.contains($1) { $0.append($1) } }) {
        self.gym.telemetry.event("gym_workout_plan_changed", properties: ["action": action, "outcome": outcome, "door": "workout"])
      }
    }
    guard !operations.isEmpty else { return true }
    guard flushRack(), let session, session.isOpen, !finishing, !finishQueued, !paging, !gym.accountTransition, !gym.readFailed else {
      report("refused"); return false
    }
    let revision = ReviseWorkoutPlan(sessionId: session.id, base: base, operations: operations)
    guard let result = gym.run(ReviseWorkout(revision: revision, walk: next)) else { message = gym.error; report("failed"); return false }
    guard result.refusal == nil else { message = gym.error; report("refused"); return false }
    if let next { walk = next }
    report("ok")
    reconcile(); activityChanged()
    return true
  }
  @discardableResult func logSet(offered: WorkoutActivityOffer? = nil) -> Bool {
    guard flushRack() else { return false }
    guard canLog, let selected, let session else { message = "Check the weight and reps before logging."; return false }
    guard session.holdsRack(of: offerSession) && LogWorkoutSet.matchesOfferedSets(sets, offerSets) else { message = "The workout changed. Check the current set."; prefill(); return false }
    guard weightKg.isFinite, SetRules.loggedReps.contains(reps) else { message = "Check the weight and reps before logging."; return false }
    let offer = offered ?? activityOffer()
    let now: Instant
    do { now = try gym.runner.moment().now }
    catch { message = "The workout could not be read. Check the current set."; gym.report("gym_read", error); return false }
    let value = TrainingSet(id: offer.map { ID<TrainingSet>(RecordID($0.setID)) } ?? gym.runner.mint(TrainingSet.self), sessionId: session.id, exerciseId: selected,
                            weightKg: weightKg, reps: reps, completedAt: LogWorkoutSet.completedAt(now, after: sets),
                            setNumber: SetRules.nextNumber(gym.sets, sessionId: session.id, exerciseId: selected))
    guard let result = gym.run(LogWorkoutSet(value: value, session: session, previousSets: sets, offer: offer)), result.refusal == nil else {
      if case .stale = gym.refusal { message = "The workout changed. Check the current set." }
      else { message = gym.error }; return false
    }
    gym.telemetry.event("gym_set_logged", properties: ["screen": "workout", "outcome": "ok"])
    drafts[selected] = nil; message = nil; prefill(); activityChanged()
    return true
  }

  static let orderUnread = "The workout is saved. Its movement order could not be read. Try again."
  // What a plan editor says as it closes under a set the movement just took.
  static func loggedNow(_ movement: String) -> String { "\(movement) has a logged set now. Nothing changed." }

  // A tapped Finish always ends in a queued finish or a refusal, even when its task is cancelled while it waits.
  func finish() async {
    guard flushRack() else { return }
    guard !finishing, !paging, let session, session.isOpen, !gym.readFailed, !gym.accountTransition else { return }
    let account = gym.account
    finishing = true; message = nil
    defer { finishing = false }
    let unconfirmed = try? gym.runner.read(Gym.scope) { read in
      let loaded = try FinishWorkout(id: session.id).load(read)
      return loaded.serverHeld && loaded.stranded
    }
    if unconfirmed == true, let runtime = gym.runtime, !gym.isAnonymous, runtime.engine.status.online, !syncFailed {
      _ = await Self.drain(timeout: gym.waits.confirmation) { await self.flushAndConfirm(session.id, finished: false) }
      guard gym.account == account, sessionId == session.id, !gym.accountTransition else { return }
    }
    let pending: Bool
    do {
      pending = try gym.runner.read(Gym.scope) { read in
        try read.commands().contains { $0.command.name == Gym.Commands.finish && $0.command.args["sessionId"] == session.id.json }
      }
    } catch { message = "The workout could not be read. Try Finish again."; gym.report("gym_read", error); return }
    if !pending {
      guard let result = gym.run(FinishWorkout(id: session.id)), result.refusal == nil else {
        // What holds the finish back is named: the update the server requires, else the connection.
        if case .sessionOpen = gym.refusal, gym.runtime?.engine.status.upgradeRequired == true { message = "Finish needs the update — keep logging, or hide the workout." }
        else if case .sessionOpen = gym.refusal { message = "Finish needs a connection — keep logging, or hide the workout." }
        else { message = gym.error }
        gym.telemetry.event("gym_session_finished", properties: ["screen": "workout", "outcome": "refused"])
        return
      }
    }
    receiptOwed = true
    reconcile()
    finishing = false
    if receipt == nil { message = "Finish is saved on this phone. It will be confirmed when a connection is available." }
    if gym.runtime != nil, !gym.isAnonymous {
      guard await drainForFinish(timeout: gym.waits.finish, operation: { await self.flushAndConfirm(session.id, finished: true) }) else { return }
      gym.refresh()
    }
    guard !Task.isCancelled, gym.account == account, sessionId == session.id, !gym.accountTransition else { return }
    guard let finished = gym.sessions.first(where: { $0.id == session.id }), !finished.isOpen else {
      message = gym.error ?? "Finish is saved on this phone. It will be confirmed when a connection is available."; return
    }
    completeFinish(finished)
  }
  // A successful push may precede its live hint: pull until the sets (before Finish) or the finish (after it) are confirmed.
  func flushAndConfirm(_ id: ID<Session>, finished: Bool) async {
    guard let runtime = gym.runtime else { return }
    let account = gym.account
    await runtime.engine.flushOnLeave()
    guard !Task.isCancelled, gym.account == account, sessionId == id, !gym.accountTransition else { return }
    runtime.engine.foreground()
    while !Task.isCancelled {
      if runtime.engine.lastChange != gym.readThrough { gym.refresh() }
      guard gym.account == account, sessionId == id, !gym.accountTransition, !gym.isAnonymous, !gym.authPaused,
            runtime.engine.status.online, !syncFailed, !gym.readFailed else { return }
      do {
        let waiting = try gym.runner.read(Gym.scope) { read in
          let loaded = try FinishWorkout(id: id).load(read)
          if !finished { return loaded.serverHeld && loaded.stranded }
          guard loaded.training.drawn.first(where: { $0.id == id })?.isOpen == true else { return false }
          return try read.commands().contains { $0.command.name == Gym.Commands.finish && $0.command.args["sessionId"] == id.json }
        }
        if !waiting { return }
      } catch { gym.report("gym_read", error); return }
      do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
    }
  }
  func completeFinish(_ session: Session) {
    receiptOwed = false
    guard receipt == nil, handoff == nil else { return }
    receipt = WorkoutReceiptData(session: session, sets: sets, suggestsKeep: gym.suggestsKeep(session.id),
                                 routine: gym.routines.first { $0.id == session.routineId })
    message = nil
    gym.telemetry.event("gym_session_finished", properties: ["screen": "workout", "outcome": "ok"])
  }
  func drainForFinish(timeout: Duration, operation: @escaping @Sendable () async -> Void) async -> Bool {
    let account = gym.account, id = sessionId
    let completed = await Self.drain(timeout: timeout, operation: operation)
    if !completed && !Task.isCancelled && gym.account == account && sessionId == id && !gym.accountTransition {
      gym.telemetry.failure("gym_flush", kind: "timeout")
    }
    return completed
  }
  static func drain(timeout: Duration, operation: @escaping @Sendable () async -> Void) async -> Bool {
    let (results, continuation) = AsyncStream<Bool>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let work = Task { await operation(); continuation.yield(!Task.isCancelled); continuation.finish() }
    let timer = Task {
      do { try await Task.sleep(for: timeout) } catch { return }
      continuation.yield(false); continuation.finish()
    }
    defer { work.cancel(); timer.cancel(); continuation.finish() }
    return await withTaskCancellationHandler {
      for await completed in results { return completed && !Task.isCancelled }
      return false
    } onCancel: {
      work.cancel(); timer.cancel(); continuation.finish()
    }
  }
  func closeReceipt() { receipt = nil; if handoff == nil { handoff = .detail(sessionId) }; message = nil }
  func accountChanged() {
    gym.coachUnavailable = false
    sessionId = nil; walk = WorkoutWalk(); drafts = [:]; offerSession = nil; offerSets = []; typedLoad = nil
    restoreRack(weightKg: Prefill.emptyBarKg, reps: Prefill.emptyBarReps); paging = false
    receipt = nil; receiptOwed = false; handoff = nil; message = nil; finishQueued = false; restore()
  }
}

extension Session {
  // The workout as the rack and its durable offer read it: what the phone writes, so the revisions the log stamps when it
  // confirms a start or a plan edit move neither.
  func holdsRack(of other: Session?) -> Bool { other?.id == id && other?.fields == fields }
}

enum HiddenWorkoutDoor: String { case accessory, row }

enum WorkoutHandoff: Equatable {
  case detail(ID<Session>?)
  case keep(ID<Session>)
  case coach
  case writtenProgram
  case keepRoutines
  case you
  case routine(ID<Routine>)
  case buildRoutine
  static let coachQuestion = "Check my last workout."
}

extension GymModel {
  // Signed out, the first receipt that suggests Keep is the only one: the phone keeps its workout's id, so the same receipt
  // drawn again still suggests it and no later one does, signed out or in (03.15).
  static let keepReceipt = "gymKeepReceipt"
  func suggestsKeep(_ session: ID<Session>) -> Bool {
    guard isAnonymous, let phone, (phone.string(forKey: Self.keepReceipt) ?? session.description) == session.description else { return false }
    phone.set(session.description, forKey: Self.keepReceipt)
    return true
  }
  private static let workoutStates = NSMapTable<AnyObject, WorkoutState>.weakToStrongObjects()
  var workout: WorkoutState {
    if let state = Self.workoutStates.object(forKey: self) { return state }
    let state = WorkoutState(gym: self); Self.workoutStates.setObject(state, forKey: self); return state
  }
  @discardableResult func startWorkout(routineId: ID<Routine>) -> ID<Session>? {
    guard !readFailed else { error = "Your routines could not be read. Try again."; return nil }
    guard routines.contains(where: { $0.id == routineId }) else {
      error = "That routine can’t be found. No workout was started."; return nil
    }
    let id = runner.mint(Session.self)
    guard let result = run(StartWorkout(id: id, routineId: routineId)), result.refusal == nil else {
      if openSession != nil {
        let refused = refusal, explanation = error
        _ = restoreWorkout(); refusal = refused; error = explanation
      }
      return openSession?.id
    }
    _ = restoreWorkout()
    telemetry.event("gym_session_started", properties: ["screen": "workout", "outcome": "ok"])
    return id
  }
  @discardableResult func hideWorkout() -> Bool {
    guard openSession != nil, !workout.finishing, workout.receipt == nil, workout.flushRack() else { return false }
    var next = workout.walk; next.hidden = true
    guard workout.keep(next) else { return false }
    telemetry.event("gym_hidden_workout", properties: ["action": "hide"])
    return true
  }
  // A door that leads out of the workout hides it first; the room opens the door once the cover has gone.
  @discardableResult func hideWorkout(handingOff handoff: WorkoutHandoff) -> Bool {
    guard hideWorkout() else { return false }
    workout.handoff = handoff
    return true
  }
  static let restoreFailed = "Gym could not restore this workout. Try again."
  // The lifter's way back to a hidden workout: the tab bar's accessory on iOS 26, The log's Hidden row on iOS 18.
  @discardableResult func openHiddenWorkout(from door: HiddenWorkoutDoor) -> Bool {
    guard restoreWorkout() else { error = Self.restoreFailed; return false }
    telemetry.event("gym_hidden_workout", properties: ["action": "open", "door": door.rawValue])
    return true
  }
  @discardableResult func restoreWorkout() -> Bool {
    guard !accountTransition, openSession != nil else { return false }
    workout.restore()
    if workout.activityIdentityResolved {
      guard workout.restoreActivityAuthority() else { return false }
      existingWorkoutActivity?.restore()
    }
    guard workoutHidden else { return true }
    var next = workout.walk; next.hidden = false
    return workout.keep(next)
  }
  var workoutNotice: String? {
    guard let notice = notices.last else { return nil }
    let reason = message(notice.refusal)
    guard let subject = notice.subject, subject.type == TrainingSet.type else { return reason }
    let fields = notice.values(of: subject)
    guard let exercise = try? fields["exerciseId"]?.asString(), let weight = try? fields["weightKg"]?.asDouble(),
          let reps = try? fields["reps"]?.asInteger() else { return reason }
    let set = "\(catalogue.find(ID(RecordID(exercise)))?.name ?? "Movement") \(Readout.effort(weightKg: weight, reps: Int(reps)))"
    if case .full(_, let cap, _) = notice.refusal { return "\(set) not sent. Room for \(cap) sets — remove one." }
    return "\(set) not sent. \(reason)"
  }
}
