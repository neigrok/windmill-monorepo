import SyncCore
import SyncModelServer
import SyncTesting
import Testing

// §6.7 and §6.8 end to end on the model: paging reconstructs the scope, and sockets get exactly what they may read.

struct FeedTests {
  // INV-5 and INV-15 from the server's side: a small-paged boot, with a change landing mid-boot, then live pages until
  // `more` is false, rebuild exactly the alive rows, whose digest the last page carries.
  @Test func pagesPulledUntilNoMoreHoldExactlyTheAliveRowsTheirDigestNames_INV5_INV15() throws {
    var limits = ServerLimits()
    limits.pullPageBytes = 180
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"), limits: limits)
    let card = { (n: Int64, id: String, life: String, born: Int64) -> JSON in
      ["n": JSON(n), "scope": "self/probe", "d": [["t": "card", "id": .string(id), "born": .string("\(born):0:r_aaaaaaaaaaaa"),
                                                   "life": [.string(life), .string("\(1_000 + n):0:r_aaaaaaaaaaaa")]]]]
    }
    let day = { (n: Int64, id: String, life: String) -> JSON in
      ["n": JSON(n), "scope": "self/probe", "d": [["t": "day", "id": .string(id), "life": [.string(life), .string("\(1_000 + n):0:r_aaaaaaaaaaaa")],
                                                   "f": ["score": [JSON(n % 10), .string("\(1_000 + n):0:r_aaaaaaaaaaaa")]]]]]
    }
    let history: [JSON] = [
      card(1, "card0001", "alive", 1_001), card(2, "card0002", "alive", 1_002), day(3, "2026-09-01", "alive"),
      card(4, "card0001", "dead", 1_001), day(5, "2026-09-02", "alive"), day(6, "2026-09-01", "dead"), card(7, "card0003", "alive", 1_007),
    ]
    _ = server.push(["replica": "rp_a", "ackThrough": 0, "intents": .array(history)], account: "A", at: 5_000)
    var rows: [RecordKey: Row] = [:]
    var cursor = JSON.null
    var pages = 0
    while true {
      let reply = server.pull(["scopes": [["scope": "self/probe", "cursor": cursor]]], account: "A", at: 6_000)
      let page = try reply.body.member("pages").asArray()[0]
      for row in try page.member("rows").asArray().map({ try Row(json: $0) }) { rows[row.key] = row.isAlive ? row : nil }
      cursor = try page.member("cursor")
      pages += 1
      if pages == 2 {
        _ = server.push(["replica": "rp_a", "ackThrough": 0, "intents": [day(8, "2026-09-02", "dead"), card(9, "card0004", "alive", 1_009)]],
                        account: "A", at: 5_500)
      }
      guard try page.member("more").asBool() else {
        #expect(try ScopeDigest(hex: page.member("digest").asString()) == ScopeDigest(rows: rows.values.map(\.json)))
        break
      }
    }
    let scope = ScopeKey(.product(account: "A", name: "probe"))
    #expect(rows == (server.state.rows[scope] ?? [:]).filter { $0.value.isAlive })
    #expect(pages > 3)
  }

