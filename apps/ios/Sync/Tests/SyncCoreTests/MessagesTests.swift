import SyncCore
import Testing

// §9.2–§9.6 exchanges are the same only byte for byte: an epoch, a cursor, a replica or an op that differs from another
// only by canonical equivalence ("\u{E9}" and "e\u{301}") is another exchange.

struct MessagesTests {
  @Test func exchangesThatDifferOnlyByCanonicalEquivalenceAreDifferent() throws {
    let epochs = ["\u{E9}", "e\u{301}"]
    let failures = epochs.map { HTTPFailure(status: 409, error: $0, epoch: $0) }
    let hellos = try epochs.map { try HelloResponse(json: ["serverTime": 1, "epoch": .string($0), "schema": 1, "minSchema": 1]) }
    let pushes = epochs.map { PushRequest(replica: $0, ackThrough: 0, intents: []) }
    let pulls = epochs.map { PullRequest(scopes: [PullRequest.Pulled(scope: .product("p"), cursor: $0)]) }
    let pages = epochs.map { RowsPage(rows: [], cursor: $0, more: false, seq: 0, digest: .zero) }
    let pushed = try epochs.map { try PushResponse(json: ["serverTime": 1, "epoch": .string($0), "lastN": 0, "results": []]) }
    let pulled = try epochs.map { try PullResponse(json: ["serverTime": 1, "epoch": .string($0), "pages": []]) }
    let frames = try epochs.map { epoch in
      try LiveFrame(json: ["op": "change", "scope": "self/p", "epoch": .string(epoch), "seq": 1, "digest": .string(ScopeDigest.zero.hex)])
    }
    let others = try epochs.map { try LiveFrame(json: ["op": .string($0)]) }
    let counts: [Int] = [
      Set(failures).count, Set(hellos).count, Set(pushes).count, Set(pulls).count, Set(pulls.map(\.scopes[0])).count,
      Set(pages).count, Set(pushed).count, Set(pulled).count, Set(frames).count, Set(others).count,
    ]
    #expect(counts == [2, 2, 2, 2, 2, 2, 2, 2, 2, 2])
  }
}
