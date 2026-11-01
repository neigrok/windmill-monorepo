import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public typealias ExerciseAlias = String

// What a movement is lifted with; each case's raw value is the string an exercise record's `equipment` holds.
public enum Equipment: String, CaseIterable, Sendable {
  case barbell, dumbbell, machine, cable, bodyweight, kettlebell, other

  public init?(_ recorded: String?) {
    guard let recorded else { return nil }
    self.init(rawValue: recorded)
  }
}

public struct Exercise: Writable, Equatable {
  public static let type = Gym.Types.exercise
  public static let scope = Gym.scope

  public let id: ID<Exercise>
  public var name: String
  public var pattern: String
  public var equipment: String
  public let loadCount: Int
  public var stepKg: Double
  public let aliases: [ExerciseAlias]

  public init(id: ID<Exercise>, name: String, pattern: String, equipment: String, stepKg: Double, loadCount: Int? = nil, aliases: [ExerciseAlias] = []) {
    self.id = id
    self.name = name
    self.pattern = pattern
    self.equipment = equipment
    self.loadCount = Equipment(equipment) == .dumbbell ? loadCount ?? 2 : 1
    self.stepKg = stepKg
    self.aliases = aliases
  }

  public init(id: ID<Exercise>, name: String, pattern: String, equipment: Equipment, stepKg: Double, loadCount: Int? = nil, aliases: [ExerciseAlias] = []) {
    self.init(id: id, name: name, pattern: pattern, equipment: equipment.rawValue, stepKg: stepKg, loadCount: loadCount, aliases: aliases)
  }

  public init(_ fields: Fields) throws(DecodeError) {
    var aliases: [String] = []
    if let json = fields.json("aliases"), !json.isNull {
      guard case .array(let items) = json else { throw DecodeError(type: Self.type, field: "aliases", reason: "not an array") }
      for (index, item) in items.enumerated() {
        guard case .string(let text) = item else { throw DecodeError(type: Self.type, field: "aliases.\(index)", reason: "not a string") }
        aliases.append(text)
      }
    }
    self.init(id: ID(fields.id), name: try fields.string("name"), pattern: try fields.string("pattern"),
              equipment: try fields.string("equipment"), stepKg: try fields.double("stepKg"),
              aliases: aliases)
  }

  public var fields: [String: JSON] {
    ["name": .string(name), "pattern": .string(pattern), "equipment": .string(equipment), "stepKg": .of(stepKg)]
  }

  public var loadFloor: Double? { ExerciseRules.loadFloor(equipment: equipment, loadCount: loadCount) }

  public func floored(_ weightKg: Double, rule: String, at path: Path) throws(Violation) {
    guard let floor = loadFloor, weightKg < floor else { return }
    throw Violation(rule: rule, path: path, reason: .below(min: floor))
  }

  public static let checks: [Check<Exercise>] = [
    Check("name") { value, _ in value.name = try ExerciseRules.name.apply(value.name, at: "name") },
    Check("pattern") { value, _ in value.pattern = try ExerciseRules.pattern.apply(value.pattern, at: "pattern") },
    Check("equipment") { value, _ in value.equipment = try ExerciseRules.equipment.apply(value.equipment, at: "equipment") },
    Check("stepKg") { value, _ in value.stepKg = try ExerciseRules.stepKg.apply(value.stepKg, at: "stepKg") },
  ]
}

public struct ExerciseName: Writable, Equatable {
  public static let type = Gym.Types.exerciseName
  public static let scope = Gym.scope

  public let id: ID<ExerciseName>
  public var name: String?
  public var equipment: String?
  public var loadCount: Int?
  public let aliases: [ExerciseAlias]

  public init(id: ID<ExerciseName>, name: String?, equipment: String? = nil, loadCount: Int? = nil, aliases: [ExerciseAlias] = []) {
    self.id = id
    self.name = name
    self.equipment = equipment
    self.loadCount = loadCount
    self.aliases = aliases
  }

