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

  // A straight scheme is one whose sets all agree, loads read on the ladder's grid; an open line is straight.
  public static func straight(_ sets: [SetTarget]) -> Bool {
    sets.allSatisfy { $0.reps == sets[0].reps && $0.weightKg.map(WeightLadder.round) == sets[0].weightKg.map(WeightLadder.round) }
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

  public init(routine: String, entries: [RoutineEntry]) {
    self.routine = routine
    self.entries = entries
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

public enum RoutineRules {
  public static let name = TextSpec("routine.name", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let position = NumberSpec("routine.position", min: 0, max: 2_147_483_647, integer: true)
  public static let entries = CountSpec("routine.entries", min: 1, max: 50)
  public static let targets = CountSpec("routine.entries.sets", min: 1, max: 20)
  public static let targetReps = NumberSpec("routine.entries.sets.reps", min: 1, max: 100, integer: true)
  public static let targetWeight = NumberSpec("routine.entries.sets.weightKg", quantum: 0.01)
  public static let rest = NumberSpec("routine.entries.restSeconds", min: 15, max: 900, integer: true)
  public static let exercise = TextSpec("routine.entries.exerciseId", unit: .chars, min: 1, max: 64, trim: false, nfc: false)
  public static let loadFloor = "routine.loadFloor"
  static let rules: [Rule] = [.local(name), .local(position), .local(entries), .local(targets), .local(targetReps),
                             .local(targetWeight), .local(rest), .local(exercise), .local("routine.zeroTarget", subject: Routine.type),
                             .local(loadFloor, subject: Routine.type)]

  // A target load meets its movement's floor wherever the save touches it: a line whose targets changed, or one whose
  // movement changed its loading. A line the save leaves alone keeps what it held.
  static func floored(_ routine: Routine, base: Routine, movements: [RoutineMovementChange], catalogue: Catalogue) throws(Violation) {
    for (index, entry) in routine.entries.enumerated() {
      let staged = movements.first { $0.current.id == entry.exerciseId }
      let retargeted = base.entries.first { $0.exerciseId == entry.exerciseId }?.sets != entry.sets
      let reloaded = staged.map { $0.base == nil || $0.base?.equipment != $0.current.equipment || $0.base?.loadCount != $0.current.loadCount } ?? false
      guard retargeted || reloaded, let movement = staged?.current ?? catalogue.find(entry.exerciseId) else { continue }
      try floored(entry.sets, of: movement, at: Path("entries") + index)
    }
  }

  // A proposal's change lines meet their movements' floors where they set new targets: an added line, or a retargeted line
  // whose sets changed. A kept line or a rest-only change keeps what it held; a movement the catalogue lacks has no floor here.
  public static func floored(_ changes: [RoutineChange], catalogue: Catalogue) throws(Violation) {
    for (index, change) in changes.enumerated() {
      let retargeted = change.kind == "added" || (change.kind == "retargeted" && change.before?.sets != change.after?.sets)
      guard retargeted, let movement = catalogue.find(change.exerciseId) else { continue }
      try floored(change.after?.sets, of: movement, at: Path("changes") + index + "after")
    }
  }

  // Every target load of one line, at `<line>.sets.<j>.weightKg`, meets its movement's floor.
  static func floored(_ sets: [SetTarget]?, of movement: Exercise, at line: Path) throws(Violation) {
    for (at, target) in (sets ?? []).enumerated() {
      guard let weightKg = target.weightKg else { continue }
      try movement.floored(weightKg, rule: loadFloor, at: line + "sets" + at + "weightKg")
    }
  }
}

public typealias SaveRoutine = SaveDraft<Routine, GymRefusal>
public typealias DeleteRoutine = Remove<Routine, GymRefusal>

public struct RoutineMovementChange: Equatable, Sendable {
  public let base: Exercise?
  public var current: Exercise

  public init(base: Exercise?, current: Exercise) {
    precondition(base == nil || base?.id == current.id)
    self.base = base
    self.current = current
  }

  public var isDirty: Bool {
    guard let base else { return true }
    return base.name != current.name || base.equipment != current.equipment || base.loadCount != current.loadCount
  }
}

public struct SaveRoutinePlan: Action {
  public struct Loaded: Sendable {
    let routine: Routine?
    let visible: Bool
    let catalogue: Catalogue
    let visibleExercises: Set<ID<Exercise>>
    let formerNames: JSON.Object
    let moment: Moment
  }

  public let base: Routine
  public let current: Routine
  public let isNew: Bool
  public let movements: [RoutineMovementChange]

  public init(base: Routine, current: Routine, isNew: Bool, movements: [RoutineMovementChange]) {
    precondition(base.id == current.id)
    self.base = base
    self.current = current
    self.isNew = isNew
    self.movements = movements
  }

  public var scope: ScopeRef { Routine.scope }

  public func load(_ read: Reader) throws -> Loaded {
    let repository = read.repository(Routine.self)
    return Loaded(routine: try repository.find(current.id, in: .stored),
                  visible: try repository.find(current.id, in: .drawn) != nil,
                  catalogue: try Catalogue(read, in: .stored),
                  visibleExercises: Set(try Catalogue(read).exercises.map(\.id)),
                  formerNames: try read.device(Catalogue.formerNamesKey)?.asObject() ?? JSON.Object(), moment: read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<ID<Routine>, GymRefusal> {
    if isNew && loaded.routine != nil {
      return .refuse(GymRefusal(Refused(.idTaken, subject: current.id.ref, path: .predicted)))
    }
    if !isNew && (!loaded.visible || loaded.routine == nil) {
      return .refuse(GymRefusal(Refused(.unknownRecord, subject: current.id.ref, path: .predicted)))
    }
    let touched = current.fields.keys.filter { isNew || current.fields[$0] != base.fields[$0] }.sorted()
    let valid = try Valid(current, fields: isNew ? Array(current.fields.keys) : touched, at: loaded.moment)
    try RoutineRules.floored(valid.value, base: base, movements: movements, catalogue: loaded.catalogue)
    let changed = touched.filter { loaded.routine?.fields[$0] != valid.value.fields[$0] }
    if !isNew && changed.contains(where: { loaded.routine?.fields[$0] != base.fields[$0] }) {
      return .refuse(GymRefusal(Refused(.stale, subject: current.id.ref, path: .predicted)))
    }
    var plan = Plan()
    if isNew { plan.create(valid) }
    else if !changed.isEmpty { plan.update(valid, fields: changed, from: base, guarded: true) }
    var wrote = isNew || !changed.isEmpty
    var former = loaded.formerNames
    let included = Set(current.entries.map(\.exerciseId))
    let edits = movements.filter { included.contains($0.current.id) }.sorted { $0.current.id < $1.current.id }
    precondition(Set(edits.map { $0.current.id }).count == edits.count)
    for edit in edits {
      let next = try Valid(edit.current, at: loaded.moment).value
      guard let before = edit.base else {
        if loaded.catalogue.find(next.id) != nil {
          return .refuse(GymRefusal(Refused(.idTaken, subject: next.id.ref, path: .predicted)))
        }
        try plan.createRoutineMovement(Valid(next, at: loaded.moment), at: loaded.moment)
        wrote = true
        continue
      }
      guard let stored = loaded.catalogue.find(next.id), loaded.visibleExercises.contains(next.id) else {
        return .refuse(GymRefusal(Refused(.unknownRecord, subject: next.id.ref, path: .predicted)))
      }
      let targetsChanged = current.entries.first { $0.exerciseId == next.id }?.sets != base.entries.first { $0.exerciseId == next.id }?.sets
      let unitsChanged = next.equipment != before.equipment || next.loadCount != before.loadCount
      let unitsSettled = next.equipment == stored.equipment && next.loadCount == stored.loadCount
      if (targetsChanged || unitsChanged) && !unitsSettled && (stored.equipment != before.equipment || stored.loadCount != before.loadCount) {
        return .refuse(GymRefusal(Refused(.stale, subject: next.id.ref, path: .predicted)))
      }
      if targetsChanged || unitsChanged {
        plan.guardRead(ID<ExerciseName>(next.id.record), fields: ["equipment", "loadCount"])
        if !SeedExercises.contains(next.id) { plan.guardRead(next.id, fields: ["equipment"]) }
      }
      let renamed = next.name != before.name && next.name != stored.name
      let equipped = next.equipment != before.equipment && next.equipment != stored.equipment
      let counted = next.loadCount != before.loadCount && next.loadCount != stored.loadCount
      if (renamed && stored.name != before.name) || (equipped && stored.equipment != before.equipment)
        || (counted && stored.loadCount != before.loadCount) {
        return .refuse(GymRefusal(Refused(.stale, subject: next.id.ref, path: .predicted)))
      }
      let seed = SeedExercises.contains(next.id)
      let metadata = ExerciseName(id: ID(next.id.record), name: seed && renamed ? next.name : nil,
                                  equipment: equipped ? next.equipment : nil,
                                  loadCount: Equipment(next.equipment) == .dumbbell && (equipped || counted) ? next.loadCount : nil)
      if renamed {
        former[next.id.record.description] = ["name": .string(next.name), "aliases": .array(ExerciseRules.renamedAliases(previous: stored.name, next: next.name, aliases: stored.aliases).map(JSON.string))]
        if !seed {
          var custom = stored
          custom.name = next.name
          plan.update(try Valid(custom, fields: ["name"], at: loaded.moment), from: stored, guarded: true)
        }
        wrote = true
      }
      let fields = Array(metadata.fields.keys).sorted()
      if !fields.isEmpty {
        plan.guardRead(metadata.id, fields: fields)
        plan.create(try Valid(metadata, fields: fields, at: loaded.moment), fields: fields)
        wrote = true
      }
    }
    if former != loaded.formerNames { plan.device(Catalogue.formerNamesKey, .object(former)) }
    return wrote ? .write(plan, current.id) : .unchanged(current.id)
  }
}

extension Plan {
  mutating func createRoutineMovement(_ value: Valid<Exercise>, at moment: Moment) throws(Violation) {
    create(value)
    let movement = value.value
    if Equipment(movement.equipment) == .dumbbell, movement.loadCount != 2 {
      create(try Valid(ExerciseName(id: ID(movement.id.record), name: nil, loadCount: movement.loadCount), at: moment), fields: ["loadCount"])
    }
  }
}

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