  // A socket gets a scope's frames while its principal may read it; a private tree answers not-found at once, a
  // tree closed again ends the subscription with not-found, and a dead tree is gone to its owner.
  @Test func aSocketGetsExactlyTheFramesItsPrincipalMayRead_6_8() throws {
    var server = ModelServer(
      registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1", accounts: ["A": "Ann", "B": "Bob"]))
    let board = { (n: Int64, life: String) -> JSON in
      ["replica": "rp_a", "ackThrough": 0, "intents": [
        ["n": JSON(n), "scope": "self/probe", "d": [["t": "board", "id": "b_00000001", "born": "10:0:r_aaaaaaaaaaaa",
                                                     "life": [.string(life), .string("\(10 * n):0:r_aaaaaaaaaaaa")]]]],
      ]]
    }
    let visibility = { (value: String) -> ServerCall in
      ServerCall(account: "A", requestId: nil, tool: "share", args: .string(value), intents: [
        ["scope": "tree/b_00000001", "d": [["t": "meta", "id": "meta", "f": ["visibility": [.string(value), .null]]]]],
      ])
    }
    let tree = ScopeRef.tree("b_00000001")
    _ = server.push(board(1, "alive"), account: "A", at: 1_000)
    let owner = server.connect(account: "A")
    let reader = server.connect(account: "B")
    server.subscribe(owner, to: [tree])
    server.subscribe(reader, to: [tree])
    #expect(server.frames(for: reader) == [["op": "not-found", "scope": "tree/b_00000001"]])

    _ = server.call(visibility("public"), at: 2_000)
    let opened = try #require(server.state.scopes[ScopeKey(.tree("b_00000001"))])
    server.subscribe(reader, to: [tree])
    let titled = server.push(
      ["replica": "rp_a", "ackThrough": 0, "intents": [
        ["n": 2, "scope": "tree/b_00000001", "d": [["t": "meta", "id": "meta", "f": ["title": ["Plan", "30:0:r_aaaaaaaaaaaa"]]]]],
      ]], account: "A", at: 3_000)
    _ = server.call(visibility("private"), at: 4_000)
    let closed = try #require(server.state.scopes[ScopeKey(.tree("b_00000001"))])
    _ = server.push(board(3, "dead"), account: "A", at: 5_000)

    let titleFrame = try #require(titled.events.first.map(\.json)?["frame"])
    #expect(server.frames(for: reader) == [titleFrame, ["op": "not-found", "scope": "tree/b_00000001"]])
    let owned = server.frames(for: owner)
    #expect(owned.map { $0["seq"] ?? $0["op"] ?? .null } == [1, 2, 3, "gone"])
    #expect(owned[0]["digest"] == .string(opened.digest.hex))
    #expect(owned[1] == titleFrame)
    #expect(owned[2]["digest"] == .string(closed.digest.hex))
    #expect(server.frames(for: owner) == [])
  }

  // Review F1: "An overlay never written was never created (§6.1 step 3.5), so a tree's death sends no frame for it."
  @Test func aTreeDeathSendsNoFrameForAnOverlayNeverWritten_6_8() throws {
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"))
    let board = { (n: Int64, life: String) -> JSON in
      ["replica": "rp_a", "ackThrough": 0, "intents": [
        ["n": JSON(n), "scope": "self/probe", "d": [["t": "board", "id": "b_00000001", "born": "10:0:r_aaaaaaaaaaaa",
                                                     "life": [.string(life), .string("\(10 * n):0:r_aaaaaaaaaaaa")]]]],
      ]]
    }
    _ = server.push(board(1, "alive"), account: "A", at: 1_000)
    let socket = server.connect(account: "A")
    server.subscribe(socket, to: [.tree("b_00000001"), .overlay("b_00000001")])
    _ = server.push(board(2, "dead"), account: "A", at: 2_000)
    #expect(server.frames(for: socket) == [["op": "gone", "scope": "tree/b_00000001"]])
  }

  // Review F2: each admission publishes at its own step 17, to sockets that may read the scope then.
  @Test func eachAdmissionOfAPushPublishesAtItsOwnStep17_6_8() throws {
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"))
    let board = { (n: Int64, life: String) -> JSON in
      ["n": JSON(n), "scope": "self/probe", "d": [["t": "board", "id": "b_00000001", "born": "10:0:r_aaaaaaaaaaaa",
                                                   "life": [.string(life), .string("\(10 * n):0:r_aaaaaaaaaaaa")]]]]
    }
    _ = server.push(["replica": "rp_a", "ackThrough": 0, "intents": [board(1, "alive")]], account: "A", at: 1_000)
    let socket = server.connect(account: "A")
    server.subscribe(socket, to: [.tree("b_00000001")])
    let reply = server.push(["replica": "rp_a", "ackThrough": 0, "intents": [
      ["n": 2, "scope": "tree/b_00000001", "d": [["t": "meta", "id": "meta", "f": ["title": ["Plan", "20:0:r_aaaaaaaaaaaa"]]]]],
      board(3, "dead"),
    ]], account: "A", at: 2_000)
    let titleFrame = try #require(reply.events.first?.json["frame"])
    #expect(server.frames(for: socket) == [titleFrame, ["op": "gone", "scope": "tree/b_00000001"]])
  }

  // INV-7(e): a scope answers not-found identically on pull and live, a signed-out socket's `self/…` included.
  @Test func aSignedOutSocketSubscribingItsOwnScopesIsAnsweredNotFound_INV7() throws {
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"))
    let socket = server.connect(account: nil)
    server.subscribe(socket, to: [.product("probe"), .product("nope"), .overlay("b_00000001")])
    #expect(server.frames(for: socket) == [
      ["op": "not-found", "scope": "self/probe"], ["op": "not-found", "scope": "self/nope"],
      ["op": "not-found", "scope": "self/overlay/b_00000001"],
    ])
  }

  @Test func aFrameLeavesItsRowsOutAboveTheInlineBoundAndFramesOfAScopeLeaveInSeqOrder_6_8() throws {
    var limits = ServerLimits()
    limits.liveInlineBytes = 16
    var server = ModelServer(registry: try Corpus.probeRegistry(), rules: ProbeServerRules(), state: ServerState(epoch: "ep-1"), limits: limits)
    let intents: [JSON] = (1...3).map { n in
      ["n": JSON(n), "scope": "self/probe", "d": [["t": "day", "id": .string("2026-09-0\(n)"), "life": ["alive", .string("\(n):0:r_aaaaaaaaaaaa")]]]]
    }
    let reply = server.push(["replica": "rp_a", "ackThrough": 0, "intents": .array(intents)], account: "A", at: 1_000)
    let digest = try #require(server.state.scopes[ScopeKey(.product(account: "A", name: "probe"))]?.digest)
    #expect(reply.events.map(\.json).map { $0["frame"]?["seq"] } == [1, 2, 3])
    #expect(reply.events.last?.json == ["key": "acct:A/probe", "frame": [
      "op": "change", "scope": "self/probe", "epoch": "ep-1", "seq": 3, "digest": .string(digest.hex),
    ]])
  }
}
