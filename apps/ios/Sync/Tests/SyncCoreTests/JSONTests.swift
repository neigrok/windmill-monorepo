import SyncCore
import SyncTesting
import Testing

// The Swift traps JSON must avoid, strict parsing, and the round trip of every value through its JCS text.

struct JSONTests {
  @Test func canonicallyEquivalentKeysStayTwoKeysInUTF16Order() throws {
    let object = try JSON(parsing: "{\"\u{E9}\":1,\"e\u{301}\":2,\"\u{212A}\":3,\"K\":4}")
    #expect(object.jcs == Array("{\"K\":4,\"e\u{301}\":2,\"\u{E9}\":1,\"\u{212A}\":3}".utf8))
  }

  @Test func canonicallyEquivalentStringsAreDifferentValues() {
    let values: Set<JSON> = [.string("\u{E9}"), .string("e\u{301}"), .string("K"), .string("\u{212A}")]
    #expect(values.count == 4)
    #expect(JSON.string("\u{E9}") != JSON.string("e\u{301}"))
  }

  @Test func aDuplicateKeyIsRefusedByItsBytes() {
    #expect(throws: JSONError.duplicateKey("a")) { try JSON(parsing: #"{"a":1,"b":2,"a":3}"#) }
  }

  @Test(arguments: [
    "01", "1.", ".5", "+1", "-", "1e", "1e+", "0x10", "NaN", "Infinity", "1e400", "-1e400", "tru", "nul", "[1,]", "[1 2]",
    "{\"a\"}", "{\"a\":1,}", "{a:1}", "'a'", "\"a", "\"\\x\"", "\"\\u12\"", "1 2", "\u{FEFF}1", "", " ",
  ])
  func malformedTextIsRefused(_ text: String) {
    #expect(throws: JSONError.self) { try JSON(parsing: text) }
  }

  @Test func rawControlCharactersAndInvalidUTF8AreRefused() {
    #expect(throws: JSONError.self) { try JSON(parsing: "\"a\u{1}b\"") }
    #expect(throws: JSONError.self) { try JSON(parsing: [0x22, 0xC3, 0x28, 0x22]) }
    #expect(throws: JSONError.self) { try JSON(parsing: [0x22, 0xED, 0xA0, 0x80, 0x22]) }
  }

  @Test func nestingStopsAtMaxDepth() throws {
    let deepest = String(repeating: "[", count: JSON.maxDepth) + String(repeating: "]", count: JSON.maxDepth)
    #expect(try JSON(parsing: deepest).jcsText == deepest)
    #expect(throws: JSONError.tooDeep(offset: JSON.maxDepth)) { try JSON(parsing: "[" + deepest + "]") }
  }

  @Test func negativeZeroIsZero() throws {
    let zero = try #require(JSON.Number(-0.0))
    #expect(zero.value.sign == .plus)
    #expect(JSON.number(zero) == 0)
  }

  @Test func objectMembersKeepJCSOrderWhenSetAndRemoved() {
    var object: JSON.Object = ["b": 1, "\u{FB33}": 2]
    object["😀"] = 3
    object["a"] = 4
    object["b"] = nil
    #expect(JSON.object(object).jcs == Array("{\"a\":4,\"😀\":3,\"\u{FB33}\":2}".utf8))
  }

  @Test func everyValueRoundTripsThroughItsJCSText() throws {
    var random = SeededRandom.fromEnvironment()
    for _ in 0..<2_000 {
      let value = random.json()
      let reparsed = try JSON(parsing: value.jcsText)
      #expect(reparsed.jcs == value.jcs, "seed \(random.seed): \(value.jcsText)")
    }
  }

  @Test func everyFiniteDoubleRoundTripsThroughItsECMAScriptText() throws {
    var random = SeededRandom.fromEnvironment()
    for _ in 0..<20_000 {
      guard let number = JSON.Number(Double(bitPattern: random.next())) else { continue }
      let reparsed = try JSON(parsing: number.description)
      #expect(reparsed == .number(number), "seed \(random.seed): \(number.value) printed as \(number.description)")
    }
  }
}