  public init(_ fields: Fields) throws(DecodeError) {
    var aliases: [String] = []
    if let json = fields.json("aliases"), !json.isNull {
      guard case .array(let items) = json else { throw DecodeError(type: Self.type, field: "aliases", reason: "not an array") }
      for (index, item) in items.enumerated() {
        guard case .string(let text) = item else { throw DecodeError(type: Self.type, field: "aliases.\(index)", reason: "not a string") }
        aliases.append(text)
      }
    }
    self.init(id: ID(fields.id), name: try fields.optionalString("name"), equipment: try fields.optionalString("equipment"),
              loadCount: try fields.optionalInt("loadCount"), aliases: aliases)
  }

  public var fields: [String: JSON] {
    ["name": name.map(JSON.string), "equipment": equipment.map(JSON.string), "loadCount": loadCount.map(JSON.init)].compactMapValues { $0 }
  }

  public static let checks: [Check<ExerciseName>] = [
    Check("name") { value, _ in value.name = try ExerciseRules.seedName.apply(value.name, at: "name") },
    Check("equipment") { value, _ in
      value.equipment = try ExerciseRules.seedEquipment.apply(value.equipment, at: "equipment")
    },
    Check("loadCount") { value, _ in
      if let count = value.loadCount { value.loadCount = Int(try ExerciseRules.loadCount.apply(Double(count), at: "loadCount")) }
    },
  ]
}

