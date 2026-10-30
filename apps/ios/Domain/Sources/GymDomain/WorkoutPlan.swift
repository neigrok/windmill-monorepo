import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

// The open workout as an edit of its plan finds it: the session as stored and whether it is in sight, its sets, the
// movements a set alive in either view locks (a set the lifter just deleted locks its movement until the delete lands),
// the catalogue that names movements, and the moment.
public struct OpenWorkout: Sendable {
  public let id: ID<Session>
  public let session: Session?
  public let visible: Bool
  public let sets: [TrainingSet]
  public let logged: Set<ID<Exercise>>
  public let catalogue: Catalogue
  public let moment: Moment

  public init(_ read: Reader, id: ID<Session>) throws {
    let sessions = read.repository(Session.self), sets = read.repository(TrainingSet.self)
    let stored = try sets.all(in: .stored).filter { $0.sessionId == id }
    self.id = id
    session = try sessions.find(id, in: .stored)
    visible = try sessions.find(id, in: .drawn) != nil
    self.sets = stored
    logged = Set((try sets.all(in: .drawn).filter { $0.sessionId == id } + stored).map(\.exerciseId))
    catalogue = try Catalogue(read)
    self.moment = read.moment
  }

  // Closed by its finish, or drawn closed by the stale rule four hours past its last set.
  public var isClosed: Bool {
    guard let session else { return false }
    return !SessionRules.drawn(session, sets: sets, now: moment.now).isOpen
  }

  // The plan an edit may change, or what refuses the edit: a workout out of sight is gone, a closed one is finished
  // (refused about `subject`), and one started with no plan has none to change.
  public func plan(refusing subject: RecordRef) throws(GymRefusal) -> WorkoutPlan {
    guard let session, visible else { throw GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted)) }
    if isClosed { throw GymRefusal(Refused(Gym.Codes.sessionFinished, subject: subject, path: .predicted)) }
    do throws(Violation) {
      return WorkoutPlan(session: id, plan: try WorkoutPlanRules.plan(of: session), logged: logged)
    } catch {
      throw GymRefusal(error)
    }
  }
}

// An open workout's plan with the movements its logged sets lock. A locked movement keeps its entry exactly as it
// stands; every other entry takes operations, and new movements join at the end.
public struct WorkoutPlan: Equatable, Sendable {
  public enum Operation: Equatable, Sendable {
    case retarget(index: Int, set: Int, target: SetTarget)
    case addSet(index: Int)
    case removeSet(index: Int, set: Int)
    case swap(index: Int, exerciseId: ID<Exercise>)
    case addMovement(ID<Exercise>)
    case removeMovement(index: Int)
    case setRest(index: Int, restSeconds: Int?)

    var entry: Int? {
      switch self {
      case .retarget(let index, _, _), .addSet(let index), .removeSet(let index, _), .swap(let index, _), .removeMovement(let index),
           .setRest(let index, _): index
      case .addMovement: nil
      }
    }

    var plannedSet: Int? {
      switch self {
      case .retarget(_, let set, _), .removeSet(_, let set): set
      default: nil
      }
    }

    var movement: ID<Exercise>? {
      switch self {
      case .swap(_, let exerciseId), .addMovement(let exerciseId): exerciseId
      default: nil
      }
    }
  }

  public let session: ID<Session>
  public let plan: SessionPlan
  public let logged: Set<ID<Exercise>>

  public init(session: ID<Session>, plan: SessionPlan, logged: Set<ID<Exercise>>) {
    self.session = session
    self.plan = plan
    self.logged = logged
  }

  public func isLocked(_ entry: RoutineEntry) -> Bool { logged.contains(entry.exerciseId) }

  // The plan the operations make, applied in order; any one refused refuses them all. An entry an operation wrote is
  // validated as a routine entry at its place in the result; an untouched one stands as stored.
  public func revised(by operations: [Operation], catalogue: Catalogue) throws(GymRefusal) -> SessionPlan {
    var entries = plan.entries.map { (entry: $0, written: false) }
    for (k, operation) in operations.enumerated() {
      let at = Path("operations") + k
      if let index = operation.entry {
        let outOfRange = GymRefusal(Violation(rule: WorkoutPlanRules.operation, path: at, reason: .custom("outOfRange")))
        guard entries.indices.contains(index) else { throw outOfRange }
        if let set = operation.plannedSet, !(entries[index].entry.sets ?? []).indices.contains(set) { throw outOfRange }
        if isLocked(entries[index].entry) { throw lockedBy(entries[index].entry.exerciseId) }
      }
      if let movement = operation.movement {
        guard catalogue.find(movement) != nil else { throw GymRefusal(Refused(Gym.Codes.unknownExercise, subject: session.ref, path: .predicted)) }
        if entries.contains(where: { $0.entry.exerciseId == movement }) {
          throw GymRefusal(Violation(rule: WorkoutPlanRules.duplicate, path: at + "exerciseId", reason: .custom("duplicate")))
        }
        if logged.contains(movement) { throw lockedBy(movement) }
      }
      switch operation {
      case .retarget(let index, let set, let target):
        entries[index].entry.sets?[set] = target
        entries[index].written = true
      case .addSet(let index):
        let sets = entries[index].entry.sets ?? []
        entries[index].entry.sets = sets + [sets.last ?? SetTarget()]
        entries[index].written = true
      case .removeSet(let index, let set):
        entries[index].entry.sets?.remove(at: set)
        if entries[index].entry.sets?.isEmpty == true { entries[index].entry.sets = nil }
        entries[index].written = true
      case .swap(let index, let exerciseId):
        let unit = { (id: ID<Exercise>) in catalogue.find(id).map { Readout.loadUnit(equipment: $0.equipment, loadCount: $0.loadCount) } }
        let from = entries[index].entry
        let loads = unit(from.exerciseId) == unit(exerciseId)
        entries[index].entry = RoutineEntry(exerciseId: exerciseId, sets: loads ? from.sets : from.sets?.map { SetTarget(reps: $0.reps) },
                                            restSeconds: from.restSeconds)
        entries[index].written = true
      case .addMovement(let exerciseId):
        entries.append((entry: RoutineEntry(exerciseId: exerciseId), written: true))
      case .removeMovement(let index):
        entries.remove(at: index)
      case .setRest(let index, let restSeconds):
        entries[index].entry.restSeconds = restSeconds
        entries[index].written = true
      }
    }
    var revised: [RoutineEntry] = []
    for (index, line) in entries.enumerated() {
      do throws(Violation) {
        revised.append(line.written ? try line.entry.validated(at: Path("plan.entries") + index) : line.entry)
      } catch {
        throw GymRefusal(error)
      }
    }
    return SessionPlan(routine: plan.routine, entries: revised)
  }

