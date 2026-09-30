import SyncCore
import Testing

// §9.2–§9.6 exchanges are the same only byte for byte: an epoch, a cursor, a replica, an account, an `as` or an op that
// differs from another only by canonical equivalence ("\u{E9}" and "e\u{301}") is another exchange, and an answer served
// as one of them is not served to the other.

struct MessagesTests {
  @Test func exchangesThatDifferOnlyByCanonicalEquivalenceAreDifferent() throws {
    let epochs = ["\u{E9}", "e\u{301}"]
    let failures = epochs.map { HTTPFailure(status: 409, error: $0, epoch: $0) }
    let hellos = try epochs.map { try HelloResponse(json: ["serverTime": 1, "epoch": .string($0), "schema": 1, "minSchema": 1]) }
    let pushes = epochs.map { PushRequest(replica: $0, account: "A", ackThrough: 0, intents: []) }
    let accounts = epochs.map { PushRequest(replica: "rp", account: $0, ackThrough: 0, intents: []) }
    let served = try epochs.map { try PullResponse(json: ["serverTime": 1, "epoch": "ep", "as": .string($0), "pages": []]) }
    let pulls = epochs.map { PullRequest(scopes: [PullRequest.Pulled(scope: .product("p"), cursor: $0)]) }
    let pages = epochs.map { RowsPage(rows: [], cursor: $0, more: false, seq: 0, digest: .zero) }
    let pushed = try epochs.map { try PushResponse(json: ["serverTime": 1, "epoch": .string($0), "lastN": 0, "results": []]) }
    let pulled = try epochs.map { try PullResponse(json: ["serverTime": 1, "epoch": .string($0), "pages": []]) }
    let frames = try epochs.map { epoch in
      try LiveFrame(json: ["op": "change", "scope": "self/p", "epoch": .string(epoch), "seq": 1, "digest": .string(ScopeDigest.zero.hex)])
    }
    let others = try epochs.map { try LiveFrame(json: ["op": .string($0)]) }
    let counts: [Int] = [
      Set(failures).count, Set(hellos).count, Set(pushes).count, Set(accounts).count, Set(pulls).count,
      Set(pulls.map(\.scopes[0])).count, Set(pages).count, Set(pushed).count, Set(pulled).count, Set(served).count,
      Set(frames).count, Set(others).count,
    ]
    #expect(counts == [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2])
    #expect([served[0].isServed(to: epochs[0]), served[0].isServed(to: epochs[1])] == [true, false])
  }
}

// §9.1: an `as` that is null, absent or not a string names no account, so an answer or frame carrying one decodes, and is
// served to no replica of an account; the `anon` replica takes whatever it is served.
struct ServedAsTests {
  @Test func anAsThatIsNotAnAccountIdIsServedToNoAccount() throws {
    let values: [JSON?] = [nil, .null, 42, ["A"], "A"]
    let answers = try values.map { value -> PullResponse in
      var body: JSON.Object = ["serverTime": 1, "epoch": "ep", "pages": []]
      body["as"] = value
      return try PullResponse(json: .object(body))
    }
    let frames = try values.map { value -> LiveFrame in
      var body: JSON.Object = ["op": "not-found", "scope": "self/probe"]
      body["as"] = value
      return try LiveFrame(json: .object(body))
    }
    #expect(answers.map { $0.isServed(to: "A") } == [false, false, false, false, true])
    #expect(frames.map { $0.isServed(to: "A") } == [false, false, false, false, true])
    #expect(answers.map { $0.isServed(to: nil) } == [true, true, true, true, true])
  }
}
