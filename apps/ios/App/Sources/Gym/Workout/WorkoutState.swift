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
    let place: Place
    var set: TrainingSet? { if case .logged(let set) = place { set } else { nil } }
  }
  let sets: [TrainingSet]
  let plan: RoutineEntry?

  var targets: [SetTarget] { plan?.sets ?? [] }
  var performed: Int { sets.count }
  var current: Row {
    let target = performed < targets.count ? targets[performed] : nil
    return Row(id: sets.count, marker: "\(performed + 1)", reading: target.map(Readout.setTarget) ?? Readout.openTarget, target: target, place: .current)
  }
  var rows: [Row] {
    let logged = sets.enumerated().map { index, set in
      Row(id: index, marker: SetRow.marker(set, in: sets), reading: Readout.effort(weightKg: set.weightKg, reps: set.reps), target: nil, place: .logged(set))
    }
    let ahead = targets.indices.dropFirst(performed + 1).map { index in
      Row(id: sets.count + index - performed, marker: "\(index + 1)", reading: Readout.setTarget(targets[index]), target: targets[index], place: .planned)
    }
    return logged + [current] + ahead
  }
  // Planned rows state the plan, so the line under the name speaks only for a planned movement that holds no targets.
  var planLine: String? { plan != nil && targets.isEmpty ? "plan \(Readout.openTarget)" : nil }
  // This workout's count: the sets against the plan's, or alone where the movement has no targets.
  var tally: String { targets.isEmpty ? GymCount.of(performed, "set") : "\(performed) of \(GymCount.of(targets.count, "set"))" }
  var complete: Bool { !targets.isEmpty && performed >= targets.count }
}

nonisolated struct WorkoutDeviation: Equatable, Identifiable, Sendable {
  let exerciseId: ID<Exercise>
  let routineId: ID<Routine>
  let routine: String
  let position: Int
  let plannedKg: Double
  let liftedKg: Double
  let scheme: [SetTarget]
  let lifted: [SetTarget]
  let revision: Int?
  let offeredEntry: RoutineEntry
  var id: ID<Exercise> { exerciseId }
  var varied: Bool { scheme.contains { $0 != scheme.first } }
  var proposed: [SetTarget] { varied ? lifted : scheme.map { SetTarget(reps: $0.reps, weightKg: liftedKg) } }
  var saveLabel: String { varied ? "Save today’s sets" : "Save \(Readout.weight(liftedKg)) to \(routine)" }
  func sentence(_ movement: String) -> String {
    "Today’s \(movement) ran at \(Readout.weight(liftedKg)) against a planned \(Readout.weight(plannedKg)). Today’s workout already has it. \(routine) does not."
  }
  static func leaving(_ id: ID<Exercise>, session: Session, sets: [TrainingSet], asked: [ID<Exercise>],
                      routine: Routine? = nil, againstCurrent: Bool = false) -> Self? {
    guard !asked.contains(id), let routineId = session.routineId, let plan = session.plan else { return nil }
    let source = againstCurrent ? routine.map(SessionPlan.init) ?? plan : plan
    let candidates = source.entries.enumerated().compactMap { index, entry -> (Int, [SetTarget], Double)? in
      guard entry.exerciseId == id, let scheme = entry.sets, let top = scheme.compactMap(\.weightKg).max() else { return nil }
      return (index, scheme, top)
    }
    guard let target = candidates.max(by: { $0.2 < $1.2 }) else { return nil }
    let working = sets.filter { $0.sessionId == session.id && $0.exerciseId == id }
      .sorted { $0.completedAt == $1.completedAt ? $0.id < $1.id : $0.completedAt < $1.completedAt }
    guard let liftedKg = working.map(\.weightKg).max(), liftedKg > target.2 else { return nil }
    if target.1.contains(where: { $0 != target.1.first }) && working.count > 20 { return nil }
    return Self(exerciseId: id, routineId: routineId, routine: source.routine, position: target.0,
                plannedKg: target.2, liftedKg: liftedKg, scheme: target.1,
                lifted: working.map { SetTarget(reps: $0.reps, weightKg: $0.weightKg) },
                revision: routine?.revision, offeredEntry: source.entries[target.0])
  }
  var json: JSON {
    .object(["exerciseId": exerciseId.json, "routineId": routineId.json, "routine": .string(routine),
             "position": JSON(position), "plannedKg": .of(plannedKg), "liftedKg": .of(liftedKg),
             "scheme": .array(scheme.map(\.json)), "lifted": .array(lifted.map(\.json)),
             "revision": revision.map(JSON.init) ?? .null, "offeredEntry": offeredEntry.json])
  }
}

