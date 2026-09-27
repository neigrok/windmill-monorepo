import SyncCore
import SyncModelServer
import Testing

// §6.11 properties over random texts: scripts are shortest and rebuild their target, and a merge keeps text (INV-12).

struct TextMergeTests {
  static let vocabulary = ["a", "b", "c", "dd", " ", "  ", "\n", "\t "]

  func randomText(_ draws: inout SplitMix64) -> String {
    (0..<Int(draws.next() % 9)).map { _ in Self.vocabulary[Int(draws.next() % UInt64(Self.vocabulary.count))] }.joined()
  }

  @Test func aScriptRebuildsItsTargetWithTheFewestEdits_6_11() {
    var draws = SplitMix64(seed: 11)
    for _ in 0..<400 {
      let a = TextMerge.tokens(randomText(&draws))
      let b = TextMerge.tokens(randomText(&draws))
      let script = TextMerge.script(a, b)
      #expect(script.filter { $0.0 != .delete }.map(\.1) == b)
      #expect(script.filter { $0.0 != .insert }.map(\.1) == a)
      #expect(script.filter { $0.0 != .keep }.count == a.count + b.count - 2 * longestCommonSubsequence(a, b))
    }
  }

  func longestCommonSubsequence(_ a: [String], _ b: [String]) -> Int {
    var lengths = [[Int]](repeating: [Int](repeating: 0, count: b.count + 1), count: a.count + 1)
    for i in a.indices.reversed() {
      for j in b.indices.reversed() {
        lengths[i][j] = a[i] == b[j] ? lengths[i + 1][j + 1] + 1 : max(lengths[i + 1][j], lengths[i][j + 1])
      }
    }
    return lengths[0][0]
  }

  // Every non-whitespace token a side inserted, with every base token both sides kept, is in the result as often.
  @Test func aMergeKeepsEveryInsertedTokenAndEveryBaseTokenNeitherSideDeleted_INV12() {
    var draws = SplitMix64(seed: 12)
    for _ in 0..<600 {
      let base = randomText(&draws)
      let head = randomText(&draws)
      let mine = randomText(&draws)
      let merged = TextMerge.diff3(base: base, head: head, mine: mine)
      let result = counts(TextMerge.tokens(merged.text))
      let headScript = TextMerge.script(TextMerge.tokens(base), TextMerge.tokens(head))
      let mineScript = TextMerge.script(TextMerge.tokens(base), TextMerge.tokens(mine))
      let keptByBoth = counts(kept(headScript, alongside: mineScript))
      for script in [headScript, mineScript] {
        let expected = counts(script.filter { $0.0 == .insert }.map(\.1)).merging(keptByBoth, uniquingKeysWith: +)
        for (token, count) in expected {
          #expect(result[token, default: 0] >= count, "\(base.debugDescription) / \(head.debugDescription) / \(mine.debugDescription)")
        }
      }
    }
  }

  // The base tokens, by position, that neither script deletes.
  func kept(_ first: [(TextMerge.Edit, String)], alongside second: [(TextMerge.Edit, String)]) -> [String] {
    let keptPositions = { (script: [(TextMerge.Edit, String)]) -> [Bool] in script.filter { $0.0 != .insert }.map { $0.0 == .keep } }
    let base = first.filter { $0.0 != .insert }.map(\.1)
    return zip(base, zip(keptPositions(first), keptPositions(second))).filter { $0.1.0 && $0.1.1 }.map(\.0)
  }

  func counts(_ tokens: [String]) -> [String: Int] {
    tokens.filter { !$0.unicodeScalars.allSatisfy(TextMerge.isWhitespace) }.reduce(into: [:]) { $0[$1, default: 0] += 1 }
  }
}
