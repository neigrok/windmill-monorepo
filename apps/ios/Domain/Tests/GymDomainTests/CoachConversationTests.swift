import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// A Coach conversation on the real engine: the entities against the registry, a turn opened and ended, and the executor
// recording every call on the Coach message in the one gesture that commits the call's writes (Coach §4.3 step 2).
struct CoachConversationTests {
  static let now = Instant(ms: 1_800_000_000_000)

  static func phone() -> Harness {
    Harness(registry: SyncSchema.registry, start: now)
  }

  static func open(_ h: Harness, _ question: String = "How heavy today?") throws -> OpenTurn.Turn {
    try #require(committed(try h.runner.run(OpenTurn(question: question))))
  }

  static func executor(_ h: Harness) -> AbilityExecutor {
    AbilityExecutor(runner: h.runner, appBaseUrl: "https://windmill.works")
  }

  static func request(_ name: String, _ input: JSON, callId: String = "call-1") -> AbilityRequest {
    AbilityRequest(callId: callId, name: name, input: input)
  }

  static func coachMessage(_ h: Harness, _ turn: OpenTurn.Turn) throws -> CoachMessage {
    try #require(try h.stored(CoachMessage.self).first { $0.id == turn.coach })
  }

  @Test func theEntitiesAgreeWithTheRegistry() throws {
    try RegistryCheck.entity(CoachThread.self, sample: CoachThread(id: ID("thrdAAAAAAAAAAA1"), title: "How heavy today?"), book: CoachRules.book,
                             registry: SyncSchema.registry)
    var served = ReadServed()
    served.saw(week: 1_799_452_800_000)
    let call = AbilityCall(callId: "call-1", name: "list_sessions", input: [:], outcome: .ok, created: [RecordRef(type: "proposal", id: "propA")],
                           read: served)
    let sample = CoachMessage(id: ID("turnAAAAAAAAAAA1"), threadId: ID("thrdAAAAAAAAAAA1"), role: .coach, replica: "rp_00000000000000000000000000000001",
                              text: "Add 5 kg.", state: .completed, truncated: true, receipt: AbilityCall.receipt(of: [call]), calls: [call],
                              pictures: [Picture(id: "picAAAAAAAAAAAA1", mediaType: "image/jpeg", localOnly: true)], at: Self.now)
    try RegistryCheck.entity(CoachMessage.self, sample: sample, book: CoachRules.book, registry: SyncSchema.registry)
    #expect(CoachMessage(id: sample.id, threadId: sample.threadId, role: .lifter, text: "How heavy today?", at: Self.now).fields.keys.sorted()
      == ["at", "role", "text", "threadId"])
    #expect(MessageState.allCases.map(\.rank) == [0, 1, 2, 2, 2, 2])
  }

  @Test func aTurnOpensInOneGestureAndEndsWithItsReceipt() throws {
    let a = Self.phone()
    let turn = try Self.open(a)
    #expect(try a.stored(CoachThread.self).map(\.title) == ["How heavy today?"])
    let messages = try a.stored(CoachMessage.self)
    #expect(messages.map(\.role) == [turn.lifter, turn.coach].sorted().map { $0 == turn.lifter ? CoachMessage.Role.lifter : .coach })
    #expect(try Self.coachMessage(a, turn).state == .running)
    #expect(try a.runner.read(Gym.scope) { try $0.device(EndTurn.runningTurnKey) } == turn.coach.json)
    let b = a.device()
    a.sync()
    #expect(try b.stored(CoachMessage.self).count == 2)

    _ = try #require(committed(try Self.executor(a).run(Self.request("list_notes", [:]), on: turn.coach, seat: .bound)))
    #expect(committed(try a.runner.run(EndTurn(turn.coach, state: .completed, text: "Add 5 kg."))) != nil)
    let ended = try Self.coachMessage(a, turn)
    #expect(ended.state == .completed && ended.text == "Add 5 kg." && ended.truncated == false)
    #expect(ended.receipt == ["read": ["sets": 0, "sessions": 0, "weeks": 0], "results": []])
    #expect(try a.runner.read(Gym.scope) { try $0.device(EndTurn.runningTurnKey) } == nil)
    #expect(unchanged(try a.runner.run(EndTurn(turn.coach, state: .stopped))) != nil)
    #expect(try Self.executor(a).run(Self.request("list_notes", [:], callId: "call-2"), on: turn.coach, seat: .bound).refusal
      == .other(Refused(Gym.Codes.messageFinal, subject: turn.coach.ref, path: .predicted)))
    a.sync()
    #expect(try a.notices(GymRefusal.self).isEmpty)
    #expect(try b.stored(CoachMessage.self).first { $0.id == turn.coach }?.state == .completed)
  }

  @Test func aQuestionPastTheBoundOrBlankIsRefused() throws {
    let a = Self.phone()
    let long = String(repeating: "x", count: CoachRules.maxQuestionBytes + 1)
    #expect(try a.runner.run(OpenTurn(question: long)).refusal
      == .invalid(Violation(rule: CoachRules.question, path: "text", reason: .tooLong(max: 8_000, unit: .bytes, measured: 8_001))))
    #expect(try a.runner.run(OpenTurn(question: " ")).refusal == .invalid(Violation(rule: CoachRules.question, path: "text", reason: .blank)))
    let picture = Picture(id: "picAAAAAAAAAAAA1", mediaType: "image/jpeg", localOnly: true)
    let photo = try #require(committed(try a.runner.run(OpenTurn(question: "", pictures: [picture]))))
    #expect(try a.stored(CoachThread.self).first { $0.id == photo.thread }?.title == "Photo")
    #expect(try a.stored(CoachMessage.self).first { $0.id == photo.lifter }?.pictures == [picture])
  }

  @Test func aWriteAndItsRecordLandInOneGesture() throws {
    let a = Self.phone()
    let turn = try Self.open(a)
    let input: JSON = ["id": "tn7Qm2Kx9Lp4Wz8R-2", "name": "Cable fly", "pattern": "isolation", "equipment": "cable"]
    let outcome = try Self.executor(a).run(Self.request("create_exercise", input), on: turn.coach, seat: .bound)
    let receipt = try #require(outcome.receipt)
    #expect(receipt.ids.count == 2)
    let expected: JSON = ["custom": true, "equipment": "cable", "id": "tn7Qm2Kx9Lp4Wz8R-2", "name": "Cable fly", "pattern": "isolation", "stepKg": 2.5]
    #expect(committed(outcome) == .result(jcs: expected.jcs, sha256: SHA256Hex.of(expected.jcs)))
    #expect(try a.stored(Exercise.self).map(\.id) == [ID("tn7Qm2Kx9Lp4Wz8R-2")])
    let calls = try Self.coachMessage(a, turn).calls
    #expect(calls == [AbilityCall(callId: "call-1", name: "create_exercise", input: input, outcome: .ok,
                                  created: [RecordRef(type: Exercise.type, id: "tn7Qm2Kx9Lp4Wz8R-2")])])

    let replay = try Self.executor(a).run(Self.request("create_exercise", input, callId: "call-2"), on: turn.coach, seat: .bound)
    #expect(committed(replay) == committed(outcome))
    #expect(try #require(replay.receipt).ids.count == 1)
    #expect(try a.stored(Exercise.self).count == 1)
    #expect(try Self.coachMessage(a, turn).calls.map(\.callId) == ["call-1", "call-2"])
    a.sync()
    #expect(try a.notices(GymRefusal.self).isEmpty)
    #expect(a.server.rows(Gym.scope, of: "acct-1").contains { $0.key.type == Exercise.type })
  }

  @Test func aRefusedCallWritesItsRecordAlone() throws {
    let a = Self.phone()
    let turn = try Self.open(a)
    let executor = Self.executor(a)
    let gone = try executor.run(Self.request("last_time", ["exerciseId": "no-such-movement"]), on: turn.coach, seat: .bound)
    #expect(committed(gone) == .refused(.refused))
    #expect(try #require(gone.receipt).ids.count == 1)
    let malformed = try executor.run(Self.request("get_sessions", ["sessionIds": ["a", "a"]], callId: "call-2"), on: turn.coach, seat: .bound)
    #expect(committed(malformed) == .refused(.invalidArguments))
    let withheld = try executor.run(Self.request("log_set", [:], callId: "call-3"), on: turn.coach, seat: .bound)
    #expect(committed(withheld) == .refused(.notOffered))
    let share = try executor.run(Self.request("share_session", ["sessionId": "sesAAAAAAAAAAAA1"], callId: "call-4"), on: turn.coach, seat: .bound)
    #expect(committed(share) == .refused(.notOffered))
    let note = try executor.run(Self.request("save_note", ["id": "tn7Qm2Kx9Lp4Wz8R-4", "title": "Tone", "body": "Blunt."], callId: "call-5"),
                                on: turn.coach, seat: .anon)
    #expect(committed(note) == .refused(.seatRequired))
    #expect(try a.stored(Note.self).isEmpty)
    let calls = try Self.coachMessage(a, turn).calls
    #expect(calls.map(\.outcome) == [.refused(.refused), .refused(.invalidArguments), .refused(.notOffered), .refused(.notOffered), .refused(.seatRequired)])
    #expect(calls.map { $0.input == nil } == [false, true, true, true, true])
    #expect(AbilityCall.receipt(of: calls) == ["read": ["sets": 0, "sessions": 0, "weeks": 0], "results": []])
  }

  @Test func theReceiptCountsByIdentityAcrossCalls() throws {
    let a = Self.phone()
    let turn = try Self.open(a)
    let executor = Self.executor(a)
    _ = try #require(committed(try executor.run(Self.request("list_exercises", [:]), on: turn.coach, seat: .bound)))
    let note = try executor.run(Self.request("save_note", ["id": "tn7Qm2Kx9Lp4Wz8R-4", "title": "Tone", "body": "Blunt."], callId: "call-2"),
                                on: turn.coach, seat: .bound)
    let saved: JSON = ["saved": true, "note": ["id": "tn7Qm2Kx9Lp4Wz8R-4", "position": 0, "title": "Tone", "body": "Blunt."]]
    #expect(committed(note) == .result(jcs: saved.jcs, sha256: SHA256Hex.of(saved.jcs)))
    _ = try #require(committed(try executor.run(Self.request("list_sessions", [:], callId: "call-3"), on: turn.coach, seat: .bound)))
    _ = try #require(committed(try executor.run(Self.request("list_sessions", [:], callId: "call-4"), on: turn.coach, seat: .bound)))
    let calls = try Self.coachMessage(a, turn).calls
    #expect(calls.map(\.callId) == ["call-1", "call-2", "call-3", "call-4"])
    #expect(AbilityCall.receipt(of: calls)
      == ["read": ["sets": 0, "sessions": 0, "weeks": 0], "results": [["t": "note", "id": "tn7Qm2Kx9Lp4Wz8R-4"]]])
    var served = ReadServed()
    served.saw(week: 1_799_452_800_000)
    served.saw(week: 1_798_848_000_000)
    served.saw(week: 1_799_452_800_000)
    let twice = AbilityCall(callId: "x", name: "get_stats", input: nil, outcome: .ok, read: served)
    #expect(AbilityCall.receipt(of: [twice, twice]) == ["read": ["sets": 0, "sessions": 0, "weeks": 2], "results": []])
    #expect(ReadServed.week(of: Instant(ms: 1_789_740_800_000)) == 1_789_344_000_000)
  }

  @Test func aCallPastTheCallsBoundLosesItsInputThenTheTurnItsCalls() throws {
    let a = Self.phone()
    let turn = try Self.open(a)
    let executor = Self.executor(a)
    let sets: [JSON] = Array(repeating: ["reps": 100, "weightKg": 123.45], count: 20)
    let entries: [JSON] = (0..<50).map { _ in ["exerciseId": "bench-press", "sets": .array(sets), "restSeconds": 900] }
    let first = try executor.run(Self.request("create_routine", ["id": "tn7Qm2Kx9Lp4Wz8R-1", "name": "Big", "position": 0, "entries": .array(entries)]),
                                 on: turn.coach, seat: .bound)
    #expect(committed(first) != nil)
    let second = try executor.run(Self.request("create_routine", ["id": "tn7Qm2Kx9Lp4Wz8R-2", "name": "Bigger", "position": 1, "entries": .array(entries)],
                                               callId: "call-2"), on: turn.coach, seat: .bound)
    #expect(committed(second) != nil)
    #expect(try a.stored(Routine.self).count == 2)
    let recorded = try Self.coachMessage(a, turn).calls
    #expect(recorded.map(\.outcome) == [.ok, .ok] && recorded[1].input == nil)
    #expect(try Self.coachMessage(a, turn).callsBytes <= CoachRules.maxCallsBytes)
  }

  // The calls are steered to the byte where a write's record fits only without the id it would create: that call is
  // refused `coach-turn-volume`, recorded so, and writes nothing; the next cannot be recorded at all and is refused as
  // the message's own bound, writing nothing.
  @Test func aTurnPastItsCallsBoundRefusesVolumeThenRecordsNothing() throws {
    let a = Self.phone()
    let turn = try Self.open(a)
    let executor = Self.executor(a)
    _ = try #require(committed(try executor.run(Self.request("list_sessions", [:], callId: "fill-1"), on: turn.coach, seat: .bound)))
    let current = try Self.coachMessage(a, turn).callsBytes
    let created = RecordRef(type: Exercise.type, id: "tn7Qm2Kx9Lp4Wz8R-3")
    let trimmed = AbilityCall(callId: "fill-3", name: "create_exercise", input: nil, outcome: .ok, created: [created]).json.jcs.count
    let bare = AbilityCall(callId: "fill-3", name: "create_exercise", input: nil, outcome: .refused(.volume)).json.jcs.count
    try #require(bare < trimmed)
    let target = CoachRules.maxCallsBytes - 1 - bare - (trimmed - bare) / 2
    let steering = AbilityCall(callId: "fill-2", name: "list_sessions", input: ["before": 1, "beforeId": ""], outcome: .ok).json.jcs.count
    let cursor: JSON = ["before": 1, "beforeId": .string(String(repeating: "x", count: target - current - 1 - steering))]
    _ = try #require(committed(try executor.run(Self.request("list_sessions", cursor, callId: "fill-2"), on: turn.coach, seat: .bound)))
    #expect(try Self.coachMessage(a, turn).callsBytes == target)

    let exercise: JSON = ["id": "tn7Qm2Kx9Lp4Wz8R-3", "name": "Cable fly", "pattern": "isolation", "equipment": "cable"]
    let volume = try executor.run(Self.request("create_exercise", exercise, callId: "fill-3"), on: turn.coach, seat: .bound)
    #expect(committed(volume) == .refused(.volume))
    #expect(try a.stored(Exercise.self).isEmpty)
    #expect(try Self.coachMessage(a, turn).calls.last == AbilityCall(callId: "fill-3", name: "create_exercise", input: nil, outcome: .refused(.volume)))
    #expect(try Self.coachMessage(a, turn).callsBytes <= CoachRules.maxCallsBytes)
    let unrecorded = try executor.run(Self.request("list_sessions", [:], callId: "fill-4"), on: turn.coach, seat: .bound)
    #expect(unrecorded.refusal == .other(Refused(.tooLarge, subject: turn.coach.ref, path: .predicted)))
    #expect(try Self.coachMessage(a, turn).calls.map(\.callId) == ["fill-1", "fill-2", "fill-3"])
  }
}
