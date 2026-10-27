import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
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
