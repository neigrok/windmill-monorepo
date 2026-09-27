import SyncCore
import SyncTesting
import Testing

// §9.1 wire values are the same only byte for byte: a scope reference by its text, every other value by its JSON, so a
// canonically equivalent look-alike ("\u{E9}" and "e\u{301}", "\u{212A}" and "K") is always another value. U+0000 is
// found at any depth, and a cursor decodes only safe integers.

struct WireTests {
  @Test func scopeReferencesAreTheSameOnlyByteForByte() {
    let scopes: Set<ScopeRef> = [.tree("t\u{E9}"), .tree("te\u{301}"), .product("\u{212A}"), .product("K"), .tree("t\u{E9}")]
    #expect(scopes.sorted().map(\.json) == ["self/K", "self/\u{212A}", "tree/te\u{301}", "tree/t\u{E9}"])
    #expect(ScopeRef.overlay("t\u{E9}") != .overlay("te\u{301}"))
  }

  // A reference the wire cannot carry (not printable ASCII, or with an empty part) names no scope of the registry.
  @Test func aReferenceTheWireCannotCarryNamesNoScopeKind() throws {
    let probe = try Corpus.probeRegistry()
    let scopes: [ScopeRef] = [.tree("t\u{E9}"), .overlay("\u{212A}"), .tree(""), .product("pro/be"), .tree("b_00000001"), .product("probe")]
    #expect(scopes.map(probe.scopeKind(of:)) == [nil, nil, nil, nil, .tree, .product("probe")])
  }

  @Test func wireValuesAreEqualOnlyWhenTheirJSONIs() throws {
    let stamp = try Stamp("1:0:r_aaaaaaaaaaaa")
    let key = RecordKey("card", "c1")
    let states = [TextState(text: "\u{E9}", rev: 1, merged: false), TextState(text: "e\u{301}", rev: 1, merged: false)]
    let bases = [TextBase.text("\u{E9}"), .text("e\u{301}")]
    let writes = [TextWrite(text: "\u{E9}", base: .rev(1)), TextWrite(text: "e\u{301}", base: .rev(1))]
    let rows = [Row(key: key, texts: ["body": states[0]], seq: 1), Row(key: key, texts: ["body": states[1]], seq: 1)]
    let deltas = [Delta(key: key, texts: ["body": writes[0]]), Delta(key: key, texts: ["body": writes[1]])]
    let guards = [Guard(key: key, field: "\u{212A}", stamp: stamp), Guard(key: key, field: "K", stamp: stamp)]
    let commands = [Command(name: "p.\u{212A}", args: .null), Command(name: "p.K", args: .null)]
    let intents = [Intent(scope: .product("p"), gestureId: "g\u{E9}"), Intent(scope: .product("p"), gestureId: "ge\u{301}")]
    let cursors = [Cursor(epoch: "\u{E9}", mode: .live, seq: 1), Cursor(epoch: "e\u{301}", mode: .live, seq: 1)]
    let counts: [Int] = [
      Set(states).count, Set(bases).count, Set(writes).count, Set(rows).count, Set(deltas).count, Set(guards).count,
      Set(commands).count, Set(intents).count, Set(cursors).count,
    ]
    #expect(counts == [2, 2, 2, 2, 2, 2, 2, 2, 2])
  }

  // §6.1 step 2 and §7.1 step 7: U+0000 in any string, a key or a value at any depth.
  @Test func aValueHoldsNulWhereverAStringOfItDoes() {
    let values: [JSON] = [
      "a\u{0}b", ["a", ["b\u{0}"]], ["a": ["b": "\u{0}"]], ["a\u{0}": 1], [["k\u{0}": .null]],
      "a", ["a", 1, true, .null], ["a": ["b": "c"]], "\u{1}", 0,
    ]
    #expect(values.map(\.holdsNul) == [true, true, true, true, true, false, false, false, false, false])
  }

  // §9.1 Integers: a cursor whose `s` or `a` is beyond 2^53 − 1 in magnitude is undecodable.
  @Test func aCursorDecodesOnlySafeIntegers() {
    let safe: Int64 = 9_007_199_254_740_991
    let cursors = [
      Cursor(epoch: "ep-1", mode: .live, seq: safe), Cursor(epoch: "ep-1", mode: .live, seq: safe + 1),
      Cursor(epoch: "ep-1", mode: .boot, seq: 1, asOf: safe), Cursor(epoch: "ep-1", mode: .boot, seq: 1, asOf: safe + 1),
    ]
    #expect(cursors.map { Cursor(decoding: $0.text) } == [cursors[0], nil, cursors[2], nil])
  }
}
