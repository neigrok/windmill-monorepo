import SyncCore
import SyncTesting
import Testing

// §11.2 property 5: `between(a, b)` is a key strictly between `a` and `b`, however the list grows.

struct FractionalIndexTests {
  enum Growth: CaseIterable {
    case anywhere, top, bottom, oneGap
  }

  @Test(arguments: Growth.allCases)
  func betweenLiesStrictlyBetween(_ growth: Growth) throws {
    var random = SeededRandom.fromEnvironment()
    var keys: [FractionalKey] = []
    for _ in 0..<1_500 {
      let at = switch growth {
      case .anywhere: Int.random(in: 0...keys.count, using: &random)
      case .top: 0
      case .bottom: keys.count
      case .oneGap: min(1, keys.count)
      }
      let above = at == 0 ? nil : keys[at - 1]
      let below = at == keys.count ? nil : keys[at]
      let key = try FractionalKey(between: above, and: below)
      #expect(above.map { $0 < key } ?? true, "seed \(random.seed): \(key) is not after \(String(describing: above))")
      #expect(below.map { key < $0 } ?? true, "seed \(random.seed): \(key) is not before \(String(describing: below))")
      #expect(try FractionalKey(key.text) == key, "seed \(random.seed): \(key) is not a valid key")
      keys.insert(key, at: at)
    }
    #expect(keys == keys.sorted())
    #expect(keys.map(\.text) == keys.map(\.text).sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) })
  }

  @Test func aKeyOfAnyLengthHasAKeyAfterIt() throws {
    let long = try FractionalKey("a0" + String(repeating: "z", count: 100_000))
    let next = try FractionalKey("a1")
    let key = try FractionalKey(between: long, and: next)
    #expect(long < key && key < next)
    #expect(key.text.utf8.count == 100_003)
  }
}
