import Foundation
import Testing
import UIKit
import Synchronization
import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import SyncEngine
import SyncModelServer
import SyncSchema
import SyncTesting
@testable import Windmill

// The turn driver against a scripted server (Coach §10.1): every exchange of `packages/api-contract/gym/turns/` replayed
// as the phone, then the turns a process death or a seat change left running, the local admission that keeps the draft,
// the picture's model copy, and the text that lands in coalesced commits.
@Suite(.serialized) @MainActor struct CoachTurnTests {
  struct Phone {
    let runtime: AppRuntime
    let gym: GymModel
    let coach: CoachConversation
    let telemetry: TelemetryRecorder
    let cache: CoachDraftStore
    let connectivity: SwitchedConnectivity
    @MainActor var driver: CoachTurnDriver { gym.coachTurns! }
  }

  // A phone on a fresh engine, signed in for a bound seat, holding an installation credential for an anon seat, whose
  // Coach wire speaks to the scripted server; the gym holds the movements and routines the exchanges name.
  func phone(seat: String, beat: Duration = .milliseconds(5)) async throws -> Phone {
    let telemetry = TelemetryRecorder(), transport = JournalModelTransport(), connectivity = SwitchedConnectivity()
    let credentials = InstallationMemoryStore(String(repeating: "a", count: 43))
    let installation = AiInstallation(baseURL: URL(string: "https://gym.invalid"), credentials: credentials, telemetry: telemetry)
    let runtime = try GymModelTests().runtime(telemetry: telemetry, transport: transport, drivesLoops: seat == "bound", connectivity: connectivity, installation: installation)
    if seat == "bound" {
      let identity = transport.identity(email: "turns@example.com")
      _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
      await runtime.engine.start()
      try await settle { (try? runtime.runner.read(Gym.scope) { try $0.firstPullComplete() }) == true }
    }
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [TurnFixtureProtocol.self]
    let wire = CoachTurnWire(baseURL: URL(string: "https://coach.invalid"), session: URLSession(configuration: config))
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry, waits: GymWaits(coachBeat: beat), coachWire: wire)
    for (id, name) in [("rt_00000001", "Push A"), ("rt_00000002", "Pull A")] {
      var routine = Draft(new: Routine(id: ID(RecordID(id)), name: name, entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
      _ = gym.save(&routine)
    }
    let cache = CoachDraftStore(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
    let coach = CoachConversation(gym: gym, store: cache)
    await coach.activate()
    return Phone(runtime: runtime, gym: gym, coach: coach, telemetry: telemetry, cache: cache, connectivity: connectivity)
  }

  func settle(_ condition: () -> Bool) async throws {
    for _ in 0..<600 { if condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
    Issue.record("The turn did not settle")
  }

  func messages(_ phone: Phone) throws -> [CoachMessage] {
    try phone.gym.runner.read(Gym.scope) { try $0.repository(CoachMessage.self).all(in: .drawn) }.inOrder
  }

  func send(_ phone: Phone, _ question: String) async throws {
    phone.coach.edit(question); phone.coach.send()
    try await settle { !phone.coach.sending }
    try await settle { phone.driver.running == nil }
  }

  nonisolated static let exchanges = (try? Contract.files(under: "gym/turns")) ?? []

  @Test(arguments: exchanges) func everyExchangeReplaysAsThePhone(file: String) async throws {
    let vector = try Contract.json(file)
    let seat = try vector.member("seat").asString(), open = try vector.member("open"), end = try vector.member("end")
    let phone = try await phone(seat: seat)
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    let script = TurnScript(events: try vector.member("events").asArray(), lostOnResume: false)
    TurnFixtureProtocol.state.withLock { $0 = script }
    let history = try open.member("history").asArray()
    if !history.isEmpty {
      #expect(committed(try phone.gym.runner.run(SeedConversation(id: ID("thrdSeededHistory"), title: try history[0].member("text").asString(),
        at: Instant(ms: 1_790_000_000_000), calls: [], answer: try history[1].member("text").asString()))) != nil)
      var next = phone.coach.saved; next.conversation = "thrdSeededHistory"; next.threadId = "thrdSeededHistory"
      #expect(phone.coach.keep(next, failure: "x")); phone.coach.observe()
    }
    let question = try open.member("question").asString()
    let stopAfter = try? vector.member("stop")
    if stopAfter != nil {
      phone.coach.edit(question); phone.coach.send()
      try await settle { TurnFixtureProtocol.state.withLock { $0.pending == "stop" } }
      phone.driver.requestStop()
      try await settle { !phone.coach.sending && phone.driver.running == nil }
    } else {
      try await send(phone, question)
    }
    let said = try messages(phone).filter { $0.threadId == phone.coach.thread }
    let answer = try #require(said.last { $0.role == .coach })
    let lifter = try #require(said.last { $0.role == .lifter })
    #expect(lifter.text == question)
    #expect(answer.state.rawValue == (try end.member("state").asString()), Comment(rawValue: file))
    #expect(answer.truncated == ((try? end.member("truncated").asBool()) ?? false), Comment(rawValue: file))
    #expect(answer.text == script.expectedText, Comment(rawValue: file))
    #expect(answer.receipt != nil)
    let sent = TurnFixtureProtocol.state.withLock { $0.requests }
    let opened = try #require(sent.first { $0.path == "/v1/gym/coach/turns" })
    #expect(opened.headers["X-Windmill-Installation"] == (seat == "anon" ? String(repeating: "a", count: 43) : nil))
    #expect((opened.headers["Authorization"]?.hasPrefix("Bearer ") ?? false) == (seat == "bound"))
    let body = try #require(opened.body)
    #expect(try body.member("catalog").asString() == "catalog/2")
    #expect(try body.member("question").asString() == question)
    #expect(try body.member("turnId").asString() == answer.id.description)
    let sentHistory = try body.member("history"), expectedHistory = try open.member("history")
    #expect(sentHistory == expectedHistory)
    let contextNames = try body.member("context").asArray().map { try $0.member("name").asString() }
    #expect(contextNames == CoachTurnBounds.contextReads)
    // The calls the server sent, in order, follow the four context reads on the Coach message, each with its outcome.
    // Every batch the server asked of the phone, a snapshot's unanswered batch among them: the phone runs it again and
    // posts again, and the server answers the replay with 204.
    let batches = try script.events.compactMap { frame -> TurnBatch? in
      switch try? frame.member("event").asString() {
      case "calls": return try TurnBatch(try frame.member("data"))
      case "snapshot": return try (try? frame.member("data").member("calls")).flatMap { $0.isNull ? nil : try TurnBatch($0) }
      default: return nil
      }
    }
    #expect(answer.calls.map(\.name) == CoachTurnBounds.contextReads + batches.flatMap { $0.calls.map(\.name) }, Comment(rawValue: file))
    let answered = sent.filter { $0.path.hasSuffix("/results") }
    let answeredBatches = try answered.map { try $0.body?.member("batch").asInteger() }
    #expect(answeredBatches == batches.map { Int64($0.batch) }, Comment(rawValue: file))
    for (request, batch) in zip(answered, batches) {
      let callIds = try request.body?.member("results").asArray().map { try $0.member("callId").asString() }
      #expect(callIds == batch.calls.map(\.callId))
    }
    // A failed turn's code becomes the refusal said at the conversation's end only where it names a cap or a door; a
    // code that names neither is said by the message's own ending line alone (08.48).
    if let code = try? end.member("code").asString(), case let expected = CoachTurnRefusal(code: code), expected != .said(code) {
      #expect(phone.driver.refusal == expected, Comment(rawValue: file))
    } else {
      #expect(phone.driver.refusal == nil, Comment(rawValue: file))
    }
    let outcome = phone.telemetry.entries.withLock { $0.filter { $0.name == "gym_ask_outcome" } }.last?.properties["outcome"]
    #expect(outcome == CoachTurnDriver.outcome(of: answer.state) || (answer.state == .failed && outcome == "capped"), Comment(rawValue: file))
    let turn = phone.telemetry.entries.withLock { $0.filter { $0.name == "coach_turn" } }
    #expect(turn.map { $0.properties["state"] } == [answer.state.rawValue] && turn.first?.properties["seat"] == seat, Comment(rawValue: file))
    #expect(!phone.telemetry.entries.withLock { $0.flatMap { $0.properties.values } }.contains { $0.contains(question) })
  }

  @Test func everyTurnRouteCarriesTheGeneratedSchemaAndOnlyItsOpeningSeat() throws {
    let wire = CoachTurnWire(baseURL: URL(string: "https://coach.invalid"))
    for seat in [TurnSeat.bound(token: "private-token"), .anon(credential: "private-installation")] {
      for (path, method) in [("/v1/gym/coach/turns", "POST"), ("/v1/gym/coach/turns/fixture", "GET"),
                             ("/v1/gym/coach/turns/fixture/results", "POST"), ("/v1/gym/coach/turns/fixture/stop", "POST")] {
        let request = try wire.request(path, method: method, seat: seat)
        #expect(request.value(forHTTPHeaderField: "Sync-Schema") == String(SyncSchema.version))
        #expect(request.httpMethod == method && request.url?.path == path)
        #expect(request.value(forHTTPHeaderField: "Authorization") == (seat == .bound(token: "private-token") ? "Bearer private-token" : nil))
        #expect(request.value(forHTTPHeaderField: "X-Windmill-Installation") == (seat == .anon(credential: "private-installation") ? "private-installation" : nil))
      }
    }
  }

  @Test(arguments: ["bound", "anon"]) func schemaRefusalWithdrawsTheLocalTurnAndKeepsTheDraft(seat: String) async throws {
    let phone = try await phone(seat: seat)
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [], lostOnResume: false); $0.refuseOpen = (426, "client-update-required") }
    try await send(phone, "Private question")
    #expect(try messages(phone).isEmpty)
    try await settle { phone.coach.saved.text == "Private question" }
    #expect(phone.coach.thread == nil && phone.coach.saved.conversation == nil)
    #expect(phone.driver.refusal == .updateRequired && phone.coach.canCompose)
    let requests = TurnFixtureProtocol.state.withLock { $0.requests }
    #expect(requests.map(\.path) == ["/v1/gym/coach/turns"])
    #expect(requests.first?.headers["Sync-Schema"] == String(SyncSchema.version))
    let events = phone.telemetry.entries.withLock { $0 }
    #expect(events.filter { $0.name == "client_error" }.isEmpty)
    #expect(!events.flatMap { $0.properties.values }.contains { $0.contains("Private question") || $0.contains("private-token") })
  }

  // A turn the server no longer knows on resume ends interrupted, and the same results posted again are a replay.
  @Test func aLostTurnEndsInterruptedAndResultsReplay() async throws {
    let phone = try await phone(seat: "bound")
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    let events: [JSON] = [["event": "text", "data": ["delta": "Checking."]], ["await": "resume"], ["event": "done", "data": ["state": "completed"]]]
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: events, lostOnResume: true) }
    try await send(phone, "What routines do I have?")
    let answer = try #require(try messages(phone).last { $0.role == .coach })
    #expect(answer.state == .interrupted && answer.text == "Checking.")
    #expect(phone.driver.error == nil && phone.driver.refusal == nil)
    #expect(TurnFixtureProtocol.state.withLock { $0.requests.map(\.path).filter { $0.hasPrefix("/v1/gym/coach/turns/") }.count } == 1)
    let wire = phone.driver.wire
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [], lostOnResume: false); $0.answered.insert(1) }
    #expect(try await wire.answer("tn_replay", batch: 1, results: [TurnResult(callId: "c", outcome: .ok(["routines": []]))], seat: .bound(token: "t")) == .replayed)
    #expect(phone.telemetry.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } == [])
  }

  // A turn the process died under is ended at engine start, and a turn whose replica changed under it ends interrupted
  // by that one write, while another device never writes a running turn it did not open.
  @Test func abandonedAndSeatChangedTurnsEndInterrupted() async throws {
    let phone = try await phone(seat: "anon")
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    let turn = try #require(committed(try phone.gym.runner.run(OpenTurn(question: "Still here?"))))
    #expect(try phone.gym.runner.read(Gym.scope) { try $0.device(EndTurn.runningTurnKey) } == turn.coach.json)
    phone.driver.start()
    let ended = try #require(try messages(phone).first { $0.id == turn.coach })
    #expect(ended.state == .interrupted)
    #expect(try phone.gym.runner.read(Gym.scope) { try $0.device(EndTurn.runningTurnKey) } == nil)
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [["event": "text", "data": ["delta": "On it."]], ["await": "stop"], ["event": "done", "data": ["state": "stopped"]]], lostOnResume: false) }
    phone.coach.edit("Add three new days."); phone.coach.send()
    try await settle { TurnFixtureProtocol.state.withLock { $0.pending == "stop" } }
    let running = try #require(phone.driver.running)
    let replica = try phone.gym.runner.read(Gym.scope) { $0.replica }
    phone.driver.seatChanged(from: replica)
    #expect(phone.driver.running == nil)
    #expect(try messages(phone).first { $0.id == running.turn.coach }?.state == .interrupted)
    // The server is told to stop once, so its slot is not held for CALL_RESULT_TIMEOUT.
    try await settle { TurnFixtureProtocol.state.withLock { $0.requests.contains { $0.path == "/v1/gym/coach/turns/\(running.turnId)/stop" } } }
    phone.driver.stop()
  }

  // Coach §4.5, the writer rule: another device never writes a running turn it did not open, and its text commits land
  // only from the replica named on the message.
  @Test func anotherDeviceNeverWritesARunningTurn() throws {
    let a = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: "coach-owner",
                    rules: ComposedServerRules.windmill(registry: SyncSchema.registry), commandResultWrites: AppRuntime.commandResultWrites)
    let turn = try #require(committed(try a.runner.run(OpenTurn(question: "Still here?"))))
    #expect(committed(try a.runner.run(StreamTurnText(message: turn.coach, text: "On"))) != nil)
    let b = a.device()
    a.sync()
    #expect(try b.stored(CoachMessage.self).first { $0.id == turn.coach }?.text == "On")
    #expect(unchanged(try b.runner.run(StreamTurnText(message: turn.coach, text: "Elsewhere"))) != nil)
    #expect(try b.runner.read(Gym.scope) { try $0.device(EndTurn.runningTurnKey) } == nil)
    b.sync()
    #expect(try a.stored(CoachMessage.self).first { $0.id == turn.coach }?.state == .running)
    #expect(committed(try a.runner.run(EndTurn(turn.coach, state: .completed, text: "On it."))) != nil)
    a.sync()
    #expect(try b.stored(CoachMessage.self).first { $0.id == turn.coach }?.text == "On it.")
  }

  // A send refused locally keeps the draft and sends nothing: no connection, a question past the bound.
  @Test func localAdmissionKeepsTheDraft() async throws {
    let phone = try await phone(seat: "anon")
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [], lostOnResume: false) }
    phone.connectivity.set(online: false)
    try await settle { phone.coach.offline }
    phone.coach.edit("Private question"); phone.coach.send()
    try await settle { phone.driver.refusal == .offline }
    #expect(!phone.coach.asking && phone.coach.saved.text == "Private question")
    phone.connectivity.set(online: true)
    try await settle { !phone.coach.offline }
    phone.coach.edit(String(repeating: "x", count: CoachRules.maxQuestionBytes + 1)); phone.coach.send()
    try await settle { !phone.coach.sending }
    #expect(!phone.coach.asking && phone.coach.saved.text.utf8.count == 8001)
    let recorded = try messages(phone)
    #expect(TurnFixtureProtocol.state.withLock { $0.requests.isEmpty } && recorded.isEmpty)
    #expect(phone.telemetry.entries.withLock { $0.filter { $0.name == "gym_ask_outcome" }.map { $0.properties["outcome"] ?? "" } } == ["offline"])
  }

  // Coach answers during a workout: the open workout is the first session its context reads, and the turn reads the
  // workout itself after the four list reads (Coach §4.1 step 3), each recorded on the Coach message.
  @Test func aSendDuringAWorkoutReadsTheOpenWorkout() async throws {
    let phone = try await phone(seat: "anon")
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [["event": "text", "data": ["delta": "Keep going."]], ["event": "done", "data": ["state": "completed"]]], lostOnResume: false) }
    let session = phone.gym.runner.mint(Session.self)
    #expect(phone.gym.run(StartSession(id: session))?.receipt != nil)
    try await send(phone, "How is this workout going?")
    #expect(phone.driver.refusal == nil && phone.gym.openSession?.id == session)
    let body = try #require(TurnFixtureProtocol.state.withLock { $0.requests.first { $0.path == "/v1/gym/coach/turns" }?.body })
    let sessions = try #require(try body.member("context").asArray().first { try $0.member("name").asString() == "list_sessions" })
    let open = try sessions.member("result").member("sessions").asArray().first
    #expect(try open?.member("id").asString() == session.record.string && (try? open?.member("finishedAt")) == nil)
    let reads: [String] = CoachTurnBounds.contextReads + ["get_session"]
    let context = try body.member("context").asArray()
    let sent: [String] = try context.map { try $0.member("name").asString() }
    #expect(sent == reads)
    let workout = try #require(context.last)
    #expect(try workout.member("input") == ["sessionId": session.json])
    #expect(try workout.member("result").member("session").member("id").asString() == session.record.string)
    let answer = try #require(try messages(phone).last { $0.role == .coach })
    #expect([answer.text, answer.state.rawValue] == ["Keep going.", "completed"])
    let recorded: [String] = answer.calls.map(\.name)
    #expect(recorded == reads && answer.calls.allSatisfy { $0.outcome == .ok })
    let reported: [String] = phone.telemetry.entries.withLock { $0.filter { $0.name == "coach_ability" }.map { $0.properties["name"] ?? "" } }
    #expect(reported == reads)
    #expect(phone.telemetry.entries.withLock { $0.filter { $0.name == "gym_ask_outcome" }.map { $0.properties["outcome"] ?? "" } } == ["answered"])
  }

  // A refusal before the stream withdraws the turn: the question returns to the field, and no message or picture row stays.
  @Test func aRefusalBeforeTheStreamWithdrawsTheTurn() async throws {
    let phone = try await phone(seat: "anon")
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    try phone.coach.addPhoto(UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { _ in }.jpegData(compressionQuality: 0.9)!)
    let photo = try #require(phone.coach.saved.photo)
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [], lostOnResume: false); $0.refuseOpen = (429, "subject_exhausted") }
    try await send(phone, "Private question")
    #expect(try messages(phone).isEmpty)
    #expect(try phone.gym.runner.read(Gym.scope) { try $0.device(CoachPictureRow.key(photo.id)) } == nil)
    try await settle { phone.coach.saved.text == "Private question" }
    #expect(phone.coach.thread == nil && phone.coach.saved.conversation == nil)
    #expect(phone.driver.refusal == .allowance("subject_exhausted") && !phone.coach.canCompose)
    #expect(phone.telemetry.entries.withLock { $0.filter { $0.name == "gym_ask_outcome" }.map(\.properties) }.last == ["screen": "coach", "outcome": "capped", "cap": "allowance"])
    #expect(phone.telemetry.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
  }

  // A batch the server timed out is refused coach-turn-order (Coach §6.4): the turn ends interrupted with that code on
  // its event, an expected refusal that reports nothing and names nothing on the band but the interruption.
  @Test func aBatchTheServerTimedOutEndsInterruptedWithItsCode() async throws {
    let phone = try await phone(seat: "bound")
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    let events = try Contract.json("gym/turns/result-timeout-interrupted.json").member("events").asArray()
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: events, lostOnResume: false) }
    try await send(phone, "What routines do I have?")
    let answer = try #require(try messages(phone).last { $0.role == .coach })
    #expect(answer.state == .interrupted && answer.calls.map(\.name).last == "list_routines")
    #expect(phone.driver.refusal == nil && phone.driver.error == nil)
    let turn = phone.telemetry.entries.withLock { $0.filter { $0.name == "coach_turn" }.map(\.properties) }
    #expect(turn.map { $0["state"] } == ["interrupted"] && turn.map { $0["code"] } == ["coach-turn-order"])
    #expect(phone.telemetry.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } == [])
  }

  // The model copy keeps within the model's edge and byte bounds beside the original, and the open request carries it.
  @Test func aPictureSendsItsModelCopyAndKeepsTheOriginalOnThePhone() async throws {
    let phone = try await phone(seat: "anon")
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    let format = UIGraphicsImageRendererFormat(); format.scale = 1
    let large = UIGraphicsImageRenderer(size: CGSize(width: 4000, height: 3000), format: format).image { context in
      for x in stride(from: 0, to: 4000, by: 10) { UIColor(hue: CGFloat(x % 360) / 360, saturation: 1, brightness: 1, alpha: 1).setFill(); context.fill(CGRect(x: x, y: 0, width: 10, height: 3000)) }
    }.jpegData(compressionQuality: 1)!
    try phone.coach.addPhoto(large)
    let attachment = try #require(phone.coach.saved.photo)
    let copy = try CoachPhotoPreparation.modelCopy(of: try #require(phone.coach.saved.photoData), attachment: attachment)
    let model = try #require(UIImage(data: copy.model))
    #expect(max(model.size.width, model.size.height) <= 1568 && copy.model.count <= 1024 * 1024 && copy.original == phone.coach.saved.photoData)
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [["event": "text", "data": ["delta": "A fine program."]], ["event": "done", "data": ["state": "completed"]]], lostOnResume: false) }
    try await send(phone, "")
    let lifter = try #require(try messages(phone).first { $0.role == .lifter })
    #expect(lifter.pictures == [Picture(id: attachment.id, mediaType: "image/jpeg", localOnly: true)] && lifter.text == "")
    let row = CoachPictureRow(id: attachment.id, json: try phone.gym.runner.read(Gym.scope) { try $0.device(CoachPictureRow.key(attachment.id)) })
    #expect(row?.original == copy.original && row?.model == copy.model)
    let body = try #require(TurnFixtureProtocol.state.withLock { $0.requests.first { $0.path == "/v1/gym/coach/turns" }?.body })
    #expect(try body.member("pictures").asArray().map { try $0.member("id").asString() } == [attachment.id])
    #expect(try Data(base64Encoded: body.member("pictures").asArray()[0].member("data").asString()) == copy.model)
    #expect(phone.coach.saved.photo == nil && phone.coach.saved.photoData == nil)
  }

  @Test func textCommitsInCoalescedChunks() async throws {
    let phone = try await phone(seat: "anon", beat: .seconds(1))
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [["await": "stop"], ["event": "done", "data": ["state": "stopped"]]], lostOnResume: false) }
    phone.coach.edit("Stream it"); phone.coach.send()
    try await settle { TurnFixtureProtocol.state.withLock { $0.pending == "stop" } }
    let running = try #require(phone.driver.running)
    var seen = [try #require(try messages(phone).last { $0.role == .coach }?.text)]
    for index in 1...5 {
      phone.driver.streamed += "word\(index) "
      phone.driver.scheduleTextCommit(running)
      let text = try #require(try messages(phone).last { $0.role == .coach }?.text)
      #expect(text == "")
      if seen.last != text { seen.append(text) }
    }
    let flush = try #require(phone.driver.textFlush)
    await flush.value
    seen.append(try #require(try messages(phone).last { $0.role == .coach }?.text))
    #expect(seen == ["", "word1 word2 word3 word4 word5 "])
    phone.driver.requestStop()
    try await settle { phone.driver.running == nil }
    let message = try #require(try messages(phone).last { $0.role == .coach })
    #expect(message.text == "word1 word2 word3 word4 word5 " && message.state == .stopped)
  }

  // Deleting a conversation removes its thread, its messages and the pictures it kept on this phone.
  @Test func deletingAConversationRemovesItsRecordsAndPictures() async throws {
    let phone = try await phone(seat: "anon")
    defer { try? FileManager.default.removeItem(at: phone.cache.directory) }
    try phone.coach.addPhoto(UIGraphicsImageRenderer(size: CGSize(width: 40, height: 40)).image { _ in }.jpegData(compressionQuality: 0.9)!)
    let photo = try #require(phone.coach.saved.photo)
    TurnFixtureProtocol.state.withLock { $0 = TurnScript(events: [["event": "done", "data": ["state": "completed"]]], lostOnResume: false) }
    try await send(phone, "Look at this")
    let thread = try #require(phone.coach.thread)
    #expect(try messages(phone).count == 2)
    #expect(phone.coach.delete(thread.description))
    #expect(try messages(phone).isEmpty && phone.coach.thread == nil)
    #expect(try phone.gym.runner.read(Gym.scope) { try $0.repository(CoachThread.self).all(in: .drawn) }.isEmpty)
    #expect(try phone.gym.runner.read(Gym.scope) { try $0.device(CoachPictureRow.key(photo.id)) } == nil)
  }
}

