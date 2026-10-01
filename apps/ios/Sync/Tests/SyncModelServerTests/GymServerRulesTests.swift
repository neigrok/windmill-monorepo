import SyncCore
import SyncTesting
import Testing

@testable import SyncModelServer

struct GymServerRulesTests {
  @Test func aLaterCapRefusalRollsBackTheRoutineProjectionAndItsServerStamps() throws {
    let create = try vector("a routine created with entries takes revision 1")
    let cap = try vector("an eleventh note is refused cap")
    var state = try ServerState(json: cap.input.member("state"))
    let before = state
    var routine = try create.input.member("intent").member("d").asArray()[0].asObject()
    routine["born"] = .null
    routine["life"] = ["alive", .null]
    let fields = try routine.member("f").asObject().members.map { name, pair in
      (name, JSON.array([try pair.asArray()[0], .null]))
    }
    routine["f"] = .object(JSON.Object(uniqueKeysWithValues: fields))
    let deltas = try [JSON.object(routine)] + cap.input.member("intent").member("d").asArray()
    let admission = Admission(registry: try Registry(json: Corpus.registryFile("gym")), rules: GymServerRules())
    let admitted = try admission.admit(["scope": "self/gym", "d": .array(deltas)], from: .server(account: "A", requestId: nil),
      at: try cap.input.member("serverNow").asInteger(), in: &state)
    #expect(admitted.result == .refused(Refusal(.cap, detail: ["type": "note", "cap": 10])))
    #expect(admitted.events == [])
    #expect(state == before)
  }

  @Test func aSessionCreateBesideItsCommandStillHasAnIntentSourceAndRollsBack() throws {
    let create = try vector("a session created by a bare delta is invalid: only commands create sessions")
    var state = try ServerState(json: create.input.member("state"))
    let before = state
    var intent = try create.input.member("intent").asObject()
    let delta = try intent.member("d").asArray()[0]
    intent["cmd"] = ["name": "gym.start", "args": ["id": try delta.member("id"), "startedAt": 100, "joinOpenSession": true]]
    let admission = Admission(registry: try Registry(json: Corpus.registryFile("gym")), rules: GymServerRules())
    let admitted = try admission.admit(.object(intent), from: .server(account: "A", requestId: nil),
      at: try create.input.member("serverNow").asInteger(), in: &state)
    #expect(admitted.result == .refused(Refusal(.invalid)))
    #expect(admitted.events == [])
    #expect(state == before)
  }

  @Test func multipleSetsExtendAStaleCloseInIntentOrder() throws {
    let create = try vector("a new set within 4 h of a stale close lands and moves finishedAt to it")
    var state = try ServerState(json: create.input.member("state"))
    let scope = ScopeKey(.product(account: "A", name: "gym"))
    var intent = try create.input.member("intent").asObject()
    let original = try intent.member("d").asArray()[0]
    let sessionId = try original.member("f").member("sessionId").asArray()[0].asString()
    let sessionKey = RecordKey("session", RecordID(sessionId))
    let session = try #require(state.rows[scope]?[sessionKey])
    let finishedAt = try #require(session.lattice.fields["finishedAt"]?.value).asInteger()
    var first = try original.asObject()
    var fields = try first.member("f").asObject()
    let stamp = try fields.member("completedAt").asArray()[1]
    fields["completedAt"] = [JSON(finishedAt + 14_400_000), stamp]
    first["f"] = .object(fields)
    var second = first
    second["id"] = "newset0002"
    fields["completedAt"] = [JSON(finishedAt + 28_800_000), stamp]
    second["f"] = .object(fields)
    intent["d"] = [.object(first), .object(second)]
    let admission = Admission(registry: try Registry(json: Corpus.registryFile("gym")), rules: GymServerRules())
    let admitted = try admission.admit(.object(intent), from: .replica(account: "A", replica: "r_aaaaaaaaaaaa", n: 1),
      at: try create.input.member("serverNow").asInteger(), in: &state)
    #expect(admitted.result == .ok(seq: (try create.expect.member("result").member("seq").asInteger()), write: nil, detail: nil))
    let stored = try #require(state.rows[scope]?[sessionKey])
    var expectedFields = session.lattice.fields.mapValues(\.value)
    expectedFields["finishedAt"] = JSON(finishedAt + 28_800_000)
    #expect(stored.lattice.fields.mapValues(\.value) == expectedFields)
    #expect(state.spent == [:])
    #expect(state.scopes[scope]?.digest == ScopeDigest(rows: Array((state.rows[scope] ?? [:]).values).map(\.json)))
  }

  @Test(arguments: [
    (Int64(0), "1970-01-01"), (Int64(-1), "1969-12-31"),
    (Int64(1_709_251_199_999), "2024-02-29"), (Int64(1_709_251_200_000), "2024-03-01"),
    (Int64(1_735_689_600_000), "2025-01-01"),
  ])
  func utcDatesUseEpochMilliseconds(_ ms: Int64, _ day: String) {
    #expect(GymServerRules().utcDay(ms) == day)
  }

  func vector(_ name: String) throws -> CorpusVector {
    let file = try #require(try Corpus.files().first { $0.path == "gym/admit.json" })
    return try #require(try Corpus.vectors(in: file).first { $0.name == name })
  }
}
