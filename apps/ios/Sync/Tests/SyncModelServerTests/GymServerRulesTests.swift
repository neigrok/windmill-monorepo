import SyncCore
import SyncTesting
import Testing

@testable import SyncModelServer

struct GymServerRulesTests {
  @Test func aProposalApplyReceiptRollsBackWithALaterRefusalAndSurvivesAReload() throws {
    let removal = try vector("apply of a removal kills the routine and its proposals, and writes routineId null on its sessions")
    let invalid = try vector("a session created by a bare delta is invalid: only commands create sessions")
    let replay = try vector("a restored removal receipt survives proposal death and a new replica with old guards")
    var state = try ServerState(json: removal.input.member("state"))
    let before = state
    let admission = Admission(registry: try Registry(json: Corpus.registryFile("gym")), rules: GymServerRules())
    var rejected = try removal.input.member("intent").asObject()
    rejected["d"] = try invalid.input.member("intent").member("d")
    let now = try removal.input.member("serverNow").asInteger()
    let refused = try admission.admit(.object(rejected), from: .replica(account: "A", replica: "rp_1", n: 1), at: now, in: &state)
    #expect(refused.result == .refused(Refusal(.invalid)))
    #expect(state == before)
    let applied = try admission.admit(removal.input.member("intent"), from: .replica(account: "A", replica: "rp_1", n: 2), at: now, in: &state)
    #expect(applied.result.json["s"] == "ok")
    #expect(state.product["proposalApplies"]?["acct:A/gym"]?["proposal001"] == true)
    var reloaded = try ServerState(json: state.json)
    let accepted = try admission.admit(replay.input.member("intent"), from: .replica(account: "A", replica: "rp_2", n: 1), at: now + 1, in: &reloaded)
    #expect(accepted.result.json["s"] == "ok")
    #expect(accepted.result.json["write"] == [])
    #expect(reloaded == state)
  }

  @Test func aLaterCapRefusalRollsBackTheRoutineProjectionAndItsServerStamps() throws {
    let create = try vector("a routine created with entries takes revision 1")
    let cap = try vector("an eleventh note is refused cap")
    var state = try ServerState(json: cap.input.member("state"))
    let before = state
    var routine = try create.input.member("intent").member("d").asArray()[0].asObject()
    routine["born"] = .null
    routine["life"] = ["alive", .null]
    var fields = try routine.member("f").asObject().members.map { name, pair in
      (name, JSON.array([try pair.asArray()[0], .null]))
    }
    fields.append(("createdDoor", ["ask", .null]))
    routine["f"] = .object(JSON.Object(uniqueKeysWithValues: fields))
    let deltas = try [JSON.object(routine)] + cap.input.member("intent").member("d").asArray()
    let admission = Admission(registry: try Registry(json: Corpus.registryFile("gym")), rules: GymServerRules())
    let admitted = try admission.admit(["scope": "self/gym", "d": .array(deltas)], from: .server(account: "A", requestId: nil),
      at: try cap.input.member("serverNow").asInteger(), in: &state)
    #expect(admitted.result == .refused(Refusal(.cap, detail: ["type": "note", "cap": 10])))
    #expect(admitted.events == [])
    #expect(state == before)
  }

  @Test(arguments: [nil, Int64(2_147_483_647)])
  func aDocumentEditCannotInventOrOverflowItsRevision(_ revision: Int64?) throws {
    let edit = try vector("R118 a name and entries edit increments revision once and preserves creation metadata")
    var state = try ServerState(json: edit.input.member("state"))
    let scope = ScopeKey(.product(account: "A", name: "gym"))
    let key = RecordKey("routine", RecordID("routine0002"))
    var row = try #require(state.rows[scope]?[key])
    let stamp = try #require(row.lattice.fields["revision"]?.stamp)
    row.lattice.fields["revision"] = revision.map { Register(JSON($0), stamp) }
    state.rows[scope]?[key] = row
    state.scopes[scope]?.digest = ScopeDigest(rows: Array((state.rows[scope] ?? [:]).values).map(\.json))
    let before = state
    let admission = Admission(registry: try Registry(json: Corpus.registryFile("gym")), rules: GymServerRules())
    let admitted = try admission.admit(edit.input.member("intent"), from: .server(account: "A", requestId: nil),
      at: try edit.input.member("serverNow").asInteger(), in: &state)
    #expect(admitted.result == .refused(Refusal(.invalid)))
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