public enum ExerciseRules {
  public static let name = TextSpec("exercise.name", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let seedName = TextSpec("exerciseName.name", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let pattern = ChoiceSpec("exercise.pattern", values: ["squat", "hinge", "press", "pull", "carry", "core", "isolation"])
  public static let equipment = ChoiceSpec("exercise.equipment", values: Equipment.allCases.map(\.rawValue))
  public static let seedEquipment = ChoiceSpec("exerciseName.equipment", values: Equipment.allCases.map(\.rawValue))
  public static let loadCount = NumberSpec("exerciseName.loadCount", min: 1, max: 2, integer: true)
  public static let stepKg = NumberSpec("exercise.stepKg", min: 0.01, max: 99.99, quantum: 0.01)
  static let rules: [Rule] = [.local(name), .local(seedName), .local(pattern), .local(equipment), .local(seedEquipment), .local(loadCount), .local(stepKg)]

  public static func loadingChoice(equipment: String, loadCount: Int) -> String {
    switch Equipment(equipment) {
    case .barbell: Equipment.barbell.rawValue
    case .dumbbell where loadCount == 2: Equipment.dumbbell.rawValue
    case .dumbbell, .machine, .cable, .bodyweight, .kettlebell, .other, nil: Equipment.other.rawValue
    }
  }

  // A barbell or a pair of dumbbells carries 0 or more; every other loading keeps its sign, an assisted machine's included.
  public static func loadFloor(equipment: String, loadCount: Int) -> Double? {
    loadingChoice(equipment: equipment, loadCount: loadCount) == "other" ? nil : 0
  }

  public static func defaultStepKg(equipment: String) -> Double {
    switch Equipment(equipment) {
    case .dumbbell: 2
    case .machine: 5
    case .kettlebell: 4
    case .barbell, .cable, .bodyweight, .other, nil: 2.5
    }
  }

  public static func renamedAliases(previous: String, next: String, aliases: [String]) -> [String] {
    var result: [String] = []
    for alias in [previous] + aliases where !alias.utf8.elementsEqual(next.utf8) && !result.contains(where: { $0.utf8.elementsEqual(alias.utf8) }) {
      result.append(alias)
      if result.count == 5 { break }
    }
    return result
  }
}

public struct Catalogue: Equatable, Sendable {
  public static let formerNamesKey = "rack:catalogue"
  public let exercises: [Exercise]

  public init(exercises: [Exercise]) { self.exercises = exercises }

  public init(custom: [Exercise], names: [ExerciseName]) {
    let resolved = (SeedExercises.all + custom).map { exercise in
      guard let override = names.first(where: { $0.id.record == exercise.id.record }) else { return exercise }
      let seed = SeedExercises.contains(exercise.id)
      return Exercise(id: exercise.id, name: seed ? override.name ?? exercise.name : exercise.name,
                      pattern: exercise.pattern, equipment: override.equipment ?? exercise.equipment,
                      stepKg: exercise.stepKg, loadCount: override.loadCount ?? (Equipment(exercise.equipment) == .dumbbell ? exercise.loadCount : nil),
                      aliases: seed ? override.aliases : exercise.aliases)
    }
    exercises = resolved.sorted {
      if $0.name.utf8.elementsEqual($1.name.utf8) { return $0.id < $1.id }
      return $0.name.utf8.lexicographicallyPrecedes($1.name.utf8)
    }
  }

  public init(_ read: Reader, in view: ViewMode = .drawn) throws {
    self.init(custom: try read.repository(Exercise.self).all(in: view), names: try read.repository(ExerciseName.self).all(in: view))
    let former = try read.device(Self.formerNamesKey)?.asObject() ?? JSON.Object()
    self = Catalogue(exercises: try exercises.map { exercise in
      guard let value = former[exercise.id.record.description],
            try value.member("name").asString().utf8.elementsEqual(exercise.name.utf8) else { return exercise }
      let aliases = try value.member("aliases").asArray().map { try $0.asString() }
      let merged = ExerciseRules.renamedAliases(previous: exercise.name, next: exercise.name, aliases: aliases + exercise.aliases)
      return Exercise(id: exercise.id, name: exercise.name, pattern: exercise.pattern, equipment: exercise.equipment,
                      stepKg: exercise.stepKg, loadCount: exercise.loadCount, aliases: merged)
    })
  }

  public func find(_ id: ID<Exercise>) -> Exercise? { exercises.first { $0.id == id } }

  public func search(_ text: String) -> [Exercise] {
    let query = Array(text.lowercased().utf8)
    return exercises.filter { exercise in
      ([exercise.name] + exercise.aliases).contains { text in
        let bytes = Array(text.lowercased().utf8)
        if bytes.count < query.count { return false }
        return (0...(bytes.count - query.count)).contains { bytes[$0..<($0 + query.count)].elementsEqual(query) }
      }
    }
  }
}

public struct CreateExercise: Action {
  public let value: Exercise

  public init(_ value: Exercise) { self.value = value }
  public var scope: ScopeRef { Exercise.scope }
  public func load(_ read: Reader) -> Moment { read.moment }

  public func decide(_ loaded: Moment, ids: IDSource) throws(Violation) -> Decision<ID<Exercise>, GymRefusal> {
    let exercise = try Valid(value, at: loaded)
    var plan = Plan()
    plan.create(exercise)
    if Equipment(exercise.value.equipment) == .dumbbell, exercise.value.loadCount != 2 {
      plan.create(try Valid(ExerciseName(id: ID(value.id.record), name: nil, loadCount: exercise.value.loadCount), at: loaded), fields: ["loadCount"])
    }
    return .write(plan, value.id)
  }
}

public typealias RenameExercise = UpdateExercise

public struct UpdateExercise: Action {
  public typealias Loaded = (exercise: Exercise?, formerNames: JSON.Object, moment: Moment)
  public let id: ID<Exercise>
  public let name: String?
  public let equipment: String?
  public let loadCount: Int?

  public init(_ id: ID<Exercise>, name: String? = nil, equipment: String? = nil, loadCount: Int? = nil) {
    self.id = id
    self.name = name
    self.equipment = equipment
    self.loadCount = loadCount
  }

  public var scope: ScopeRef { Exercise.scope }
  public func load(_ read: Reader) throws -> Loaded {
    (try Catalogue(read, in: .stored).find(id), try read.device(Catalogue.formerNamesKey)?.asObject() ?? JSON.Object(), read.moment)
  }

  // Writes only what differs from the stored movement, so an edit on a stale phone never re-sends a field it left alone.
  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard var old = loaded.exercise else { return .refuse(GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted))) }
    var renamed: String?
    if let name {
      let next = try ExerciseRules.name.apply(name, at: "name")
      if !next.utf8.elementsEqual(old.name.utf8) { renamed = next }
    }
    var equipped: String?
    if let equipment {
      let next = try ExerciseRules.equipment.apply(equipment, at: "equipment")
      if next != old.equipment { equipped = next }
    }
    var counted: Int?
    if let loadCount, Equipment(equipped ?? old.equipment) == .dumbbell, equipped != nil || loadCount != old.loadCount { counted = loadCount }
    let seed = SeedExercises.contains(id)
    let metadata = ExerciseName(id: ID(id.record), name: seed ? renamed : nil, equipment: equipped, loadCount: counted)
    if renamed == nil && metadata.fields.isEmpty { return .unchanged(()) }
    var plan = Plan()
    if let renamed {
      var former = loaded.formerNames
      former[id.record.description] = ["name": .string(renamed), "aliases": .array(ExerciseRules.renamedAliases(previous: old.name, next: renamed, aliases: old.aliases).map(JSON.string))]
      plan.device(Catalogue.formerNamesKey, .object(former))
      if !seed {
        old.name = renamed
        plan.update(try Valid(old, fields: ["name"], at: loaded.moment))
      }
    }
    let changed = Array(metadata.fields.keys)
    if !changed.isEmpty { plan.create(try Valid(metadata, fields: changed, at: loaded.moment), fields: changed) }
    return .write(plan)
  }
}

