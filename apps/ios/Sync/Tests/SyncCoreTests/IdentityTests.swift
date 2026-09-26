import SyncCore
import SyncTesting
import Testing

// D-8 minted ids match their type's pattern; ids compare by bytes, never by canonical equivalence.

struct IdentityTests {
  @Test func everyMintedIdMatchesItsTypesPattern() throws {
    var random = SeededRandom.fromEnvironment()
    let minting = try Corpus.probeRegistry().types.compactMap { type in type.mint.map { (type: type, mint: $0) } }
    #expect(minting.map(\.type.name) == ["board", "card", "run", "lap", "tag"])
    for (type, mint) in minting {
      for _ in 0..<500 {
        let id = mint.id(using: &random)
        #expect(type.idPattern?.matches(id) == true, "seed \(random.seed): \(type.name) minted \(id)")
      }
    }
  }

  @Test func idsCompareByBytesNotByCanonicalEquivalence() {
    #expect(DerivedID.from(label: "", fallback: "K", taken: ["\u{212A}"]) == "K")
    #expect(DerivedID.from(label: "", fallback: "K", taken: ["K"]) == "K-2")
    #expect(SeededID(parsing: "\u{E9}-1") != SeededID(parsing: "e\u{301}-1"))
    #expect(Set([SeededID(parsing: "\u{E9}-1"), SeededID(parsing: "e\u{301}-1")]).count == 2)
  }
}
