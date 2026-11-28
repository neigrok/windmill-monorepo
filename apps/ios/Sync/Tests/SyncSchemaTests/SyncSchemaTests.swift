import SyncCore
import SyncSchema
import SyncTesting
import Testing

// The generated registry is the composition's product registries, gym's, journal's and roadmap's, with the registry's own
// names and version.

struct SyncSchemaTests {
  @Test func theRegistryIsTheProductRegistryFilesComposed() throws {
    let registries: [JSON.Object] = try ["gym", "journal", "roadmap"].map { (name: String) throws -> JSON.Object in try Corpus.registryFile(name).asObject() }
    let products: [(String, JSON)] = try registries.flatMap { (registry: JSON.Object) throws -> [(String, JSON)] in
      try registry.member("products").asObject().members.map { ($0.key, $0.value) }
    }
    let types: [JSON] = try registries.flatMap { (registry: JSON.Object) throws -> [JSON] in try registry.member("types").asArray() }
    let commands: [JSON] = try registries.flatMap { (registry: JSON.Object) throws -> [JSON] in try registry.member("commands").asArray() }
    let expected: JSON = [
      "registry": "windmill", "version": 15, "minVersion": 15, "products": .object(JSON.Object(uniqueKeysWithValues: products)),
      "types": .array(types), "commands": .array(commands),
    ]
    #expect(SyncSchema.registry.json == expected)
  }

  @Test func theRegistryRoundTripsThroughTheDecoder() throws {
    #expect(try Registry(json: SyncSchema.registry.json).json == SyncSchema.registry.json)
  }

  @Test func theVersionIsTheRegistrys() {
    #expect([SyncSchema.version, SyncSchema.registry.version, SyncSchema.registry.minVersion] == [15, 15, 15])
  }

  @Test func everyTypeAndCommandHasItsName() {
    let types = [
      Gym.Types.routine, Gym.Types.routineCreation, Gym.Types.exercise, Gym.Types.exerciseName, Gym.Types.session, Gym.Types.set, Gym.Types.note,
      Gym.Types.weighin, Gym.Types.prefs, Gym.Types.proposal, Gym.Types.workoutProposal, Gym.Types.thread, Gym.Types.message, Journal.Types.page, Journal.Types.journalState,
      Roadmap.Types.tree, Roadmap.Types.meta, Roadmap.Types.node, Roadmap.Types.edge, Roadmap.Types.kind, Roadmap.Types.progress, Roadmap.Types.pointer,
      Roadmap.Types.subtask, Roadmap.Types.stepLink, Roadmap.Types.stepNote, Roadmap.Types.coachThread, Roadmap.Types.coachMessage,
      Roadmap.Types.coachProposal, Roadmap.Types.coachWriteFate,
    ]
    let commands = [
      Gym.Commands.start, Gym.Commands.importSession, Gym.Commands.correctSession, Gym.Commands.finish,
      Gym.Commands.applyProposal, Gym.Commands.dismissProposal, Gym.Commands.applyWorkoutProposal,
      Gym.Commands.dismissWorkoutProposal, Gym.Commands.closeStale, Journal.Commands.savePage, Journal.Commands.claimPage,
      Roadmap.Commands.createSubtree, Roadmap.Commands.recolourKind, Roadmap.Commands.undoCreateRoadmap, Roadmap.Commands.undoCreateSubtree,
      Roadmap.Commands.redoCreateSubtree, Roadmap.Commands.capture, Roadmap.Commands.captureTree, Roadmap.Commands.captureOverlay,
      Roadmap.Commands.restore, Roadmap.Commands.restoreTree, Roadmap.Commands.restoreOverlay,
    ]
    #expect(types == SyncSchema.registry.types.map(\.name))
    #expect(commands == SyncSchema.registry.commands.map(\.name))
  }