public struct EditExercise: Action {
  public typealias Loaded = (exercise: Exercise?, visible: Bool, formerNames: JSON.Object, moment: Moment)
  public let base: Exercise
  public let name: String
  public let equipment: String
  public let loadCount: Int
  public var id: ID<Exercise> { base.id }

  public init(base: Exercise, name: String, equipment: String, loadCount: Int) {
    self.base = base
    self.name = name
    self.equipment = equipment
    self.loadCount = loadCount
  }

  public var scope: ScopeRef { Exercise.scope }
  public func load(_ read: Reader) throws -> Loaded {
    (try Catalogue(read, in: .stored).find(id), try Catalogue(read).find(id) != nil,
     try read.device(Catalogue.formerNamesKey)?.asObject() ?? JSON.Object(), read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Exercise, GymRefusal> {
    guard let old = loaded.exercise, loaded.visible else {
      return .refuse(GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted)))
    }
    let nextName = try ExerciseRules.name.apply(name, at: "name")
    let nextEquipment = try ExerciseRules.equipment.apply(equipment, at: "equipment")
    let nextCount = Equipment(nextEquipment) == .dumbbell ? Int(try ExerciseRules.loadCount.apply(Double(loadCount), at: "loadCount")) : 1
    let renamed = !nextName.utf8.elementsEqual(base.name.utf8) && !nextName.utf8.elementsEqual(old.name.utf8)
    let unitsChanged = nextEquipment != base.equipment || nextCount != base.loadCount
    let unitsSettled = nextEquipment == old.equipment && nextCount == old.loadCount
    if (renamed && !old.name.utf8.elementsEqual(base.name.utf8)) ||
        (unitsChanged && !unitsSettled && (old.equipment != base.equipment || old.loadCount != base.loadCount)) {
      return .refuse(GymRefusal(Refused(.stale, subject: id.ref, path: .predicted)))
    }
    let equipped = unitsChanged && nextEquipment != old.equipment
    let counted = unitsChanged && Equipment(nextEquipment) == .dumbbell && (equipped || nextCount != old.loadCount)
    if !renamed && !equipped && !counted { return .unchanged(old) }
    let seed = SeedExercises.contains(id)
    let metadata = ExerciseName(id: ID(id.record), name: seed && renamed ? nextName : nil,
                               equipment: equipped ? nextEquipment : nil, loadCount: counted ? nextCount : nil)
    var plan = Plan()
    if unitsChanged { plan.guardRead(metadata.id, fields: ["equipment", "loadCount"]) }
    let aliases = renamed ? ExerciseRules.renamedAliases(previous: old.name, next: nextName, aliases: old.aliases + base.aliases) : old.aliases
    if renamed {
      if !seed {
        var value = old
        value.name = nextName
        plan.update(try Valid(value, fields: ["name"], at: loaded.moment), from: old, guarded: true)
      }
      var former = loaded.formerNames
      former[id.record.description] = ["name": .string(nextName), "aliases": .array(
        aliases.map(JSON.string))]
      plan.device(Catalogue.formerNamesKey, .object(former))
    }
    let fields = metadata.fields.keys.sorted()
    if !fields.isEmpty {
      plan.guardRead(metadata.id, fields: fields)
      plan.create(try Valid(metadata, fields: fields, at: loaded.moment), fields: fields)
    }
    return .write(plan, Exercise(id: old.id, name: renamed ? nextName : old.name, pattern: old.pattern,
      equipment: unitsChanged ? nextEquipment : old.equipment, stepKg: old.stepKg,
      loadCount: unitsChanged ? nextCount : old.loadCount, aliases: aliases))
  }
}
