import Foundation
import Testing
import Agent
import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
import WindmillPlatform
@testable import Windmill

// Roadmap Coach in the room (roadmap-ios.md §8): a turn on the Coach engine over the room's runner, played by the service a
// Debug launch plays, so no test calls the AI service or a provider.
@Suite(.serialized) @MainActor struct RoadmapCoachTests {
  final class NoLease: CoachWorkLease {
    func acquire(expired: @escaping @MainActor () -> Void) {}
    func release() {}
  }

  struct Phone {
    let engine: SteppedEngine
    let runner: ActionRunner
    let room: RoadmapModel
    let coach: RoadmapCoach
    let telemetry: TelemetryRecorder
    let planted: CreateRoadmap.Result
  }

  // A signed-in phone on the model server with *Learn to sail* open, two of its steps done, and Coach on the played service.
  func phone(allowance: PlayedAiService.Allowance = .ok, online: Bool = true) async throws -> Phone {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, seed: 1, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let runner = ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: true)
    let telemetry = TelemetryRecorder()
    let room = RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner,
                            phone: UserDefaults(suiteName: "coach-\(UUID().uuidString)")!, telemetry: telemetry,
                            wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
    let profile = try CoachProfile()
    let seat = Agent.Seat(kind: .bound, key: "acct-1")
    let host = RoadmapTurnHost(runner: runner, profile: profile, seat: { seat }, textEvery: .zero)
    let ports = CoachTelemetry(telemetry: telemetry) { [weak host] in host?.lastEnd?.truncated ?? false }
    let client = ServiceAiClient(transport: PlayedAiService(allowance: allowance, pace: .zero), clock: AiSystemClock(), diagnostics: ports,
                                 credentials: { _ in AiCredentials(session: "session") }, connection: { online })
    let turn = Turn(host: host, client: client, telemetry: ports, runtime: CoachRuntime(clock: AiSystemClock(), lease: NoLease(), expired: {}))
    let coach = RoadmapCoach(runner: runner, engine: .init(turn: turn, client: client, host: host), profile: profile, telemetry: telemetry,
                             seat: { seat }, installation: {}, online: { online }, freshness: { SyncFreshness() })
    coach.room = room
    room.coach = coach
    let planted = try RoadmapFixture.plantLearnToSail(runner, done: ["choose", "parts"])
    for _ in 0..<100 where room.shown == nil {
      await engine.settleViews()
      room.observe()
    }
    #expect(room.shown != nil)
    return Phone(engine: engine, runner: runner, room: room, coach: coach, telemetry: telemetry, planted: planted)
  }

  func step(_ key: String, of phone: Phone) -> (id: String, label: String) {
    let id = phone.planted.steps.first { $0.key == key }!.id.description
    return (id, phone.room.label(of: id, in: phone.planted.tree.description) ?? "")
  }

  func events(_ phone: Phone, _ name: String) -> [[String: String]] {
    phone.telemetry.entries.withLock { $0 }.filter { $0.name == name }.map(\.properties)
  }

  func subtasks(_ phone: Phone) throws -> [String] {
    try phone.runner.read(phone.planted.tree.overlay) { try $0.repository(Subtask.self).all(in: .drawn).map(\.label) }
  }

  @Test func aQuestionsAnswerStreamsIntoTheSheetAndItsRecordKeepsWhatCoachRead() async throws {
    let phone = try await phone()
    phone.coach.open(from: .foot)
    phone.coach.field = "What’s next?"
    await phone.coach.send()

    let conversation = try #require(phone.coach.conversation)
    #expect(conversation.thread.treeId == phone.planted.tree.description && conversation.thread.title == "What’s next?")
    #expect(conversation.messages.map(\.role) == ["person", "coach"])
    let answer = conversation.messages[1]
    #expect(answer.state == .completed)
    #expect(answer.text == "Rig the boat. It’s open now, and Read the wind can wait.")
    #expect(answer.calls == [CoachCall(ability: CoachCall.context, treeId: phone.planted.tree.description, steps: 8, done: 2)])
    #expect(answer.receipts == [])
    #expect(phone.coach.sheet && phone.coach.running == nil && phone.coach.field.isEmpty)
    #expect(CoachThreadView.readLine(answer.calls) == "Read your roadmap · 8 steps")
    #expect(try phone.runner.read(CoachMessage.scope) { try $0.devices(prefix: "runningTurn:") }.isEmpty, "the end lets go of the mark")
    #expect(events(phone, "roadmap_coach_opened") == [["entry": "foot"]])
    let turn = try #require(events(phone, "roadmap_coach_turn").first)
    #expect(turn["state"] == "completed" && turn["seat"] == "bound" && turn["truncated"] == "false" && turn["ability_calls"] == "0" && turn["code"] == nil)
  }

  @Test func aDirectWriteIsItsReceiptInTheBandAndItsUndoIsTheReceiptsFateOnEveryDevice() async throws {
    let phone = try await phone()
    let read = step("read", of: phone)
    phone.coach.open(about: read, from: .row)
    await phone.coach.send("add a subtask: note the wind direction")

    let receipt = CoachReceipt(ability: "update_node", treeId: phone.planted.tree.description, nodeId: read.id, label: "Read the wind", change: .changed,
                               items: ["Note the wind direction"])
    let answer = try #require(phone.coach.conversation?.messages.last)
    #expect(answer.state == .completed && answer.text.isEmpty && answer.receipts == [receipt])
    #expect(answer.calls?.map(\.ability) == [CoachCall.context, "update_node"])
    #expect(phone.coach.conversation?.thread.stepId == read.id)
    #expect(try subtasks(phone) == ["Note the wind direction"])
    #expect(phone.room.band?.says == .coachWrote(receipt) && phone.room.band?.says.words == "Subtask added · Note the wind direction")
    #expect(!phone.coach.sheet, "a direct write raises no sheet")
    #expect(events(phone, "roadmap_coach_ability") == [["name": "update_node", "outcome": "ok"]])

    // The engine settles the Undo as the server answers it, and the room tells it on its next read of the copy.
    phone.room.undo()
    for _ in 0..<20 where phone.room.band?.says != .coachUndone {
      phone.engine.sync()
      await phone.engine.settleViews()
      phone.room.observe()
    }
    #expect(try subtasks(phone) == [])
    #expect(phone.room.band?.says == .coachUndone && phone.room.band?.says.words == "Undone")
    let fates = try #require(phone.coach.conversation?.fates)
    #expect(fates.map(\.receipt) == [0] && fates.map(\.fate) == ["undone"])
    #expect(events(phone, "roadmap_coach_write_undone") == [["ability": "update_node", "outcome": "undone"]])
  }

  @Test func aCompletionCoachWritesIsToldInTheBoardsOwnWords() async throws {
    let phone = try await phone()
    phone.coach.open(from: .foot)
    await phone.coach.send("I finished Read the wind")
    #expect(phone.room.band?.says.words == "Read the wind done")
    #expect(phone.coach.conversation?.messages.last?.receipts?.map(\.change) == [.completed])
  }

  @Test func withNoConnectionTheQuestionStaysInTheFieldAndNothingIsWritten() async throws {
    let phone = try await phone(online: false)
    phone.coach.open(from: .foot)
    phone.coach.field = "Should I add a night sail?"
    await phone.coach.send()
    #expect(phone.coach.field == "Should I add a night sail?" && phone.coach.notice == .offline && phone.coach.thread == nil)
    #expect(try phone.runner.read(CoachThread.scope) { try $0.repository(CoachThread.self).all(in: .drawn) }.isEmpty)
    #expect(events(phone, "roadmap_coach_ask_refused") == [["reason": "offline"]])
  }

  @Test func aSpentAllowanceGivesTheQuestionBackWithTheDayItRenews() async throws {
    let phone = try await phone(allowance: .spent)
    phone.coach.open(from: .foot)
    phone.coach.field = "Should I add a night sail?"
    await phone.coach.send()
    #expect(phone.coach.field == "Should I add a night sail?" && phone.coach.thread == nil)
    #expect(phone.coach.notice == .allowanceUsed(signedIn: true, renews: Instant(ms: 1_796_083_200_000)))
    #expect(try phone.runner.read(CoachMessage.scope) { try $0.repository(CoachMessage.self).all(in: .drawn) }.isEmpty, "a turn never admitted is withdrawn")
    #expect(events(phone, "roadmap_coach_ask_refused") == [["reason": "allowanceUsed"]])
  }

  @Test func aTurnWhoseProcessEndedIsReadBackByItsRoundAndEnded() async throws {
    let phone = try await phone()
    guard case .committed(let turn, _) = try phone.runner.runAct(RoadmapDomain.OpenTurn(about: .init(treeId: phone.planted.tree.description),
                                                                                           question: "What’s next?")) else { throw AppFailure(message: "no turn") }
    _ = try phone.runner.runAct(BeginRound(turn.coach, callId: "AAAAAAAAAAAAAAAAAAAAAA", text: ""))
    await phone.coach.recover()
    let message = try #require(try phone.runner.read(CoachMessage.scope) { try $0.repository(CoachMessage.self).find(turn.coach, in: .drawn) })
    #expect(message.state == .completed)
    #expect(try phone.runner.read(CoachMessage.scope) { try $0.devices(prefix: "runningTurn:") }.isEmpty)
  }

  @Test func historyListsTheOpenRoadmapsConversationsAndItsSwipeDeletesOne() async throws {
    let phone = try await phone()
    phone.coach.open(from: .foot)
    await phone.coach.send("What’s next?")
    let thread = try #require(phone.coach.thread)
    #expect(phone.coach.history()?.current.map(\.thread.id) == [thread])
    phone.coach.delete(thread)
    #expect(phone.coach.history()?.current == [] && phone.coach.thread == nil)
  }
}
