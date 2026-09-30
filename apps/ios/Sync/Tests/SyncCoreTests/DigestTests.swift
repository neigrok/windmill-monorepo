import SyncCore
import SyncTesting
import Testing

// §11.2 property 6: an incrementally kept digest equals the recount, across sums that wrap.

struct DigestTests {
  @Test func anIncrementalDigestEqualsTheRecount() throws {
    var random = SeededRandom.fromEnvironment()
    var rows: [String: JSON] = [:]
    var digest = ScopeDigest.zero
    for seq in 1...1_000 {
      let id = random.pick(["card0001", "card0002", "card0003", "tag-a", "meta"])
      let after: JSON? = random.chance(0.2) ? nil : [
        "t": "card", "id": .string(id), "seq": JSON(seq), "rc": 1000, "ru": JSON(1000 + seq),
        "life": [.string(random.pick(["alive", "alive", "dead"])), random.stamp().json],
        "f": ["title": [random.json(depth: 1), random.stamp().json]],
      ]
      digest = digest.replacing(rows[id], with: after)
      rows[id] = after
      #expect(digest == ScopeDigest(rows: rows.values), "seed \(random.seed), seq \(seq)")
      #expect(try ScopeDigest(hex: digest.hex) == digest, "seed \(random.seed), seq \(seq)")
    }
  }

  @Test func sumsWrapBothWays() throws {
    let top = try ScopeDigest(hex: String(repeating: "f", count: 64))
    let one = try ScopeDigest(hex: String(repeating: "0", count: 63) + "1")
    #expect(top + one == .zero)
    #expect(ScopeDigest.zero - one == top)
    #expect((top + top) - top == top)
  }

  @Test(arguments: [
    "", "0", String(repeating: "0", count: 63) + "g", String(repeating: "A", count: 64), String(repeating: "0", count: 65),
  ])
  func hexIsExactlySixtyFourLowercaseDigits(_ hex: String) {
    #expect(throws: DigestError(hex: hex)) { try ScopeDigest(hex: hex) }
  }
}
