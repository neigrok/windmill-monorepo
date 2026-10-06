import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public typealias ExerciseAlias = String

public struct Exercise: Writable, Equatable {
  public static let type = Gym.Types.exercise
  public static let scope = Gym.scope

  public let id: ID<Exercise>
  public var name: String
  public var pattern: String
  public var equipment: String
  public var stepKg: Double
  public let aliases: [ExerciseAlias]

  public init(id: ID<Exercise>, name: String, pattern: String, equipment: String, stepKg: Double, aliases: [ExerciseAlias] = []) {
    self.id = id
    self.name = name
    self.pattern = pattern
    self.equipment = equipment
    self.stepKg = stepKg
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
    self.init(id: ID(fields.id), name: try fields.string("name"), pattern: try fields.string("pattern"),
              equipment: try fields.string("equipment"), stepKg: try fields.double("stepKg"),
              aliases: aliases)
  }

  public var fields: [String: JSON] {
    ["name": .string(name), "pattern": .string(pattern), "equipment": .string(equipment), "stepKg": .of(stepKg)]
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
  public let aliases: [ExerciseAlias]

  public init(id: ID<ExerciseName>, name: String?, aliases: [ExerciseAlias] = []) {
    self.id = id
    self.name = name
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
    self.init(id: ID(fields.id), name: try fields.optionalString("name"),
              aliases: aliases)
  }

  public var fields: [String: JSON] { ["name": .of(name)] }

  public static let checks: [Check<ExerciseName>] = [
    Check("name") { value, _ in value.name = try ExerciseRules.seedName.apply(value.name, at: "name") },
  ]
}

public typealias ExerciseRename = ExerciseName

public enum ExerciseRules {
  public static let name = TextSpec("exercise.name", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let seedName = TextSpec("exerciseName.name", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let pattern = ChoiceSpec("exercise.pattern", values: ["squat", "hinge", "press", "pull", "carry", "core", "isolation"])
  public static let equipment = ChoiceSpec("exercise.equipment", values: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell"])
  public static let stepKg = NumberSpec("exercise.stepKg", min: 0.01, max: 99.99, quantum: 0.01)
  static let rules: [Rule] = [.local(name), .local(seedName), .local(pattern), .local(equipment), .local(stepKg)]

  public static func defaultStepKg(equipment: String) -> Double {
    switch equipment {
    case "dumbbell": 2
    case "machine": 5
    case "kettlebell": 4
    default: 2.5
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
    let seeds = SeedExercises.all.map { seed in
      guard let named = names.first(where: { $0.id.record == seed.id.record }) else { return seed }
      return Exercise(id: seed.id, name: named.name ?? seed.name, pattern: seed.pattern, equipment: seed.equipment,
                      stepKg: seed.stepKg, aliases: named.aliases)
    }
    exercises = (seeds + custom).sorted {
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
                      stepKg: exercise.stepKg, aliases: merged)
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
    var plan = Plan()
    plan.create(try Valid(value, at: loaded))
    return .write(plan, value.id)
  }
}

public struct RenameExercise: Action {
  public typealias Loaded = (exercise: Exercise?, formerNames: JSON.Object, moment: Moment)
  public let id: ID<Exercise>
  public let name: String

  public init(_ id: ID<Exercise>, name: String) {
    self.id = id
    self.name = name
  }

  public var scope: ScopeRef { Exercise.scope }
  public func load(_ read: Reader) throws -> Loaded {
    (try Catalogue(read, in: .stored).find(id), try read.device(Catalogue.formerNamesKey)?.asObject() ?? JSON.Object(), read.moment)
  }

  public func decide(_ loaded: Loaded, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard var old = loaded.exercise else { return .refuse(GymRefusal(Refused(.unknownRecord, subject: id.ref, path: .predicted))) }
    let next = try ExerciseRules.name.apply(name, at: "name")
    if old.name.utf8.elementsEqual(next.utf8) { return .unchanged(()) }
    var plan = Plan()
    var former = loaded.formerNames
    former[id.record.description] = ["name": .string(next), "aliases": .array(ExerciseRules.renamedAliases(previous: old.name, next: next, aliases: old.aliases).map(JSON.string))]
    plan.device(Catalogue.formerNamesKey, .object(former))
    if SeedExercises.all.contains(where: { $0.id == id }) {
      plan.create(try Valid(ExerciseName(id: ID(id.record), name: next), at: loaded.moment))
    } else {
      old.name = next
      plan.update(try Valid(old, fields: ["name"], at: loaded.moment))
    }
    return .write(plan)
  }
}
