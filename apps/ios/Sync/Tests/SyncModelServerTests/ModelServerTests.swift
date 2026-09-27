import SyncCore
import SyncModelServer
import SyncTesting
import Testing

// Push and call bookkeeping the corpus does not pin: scripted refusals, faults per digest, and a real fault.

struct ModelServerTests {
  @Test func aScriptedRefusalIsStoredAsStepRStoresItSoAResendIsAnsweredFromIt_INV4() throws {
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"))
    server.refuse(code: "session-open", detail: ["why": "scripted"])
    let replica = "rp_0000000000000000000000000000000a"
    let push: JSON = ["replica": .string(replica), "ackThrough": 0, "intents": [
      ["n": 1, "scope": "self/probe", "d": [["t": "card", "id": "card0001", "born": "10:0:r_aaaaaaaaaaaa", "life": ["alive", "10:0:r_aaaaaaaaaaaa"]]]],
    ]]
    let first = server.push(push, account: "A", at: 1_000)
    let tables = server.state
    let resent = server.push(push, account: "A", at: 2_000)
    #expect(first.json == ["status": 200, "body": ["serverTime": 1_000, "epoch": "ep-1", "lastN": 1, "results": [
      ["n": 1, "s": "refused", "code": "session-open", "detail": ["why": "scripted"]],
    ]]])
    #expect(resent.json == ["status": 200, "body": ["serverTime": 2_000, "epoch": "ep-1", "lastN": 1, "results": [
      ["n": 1, "s": "refused", "code": "session-open", "detail": ["why": "scripted"]],
    ]]])
    #expect(server.state == tables)
    #expect(server.state.scopes.isEmpty)
  }

  // Review F3: "caf\u{E9}" and "cafe\u{301}" are two accounts; identifiers are bytes, and String == is canonical equivalence.
  @Test func aCanonicallyEquivalentAccountIsAnotherPrincipal_INV7() throws {
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"))
    let replicas = ["rp_0000000000000000000000000000000a", "rp_0000000000000000000000000000000e"]
    let board: JSON = ["replica": .string(replicas[0]), "ackThrough": 0, "intents": [
      ["n": 1, "scope": "self/probe", "d": [["t": "board", "id": "b_00000001", "born": "10:0:r_aaaaaaaaaaaa", "life": ["alive", "10:0:r_aaaaaaaaaaaa"]]]],
    ]]
    _ = server.push(board, account: "caf\u{E9}", at: 1_000)
    let pulled = server.pull(["scopes": [["scope": "tree/b_00000001", "cursor": .null]]], account: "cafe\u{301}", at: 2_000)
    let wrote = server.push(["replica": .string(replicas[1]), "ackThrough": 0, "intents": [
      ["n": 1, "scope": "tree/b_00000001", "d": [["t": "meta", "id": "meta", "f": ["title": ["Mine", "20:0:r_aaaaaaaaaaaa"]]]]],
    ]], account: "cafe\u{301}", at: 2_000)
    let rebound = server.push(board, account: "cafe\u{301}", at: 3_000)
    #expect(try pulled.body.member("pages") == [["scope": "tree/b_00000001", "kind": "not-found"]])
    #expect(try wrote.body.member("results") == [["n": 1, "s": "refused", "code": "not-found"]])
    #expect(rebound.json == ["status": 409, "body": ["serverTime": 3_000, "epoch": "ep-1", "error": "replica-foreign"]])
  }

  // §9.1: the model's own values are equal only byte for byte, so a rollback check sees an epoch, an owner, an account or
  // a text that changed to a canonically equivalent spelling.
  @Test func valuesThatDifferOnlyByCanonicalEquivalenceAreDifferent_9_1() throws {
    let key = ScopeKey(.tree("b_00000001"))
    let owned = { (owner: String) -> ServerState in
      var state = ServerState(epoch: "ep-1")
      state.scopes[key] = ScopeRecord(owner: owner, born: .governingCreate)
      return state
    }
    let revision = { (text: String) in Revision(key: RecordKey("mark", "oak"), field: "memo", rev: 1, text: text) }
    #expect([
      ServerState(epoch: "caf\u{E9}") == ServerState(epoch: "cafe\u{301}"),
      owned("caf\u{E9}") == owned("cafe\u{301}"),
      ReplicaBinding(account: "caf\u{E9}", lastN: 1) == ReplicaBinding(account: "cafe\u{301}", lastN: 1),
      revision("caf\u{E9}") == revision("cafe\u{301}"),
      IntentOrigin.server(account: "caf\u{E9}", requestId: nil) == .server(account: "cafe\u{301}", requestId: nil),
    ] == [false, false, false, false, false])
  }

  // §10.2: the wall clock steps back a minute, but `serverNow` does not, so a stamp admitted at the skew bound passes the
  // check again, a later hello answers the greatest time, and a restore keeps the process's clock.
  @Test func serverNowNeverStepsBackWithinTheProcess_10_2() throws {
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"))
    let bound = 1_000_000 + Constants.maxSkewMs
    let replica = "rp_0000000000000000000000000000000a"
    let card = { (n: Int64, id: String) -> JSON in
      ["replica": .string(replica), "ackThrough": 0, "intents": [
        ["n": JSON(n), "scope": "self/probe", "d": [["t": "card", "id": .string(id), "born": .string("\(bound):0:r_aaaaaaaaaaaa"),
                                                    "life": ["alive", .string("\(bound):0:r_aaaaaaaaaaaa")]]]],
      ]]
    }
    let first = server.push(card(1, "card0001"), account: "A", at: 1_000_000)
    let second = server.push(card(2, "card0002"), account: "A", at: 940_000)
    server.restore(ServerState(epoch: "ep-2"))
    let hello = server.hello(account: "A", at: 900_000)
    #expect(try first.body.member("results") == [["n": 1, "s": "ok", "seq": 1]])
    #expect(second.json == ["status": 200, "body": ["serverTime": 1_000_000, "epoch": "ep-1", "lastN": 2, "results": [
      ["n": 2, "s": "ok", "seq": 2],
    ]]])
    #expect(try hello.body.member("serverTime") == 1_000_000)
  }

  @Test func faultsAreCountedPerReplicaNAndDigestSoAnotherIntentAtThatNStartsAgain_6_6() throws {
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"))
    let replica = "rp_0000000000000000000000000000000a"
    let intent = { (id: String) -> JSON in
      ["replica": .string(replica), "ackThrough": 0, "intents": [
        ["n": 1, "scope": "self/probe", "d": [["t": "card", "id": .string(id), "born": "10:0:r_aaaaaaaaaaaa", "life": ["alive", "10:0:r_aaaaaaaaaaaa"]]]],
      ]]
    }
    let faults = PushFaults(byN: [1: .fault])
    _ = server.push(intent("card0001"), account: "A", at: 1_000, faults: faults)
    _ = server.push(intent("card0001"), account: "A", at: 1_000, faults: faults)
    let forked = server.push(intent("card0002"), account: "A", at: 1_000, faults: faults)
    #expect(forked.json == ["status": 200, "body": ["serverTime": 1_000, "epoch": "ep-1", "lastN": 0, "results": [],
                                                   "retry": ["n": 1, "retryAfterMs": 0]]])
    #expect(server.state.results[replica]?[1]?.faults == 1)
    #expect(server.state.results[replica]?[1]?.digest == SHA256Hex.of(try intent("card0002").member("intents").asArray()[0].jcs))
  }

  // A stored tier the registry cannot rank makes the join throw: a deterministic fault, poison at K_POISON.
  @Test func anAdmissionThatFaultsDeterministicallyEndsInternalAtKPoisonAndTheNextIntentProceeds_INV9() throws {
    var state = ServerState(epoch: "ep-1")
    let scope = ScopeKey(.product(account: "A", name: "probe"))
    let card = try Row(json: ["t": "card", "id": "card0001", "life": ["alive", "10:0:r_aaaaaaaaaaaa"], "born": "10:0:r_aaaaaaaaaaaa",
                              "f": ["tier": ["legendary", "10:0:r_aaaaaaaaaaaa"]], "seq": 1, "rc": 10, "ru": 10])
    state.scopes[scope] = ScopeRecord(owner: "A", born: .firstWrite)
    state.scopes[scope]!.seq = 1
    state.scopes[scope]!.counters = ["card": 1]
    state.scopes[scope]!.digest = card.digest
    state.rows[scope] = [card.key: card]
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: state)
    let replica = "rp_0000000000000000000000000000000a"
    let push: JSON = ["replica": .string(replica), "ackThrough": 0, "intents": [
      ["n": 1, "scope": "self/probe", "d": [["t": "card", "id": "card0001", "born": "10:0:r_aaaaaaaaaaaa", "f": ["tier": ["done", "20:0:r_aaaaaaaaaaaa"]]]]],
      ["n": 2, "scope": "self/probe", "d": [["t": "card", "id": "card0001", "born": "10:0:r_aaaaaaaaaaaa", "f": ["title": ["Kept", "30:0:r_aaaaaaaaaaaa"]]]]],
    ]]
    let first = server.push(push, account: "A", at: 1_000)
    let second = server.push(push, account: "A", at: 1_000)
    let third = server.push(push, account: "A", at: 1_000)
    #expect(first.json == ["status": 200, "body": ["serverTime": 1_000, "epoch": "ep-1", "lastN": 0, "results": [],
                                                  "retry": ["n": 1, "retryAfterMs": 0]]])
    #expect(second.json == first.json)
    #expect(third.json == ["status": 200, "body": ["serverTime": 1_000, "epoch": "ep-1", "lastN": 2, "results": [
      ["n": 1, "s": "refused", "code": "internal"], ["n": 2, "s": "ok", "seq": 2],
    ]]])
    #expect(server.state.results[replica]?[1]?.faults == Constants.kPoison)
  }

  // §6.3 as the reference runs it: a crash right after the last part commits leaves the row running with every part, and
  // the call that takes the lease over answers the stored result and ends the row done, admitting nothing again.
  @Test func aCallThatCrashedAfterItsLastPartIsAnsweredFromItsPartsOnceTheLeaseEnds_6_3() throws {
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"))
    let create = { (id: String) -> JSON in
      ["scope": "self/probe", "d": [["t": "card", "id": .string(id), "born": .null, "life": ["alive", .null]]]]
    }
    let call = ServerCall(
      account: "A", requestId: "req-1", tool: "cards.add", args: ["n": 2], intents: [create("card0001"), create("card0002")])
    let crashed = server.call(call, at: 1_000_000, faults: CallFaults(crashAfter: 2))
    let running = server.state
    let resumed = server.call(call, at: 1_000_000 + Constants.requestLeaseMs)
    let key = RequestKey(account: "A", requestId: "req-1")
    let parts: [Int: JSON] = [1: ["s": "ok", "seq": 1], 2: ["s": "ok", "seq": 2]]
    #expect(crashed == nil)
    #expect(running.requests[key] == RequestRecord(
      digest: SHA256Hex.of(JSON.object(["tool": "cards.add", "args": ["n": 2]]).jcs), state: .running, startedAt: 1_000_000, parts: parts))
    #expect(resumed == ["s": "ok", "seq": 2])
    #expect(server.state.requests[key] == RequestRecord(
      digest: SHA256Hex.of(JSON.object(["tool": "cards.add", "args": ["n": 2]]).jcs), state: .done,
      startedAt: 1_000_000 + Constants.requestLeaseMs, parts: parts, result: ["s": "ok", "seq": 2]))
    #expect(server.state.scopes[ScopeKey(.product(account: "A", name: "probe"))]?.seq == 2)
  }

  @Test func aServerOriginFaultReturnsToItsCallerAsInternalAndEndsItsRequest_6_3_6_6() throws {
    var state = ServerState(epoch: "ep-1")
    let scope = ScopeKey(.product(account: "A", name: "probe"))
    let card = try Row(json: ["t": "card", "id": "card0001", "life": ["alive", "10:0:r_aaaaaaaaaaaa"], "born": "10:0:r_aaaaaaaaaaaa",
                              "f": ["tier": ["legendary", "10:0:r_aaaaaaaaaaaa"]], "seq": 1, "rc": 10, "ru": 10])
    state.scopes[scope] = ScopeRecord(owner: "A", born: .firstWrite)
    state.scopes[scope]!.seq = 1
    state.scopes[scope]!.counters = ["card": 1]
    state.scopes[scope]!.digest = card.digest
    state.rows[scope] = [card.key: card]
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: state)
    let call = ServerCall(account: "A", requestId: "req-1", tool: "cards.rank", args: ["tier": "done"], intents: [
      ["scope": "self/probe", "d": [["t": "card", "id": "card0001", "born": "10:0:r_aaaaaaaaaaaa", "f": ["tier": ["done", .null]]]]],
    ])
    #expect(server.call(call, at: 1_000) == ["s": "refused", "code": "internal"])
    #expect(server.call(call, at: 70_000) == ["s": "refused", "code": "internal"])
    var ended = state
    ended.requests = [RequestKey(account: "A", requestId: "req-1"): RequestRecord(
      digest: SHA256Hex.of(JSON.object(["tool": "cards.rank", "args": ["tier": "done"]]).jcs), state: .done, startedAt: 1_000,
      parts: [1: ["s": "refused", "code": "internal"]], result: ["s": "refused", "code": "internal"])]
    #expect(server.state == ended)
  }
}