extension WorkoutDeviation {
  nonisolated init(_ json: JSON) throws {
    let fields = try Fields(json), object = try json.asObject()
    self.init(exerciseId: try fields.ref("exerciseId", Exercise.self), routineId: try fields.ref("routineId", Routine.self),
              routine: try fields.string("routine"), position: try fields.int("position"),
              plannedKg: try fields.double("plannedKg"), liftedKg: try fields.double("liftedKg"),
              scheme: try fields.list("scheme", of: SetTarget.self), lifted: try fields.list("lifted", of: SetTarget.self),
              revision: try fields.optionalInt("revision"), offeredEntry: try RoutineEntry(Fields(object["offeredEntry"] ?? .null)))
  }
}

nonisolated struct WorkoutWalk: Equatable, Sendable {
  var order: [ID<Exercise>] = []
  var selected: ID<Exercise>?
  var asked: [ID<Exercise>] = []
  var pending: ID<Exercise>?
  var offer: WorkoutDeviation?
  var offerNotices: [String] = []
  var hidden = false
  static func key(_ session: ID<Session>) -> String { "rack:\(session.record)" }
  init() {}
  init(_ json: JSON?) throws {
    guard let json else { return }
    let object = try json.asObject()
    order = try object["order"]?.asArray().map { ID<Exercise>(RecordID(try $0.asString())) } ?? []
    asked = try object["asked"]?.asArray().map { ID<Exercise>(RecordID(try $0.asString())) } ?? []
    selected = try object["selected"].flatMap { $0.isNull ? nil : ID<Exercise>(RecordID(try $0.asString())) }
    pending = try object["pending"].flatMap { $0.isNull ? nil : ID<Exercise>(RecordID(try $0.asString())) }
    offer = try object["offer"].flatMap { $0.isNull ? nil : try WorkoutDeviation($0) }
    offerNotices = try object["offerNotices"]?.asArray().map { try $0.asString() } ?? []
    hidden = try object["hidden"]?.asBool() ?? false
  }
  var json: JSON {
    .object(["order": .array(order.map(\.json)), "selected": selected?.json ?? .null,
             "asked": .array(asked.map(\.json)), "pending": pending?.json ?? .null, "offer": offer?.json ?? .null,
             "offerNotices": .array(offerNotices.map(JSON.string)),
             "hidden": .bool(hidden)])
  }
  // Where a movement stands in the walk, while the walk holds more than one.
  func position(of id: ID<Exercise>?) -> (index: Int, count: Int)? {
    guard order.count > 1, let id, let index = order.firstIndex(of: id) else { return nil }
    return (index, order.count)
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

struct StartWorkoutCommand: ServerCommand {
  static let name = Gym.Commands.start
  static let specs: [any ValueSpec] = []
  let args: [String: JSON]
  init(id: ID<Session>, routineId: ID<Routine>?, at: Instant) {
    var args: [String: JSON] = ["id": id.json, "startedAt": .of(at), "joinOpenSession": false]
    if let routineId { args["routineId"] = routineId.json }; self.args = args
  }
}

struct SaveWorkoutDeviation: Action {
  let original: Routine
  let current: Routine
  let sessionId: ID<Session>
  let walk: WorkoutWalk
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws -> (Routine?, Session?, Moment) {
    (try read.repository(Routine.self).find(original.id, in: .drawn),
     try read.repository(Session.self).find(sessionId, in: .drawn), read.moment)
  }
  func decide(_ loaded: (Routine?, Session?, Moment), ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard loaded.1 != nil else { return .refuse(.gone(sessionId.ref, .predicted)) }
    guard loaded.0 == original else { return .refuse(.stale(original.id.ref, .predicted)) }
    var plan = Plan()
    if original.revision != nil { plan.guardRead(original.id, fields: ["revision"]) }
    plan.update(try Valid(current, at: loaded.2), fields: ["entries"], from: original, guarded: true)
    plan.device(WorkoutWalk.key(sessionId), walk.json)
    return .write(plan)
  }
}

struct StartWorkout: Action {
  let id: ID<Session>
  let routineId: ID<Routine>?
  var scope: ScopeRef { Gym.scope }
  typealias Loaded = (state: TrainingState, routine: Routine?, prior: Bool, replica: String, anonymous: Bool)
  func load(_ read: Reader) throws -> Loaded {
    let loaded = try StartSession(id: id, routineId: routineId).load(read)
    return (loaded.state, loaded.routine, loaded.prior, read.replica, read.isAnonymous)
  }
  func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<ID<Session>, GymRefusal> {
    if loaded.prior { return .unchanged(id) }
    if let routineId, loaded.routine == nil { return .refuse(.gone(routineId.ref, .predicted)) }
    if loaded.state.drawn.contains(where: { SessionRules.drawn($0, sets: loaded.state.sets, now: loaded.state.moment.now).isOpen }) {
      return .refuse(.sessionOpen(Refused(Gym.Codes.sessionOpen, subject: id.ref, path: .predicted)))
    }
    let at = loaded.state.moment.now, routine = loaded.routine
    let value = Session(id: id, startedAt: at, routineId: routine?.id, plan: routine.map(SessionPlan.init))
    var plan = try Plan(running: StartWorkoutCommand(id: id, routineId: routine?.id, at: at),
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
            !input.3.hidden, input.3.pending == nil, !input.4, input.3.selected?.description == offer.movementID,
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
    guard loaded.serverHeld, case .write = decision else { return decision }
    return .write(try Plan(running: FinishSessionCommand(id: id, finishedAt: loaded.training.moment.now)))
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
    set { editRack(weightKg: newValue, reps: reps) }
  }
  var reps: Int {
    get { rackReps }
    set { editRack(weightKg: weightKg, reps: newValue) }
  }
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

  init(gym: GymModel) { self.gym = gym; restore() }
  func restoreRack(weightKg: Double, reps: Int) {
    rackSave?.cancel(); rackSave = nil; rackBase = nil
    rackWeightKg = weightKg; rackReps = reps
    activityChanged()
  }
  func editRack(weightKg: Double, reps: Int) {
    guard weightKg != self.weightKg || reps != self.reps else { return }
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
        if canLog, walk.pending == nil, !rackEditing, !gym.workoutHidden,
           weightKg.isFinite, abs(weightKg) <= 500, (1...99).contains(reps),
           let session, offerSession == session, LogWorkoutSet.matchesOfferedSets(sets, offerSets), let selected {
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
  func ledger(_ id: ID<Exercise>) -> MovementLedger {
    MovementLedger(sets: sets.filter { $0.exerciseId == id }, plan: session?.plan?.entries.first { $0.exerciseId == id })
  }
  var deviation: WorkoutDeviation? {
    guard let id = walk.pending, let session else { return nil }
    if let offer = walk.offer, offer.exerciseId == id { return offer }
    return WorkoutDeviation.leaving(id, session: session, sets: sets, asked: walk.asked,
                                    routine: gym.routines.first { $0.id == session.routineId })
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
      finishQueued = true; gym.readFailed = true
      message = Self.orderUnread
      gym.error = "Gym could not be read from this phone. Try again."; gym.report("gym_read", error); return
    }
    if sessionId != open.id { drafts = [:]; receipt = nil; receiptOwed = false; handoff = nil }
    sessionId = open.id; (walk, finishQueued) = restored
    if message == Self.orderUnread { message = nil }
    walk.merge(session: open, sets: sets)
    if walk.pending != nil, walk.offer == nil, let offer = deviation {
      var next = walk; next.offer = offer; _ = keep(next)
    }
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
      gym.report("gym_read", error); finishQueued = true; gym.readFailed = true
      gym.error = "Gym could not be read from this phone. Try again."; return
    }
    if message == Self.orderUnread { message = nil }
    walk.merge(session: session, sets: sets)
    if walk.pending == nil, let offer = walk.offer {
      let stale = gym.notices.contains { notice in
        guard !walk.offerNotices.contains(notice.id), notice.subject == offer.routineId.ref,
              case .stale = notice.refusal else { return false }
        let fields = notice.values(of: offer.routineId.ref)
        guard let entries = try? fields["entries"]?.asArray(), entries.indices.contains(offer.position),
              let entry = try? RoutineEntry(Fields(entries[offer.position])) else { return false }
        var proposed = offer.offeredEntry; proposed.sets = offer.proposed
        return entry == proposed
      }
      if stale { rebuildDeviation(offer) }
      else if let routine = gym.routines.first(where: { $0.id == offer.routineId }),
              routine.entries.indices.contains(offer.position), routine.entries[offer.position].sets == offer.proposed,
              gym.isAnonymous || routine.revision != offer.revision {
        var next = walk; next.offer = nil; next.offerNotices = []; _ = keep(next)
      }
    }
    if previousSelected != selected { prefill(); restoreActivityDraft() }
    else if offerSession != session || !LogWorkoutSet.matchesOfferedSets(sets, offerSets) {
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
    restoreRack(weightKg: value.weightKg, reps: min(99, value.reps))
    offerSession = session; offerSets = sets
  }
  @discardableResult func keep(_ next: WorkoutWalk) -> Bool {
    guard !gym.readFailed, let sessionId, gym.run(KeepWorkoutWalk(sessionId: sessionId, walk: next))?.refusal == nil,
          gym.error == nil else { message = gym.error; return false }
    walk = next; activityChanged(); return true
  }
  func select(_ id: ID<Exercise>) {
    guard walk.order.contains(id), id != selected, !finishing, flushRack() else { return }
    if let pending = deviation {
      message = "\(gym.catalogue.find(pending.exerciseId)?.name ?? "That movement") first — that question is still open."; return
    }
    if let selected { drafts[selected] = Prefill(weightKg: weightKg, reps: reps) }
    var next = walk
    if let selected, let session,
       let offer = WorkoutDeviation.leaving(selected, session: session, sets: sets, asked: walk.asked,
                                            routine: gym.routines.first { $0.id == session.routineId }) {
      next.pending = selected; next.offer = offer; next.offerNotices = []
    }
    next.selected = id
    guard keep(next) else { return }
    prefill()
    if let draft = drafts[id] { restoreRack(weightKg: draft.weightKg, reps: draft.reps) }
  }
  func add(_ id: ID<Exercise>) {
    guard !walk.order.contains(id), gym.catalogue.find(id) != nil, !finishing, flushRack() else { return }
    if let pending = deviation {
      message = "\(gym.catalogue.find(pending.exerciseId)?.name ?? "That movement") first — that question is still open."; return
    }
    var next = walk; next.order.append(id)
    if let selected, let session,
       let offer = WorkoutDeviation.leaving(selected, session: session, sets: sets, asked: walk.asked,
                                            routine: gym.routines.first { $0.id == session.routineId }) {
      next.pending = selected; next.offer = offer; next.offerNotices = []
    }
    next.selected = id
    let prior = selected, draft = Prefill(weightKg: weightKg, reps: reps)
    guard keep(next) else { return }
    if let prior { drafts[prior] = draft }
    prefill()
  }
  func move(from: IndexSet, to: Int) {
    var next = walk; next.order.move(fromOffsets: from, toOffset: to); _ = keep(next)
  }
  func canRemove(_ id: ID<Exercise>) -> Bool {
    !sets.contains { $0.exerciseId == id } && session?.plan?.entries.contains { $0.exerciseId == id } != true
  }
  func remove(_ id: ID<Exercise>) {
    guard flushRack() else { return }
    guard canRemove(id) else { message = "A movement with sets or planned targets stays in this workout."; return }
    var next = walk; next.order.removeAll { $0 == id }
    if selected == id { next.selected = next.order.first }
    if keep(next) { prefill() }
  }
  @discardableResult func logSet(offered: WorkoutActivityOffer? = nil) -> Bool {
    guard flushRack() else { return false }
    guard canLog, let selected, let session else { message = "Check the weight and reps before logging."; return false }
    guard offerSession == session && LogWorkoutSet.matchesOfferedSets(sets, offerSets) else { message = "The workout changed. Check the current set."; prefill(); return false }
    guard weightKg.isFinite, abs(weightKg) <= 500, (1...99).contains(reps) else { message = "Check the weight and reps before logging."; return false }
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
  func resolveDeviation(save: Bool) {
    guard !gym.readFailed, let offer = deviation else { return }
    var next = walk; next.asked.append(offer.exerciseId); next.pending = nil
    if save {
      guard let routine = gym.routines.first(where: { $0.id == offer.routineId }),
            routine.revision == offer.revision, routine.entries.indices.contains(offer.position),
            routine.entries[offer.position] == offer.offeredEntry else {
        rebuildDeviation(offer); return
      }
      var changed = routine; changed.entries[offer.position].sets = offer.proposed
      next.offerNotices = gym.notices.map(\.id)
      guard let sessionId, let result = gym.run(SaveWorkoutDeviation(original: routine, current: changed, sessionId: sessionId, walk: next)) else { message = gym.error; return }
      if case .stale = result.refusal { rebuildDeviation(offer); return }
      guard result.refusal == nil else { message = gym.error; return }
      walk = next; message = nil
      gym.telemetry.event("gym_routine_saved", properties: ["screen": "workout", "action": "update"])
      return
    }
    next.offer = nil; next.offerNotices = []
    if keep(next) { message = nil }
  }
  func rebuildDeviation(_ offer: WorkoutDeviation) {
    guard let session else { return }
    var next = walk; next.asked.removeAll { $0 == offer.exerciseId }
    next.offerNotices = gym.notices.map(\.id)
    let routine = gym.routines.first { $0.id == offer.routineId }
    next.offer = routine.flatMap { WorkoutDeviation.leaving(offer.exerciseId, session: session, sets: sets,
                                                          asked: next.asked, routine: $0, againstCurrent: true) }
    next.pending = next.offer?.exerciseId
    if next.offer == nil { next.asked.append(offer.exerciseId) }
    if keep(next) {
      message = next.offer == nil
        ? "The routine changed. Today’s sets are saved; the current routine no longer needs that target change."
        : "The routine changed. Today’s sets are saved; review the new offer before changing its targets."
    }
  }

  static let orderUnread = "The workout is saved. Its movement order could not be read. Try again."

  // A set the log accepted a moment ago is confirmed by the next pull. Online, Finish gives that pull this long; a
  // server that answers nothing in time leaves the decision to what this phone holds.
  static let confirmationWait = Duration.seconds(3)

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
      _ = await Self.drain(timeout: Self.confirmationWait) { await self.flushAndConfirm(session.id, finished: false) }
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
      guard await drainForFinish(operation: { await self.flushAndConfirm(session.id, finished: true) }) else { return }
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
    receipt = WorkoutReceiptData(session: session, sets: sets, routineId: gym.runner.mint(Routine.self),
                                 routinePosition: (gym.routines.map(\.position).max() ?? -1) + 1)
    message = nil
    gym.telemetry.event("gym_session_finished", properties: ["screen": "workout", "outcome": "ok"])
  }
  func drainForFinish(timeout: Duration = .seconds(15), operation: @escaping @Sendable () async -> Void) async -> Bool {
    let account = gym.account, id = sessionId
    let completed = await Self.drain(timeout: timeout, operation: operation)
    if !completed && !Task.isCancelled && gym.account == account && sessionId == id && !gym.accountTransition {
      gym.telemetry.failure("gym_flush", kind: "timeout")
    }
    return completed
  }
  static func drain(timeout: Duration = .seconds(15), operation: @escaping @Sendable () async -> Void) async -> Bool {
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
    sessionId = nil; walk = WorkoutWalk(); drafts = [:]; offerSession = nil; offerSets = []
    restoreRack(weightKg: Prefill.emptyBarKg, reps: Prefill.emptyBarReps); paging = false
    receipt = nil; receiptOwed = false; handoff = nil; message = nil; finishQueued = false; restore()
  }
}

enum HiddenWorkoutDoor: String { case accessory, row }

enum WorkoutHandoff: Equatable {
  case detail(ID<Session>?)
  case coach
  case writtenProgram
  static let coachQuestion = "Check my last workout."
}

extension GymModel {
  private static let workoutStates = NSMapTable<AnyObject, WorkoutState>.weakToStrongObjects()
  var workout: WorkoutState {
    if let state = Self.workoutStates.object(forKey: self) { return state }
    let state = WorkoutState(gym: self); Self.workoutStates.setObject(state, forKey: self); return state
  }
  @discardableResult func startWorkout(routineId: ID<Routine>? = nil) -> ID<Session>? {
    guard !readFailed else { error = "Your routines could not be read. Try again."; return nil }
    if let routineId, !routines.contains(where: { $0.id == routineId }) {
      error = "That routine is no longer in your program. Everything you logged against it is still in the log."; return nil
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