  @Test func everyRefusalCodeAndDefaultIsTheRegistrys() throws {
    let codes = [
      Gym.Codes.payloadConflict, Gym.Codes.sessionFinished, Gym.Codes.sessionOpen, Gym.Codes.sessionOverlap,
      Gym.Codes.unknownExercise, Gym.Codes.badInstant, Gym.Codes.proposalSettled, Gym.Codes.proposalSuperseded, Gym.Codes.messageFinal,
      Gym.Codes.planLogged,
      Journal.Codes.claimConflict,
      Roadmap.Codes.stepOpensATree, Roadmap.Codes.depthLimit, Roadmap.Codes.notARoot, Roadmap.Codes.turnFinal,
    ]
    #expect(codes == SyncSchema.registry.products.flatMap(\.codes))
    let meta: [String: JSON] = [
      "depth": JSON(Roadmap.Defaults.Meta.depth), "guide": .string(Roadmap.Defaults.Meta.guide), "guideInherited": .bool(Roadmap.Defaults.Meta.guideInherited),
      "parent": Roadmap.Defaults.Meta.parent, "reach": .string(Roadmap.Defaults.Meta.reach), "title": .string(Roadmap.Defaults.Meta.title),
      "visibility": .string(Roadmap.Defaults.Meta.visibility),
    ]
    let node: [String: JSON] = [
      "branch": Roadmap.Defaults.Node.branch.map(JSON.string) ?? .null, "color": .string(Roadmap.Defaults.Node.color),
      "description": .string(Roadmap.Defaults.Node.description), "icon": .string(Roadmap.Defaults.Node.icon), "label": .string(Roadmap.Defaults.Node.label),
      "links": Roadmap.Defaults.Node.links, "status": Roadmap.Defaults.Node.status.map(JSON.string) ?? .null,
    ]
    let coachMessage: [String: JSON] = [
      "proposalId": Roadmap.Defaults.CoachMessage.proposalId.map(JSON.string) ?? .null, "refusal": Roadmap.Defaults.CoachMessage.refusal.map(JSON.string) ?? .null,
      "state": .string(Roadmap.Defaults.CoachMessage.state), "truncated": .bool(Roadmap.Defaults.CoachMessage.truncated),
    ]
    let roadmap: [String: [String: JSON]] = [
      Roadmap.Types.tree: ["parent": Roadmap.Defaults.Tree.parent], Roadmap.Types.meta: meta, Roadmap.Types.node: node,
      Roadmap.Types.kind: [
        "description": .string(Roadmap.Defaults.Kind.description), "hue": .string(Roadmap.Defaults.Kind.hue), "label": .string(Roadmap.Defaults.Kind.label),
      ],
      Roadmap.Types.progress: ["mark": Roadmap.Defaults.Progress.mark],
      Roadmap.Types.subtask: ["done": .bool(Roadmap.Defaults.Subtask.done), "label": .string(Roadmap.Defaults.Subtask.label)],
      Roadmap.Types.stepLink: ["title": .string(Roadmap.Defaults.StepLink.title)], Roadmap.Types.coachMessage: coachMessage,
      Roadmap.Types.coachProposal: ["state": .string(Roadmap.Defaults.CoachProposal.state), "undone": .bool(Roadmap.Defaults.CoachProposal.undone)],
    ]
    let products: [String: [String: JSON]] = [
      Journal.Types.journalState: ["placeholder": "pending", "privacyLine": "pending", "firstPage": "pending", "scales": "pending"],
      Gym.Types.routine: ["position": JSON(Gym.Defaults.Routine.position)],
      Gym.Types.proposal: ["state": .string(Gym.Defaults.Proposal.state)],
      Gym.Types.workoutProposal: ["state": .string(Gym.Defaults.WorkoutProposal.state)],
      Gym.Types.message: ["state": .string(Gym.Defaults.Message.state)],
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
    let defaults: [String: [String: JSON]] = products.merging(roadmap) { (product: [String: JSON], _: [String: JSON]) -> [String: JSON] in product }
    #expect(defaults == Dictionary(uniqueKeysWithValues: declared))
  }
  @Test func journalDeviceRowsAreLocalOnlyAndPagesAreServerWritten() throws {
    let journal = try #require(SyncSchema.registry.product("journal"))
    #expect(journal.device.map(\.name) == ["carry", "contentClock", "pendingClaim", "talkTake"])
    #expect(journal.device.allSatisfy { $0.localOnly })
    #expect(journal.device.contains { $0.keyPattern.matches("carry:0123456789abcdef") })
    #expect(journal.device.contains { $0.keyPattern.matches("contentClock") })
    #expect(journal.device.contains { $0.keyPattern.matches("pendingClaim:a") })
    let talkTake = try #require(journal.device.first { $0.name == "talkTake" })
    #expect(talkTake.keyPattern.matches("talkTake"))
    #expect(!talkTake.keyPattern.matches("talkTake:2026-11-28"))
    #expect(SyncSchema.registry.type(Journal.Types.page)?.fields.allSatisfy { $0.writer == .server } == true)
    #expect(SyncSchema.registry.types.filter { $0.scope == .product("journal") && $0.primary }.map(\.name) == [Journal.Types.page])
  }

  @Test func theGymCoachDeviceRowsAreTheRunningTurnAndItsLocalOnlyPictures() throws {
    let gym = try #require(SyncSchema.registry.product("gym"))
    #expect(gym.device.map(\.name) == ["movement", "movementOrder", "offer", "picture", "rack", "runningRound", "runningTurn"])
    #expect(gym.device.filter(\.localOnly).map(\.name) == ["picture"])
    let runningTurn = try #require(gym.device.first { $0.name == "runningTurn" })
    #expect(runningTurn.keyPattern.matches("runningTurn"))
    #expect(!runningTurn.keyPattern.matches("runningTurn:turn00000001"))
    let picture = try #require(gym.device.first { $0.name == "picture" })
    #expect(picture.keyPattern.matches("picture:picture00001"))
    #expect(!picture.keyPattern.matches("picture"))
  }
}
