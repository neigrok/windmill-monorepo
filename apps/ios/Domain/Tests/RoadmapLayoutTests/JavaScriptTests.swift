import RoadmapLayout
import Testing

struct JavaScriptTests {
  // Swift's own String says the opposite of each line here: it takes two spellings for one text and orders by scalar.
  @Test func aTextIsEqualOrderedAndKeyedByItsUTF16CodeUnits() {
    let composed = UTF16Text("\u{E9}")
    let decomposed = UTF16Text("e\u{301}")
    let astral = UTF16Text("\u{1F600}")
    let wide = UTF16Text("\u{FF21}")
    #expect(composed != decomposed)
    #expect(Set([composed, decomposed]).count == 2)
    #expect(decomposed < composed)
    #expect(astral < wide)
    #expect([wide, UTF16Text("\u{E000}"), astral, UTF16Text("\u{10000}"), UTF16Text("a"), UTF16Text("")].sorted().map(\.units) == [
      [], [0x61], [0xD800, 0xDC00], [0xD83D, 0xDE00], [0xE000], [0xFF21],
    ])
    #expect(astral.text.unicodeScalars.map(\.value) == [0x1F600])
  }
}
