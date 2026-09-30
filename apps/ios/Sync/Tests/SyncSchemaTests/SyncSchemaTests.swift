import SyncCore
import SyncSchema
import SyncTesting
import Testing

// The generated registry is the product registry files composed, byte for byte by JCS: gym's, then journal's, under
// their one version. Its names are the registry's own.

struct SyncSchemaTests {
  @Test func theRegistryIsTheProductRegistryFilesComposed() throws {
    let gym = try Corpus.registryFile("gym").asObject()
    let journal = try Corpus.registryFile("journal").asObject()
    let expected: JSON = [
      "registry": "windmill", "version": 2, "minVersion": 2,
      "products": .object(JSON.Object(uniqueKeysWithValues:
        try gym.member("products").asObject().members.map { ($0.key, $0.value) }
          + journal.member("products").asObject().members.map { ($0.key, $0.value) })),
      "types": .array(try gym.member("types").asArray() + journal.member("types").asArray()),
      "commands": .array(try gym.member("commands").asArray() + journal.member("commands").asArray()),
    ]
    #expect(SyncSchema.registry.json == expected)
  }

  @Test func theRegistryRoundTripsThroughTheDecoder() throws {
    #expect(try Registry(json: SyncSchema.registry.json).json == SyncSchema.registry.json)
  }

  @Test func theVersionIsTheRegistrys() {
    #expect([SyncSchema.version, SyncSchema.registry.version, SyncSchema.registry.minVersion] == [2, 2, 2])
  }

  @Test func everyTypeAndCommandHasItsName() {
    let types = [
      Gym.Types.routine, Gym.Types.exercise, Gym.Types.exerciseName, Gym.Types.session, Gym.Types.set, Gym.Types.note,
      Gym.Types.weighin, Gym.Types.prefs, Gym.Types.proposal, Gym.Types.thread, Gym.Types.message, Journal.Types.page,
    ]
    let commands = [
      Gym.Commands.start, Gym.Commands.importSession, Gym.Commands.correctSession, Gym.Commands.finish,
      Gym.Commands.applyProposal, Gym.Commands.dismissProposal, Gym.Commands.closeStale,
    ]
    #expect(types == SyncSchema.registry.types.map(\.name))
    #expect(commands == SyncSchema.registry.commands.map(\.name))
  }

  @Test func everyRefusalCodeAndDefaultIsTheRegistrys() throws {
    let codes = [
      Gym.Codes.payloadConflict, Gym.Codes.sessionFinished, Gym.Codes.sessionOpen, Gym.Codes.sessionOverlap,
      Gym.Codes.unknownExercise, Gym.Codes.badInstant,
    ]
    #expect(codes == SyncSchema.registry.products.flatMap(\.codes))
    let prefs = try #require(SyncSchema.registry.type(Gym.Types.prefs))
    let defaults: [String: JSON] = [
      "units": .string(Gym.Defaults.Prefs.units), "restSeconds": Gym.Defaults.Prefs.restSeconds.map { JSON($0) } ?? .null,
      "restSound": .bool(Gym.Defaults.Prefs.restSound), "confirmHaptic": .bool(Gym.Defaults.Prefs.confirmHaptic),
      "confirmSound": .bool(Gym.Defaults.Prefs.confirmSound),
    ]
    #expect(defaults == Dictionary(uniqueKeysWithValues: prefs.fields.compactMap { field in field.defaultValue.map { (field.name, $0) } }))
  }
}
