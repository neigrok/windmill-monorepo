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
                           read: .ids(served))
    let counted = AbilityCall(callId: "call-2", name: "get_session", input: nil, outcome: .ok, read: .counts(ReadTally(sets: 600, sessions: 1, weeks: 1)))
    let sample = CoachMessage(id: ID("turnAAAAAAAAAAA1"), threadId: ID("thrdAAAAAAAAAAA1"), role: .coach, replica: "rp_00000000000000000000000000000001",
                              text: "Add 5 kg.", state: .completed, truncated: true, receipt: AbilityCall.receipt(of: [call, counted]), calls: [call, counted],
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
    #expect(committed(malformed) == .refused(.invalidInput))
    let withheld = try executor.run(Self.request("log_set", [:], callId: "call-3"), on: turn.coach, seat: .bound)
    #expect(committed(withheld) == .refused(.notOffered))
    let share = try executor.run(Self.request("share_session", ["sessionId": "sesAAAAAAAAAAAA1"], callId: "call-4"), on: turn.coach, seat: .bound)
    #expect(committed(share) == .refused(.notOffered))
    let note = try executor.run(Self.request("save_note", ["id": "tn7Qm2Kx9Lp4Wz8R-4", "title": "Tone", "body": "Blunt."], callId: "call-5"),
                                on: turn.coach, seat: .anon)
    #expect(committed(note) == .refused(.seatRequired))
    #expect(try a.stored(Note.self).isEmpty)
    let calls = try Self.coachMessage(a, turn).calls
    #expect(calls.map(\.outcome) == [.refused(.refused), .refused(.invalidInput), .refused(.notOffered), .refused(.notOffered), .refused(.seatRequired)])
    #expect(calls.map { $0.input == nil } == [false, true, true, true, true])
    #expect(AbilityCall.receipt(of: calls) == ["read": ["sets": 0, "sessions": 0, "weeks": 0], "results": []])
  }

  // The receipt counts by identity, and a call's record holds only the identities no earlier call of the turn holds.
  @Test func theReceiptCountsByIdentityAcrossCalls() throws {
    let a = Self.phone()
    let session = Session(id: ID("sesAAAAAAAAAAAA1"), startedAt: Instant(ms: 1_799_000_000_000), finishedAt: Instant(ms: 1_799_003_600_000), closedBy: "finish")
    try SeedLog.run(a, sessions: [session], sets: [])
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
    var once = ReadServed()
    once.saw(session: session)
    #expect(calls.map(\.read) == [.ids(.none), .ids(.none), .ids(once), .ids(.none)])
    #expect(AbilityCall.receipt(of: calls)
      == ["read": ["sets": 0, "sessions": 1, "weeks": 1], "results": [["t": "note", "id": "tn7Qm2Kx9Lp4Wz8R-4"]]])
    var served = ReadServed()
    served.saw(week: 1_799_452_800_000)
    served.saw(week: 1_798_848_000_000)
    served.saw(week: 1_799_452_800_000)
    let twice = AbilityCall(callId: "x", name: "get_stats", input: nil, outcome: .ok, read: .ids(served))
    #expect(AbilityCall.receipt(of: [twice, twice]) == ["read": ["sets": 0, "sessions": 0, "weeks": 2], "results": []])
    #expect(ReadServed.week(of: Instant(ms: 1_789_740_800_000)) == 1_789_344_000_000)
  }

  @Test func aCallPastTheCallsBoundLosesItsInput() throws {
    let a = Self.phone()
    let turn = try Self.open(a)
    let executor = Self.executor(a)
    let cursor: JSON = ["before": 1, "beforeId": .string(String(repeating: "x", count: 20_000))]
    let first = try executor.run(Self.request("list_sessions", cursor), on: turn.coach, seat: .bound)
    #expect(committed(first) != nil)
    let second = try executor.run(Self.request("list_sessions", cursor, callId: "call-2"), on: turn.coach, seat: .bound)
    #expect(committed(second) != nil)
    let recorded = try Self.coachMessage(a, turn).calls
    #expect(recorded.map(\.outcome) == [.ok, .ok] && recorded[0].input == cursor && recorded[1].input == nil)
    #expect(try Self.coachMessage(a, turn).callsBytes <= CoachRules.maxCallsBytes)
  }

  // Coach §4.3 step 2: a result past TOOL_RESULT_BYTES is refused before anything commits — the routine is not created, its
  // record carries the refusal alone — and three workouts of sixty sets the phone cannot send count nothing on the
  // receipt, where one workout it can send counts every row.
  @Test func aResultPastItsBoundIsRefusedBeforeItsWriteCommits() throws {
    let a = Self.phone()
    let sessions = (0..<3).map { n in
      Session(id: ID(RecordID("ses" + Self.digits(n))), startedAt: Instant(ms: 1_700_000_000_000 + Int64(n) * 7 * 86_400_000),
              finishedAt: Instant(ms: 1_700_003_600_000 + Int64(n) * 7 * 86_400_000), closedBy: "finish")
    }
    var sets: [TrainingSet] = []
    let exerciseId = ID<Exercise>("bench-press")
    for (workout, session) in sessions.enumerated() {
      for n in 0..<60 {
        let id = ID<TrainingSet>(RecordID("set" + Self.digits(workout * 100 + n)))
        let completedAt = Instant(ms: session.startedAt.ms + 60_000 * Int64(n + 1))
        sets.append(TrainingSet(id: id, sessionId: session.id, exerciseId: exerciseId, weightKg: 60, reps: 5,
                                completedAt: completedAt, setNumber: n + 1))
      }
    }
    try SeedLog.run(a, sessions: sessions, sets: sets)
    let turn = try Self.open(a)
    let executor = Self.executor(a)
    let ramp: [JSON] = (0..<20).map { ["reps": JSON(1 + $0), "weightKg": .of(Double($0) * 2.5)] }
    let entries: [JSON] = (0..<50).map { ["exerciseId": "bench-press", "sets": .array(ramp), "restSeconds": JSON(15 + $0)] }
    let input: JSON = ["id": "tn7Qm2Kx9Lp4Wz8R-1", "name": "Ramp", "position": 0, "entries": .array(entries)]
    let routine = try executor.run(Self.request("create_routine", input), on: turn.coach, seat: .bound)
    #expect(committed(routine) == .refused(.resultTooLarge))
    #expect(try a.stored(Routine.self).isEmpty)
    #expect(try Self.coachMessage(a, turn).calls == [AbilityCall(callId: "call-1", name: "create_routine", input: input, outcome: .refused(.resultTooLarge))])
    let three = try executor.run(Self.request("get_sessions", ["sessionIds": .array(sessions.map(\.id.json))], callId: "call-2"), on: turn.coach, seat: .bound)
    #expect(committed(three) == .refused(.resultTooLarge))
    #expect(try Self.coachMessage(a, turn).calls.last?.read == .ids(.none))
    #expect(AbilityCall.receipt(of: try Self.coachMessage(a, turn).calls) == ["read": ["sets": 0, "sessions": 0, "weeks": 0], "results": []])
    let one = try executor.run(Self.request("get_session", ["sessionId": sessions[0].id.json], callId: "call-3"), on: turn.coach, seat: .bound)
    guard case .result(let jcs, _)? = committed(one) else { Issue.record("one workout of sixty sets is within the bound"); return }
    #expect(jcs.count <= CoachRules.maxResultBytes)
    #expect(AbilityCall.receipt(of: try Self.coachMessage(a, turn).calls) == ["read": ["sets": 60, "sessions": 1, "weeks": 1], "results": []])
  }

  // Coach §9.2 on the calls bound: a read the calls have no room for is recorded as counts alone, never refused, and the
  // receipt sums the counts with the identities under `truncated`; a read of rows an earlier call holds records nothing new.
  @Test func aReadPastTheCallsBoundIsRecordedAsCountsAndTheReceiptSaysSo() throws {
    let served = { (workout: Int) -> ReadServed in
      var read = ReadServed()
      let startedAt = Instant(ms: 1_700_000_000_000 + Int64(workout) * 7 * 86_400_000)
      let session = Session(id: ID(RecordID("ses" + Self.digits(workout))), startedAt: startedAt, finishedAt: Instant(ms: startedAt.ms + 3_600_000), closedBy: "finish")
      read.saw(session: session)
      for n in 0..<600 {
        read.saw(set: TrainingSet(id: ID(RecordID("set" + Self.digits(workout * 600 + n))), sessionId: session.id, exerciseId: ID("bench-press"), weightKg: 60,
                                  reps: 5, completedAt: startedAt, setNumber: n + 1))
      }
      return read
    }
    var message = CoachMessage(id: ID("turnAAAAAAAAAAA1"), threadId: ID("thrdAAAAAAAAAAA1"), role: .coach, replica: "rp_00000000000000000000000000000001", at: Self.now)
    for workout in 0..<3 {
      let call = AbilityCall(callId: "call-\(workout)", name: "get_session", input: ["sessionId": .string("ses" + Self.digits(workout))], outcome: .ok,
                             read: .ids(served(workout)))
      message.calls.append(try #require(message.recorded(call)))
    }
    #expect(message.calls.map(\.read) == [.ids(served(0)), .ids(served(1)), .counts(ReadTally(sets: 600, sessions: 1, weeks: 1))])
    #expect(message.calls.map { $0.input == nil } == [false, false, true] && message.callsBytes <= CoachRules.maxCallsBytes)
    #expect(try AbilityCall(json: message.calls[2].json) == message.calls[2])
    let again = AbilityCall(callId: "call-3", name: "get_session", input: ["sessionId": "ses0000000000000"], outcome: .ok, read: .ids(served(0)))
    #expect(message.recorded(again) == again.read(.ids(.none)))
    #expect(AbilityCall.receipt(of: message.calls) == ["read": ["sets": 1800, "sessions": 3, "weeks": 3], "results": [], "truncated": true])
  }

  static func digits(_ n: Int) -> String { String(repeating: "0", count: 13 - String(n).count) + String(n) }

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

// The log seeded whole: every closed session imported with its sets, at the instants given.
enum SeedLog {
  static func run(_ a: Harness, sessions: [Session], sets: [TrainingSet]) throws {
    for session in sessions {
      let imported = sets.filter { $0.sessionId == session.id }.map {
        ImportedSet(id: $0.id, exerciseId: $0.exerciseId, weightKg: $0.weightKg, reps: $0.reps, completedAt: $0.completedAt)
      }
      let finishedAt = try #require(session.finishedAt)
      _ = try #require(committed(try a.runner.run(ImportSession(id: session.id, startedAt: session.startedAt, finishedAt: finishedAt, sets: imported))))
    }
  }
}