// The server as one exchange scripts it: the frames it sends in order, pausing where the script awaits the phone.
nonisolated struct TurnScript: Sendable {
  struct Request: Sendable {
    let path: String
    let method: String
    let body: JSON?
    let headers: [String: String]
  }
  var events: [JSON]
  var lostOnResume: Bool
  var position = 0
  var pending: String?
  var requests: [Request] = []
  var answered: Set<Int64> = []
  var refuseOpen: (Int, String)?
  var stream: TurnFixtureProtocol?

  // The answer the phone should hold once the script ran: deltas appended, a snapshot replacing what came before.
  var expectedText: String {
    var text = ""
    for frame in events {
      switch try? frame.member("event").asString() {
      case "text": text += (try? frame.member("data").member("delta").asString()) ?? ""
      case "snapshot": text = (try? frame.member("data").member("text").asString()) ?? text
      default: break
      }
    }
    return text
  }
}

nonisolated final class TurnFixtureProtocol: URLProtocol, @unchecked Sendable {
  static let state = Mutex(TurnScript(events: [], lostOnResume: false))

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let path = request.url!.path, method = request.httpMethod ?? "GET"
    var data = request.httpBody ?? Data()
    if data.isEmpty, let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count)) }
    }
    let body = data.isEmpty ? nil : try? JSON(parsing: Array(data))
    let headers = request.allHTTPHeaderFields ?? [:]
    Self.state.withLock { $0.requests.append(TurnScript.Request(path: path, method: method, body: body, headers: headers)) }
    if path == "/v1/gym/coach/turns" {
      if let (status, code) = Self.state.withLock({ $0.refuseOpen }) { respond(status, ["error": "refused", "code": .string(code)]); return }
      Self.state.withLock { $0.stream = self }
      open(); advance(); return
    }
    guard path.hasPrefix("/v1/gym/coach/turns/") else { respond(404, ["error": "no", "code": "coach-turn-unknown"]); return }
    if path.hasSuffix("/results") {
      let batch = (try? body?.member("batch").asInteger()) ?? 0
      let answer: (Int, JSON) = Self.state.withLock { script in
        // The same body again is a replay; a batch answered while the stream is down is taken, since the batch waits on the
        // server whatever the stream does, and the script moves on only where it awaited these results. A batch the server
        // timed out answers coach-turn-order, and the turn ends interrupted behind it.
        if script.answered.contains(batch) {
          if script.pending == "results:\(batch)" { script.pending = nil; return (204, [:]) }
          return (-204, [:])
        }
        if script.pending == "timeout" { script.pending = nil; return (409, ["error": "order", "code": "coach-turn-order"]) }
        guard script.pending == "results:\(batch)" || script.pending == "resume" else { return (409, ["error": "order", "code": "coach-turn-order"]) }
        script.answered.insert(batch)
        if script.pending != "resume" { script.pending = nil }
        return (script.pending == "resume" ? -200 : 200, ["batch": JSON(batch)])
      }
      respond(abs(answer.0), answer.1)
      if answer.0 > 0 || answer.0 == 409 { advance() }
      return
    }
    if path.hasSuffix("/stop") {
      respond(202, ["state": "stopped"])
      if Self.state.withLock({ $0.pending == "stop" }) { Self.state.withLock { $0.pending = nil }; advance() }
      return
    }
    if method == "GET" {
      if Self.state.withLock({ $0.lostOnResume }) { respond(404, ["error": "gone", "code": "coach-turn-unknown"]); return }
      guard Self.state.withLock({ $0.pending == "resume" }) else { respond(409, ["error": "order", "code": "coach-turn-order"]); return }
      Self.state.withLock { $0.pending = nil; $0.stream = self }
      open(); advance(); return
    }
    respond(404, ["error": "no", "code": "coach-turn-unknown"])
  }

  func open() {
    let http = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
    client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(": heartbeat\n\n".utf8))
  }

  // The script's frames from where it stands until it awaits the phone or ends.
  func advance() {
    while true {
      let next: (JSON?, TurnFixtureProtocol?) = Self.state.withLock { script in
        guard script.position < script.events.count else { return (nil, script.stream) }
        let frame = script.events[script.position]
        script.position += 1
        if let pause = try? frame.member("sleep").asInteger() { Thread.sleep(forTimeInterval: Double(pause) / 1000); return (frame, nil) }
        if let wait = try? frame.member("await").asString() {
          switch wait {
          case "results": script.pending = "results:\((try? frame.member("batch").asInteger()) ?? 0)"
          case "resume":
            script.pending = "resume"
            let stream = script.stream; script.stream = nil
            stream?.client?.urlProtocolDidFinishLoading(stream!)
          default: script.pending = wait
          }
          return (frame, nil)
        }
        return (frame, script.stream)
      }
      guard let frame = next.0 else { next.1.map { $0.client?.urlProtocolDidFinishLoading($0) }; return }
      if (try? frame.member("sleep")) != nil { continue }
      guard let stream = next.1 else { return }
      let event = (try? frame.member("event").asString()) ?? "", data = (try? frame.member("data")) ?? [:]
      stream.client?.urlProtocol(stream, didLoad: Data("event: \(event)\ndata: \(data.jcsText)\n\n".utf8))
      if event == "done" || event == "error" { stream.client?.urlProtocolDidFinishLoading(stream); Self.state.withLock { $0.stream = nil }; return }
    }
  }

  func respond(_ status: Int, _ body: JSON) {
    let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.jcs)); client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() { Self.state.withLock { if $0.stream === self { $0.stream = nil } } }
}
