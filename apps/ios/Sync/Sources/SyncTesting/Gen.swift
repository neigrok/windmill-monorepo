import Foundation
import SyncCore

// Seeded generators for property tests: SYNC_SEED fixes the seed, and every failure message names it.

public struct SeededRandom: RandomNumberGenerator, Sendable {
  public let seed: UInt64
  var state: (UInt64, UInt64, UInt64, UInt64)

  public init(seed: UInt64) {
    self.seed = seed
    var mix = seed
    func splitMix() -> UInt64 {
      mix &+= 0x9E37_79B9_7F4A_7C15
      var z = mix
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
    state = (splitMix(), splitMix(), splitMix(), splitMix())
  }

  public static func fromEnvironment() -> SeededRandom {
    let chosen = ProcessInfo.processInfo.environment["SYNC_SEED"].flatMap { UInt64($0) }
    return SeededRandom(seed: chosen ?? UInt64.random(in: 0...UInt64.max))
  }

  // xoshiro256**
  public mutating func next() -> UInt64 {
    let result = ((state.1 &* 5) << 7 | (state.1 &* 5) >> 57) &* 9
    let shifted = state.1 << 17
    state.2 ^= state.0
    state.3 ^= state.1
    state.1 ^= state.2
    state.0 ^= state.3
    state.2 ^= shifted
    state.3 = state.3 << 45 | state.3 >> 19
    return result
  }

  public mutating func pick<Element>(_ options: [Element]) -> Element {
    options[Int.random(in: options.indices, using: &self)]
  }

  public mutating func chance(_ probability: Double) -> Bool {
    Double.random(in: 0..<1, using: &self) < probability
  }

  // A small pool, so equal stamps, equal pairs with different actors and the unset stamp all recur.
  public mutating func stamp() -> Stamp {
    if chance(0.05) { return .unset }
    return try! Stamp("\(Int.random(in: 1...3, using: &self)):\(Int.random(in: 0...2, using: &self)):\(pick(["a", "b", "r_x"]))")
  }

  // Strings that trip Swift: canonical equivalents, the Kelvin sign, astral characters, controls and escapes.
  public mutating func text() -> String {
    pick(["", "a", "b", "é", "e\u{301}", "K", "\u{212A}", "\u{FB33}", "😀", "\u{7F}", "\u{2028}", "\"", "\\", "\u{0}", "\t",
          "ab", "a b", "10", "9"])
  }

  public mutating func number() -> Double {
    pick([0, -0.0, 1, -1, 9, 10, 0.1, 1e21, 1e-7, .leastNonzeroMagnitude, .greatestFiniteMagnitude, 9_007_199_254_740_991,
          333_333_333.33333325, Double.random(in: -1e6...1e6, using: &self)])
  }

  public mutating func json(depth: Int = 3) -> JSON {
    let leaf = depth == 0 || chance(0.5)
    switch Int.random(in: leaf ? 0...3 : 0...5, using: &self) {
    case 0: return .null
    case 1: return .bool(chance(0.5))
    case 2: return .number(JSON.Number(number())!)
    case 3: return .string(text())
    case 4: return .array((0..<Int.random(in: 0...3, using: &self)).map { _ in json(depth: depth - 1) })
    default:
      var object = JSON.Object()
      for _ in 0..<Int.random(in: 0...3, using: &self) { object[text()] = json(depth: depth - 1) }
      return .object(object)
    }
  }
}
