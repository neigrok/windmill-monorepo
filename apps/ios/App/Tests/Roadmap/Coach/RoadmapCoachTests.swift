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

  // A signed-in phone on the model server with *Learn to sail* open, two of its steps done, and Coach on the played service;
  // `seat` reads the seat a turn runs under, the account's by default.
  func phone(allowance: PlayedAiService.Allowance = .ok, online: Bool = true,
             seat read: (@MainActor () throws -> Agent.Seat)? = nil) async throws -> Phone {
    let engine = SteppedEngine(registry: SyncSchema.registry, startMs: 1_790_424_000_000, seed: 1, account: "acct-1",
                               rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let runner = ActionRunner(replica: engine.replica, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: true)
    let telemetry = TelemetryRecorder()
    let room = RoadmapModel(records: { scope, type in try engine.records(scope, type, .drawn, visibleOnly: false) }, runner: runner,
                            phone: UserDefaults(suiteName: "coach-\(UUID().uuidString)")!, telemetry: telemetry,
                            wait: { _ in try await Task.sleep(for: .seconds(3_600)) })
    let profile = try CoachProfile()
    let bound = Agent.Seat(kind: .bound, key: "acct-1")
    let seat = read ?? { bound }
    let host = RoadmapTurnHost(runner: runner, profile: profile, seat: seat, textEvery: .zero)
    let ports = CoachTelemetry(telemetry: telemetry) { [weak host] in host?.lastEnd?.truncated ?? false }
    let client = ServiceAiClient(transport: PlayedAiService(allowance: allowance, pace: .zero), clock: AiSystemClock(), diagnostics: ports,
                                 credentials: { _ in AiCredentials(session: "session") }, connection: { online })
    let turn = Turn(host: host, client: client, telemetry: ports, runtime: CoachRuntime(clock: AiSystemClock(), lease: NoLease(), expired: {}))
    let coach = RoadmapCoach(runner: runner, engine: .init(turn: turn, client: client, host: host), profile: profile, telemetry: telemetry,
                             seat: seat, installation: {}, online: { online }, freshness: { SyncFreshness() })
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

  func subtasks(_ phone: Phone, of tree: ID<RoadmapEntry>? = nil) throws -> [String] {
    try phone.runner.read((tree ?? phone.planted.tree).overlay) { try $0.repository(Subtask.self).all(in: .drawn).map(\.label) }
  }

  func coachMessages(_ phone: Phone) throws -> [CoachMessage] {
    try phone.runner.read(CoachMessage.scope) { try $0.repository(CoachMessage.self).all(in: .drawn) }.filter(\.isCoach)
  }

  func marks(_ phone: Phone) throws -> Int {
    try phone.runner.read(CoachMessage.scope) { try $0.devices(prefix: "runningTurn:") }.members.count
  }

  // The engine settles each Undo asked as the server answers it, and the room tells it on its next read of the copy.
  func settle(_ phone: Phone, until done: () -> Bool = { false }) async {
    for _ in 0..<20 where !done() {
      phone.engine.sync()
      await phone.engine.settleViews()
      phone.room.observe()
    }
  }

  @Test func aQuestionsAnswerStreamsIntoTheSheetAndItsRecordKeepsWhatCoachRead() async throws {
    let phone = try await phone()
    phone.coach.open(in: phone.room, from: .foot)
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
    #expect(try marks(phone) == 0, "the end lets go of the mark")
    #expect(phone.coach.hosts.isEmpty, "a turn that wrote nothing keeps no tool host")
    #expect(events(phone, "roadmap_coach_opened") == [["entry": "foot"]])
    let turn = try #require(events(phone, "roadmap_coach_turn").first)
    #expect(turn["state"] == "completed" && turn["seat"] == "bound" && turn["truncated"] == "false" && turn["ability_calls"] == "0" && turn["code"] == nil)
  }

  @Test func aDirectWriteIsItsReceiptInTheBandAndItsUndoIsTheReceiptsFateOnEveryDevice() async throws {
    let phone = try await phone()
    let read = step("read", of: phone)
    phone.coach.open(in: phone.room, about: read, from: .row)
    await phone.coach.send("add a subtask: note the wind direction")

    let receipt = CoachReceipt(ability: "update_node", treeId: phone.planted.tree.description, nodeId: read.id, label: "Read the wind", change: .changed,
                               items: ["Note the wind direction"])
    let answer = try #require(phone.coach.conversation?.messages.last)
    #expect(answer.state == .completed && answer.text.isEmpty && answer.receipts == [.read(receipt)])
    #expect(answer.calls?.map(\.ability) == [CoachCall.context, "update_node"])
    #expect(phone.coach.conversation?.thread.stepId == read.id)
    #expect(try subtasks(phone) == ["Note the wind direction"])
    #expect(phone.room.band?.says == .coachWrote(receipt) && phone.room.band?.says.words == "Subtask added · Note the wind direction")
    #expect(!phone.coach.sheet, "a direct write raises no sheet")
    #expect(events(phone, "roadmap_coach_ability") == [["name": "update_node", "outcome": "ok"]])

    // The band's Undo, asked twice, is told once; the turn's tool host closes once its one write is settled.
    let write = try #require(phone.room.band?.coach)
    phone.room.undo()
    phone.coach.undo(write)
    await settle(phone) { phone.room.band?.says == .coachUndone }
    #expect(try subtasks(phone) == [])
    #expect(phone.room.band?.says == .coachUndone && phone.room.band?.says.words == "Undone")
    let fates = try #require(phone.coach.conversation?.fates)
    #expect(fates.map(\.receipt) == [0] && fates.map(\.fate) == ["undone"])
    #expect(events(phone, "roadmap_coach_write_undone") == [["ability": "update_node", "outcome": "undone"]])
    #expect(phone.coach.hosts.isEmpty, "an Undo told leaves no tool host open")
  }

  // Two turns' Undos the engine settles at once each come to the write of their own turn.
  @Test func twoTurnsUndosPendingAtOnceSettleOntoTheirOwnReceipts() async throws {
    let phone = try await phone()
    phone.coach.open(in: phone.room, about: step("read", of: phone), from: .row)
    await phone.coach.send("add a subtask: note the wind direction")
    let first = try #require(phone.room.band?.coach)
    phone.room.undo()
    await phone.coach.send("add a subtask: check the tide")
    let second = try #require(phone.room.band?.coach)
    phone.room.undo()
    #expect(first.message != second.message && phone.coach.hosts.count == 2)
    await settle(phone) { phone.coach.hosts.isEmpty }

    let fates = try #require(phone.coach.conversation?.fates)
    #expect(Set(fates.map { "\($0.messageId.description) \($0.receipt) \($0.fate)" }) == [
      "\(first.message.description) 0 undone", "\(second.message.description) 0 undone",
    ])
    #expect(try subtasks(phone) == [])
    #expect(events(phone, "roadmap_coach_write_undone").count == 2 && phone.coach.hosts.isEmpty)
  }

  @Test func aCompletionCoachWritesIsToldInTheBoardsOwnWords() async throws {
    let phone = try await phone()
    phone.coach.open(in: phone.room, from: .foot)
    await phone.coach.send("I finished Read the wind")
    #expect(phone.room.band?.says.words == "Read the wind done")
    #expect(phone.coach.conversation?.messages.last?.receipts?.map { $0.receipt?.change } == [.completed])
  }

  // A conversation continued from History is about what its record says, here every roadmap: Coach is told of every
  // roadmap, offered no direct write, and writes into none.
  @Test func aConversationContinuedFromHistoryRunsAboutItsOwnScope() async throws {
    let phone = try await phone()
    guard case .committed(let other, _) = try phone.runner.runAct(RoadmapDomain.OpenTurn(about: .init(treeId: nil), question: "Which roadmap first?")) else {
      throw AppFailure(message: "no turn")
    }
    _ = try phone.runner.runAct(RoadmapDomain.EndTurn(other.coach, state: .completed, text: "Sailing first."))
    phone.coach.open(in: phone.room, from: .foot)
    phone.coach.show(other.thread)
    #expect(phone.coach.about == .init(treeId: nil, step: nil, stepLabel: nil, writes: false))
    await phone.coach.send("add a subtask: check the tide")

    let conversation = try #require(phone.coach.conversation)
    let answer = try #require(conversation.messages.last)
    #expect(conversation.thread.id == other.thread && conversation.thread.treeId == nil)
    #expect(answer.calls?.first?.ability == CoachCall.context && answer.calls?.first?.treeId == nil, "an all-roadmaps conversation is told of every roadmap")
    #expect(try answer.receipts == [] && (subtasks(phone)) == [], "a conversation about every roadmap writes into none")
    #expect(CoachSheet(coach: phone.coach, roadmap: phone.room).scope == "All roadmaps")
  }

  // In a roadmap gone into, two rooms deep, the composer, a row's Ask Coach and a step's page ask about that roadmap and its
  // step, and a direct write lands there.
  @Test func aRoadmapGoneIntoTwoDeepIsWhatCoachAsksAboutAndWritesIn() async throws {
    let phone = try await phone()
    let sail = phone.planted
    let skipper = try RoadmapFixture.plant(RoadmapFixture.others[1], opening: sail.tree, by: phone.runner)
    let spanish = try RoadmapFixture.plant(RoadmapFixture.others[0], opening: sail.tree, by: phone.runner)
    let wind = try #require(sail.steps.first { $0.key == "read" }?.id)
    guard case .committed = try phone.runner.runAct(PointStep.set(tree: sail.tree, step: wind, opens: spanish.tree)) else { throw AppFailure(message: "no pointer") }
    for _ in 0..<100 where phone.room.roadmaps.count < 3 { await phone.engine.settleViews(); phone.room.observe() }
    phone.room.open(skipper.tree.description, from: .menu)
    for _ in 0..<100 where phone.room.shown?.listed.title != "Become a day skipper" { await phone.engine.settleViews(); phone.room.observe() }
    let learn = try #require(phone.room.shown?.rows.values.first { $0.step.label == "Learn to sail" })
    phone.room.goIn(learn, by: .foot)
    let inside = try #require(phone.room.inside)
    let read = try #require(inside.shown?.rows.values.first { $0.step.label == "Read the wind" })
    inside.goIn(read, by: .foot)
    let deepest = try #require(inside.inside)
    let order = try #require(deepest.shown?.rows.values.first { $0.step.label == "Order at a café" })

    phone.coach.open(in: deepest, about: (order.id, order.step.label), from: .row)
    #expect(phone.coach.about == .init(treeId: spanish.tree.description, step: order.id, stepLabel: "Order at a café", writes: true))
    await phone.coach.send("add a subtask: practise ordering")
    let thread = try #require(phone.coach.conversation?.thread)
    #expect(thread.treeId == spanish.tree.description && thread.stepId == order.id)
    #expect(try subtasks(phone, of: spanish.tree) == ["Practise ordering"])
    #expect(try subtasks(phone, of: skipper.tree) == [] && (subtasks(phone, of: sail.tree)) == [])

    // The composer at the foot of the room one deep asks about *Learn to sail*, and starts a conversation of its own.
    phone.coach.focused = false
    phone.coach.open(in: inside, from: .foot)
    #expect(phone.coach.about?.treeId == sail.tree.description && phone.coach.thread == nil)
  }

  // While a turn this phone marked is read back, a question waits in the field and no record is written.
  @Test func aQuestionSentWhileATurnIsRecoveredWaitsInTheField() async throws {
    let phone = try await phone()
    guard case .committed(let stale, _) = try phone.runner.runAct(RoadmapDomain.OpenTurn(about: .init(treeId: phone.planted.tree.description),
                                                                                            question: "What’s next?")) else { throw AppFailure(message: "no turn") }
    _ = try phone.runner.runAct(BeginRound(stale.coach, callId: "AAAAAAAAAAAAAAAAAAAAAA", text: ""))
    let recovering = Task { await phone.coach.recover() }
    for _ in 0..<3 { await Task.yield() }
    phone.coach.open(in: phone.room, from: .foot)
    phone.coach.field = "Is this realistic?"
    await phone.coach.send()
    await recovering.value

    #expect(try coachMessages(phone).map(\.id) == [stale.coach] && (coachMessages(phone)).allSatisfy { $0.state != .running })
    #expect(try marks(phone) == 0)
    #expect(phone.coach.field == "Is this realistic?" && phone.coach.running == nil)
  }

  // A seat change holds Coach from its start until it has finished: a question sent between waits in the field.
  @Test func aQuestionSentWhileTheSeatChangesWaitsInTheField() async throws {
    let phone = try await phone()
    phone.coach.open(in: phone.room, from: .foot)
    await phone.coach.seatWillChange()
    phone.coach.field = "Is this realistic?"
    await phone.coach.send()
    #expect(try phone.coach.field == "Is this realistic?" && phone.coach.thread == nil && (coachMessages(phone)).isEmpty)
    phone.coach.seatChangeFinished()
    await phone.coach.send()
    #expect(try phone.coach.field.isEmpty && (coachMessages(phone)).map(\.state) == [.completed])
  }

  @Test func aSeatChangeMidTurnEndsItInterrupted() async throws {
    let phone = try await phone()
    phone.coach.open(in: phone.room, from: .foot)
    let asking = Task { await phone.coach.send("take your time") }
    for _ in 0..<500 where phone.coach.running == nil { await Task.yield() }
    try await Task.sleep(for: .milliseconds(500))
    await phone.coach.seatWillChange()
    await asking.value
    #expect(try coachMessages(phone).map(\.state) == [.interrupted] && (marks(phone)) == 0 && phone.coach.running == nil)
  }

  // A seat the phone cannot read is reported and refuses the send, the question kept; it never becomes the anonymous seat.
  @Test func aSeatThePhoneCannotReadKeepsTheQuestion() async throws {
    let phone = try await phone(seat: { throw AppFailure(message: "the account could not be read") })
    phone.coach.open(in: phone.room, from: .foot)
    phone.coach.field = "Should I add a night sail?"
    await phone.coach.send()
    #expect(try phone.coach.field == "Should I add a night sail?" && phone.coach.thread == nil && (coachMessages(phone)).isEmpty)
    #expect(events(phone, "client_error") == [["operation": "roadmap-coach-turn", "failure_kind": "storage"]])
  }

  @Test func withNoConnectionTheQuestionStaysInTheFieldAndNothingIsWritten() async throws {
    let phone = try await phone(online: false)
    phone.coach.open(in: phone.room, from: .foot)
    phone.coach.field = "Should I add a night sail?"
    await phone.coach.send()
    #expect(phone.coach.field == "Should I add a night sail?" && phone.coach.notice == .offline && phone.coach.thread == nil)
    #expect(try phone.runner.read(CoachThread.scope) { try $0.repository(CoachThread.self).all(in: .drawn) }.isEmpty)
    #expect(events(phone, "roadmap_coach_ask_refused") == [["reason": "offline"]])
  }

  @Test func aSpentAllowanceGivesTheQuestionBackWithTheDayItRenews() async throws {
    let phone = try await phone(allowance: .spent)
    phone.coach.open(in: phone.room, from: .foot)
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
    #expect(try marks(phone) == 0)
  }

  // History's swipe holds the conversation's delete with the room's band and its Undo, which brings it back.
  @Test func historyListsTheOpenRoadmapsConversationsAndItsSwipeIsHeldWithUndo() async throws {
    let phone = try await phone()
    phone.coach.open(in: phone.room, from: .foot)
    await phone.coach.send("What’s next?")
    let thread = try #require(phone.coach.thread)
    #expect(phone.coach.history()?.current.map(\.thread.id) == [thread])
    phone.room.letBandGo()
    phone.coach.delete(thread)
    #expect(phone.coach.history()?.current == [] && phone.coach.thread == nil)
    #expect(phone.room.band?.says == .deletedConversation("What’s next?") && phone.room.band?.says.words == "What’s next? deleted")
    #expect(phone.room.band?.undo?.held == true && phone.room.band?.undo?.act == .conversation)
    phone.room.undo()
    #expect(phone.coach.history()?.current.map(\.thread.id) == [thread])
  }

  // What Coach Read says only what a call recorded: a roadmap's done count where the read kept one, and a step the copy
  // still holds by its name, never its id.
  @Test func whatCoachReadSaysOnlyWhatTheRecordHolds() async throws {
    let phone = try await phone()
    let tree = phone.planted.tree.description, read = step("read", of: phone)
    let page = WhatCoachRead(coach: phone.coach, roadmap: phone.room, message: ID(RecordID("m")))
    let rows = page.rows([CoachCall(ability: "get_tree", treeId: tree, steps: 8), CoachCall(ability: CoachCall.context, treeId: tree, steps: 8, done: 2),
                          CoachCall(ability: "get_nodes", treeId: tree, nodeIds: [read.id, "n_gone"])])
    #expect(rows.map { "\($0.title) · \($0.detail)" } == ["Learn to sail · 8 steps", "Learn to sail · 8 steps · 2 done", "Read the wind · Its line on the Board"])
    let states: JSON = ["steps": [["id": "a", "state": "complete"], ["id": "b", "state": "locked"], ["id": "c", "state": "complete"]]]
    let call = ToolCall(id: "c1", name: "get_tree", input: ["treeId": .string(tree), "fields": ["state"]])
    #expect(RoadmapTurnHost.call(call, outcome: "ok", answer: states).done == 2)
    #expect(RoadmapTurnHost.call(call, outcome: "ok", answer: ["steps": [["id": "a"]]]).done == nil)
  }
}
