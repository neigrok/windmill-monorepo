import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import Testing

struct CatalogueTests {
  @Test func standaloneEditKeepsNameLoadingAndAliasesAtomicAcrossStorageFailureAndAStaleRace() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), rules: GymServerRules())
    let other = phone.device()
    let base = Exercise(id: phone.runner.mint(Exercise.self), name: "Press", pattern: "press", equipment: "barbell", stepKg: 2.5)
    #expect(try phone.runner.run(CreateExercise(base)).receipt != nil)
    phone.sync()
    let edit = EditExercise(base: base, name: "First", equipment: "dumbbell", loadCount: 1)
    phone.failNextCommit()
    #expect(throws: (any Error).self) { try phone.runner.run(edit) }
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(base.id) } == base)
    #expect(try phone.runner.read(Gym.scope) { try $0.device(Catalogue.formerNamesKey) } == nil)
    #expect(try phone.runner.run(edit).receipt != nil)
    #expect(try other.runner.run(EditExercise(base: base, name: "Second", equipment: "dumbbell", loadCount: 2)).receipt != nil)
    phone.sync()
    let expected = Exercise(id: base.id, name: "First", pattern: "press", equipment: "dumbbell", stepKg: 2.5, loadCount: 1, aliases: ["Press"])
    for device in [phone, other] {
      #expect(try device.runner.read(Gym.scope) { try Catalogue($0).find(base.id) } == expected)
      #expect(try device.drawn(ExerciseName.self).map(\.fields) == [["equipment": "dumbbell", "loadCount": 1]])
    }
    #expect(try other.notices(GymRefusal.self).map(\.notice.code) == [.stale])
  }

  @Test func exerciseMetadataKeepsIdsAndRawHistoryWhileChangingDerivedVolume() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: nil)
    let id = phone.runner.mint(Exercise.self)
    #expect(try phone.runner.run(CreateExercise(Exercise(id: id, name: "Custom press", pattern: "press", equipment: "barbell", stepKg: 2.5))).receipt != nil)
    let session = phone.runner.mint(Session.self)
    #expect(try phone.runner.run(StartSession(id: session)).receipt != nil)
    let set = TrainingSet(id: phone.runner.mint(TrainingSet.self), sessionId: session, exerciseId: id, weightKg: 16, reps: 10, completedAt: Instant(ms: 1_800_000_000_001))
    #expect(try phone.runner.run(AppendSet(set)).receipt != nil)
    #expect(try phone.runner.run(UpdateExercise(id, name: "Dumbbell press", equipment: "dumbbell", loadCount: 2)).receipt != nil)
    let log = try phone.runner.read(Gym.scope) { try TrainingLog($0) }
    #expect(log.catalogue.find(id)?.name == "Dumbbell press")
    #expect(log.catalogue.find(id)?.equipment == "dumbbell" && log.catalogue.find(id)?.loadCount == 2)
    #expect(log.sets == [set] && log.volumeKg(session: session) == 320)
    #expect(try phone.drawn(Exercise.self).first?.equipment == "barbell")
    #expect(try phone.runner.run(UpdateExercise(id, name: "Single press", loadCount: 1)).receipt != nil)
    #expect(try phone.runner.read(Gym.scope) { try TrainingLog($0).volumeKg(session: session) } == 160)
    #expect(try phone.runner.run(RenameExercise(id, name: "My press")).receipt != nil)
    #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(id)?.loadCount } == 1)
  }

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
    try RegistryCheck.entity(ExerciseName.self, sample: ExerciseName(id: ID("back-squat"), name: "My squat", equipment: "dumbbell", loadCount: 2, aliases: ["Back Squat"]),
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

  @Test func anEditWritesOnlyTheMetadataItChangedAndTheMovementResolvesToIt() throws {
    let edits: [(UpdateExercise, written: [[String: JSON]], resolved: [String])] = [
      (UpdateExercise(ID("back-squat"), name: "Back Squat", equipment: "dumbbell", loadCount: 1), [["equipment": "dumbbell", "loadCount": 1]], ["dumbbell", "1"]),
      (UpdateExercise(ID("back-squat"), equipment: "dumbbell", loadCount: 2), [["equipment": "dumbbell", "loadCount": 2]], ["dumbbell", "2"]),
      (UpdateExercise(ID("goblet-squat"), equipment: "dumbbell", loadCount: 2), [["loadCount": 2]], ["dumbbell", "2"]),
      (UpdateExercise(ID("dumbbell-bench-press"), equipment: "barbell", loadCount: 2), [["equipment": "barbell"]], ["barbell", "1"]),
      (UpdateExercise(ID("dumbbell-bench-press"), name: "Dumbbell Bench Press", equipment: "dumbbell", loadCount: 2), [], ["dumbbell", "2"]),
    ]
    for (edit, written, resolved) in edits {
      let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
      let outcome = try phone.runner.run(edit)
      #expect(written.isEmpty ? unchanged(outcome) != nil : outcome.receipt != nil)
      #expect(try phone.drawn(ExerciseName.self).map(\.fields) == written)
      #expect(try phone.runner.read(Gym.scope) { try Catalogue($0).find(edit.id).map { [$0.equipment, "\($0.loadCount)"] } } == resolved)
    }
  }

  @Test func aOneDumbbellMovementIsAdmittedByTheServerAndASetLoggedWithItSurvivesSync() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), rules: GymServerRules())
    let id = phone.runner.mint(Exercise.self)
    #expect(try phone.runner.run(CreateExercise(Exercise(id: id, name: "One-arm row", pattern: "pull", equipment: "dumbbell", stepKg: 2, loadCount: 1))).receipt != nil)
    let session = try #require(committed(try phone.runner.run(StartSession(id: phone.runner.mint(Session.self)))))
    let set = TrainingSet(id: phone.runner.mint(TrainingSet.self), sessionId: session, exerciseId: id, weightKg: 30, reps: 10, completedAt: Instant(ms: 1_800_000_000_500))
    #expect(try phone.runner.run(AppendSet(set)).receipt != nil)
    phone.sync()
    let other = phone.device()
    other.sync()
    for device in [phone, other] {
      #expect(try device.runner.read(Gym.scope) { try Catalogue($0).find(id) } ==
              Exercise(id: id, name: "One-arm row", pattern: "pull", equipment: "dumbbell", stepKg: 2, loadCount: 1))
      #expect(try device.runner.read(Gym.scope) { try TrainingLog($0).sets(session: session).map(\.id) } == [set.id])
      #expect(try device.runner.read(Gym.scope) { try TrainingLog($0).volumeKg(session: session) } == 300)
      #expect(try device.notices(GymRefusal.self).isEmpty)
    }
  }

  // The model server holds no seed catalogue, so the seed override syncs register by register without the gym's rules.
  @Test func aStaleSeedEquipmentEditKeepsANewerRename() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let stale = phone.device()
    let id = ID<Exercise>("back-squat")
    #expect(try phone.runner.run(RenameExercise(id, name: "My squat")).receipt != nil)
    phone.advance(ms: 1000)
    let opened = try #require(try stale.runner.read(Gym.scope) { try Catalogue($0).find(id) })
    #expect(try stale.runner.run(UpdateExercise(id, name: opened.name, equipment: "dumbbell", loadCount: 1)).receipt != nil)
    phone.sync()
    for (device, formerNames) in [(phone, ["Back Squat"]), (stale, [])] {
      #expect(try device.runner.read(Gym.scope) { try Catalogue($0).find(id) } ==
              Exercise(id: id, name: "My squat", pattern: "squat", equipment: "dumbbell", stepKg: 2.5, loadCount: 1, aliases: formerNames))
      #expect(try device.notices(GymRefusal.self).isEmpty)
    }
  }

  @Test func aStaleCustomRenameKeepsANewerEquipmentChange() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), rules: GymServerRules())
    let id = phone.runner.mint(Exercise.self)
    #expect(try phone.runner.run(CreateExercise(Exercise(id: id, name: "Press", pattern: "press", equipment: "barbell", stepKg: 2.5))).receipt != nil)
    phone.sync()
    let stale = phone.device()
    stale.sync()
    #expect(try phone.runner.run(UpdateExercise(id, equipment: "dumbbell", loadCount: 1)).receipt != nil)
    phone.advance(ms: 1000)
    let opened = try #require(try stale.runner.read(Gym.scope) { try Catalogue($0).find(id) })
    #expect(try stale.runner.run(UpdateExercise(id, name: "Bench", equipment: opened.equipment, loadCount: opened.loadCount)).receipt != nil)
    phone.sync()
    for device in [phone, stale] {
      #expect(try device.runner.read(Gym.scope) { try Catalogue($0).find(id) } ==
              Exercise(id: id, name: "Bench", pattern: "press", equipment: "dumbbell", stepKg: 2.5, loadCount: 1, aliases: ["Press"]))
      #expect(try device.notices(GymRefusal.self).isEmpty)
    }
  }

  @Test(arguments: try Contract.vectors("gym/domain/catalogue-actions.json"))
  func vector(_ vector: Vector) throws {
    let corpus = ProductCorpus(GymRules.book)
    let input = try vector.input.member("input")
    let result: JSON
    if let action = vector.input["action"] {
      switch try action.asString() {
      case "CreateExercise":
        let form = try Exercise(form: input.member("exercise"))
        let exercise = Exercise(id: form.id, name: form.name, pattern: form.pattern, equipment: form.equipment, stepKg: form.stepKg,
                                loadCount: try input["loadCount"].map { Int(try $0.asInteger()) }, aliases: form.aliases)
        result = try corpus.decision(of: CreateExercise(exercise), vector, result: \.json, refusal: \.form)
      case "EditExercise":
        let form = try input.member("base")
        let value = try Exercise(form: form)
        let base = Exercise(id: value.id, name: value.name, pattern: value.pattern, equipment: value.equipment,
                            stepKg: value.stepKg, loadCount: try form["loadCount"].map { Int(try $0.asInteger()) }, aliases: value.aliases)
        result = try corpus.decision(of: EditExercise(base: base, name: input.member("name").asString(),
          equipment: input.member("equipment").asString(), loadCount: Int(input.member("loadCount").asInteger())),
          vector, result: { ["exercise": Self.form($0), "loadCount": .of($0.loadCount)] }, refusal: \.form)
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
          case "LoadingChoice":
            return .string(try ExerciseRules.loadingChoice(equipment: input.member("equipment").asString(), loadCount: Int(input.member("loadCount").asInteger())))
          case "DefaultStepKg":
            return .object(fields: Dictionary(uniqueKeysWithValues: ["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "other"].map {
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
