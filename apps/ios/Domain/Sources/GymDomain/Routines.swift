import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct SetTarget: ValueObject, Equatable {
  public var reps: Int?
  public var weightKg: Double?

  public init(reps: Int? = nil, weightKg: Double? = nil) {
    self.reps = reps
    self.weightKg = weightKg
  }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(reps: try fields.optionalInt("reps"), weightKg: try fields.optionalDouble("weightKg"))
  }

  public var json: JSON {
    .object(omittingNil: ["reps": reps.map(JSON.init), "weightKg": weightKg.map { .of($0) }])
  }

  public func validated(at path: Path) throws(Violation) -> SetTarget {
    if reps == 0 { throw Violation(rule: "routine.zeroTarget", path: path + "reps", reason: .custom("zeroTarget")) }
    let checkedReps = try RoutineRules.targetReps.apply(reps, at: path + "reps")
    let roundedWeight = try RoutineRules.targetWeight.apply(weightKg, at: path + "weightKg")
    if roundedWeight == 0 && weightKg != 0 { throw Violation(rule: "routine.zeroTarget", path: path + "weightKg", reason: .custom("zeroTarget")) }
    return SetTarget(reps: checkedReps, weightKg: roundedWeight)
  }
}

public struct RoutineEntry: ValueObject, Equatable {
  public var exerciseId: ID<Exercise>
  public var sets: [SetTarget]?
  public var restSeconds: Int?

  public init(exerciseId: ID<Exercise>, sets: [SetTarget]? = nil, restSeconds: Int? = nil) {
    self.exerciseId = exerciseId
    self.sets = sets
    self.restSeconds = restSeconds
  }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(exerciseId: try fields.ref("exerciseId", Exercise.self), sets: try fields.optionalList("sets", of: SetTarget.self),
              restSeconds: try fields.optionalInt("restSeconds"))
  }

  public var json: JSON {
    .object(omittingNil: ["exerciseId": exerciseId.json, "sets": sets.map { .array($0.map(\.json)) },
                         "restSeconds": restSeconds.map(JSON.init)])
  }

  public var isOpen: Bool { sets == nil }

  public func validated(at path: Path) throws(Violation) -> RoutineEntry {
    _ = try RoutineRules.exercise.apply(exerciseId.record.string ?? "", at: path + "exerciseId")
    return RoutineEntry(exerciseId: exerciseId, sets: try RoutineRules.targets.apply(sets, at: path + "sets"),
                        restSeconds: try RoutineRules.rest.apply(restSeconds, at: path + "restSeconds"))
  }
}

public struct Routine: Draftable, Removable, Equatable {
  public static let type = Gym.Types.routine
  public static let scope = Gym.scope
  public static let savesGuarded = true
  public static let heldRemoval = true

  public let id: ID<Routine>
  public var name: String
  public var position: Int
  public var entries: [RoutineEntry]
  public let revision: Int?
  public let createdEntries: Int?
  public let createdDoor: String?

  public init(id: ID<Routine>, name: String = "", position: Int = 0, entries: [RoutineEntry] = [],
              revision: Int? = nil, createdEntries: Int? = nil, createdDoor: String? = nil) {
    self.id = id
    self.name = name
    self.position = position
    self.entries = entries
    self.revision = revision
    self.createdEntries = createdEntries
    self.createdDoor = createdDoor
  }

  public init(_ fields: Fields) throws(DecodeError) {
    self.init(id: ID(fields.id), name: try fields.string("name"), position: try fields.optionalInt("position") ?? 0,
              entries: try fields.list("entries", of: RoutineEntry.self), revision: try fields.optionalInt("revision"),
              createdEntries: try fields.optionalInt("createdEntries"), createdDoor: try fields.optionalString("createdDoor"))
  }

  public var fields: [String: JSON] {
    ["name": .string(name), "position": JSON(position), "entries": .array(entries.map(\.json))]
  }

  public static let checks: [Check<Routine>] = [
    Check("name") { value, _ in value.name = try RoutineRules.name.apply(value.name, at: "name") },
    Check("position") { value, _ in value.position = try RoutineRules.position.apply(value.position, at: "position") },
    Check("entries") { value, _ in value.entries = try RoutineRules.entries.apply(value.entries, at: "entries") },
  ]

  public static func ordered(_ routines: [Routine]) -> [Routine] {
    routines.sorted { $0.position == $1.position ? $0.id < $1.id : $0.position < $1.position }
  }
}

public typealias PlannedExercise = RoutineEntry

public struct SessionPlan: Equatable, Sendable {
  public let routine: String
  public let entries: [RoutineEntry]
  public var exercises: [PlannedExercise] { entries }

  public init(routine: String, entries: [RoutineEntry]) {
    self.routine = routine
    self.entries = entries
  }

  public init(routine: String, exercises: [PlannedExercise]) {
    self.init(routine: routine, entries: exercises)
  }

  public init(_ routine: Routine) {
    self.init(routine: routine.name, entries: routine.entries)
  }

  public var json: JSON { ["routine": .string(routine), "entries": .array(entries.map(\.json))] }

  public static func decode(_ json: JSON?) throws(DecodeError) -> SessionPlan? {
    guard let json, !json.isNull else { return nil }
    let fields = try Fields(json)
    return SessionPlan(routine: try fields.string("routine", default: ""),
                       entries: try fields.optionalList("entries", of: RoutineEntry.self) ?? [])
  }
}

public typealias PlanSnapshot = SessionPlan

public enum RoutineRules {
  public static let name = TextSpec("routine.name", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let position = NumberSpec("routine.position", min: 0, max: 2_147_483_647, integer: true)
  public static let entries = CountSpec("routine.entries", min: 1, max: 50)
  public static let targets = CountSpec("routine.entries.sets", min: 1, max: 20)
  public static let targetReps = NumberSpec("routine.entries.sets.reps", min: 1, max: 100, integer: true)
  public static let targetWeight = NumberSpec("routine.entries.sets.weightKg", min: -500, max: 500, quantum: 0.01)
  public static let rest = NumberSpec("routine.entries.restSeconds", min: 15, max: 900, integer: true)
  public static let exercise = TextSpec("routine.entries.exerciseId", unit: .chars, min: 1, max: 64, trim: false, nfc: false)
  static let rules: [Rule] = [.local(name), .local(position), .local(entries), .local(targets), .local(targetReps),
                             .local(targetWeight), .local(rest), .local(exercise), .local("routine.zeroTarget", subject: Routine.type)]
}

public typealias SaveRoutine = SaveDraft<Routine, GymRefusal>
public typealias DeleteRoutine = Remove<Routine, GymRefusal>

public struct ReorderRoutines: Action {
  public typealias Loaded = (routines: [Routine], moment: Moment)
  public let order: [ID<Routine>]

  public init(_ order: [ID<Routine>]) { self.order = order }
  public var scope: ScopeRef { Routine.scope }

  public func load(_ read: Reader) throws -> Loaded {
    (try read.repository(Routine.self).all(in: .stored), read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    if Set(order).count != order.count || Set(order) != Set(loaded.routines.map(\.id)) {
      throw Violation(rule: "routine.order", path: "order", reason: .custom("notPermutation"))
    }
    var plan = Plan()
    var changed = false
    for (position, id) in order.enumerated() {
      guard var routine = loaded.routines.first(where: { $0.id == id }) else { preconditionFailure("a reorder names every routine") }
      if routine.position == position { continue }
      routine.position = position
      plan.update(try Valid(routine, fields: ["position"], at: loaded.moment))
      changed = true
    }
    return changed ? .write(plan) : .unchanged(())
  }
}