  // The first movement with a logged set whose entries `entries` would change, in the order the plan and then `entries`
  // name movements: a logged movement may move, but its entries stay exactly as they stand.
  public func loggedChange(to entries: [RoutineEntry]) -> ID<Exercise>? {
    let movements = (plan.entries + entries).map(\.exerciseId)
    return movements.first { movement in
      logged.contains(movement) && plan.entries.filter { $0.exerciseId == movement } != entries.filter { $0.exerciseId == movement }
    }
  }

  func lockedBy(_ movement: ID<Exercise>) -> GymRefusal {
    GymRefusal(Refused(Gym.Codes.planLogged, subject: session.ref, detail: ["exerciseId": movement.json], path: .predicted))
  }
}

public enum WorkoutPlanRules {
  public static let maxEntries = 50
  public static let entries = CountSpec("session.plan.entries", min: 0, max: maxEntries)
  public static let absent = "session.plan.absent"
  public static let duplicate = "session.plan.duplicate"
  public static let operation = "session.plan.operation"
  static let rules: [Rule] = [
    .local(entries), .local(absent, subject: Session.type), .local(duplicate, subject: Session.type), .local(operation, subject: Session.type),
    .serverDecided("session.plan.exercise", codes: [Gym.Codes.unknownExercise], subject: Session.type),
    .serverDecided("session.plan.logged", codes: [Gym.Codes.planLogged], subject: Session.type),
    .serverDecided("session.finished", codes: [Gym.Codes.sessionFinished], subject: Session.type),
    .serverDecided("session.stale", codes: [.stale], subject: Session.type),
  ]

  // A session's plan as a write of it must hold one: present, and at most fifty movements.
  public static func plan(of session: Session) throws(Violation) -> SessionPlan {
    guard let plan = session.plan else { throw Violation(rule: absent, path: "plan", reason: .custom("absent")) }
    if plan.entries.count > maxEntries { throw Violation(rule: entries.path, path: "plan.entries", reason: .tooMany(max: maxEntries)) }
    return plan
  }
}

// One edit of the open workout's plan: its operations against the plan the editor read, as one guarded write of the
// whole plan, or nothing when the plan stands.
public struct ReviseWorkoutPlan: Action {
  public let sessionId: ID<Session>
  public let base: SessionPlan?
  public let operations: [WorkoutPlan.Operation]
  public var scope: ScopeRef { Session.scope }

  public init(sessionId: ID<Session>, base: SessionPlan?, operations: [WorkoutPlan.Operation]) {
    self.sessionId = sessionId
    self.base = base
    self.operations = operations
  }

  public func load(_ read: Reader) throws -> OpenWorkout { try OpenWorkout(read, id: sessionId) }

  public func decide(_ loaded: OpenWorkout, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    let revised: SessionPlan
    do throws(GymRefusal) {
      let workout = try loaded.plan(refusing: sessionId.ref)
      guard workout.plan == base else { return .refuse(GymRefusal(Refused(.stale, subject: sessionId.ref, path: .predicted))) }
      revised = try workout.revised(by: operations, catalogue: loaded.catalogue)
      if revised == workout.plan { return .unchanged(()) }
    } catch {
      return .refuse(error)
    }
    guard var session = loaded.session else { preconditionFailure("an open workout's plan has its session") }
    session.plan = revised
    var plan = Plan()
    plan.update(try Valid(session, fields: ["plan"], at: loaded.moment), fields: ["plan"], guarded: true)
    return .write(plan)
  }
}

// The receipt's card for a workout whose plan the lifter changed: the plan's diff against its routine as drawn, counted
// as R118 counts a proposal without its name, and whether the change can be saved to the routine — only while the
// routine stands at the revision the workout started from. No card for a plan that matches, or has no routine.
public struct PlanChanges: Equatable, Sendable {
  public enum Offer: String, Sendable { case save, routineChanged, none }

  public let changes: [RoutineChange]
  public let changeCount: Int
  public let offer: Offer

  public init(session: Session?, routine: Routine?) {
    guard let session, let plan = session.plan, let routine, plan.entries != routine.entries else {
      changes = []; changeCount = 0; offer = .none; return
    }
    changes = RoutineChange.lines(from: routine.entries, to: plan.entries)
    changeCount = RoutineChange.count(changes, against: routine.entries)
    offer = routine.revision != nil && routine.revision == session.routineRevision ? .save : .routineChanged
  }

  public init(_ read: Reader, session id: ID<Session>) throws {
    let session = try read.repository(Session.self).find(id, in: .drawn)
    self.init(session: session, routine: try session?.routineId.flatMap { try read.repository(Routine.self).find($0, in: .drawn) })
  }
}
