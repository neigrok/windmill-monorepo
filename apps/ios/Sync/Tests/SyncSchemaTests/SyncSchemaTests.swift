import SyncCore
import SyncSchema
import SyncTesting
import Testing

// The generated registry is the composition's product registries, with the registry's own names and version.

struct SyncSchemaTests {
  @Test func theRegistryIsTheProductRegistryFilesComposed() throws {
    let gym = try Corpus.registryFile("gym").asObject()
    let expected: JSON = [
      "registry": "windmill", "version": 3, "minVersion": 3,
      "products": try gym.member("products"), "types": try gym.member("types"), "commands": try gym.member("commands"),
    ]
    #expect(SyncSchema.registry.json == expected)
  }

  @Test func theRegistryRoundTripsThroughTheDecoder() throws {
    #expect(try Registry(json: SyncSchema.registry.json).json == SyncSchema.registry.json)
  }

  @Test func theVersionIsTheRegistrys() {
    #expect([SyncSchema.version, SyncSchema.registry.version, SyncSchema.registry.minVersion] == [3, 3, 3])
  }

  @Test func everyTypeAndCommandHasItsName() {
    let types = [
      Gym.Types.routine, Gym.Types.exercise, Gym.Types.exerciseName, Gym.Types.session, Gym.Types.set, Gym.Types.note,
      Gym.Types.weighin, Gym.Types.prefs, Gym.Types.proposal,
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
      Gym.Codes.unknownExercise, Gym.Codes.badInstant, Gym.Codes.proposalSettled, Gym.Codes.proposalSuperseded,
    ]
    #expect(codes == SyncSchema.registry.products.flatMap(\.codes))
    let defaults: [String: [String: JSON]] = [
      Gym.Types.routine: ["position": JSON(Gym.Defaults.Routine.position)],
      Gym.Types.proposal: ["state": .string(Gym.Defaults.Proposal.state)],
      Gym.Types.prefs: [
        "units": .string(Gym.Defaults.Prefs.units), "restSeconds": Gym.Defaults.Prefs.restSeconds.map { JSON($0) } ?? .null,
        "restSound": .bool(Gym.Defaults.Prefs.restSound), "confirmHaptic": .bool(Gym.Defaults.Prefs.confirmHaptic),
        "confirmSound": .bool(Gym.Defaults.Prefs.confirmSound),
      ],
    ]
    let declared = SyncSchema.registry.types.compactMap { type -> (String, [String: JSON])? in
      let fields = Dictionary(uniqueKeysWithValues: type.fields.compactMap { field in field.defaultValue.map { (field.name, $0) } })
      guard !fields.isEmpty else { return nil }
      return (type.name, fields)
    }
    #expect(defaults == Dictionary(uniqueKeysWithValues: declared))
  }
}
