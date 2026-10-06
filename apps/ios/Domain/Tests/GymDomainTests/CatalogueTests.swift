import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

struct CatalogueTests {
  @Test func formerNamesAreSearchableBeforeSyncAndAfterReopeningWithoutWritingServerAliases() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let id = phone.runner.mint(Exercise.self)
    #expect(try phone.runner.run(CreateExercise(Exercise(id: id, name: "Old press", pattern: "press", equipment: "barbell", stepKg: 2.5))).receipt != nil)
    #expect(try phone.runner.run(RenameExercise(id, name: "New press")).receipt != nil)
    #expect(try phone.runner.run(RenameExercise(id, name: "Latest press")).receipt != nil)
    let reopened = try phone.runner.read(Gym.scope) { try Catalogue($0) }
    #expect(reopened.find(id)?.aliases == ["New press", "Old press"])
    #expect(reopened.search("OLD PRESS").map(\.id) == [id])
    #expect(try phone.drawn(Exercise.self).first?.fields["aliases"] == nil)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(Catalogue.formerNamesKey) } ==
            .object([id.record.description: ["name": "Latest press", "aliases": ["New press", "Old press"]]]))
  }

  @Test func aRefusedRenameIgnoresItsDeviceOverlayAndACommitFailureKeepsFormerNames() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let id = ID<Exercise>("back-squat")
    #expect(try phone.runner.run(RenameExercise(id, name: "My squat")).receipt != nil)
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(id)?.aliases } == ["Back Squat"])
    phone.server.refuse(code: .invalid); phone.sync()
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(id) } == SeedExercises.all.first { $0.id == id })
    phone.failNextCommit()
    #expect(throws: (any Error).self) { try phone.runner.run(RenameExercise(id, name: "Another squat")) }
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(id) } == SeedExercises.all.first { $0.id == id })
  }
  @Test func catalogueEntitiesAgreeWithTheRegistryAndServerAliasesAreExcluded() throws {
    let sample = Exercise(id: ID("exercise1"), name: "Custom squat", pattern: "squat", equipment: "barbell", stepKg: 2.5, aliases: ["Old squat"])
    try RegistryCheck.entity(Exercise.self, sample: sample, book: GymRules.book, registry: SyncSchema.registry)
    try RegistryCheck.entity(ExerciseName.self, sample: ExerciseName(id: ID("back-squat"), name: "My squat", aliases: ["Back Squat"]),
                             book: GymRules.book, registry: SyncSchema.registry)
    #expect(sample.fields["aliases"] == nil)
    #expect(SeedExercises.all.count == 64 && Set(SeedExercises.all.map(\.id)).count == 64)
  }

  @Test func customCreationAndSeedRenameUseTheRunnerWithoutWritingAliases() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let custom = Exercise(id: phone.runner.mint(Exercise.self), name: " My squat ", pattern: "squat", equipment: "barbell", stepKg: 2.125)
    #expect(committed(try phone.runner.run(CreateExercise(custom))) == custom.id)
    #expect(try phone.drawn(Exercise.self).map(\.fields) == [["name": "My squat", "pattern": "squat", "equipment": "barbell", "stepKg": 2.13]])
    #expect(try phone.runner.run(RenameExercise(ID("back-squat"), name: "My back squat")).receipt != nil)
    #expect(try phone.runner.read(Exercise.scope) { try Catalogue($0).find(ID("back-squat"))?.name } == "My back squat")
    #expect(try phone.drawn(ExerciseName.self).map(\.fields) == [["name": "My back squat"]])
  }

  @Test(arguments: try Contract.vectors("gym/domain/catalogue-actions.json"))
  func vector(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let result: JSON
    if let action = vector.input["action"] {
      switch try action.asString() {
      case "CreateExercise":
        result = try corpus.decision(of: CreateExercise(Exercise(form: input.member("exercise"))), vector, result: \.json, refusal: \.form)
      case "RenameExercise":
        let id = ID<Exercise>(try RecordID(json: input.member("id")))
        result = try corpus.decision(of: RenameExercise(id, name: input.member("name").asString()), vector, result: { _ in .null }, refusal: \.form)
      case let name: throw ContractError("no catalogue action \(name)")
      }
    } else {
      do {
        result = try corpus.read(vector, in: Exercise.scope) { read in
          switch try vector.input.member("read").asString() {
          case "SeedExercises": return .array(SeedExercises.all.map(Self.form))
          case "Catalogue":
            let catalogue = try Catalogue(read)
            if let id = input["id"] { return .array(catalogue.find(ID(try RecordID(json: id))).map { [Self.form($0)] } ?? []) }
            return .array(catalogue.search(try input["query"]?.asString() ?? "").map(Self.form))
          case "RenamedAliases":
            return .array(try ExerciseRules.renamedAliases(previous: input.member("previous").asString(), next: input.member("next").asString(),
                                                         aliases: input.member("aliases").asArray().map { try $0.asString() }).map(JSON.string))
          case "DefaultStepKg":
            return .object(fields: Dictionary(uniqueKeysWithValues: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell"].map {
              ($0, .of(ExerciseRules.defaultStepKg(equipment: $0)))
            }))
          case let name: throw ContractError("no catalogue read \(name)")
          }
        }
      } catch let error as DecodeError {
        result = ["decodeError": ["type": .string(error.type), "field": .string(error.field), "reason": .string(error.reason)]]
      }
    }
    var wire = result
    // Former names are device-only; the shared vectors pin the synced gesture.
    if vector.input["action"] == "RenameExercise", case .object(var root) = wire,
       case .object(var decision)? = root["decision"], case .object(var write)? = decision["write"],
       case .object(var gesture)? = write["gesture"] {
      gesture["local"] = []; write["gesture"] = .object(gesture); decision["write"] = .object(write)
      root["decision"] = .object(decision); wire = .object(root)
    }
    #expect(wire == vector.expect, "\(vector)\n  got    \(wire.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  static func form(_ value: Exercise) -> JSON {
    ["id": value.id.json, "fields": .object(fields: value.fields), "aliases": .array(value.aliases.map(JSON.string))]
  }
}
