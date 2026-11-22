import Foundation
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncStore
import SyncTesting
import Testing

// The gym Coach's records through the engine and the real gym server rules (engine §7.12, Coach §9.1): one gesture opens
// a turn, a writer's terminal state beats another device's interrupted whatever the stamps, and a writer's ended turn
// is final.
@MainActor
struct CoachRecordsTests {
  static let scope = ScopeRef.product("gym")
  static let history = "a phone turn creates the conversation, the lifter message and the running Coach message in one intent"

  @Test func oneGestureOpensTheConversationBothMessagesAndTheRunningTurnRow() async throws {
    let fixture = try await GymPredictionFixture(Self.history)
    let turn = try Self.openTurn(on: fixture)
    let replica: any Replica = fixture.engine
    #expect(try replica.read(Self.scope) { try $0.device("runningTurn") } == turn.coach.json)
    #expect(await fixture.engine.sender.step() == .again)
    await fixture.engine.settle()
    #expect(try fixture.engine.currentNotices("gym") == [])
    let rows = fixture.network.server.rows(Self.scope, of: "A").filter { ["thread", "message"].contains($0.key.type) }
    let values = Dictionary(uniqueKeysWithValues: rows.map { ($0.key, $0.lattice.fields.mapValues(\.value)) })
    let at = JSON(fixture.clock.nowMs())
    #expect(values == [
      RecordKey("thread", turn.thread): ["title": "How heavy today?"],
      RecordKey("message", turn.lifter): ["threadId": turn.thread.json, "role": "lifter", "text": "How heavy today?", "at": at],
      RecordKey("message", turn.coach): ["threadId": turn.thread.json, "role": "coach", "replica": .string(turn.replica), "state": "running", "at": at],
    ])
    #expect(rows.allSatisfy { $0.lattice.born == rows[0].lattice.born })
    #expect(try replica.read(Self.scope) { try $0.drawn("message", turn.coach) }?.values["state"] == "running")
  }

  // A turn's round sits in `runningRound` beside `runningTurn`. A build whose registry declares no `runningRound` opens the
  // same store, reads and clears `runningTurn`, keeps the round's row untouched, and cannot write one.
  @Test func aBuildThatKnowsNoRunningRoundStillReadsAndClearsTheRunningTurnOfAStoreHoldingOne() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "round-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appending(path: "store.sqlite").path
    var source = try Corpus.registryFile("gym").asObject()
    var products = try source.member("products").asObject()
    var gym = try products.member("gym").asObject()
    var device = try gym.member("device").asObject()
    device["runningRound"] = nil
    gym["device"] = .object(device)
    products["gym"] = .object(gym)
    source["products"] = .object(products)
    let older = try Registry(json: .object(source))
    let round: JSON = ["message": "coach0000000001", "callId": "AAAAAAAAAAAAAAAAAAAAAA", "bytesBefore": 17]
    let rows = { (replica: any Replica) in try replica.read(Self.scope) { [try $0.device("runningTurn"), try $0.device("runningRound")] } }

    let rig = try Rig(registry: Registry(json: Corpus.registryFile("gym")), path: path)
    _ = try rig.engine.commit(Self.scope, Gesture(changes: [], local: [
      DeviceWrite(key: "runningTurn", value: "coach0000000001"), DeviceWrite(key: "runningRound", value: round)]))
    #expect(try rows(rig.engine) == ["coach0000000001", round])

    let old = try Rig.engine(over: Store(path: path, registry: older), clock: rig.clock, random: rig.random, transport: rig.transport,
      tokens: rig.tokens, forkGuard: rig.forkGuard, connectivity: rig.connectivity, slicing: rig.slicing, drivesLoops: false, bindings: [],
      events: rig.events)
    #expect(try rows(old) == ["coach0000000001", round])
    #expect(throws: CommitFailure.malformed("runningRound is not a device row of gym")) {
      try old.commit(Self.scope, Gesture(changes: [], local: [DeviceWrite(key: "runningRound", value: nil)]))
    }
    _ = try old.commit(Self.scope, Gesture(changes: [], local: [DeviceWrite(key: "runningTurn", value: nil)]))
    #expect(try rows(rig.relaunch()) == [nil, round])
  }

  @Test func aWritersCompletedAtAnOlderStampBeatsAnotherDevicesInterrupted() async throws {
    let fixture = try await GymPredictionFixture(Self.history)
    let turn = try Self.openTurn(on: fixture)
    #expect(await fixture.engine.sender.step() == .again)
    let other = try fixture.device(seed: 2)
    other.puller.wants.all()
    while case .pulled = await other.puller.step() {}

    let ended = try fixture.engine.commit(Self.scope, Gesture(changes: [.update("message", turn.coach, [
      "state": "completed", "text": "Add 5 kg.", "receipt": ["proposals": []], "calls": [["name": "gym.last_time"]],
    ])]))
    guard case .committed(let receipt) = ended else { throw RigError("the writer's completed was locally refused") }
    fixture.clock.advance(ms: 1_000)
    _ = try other.commit(Self.scope, Gesture(changes: [.update("message", turn.coach, ["state": "interrupted"])]))
    #expect(await other.sender.step() == .again)
    let interrupted = try #require(Self.serverRow("message", turn.coach, on: fixture))
    #expect(interrupted.lattice.fields["state"]?.value == "interrupted")
    #expect(try #require(interrupted.lattice.fields["state"]?.stamp) > receipt.stamp)

    #expect(await fixture.engine.sender.step() == .again)
    await fixture.engine.settle()
    #expect(try fixture.engine.currentNotices("gym") == [])
    let completed = try #require(Self.serverRow("message", turn.coach, on: fixture))
    #expect(completed.lattice.fields["state"] == Register("completed", receipt.stamp))
    #expect(completed.lattice.fields["text"] == Register("Add 5 kg.", receipt.stamp))
    #expect(completed.lattice.fields["receipt"] == Register(["proposals": []], receipt.stamp))
    #expect(completed.lattice.fields["calls"] == Register([["name": "gym.last_time"]], receipt.stamp))
  }

  @Test func anInterruptedAfterTheWriterEndedItsTurnIsRefusedMessageFinalAndLosesToCompleted() async throws {
    let fixture = try await GymPredictionFixture(Self.history)
    let turn = try Self.openTurn(on: fixture)
    let replica: any Replica = fixture.engine
    #expect(await fixture.engine.sender.step() == .again)
    _ = try fixture.engine.commit(Self.scope, Gesture(changes: [.update("message", turn.coach, ["state": "completed", "text": "Add 5 kg."])]))
    #expect(await fixture.engine.sender.step() == .again)
    await fixture.pull()
    await fixture.engine.settle()
    let completed = try #require(try replica.read(Self.scope) { try $0.confirmed("message", turn.coach) })
    #expect(completed.values["state"] == "completed")

    _ = try fixture.engine.commit(Self.scope, Gesture(changes: [.update("message", turn.coach, ["state": "interrupted"])]))
    #expect(try replica.read(Self.scope) { try $0.drawn("message", turn.coach) }?.values["state"] == "completed")
    #expect(await fixture.engine.sender.step() == .again)
    await fixture.engine.settle()
    let notices = try fixture.engine.currentNotices("gym")
    #expect(notices.map(\.code) == ["message-final"])
    #expect(notices.map { $0.content.deltas.map(\.key) } == [[RecordKey("message", turn.coach)]])
    #expect(try replica.read(Self.scope) { try $0.drawn("message", turn.coach) }?.values["state"] == "completed")
    #expect(try replica.read(Self.scope) { try $0.confirmed("message", turn.coach) } == completed)
    #expect(Self.serverRow("message", turn.coach, on: fixture)?.lattice.fields["state"]?.value == "completed")
  }

  struct Turn {
    let thread: RecordID
    let lifter: RecordID
    let coach: RecordID
    let replica: String
  }

  // Coach §4.1 step 2: the question, its conversation and the running Coach message the writer names, with the
  // device's runningTurn row, in one read-and-commit.
  static func openTurn(on fixture: GymPredictionFixture) throws -> Turn {
    let replica: any Replica = fixture.engine
    let (outcome, turn) = try replica.commit(scope) { context in
      let turn = Turn(thread: try context.mintID("thread"), lifter: try context.mintID("message"), coach: try context.mintID("message"),
                      replica: context.replica)
      let changes: [Change] = [
        .create("thread", id: .given(turn.thread), ["title": "How heavy today?"]),
        .create("message", id: .given(turn.lifter), ["threadId": turn.thread.json, "role": "lifter", "text": "How heavy today?", "at": JSON(context.now)]),
        .create("message", id: .given(turn.coach), ["threadId": turn.thread.json, "role": "coach", "replica": .string(context.replica),
                                                    "state": "running", "at": JSON(context.now)]),
      ]
      return (Gesture(changes: changes, local: [DeviceWrite(key: "runningTurn", value: turn.coach.json)]), turn)
    }
    guard case .committed = try #require(outcome) else { throw RigError("the turn was locally refused") }
    return turn
  }

  static func serverRow(_ type: String, _ id: RecordID, on fixture: GymPredictionFixture) -> Row? {
    fixture.network.server.rows(scope, of: "A").first { $0.key == RecordKey(type, id) }
  }
}
