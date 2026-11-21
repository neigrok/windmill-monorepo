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
        let id = try mint.id { Int.random(in: 0..<$0, using: &random) }
        #expect(type.idPattern?.matches(id) == true, "seed \(random.seed): \(type.name) minted \(id)")
      }
    }
  }

  @Test func unicodeDomainMintsWholeScalarsAndKeepsByteIdentities() throws {
    let vector = try Corpus.files().filter { $0.path == "registry/refusals.json" }.flatMap { try Corpus.vectors(in: $0) }
      .first { $0.name == "a mint draws Unicode scalars within the id domain" }!
    let registry = try Registry(json: vector.input.member("registry"))
    let type = try #require(registry.type("node"))
    let mint = try #require(type.mint)
    let id = try mint.id { size in
      #expect(size == 2)
      return 1
    }
    #expect(id == "界" + String(repeating: "🚀", count: 127))
    #expect(registry.isID(.string(id), of: type))
    #expect(try Registry(json: registry.json).json == registry.json)
    let ids = [RecordID("é"), RecordID("e\u{301}")]
    #expect(Set(ids).count == 2)
    #expect(try ids.map { try RecordID(text: $0.text) } == ids)
  }

  @Test func idsCompareByBytesNotByCanonicalEquivalence() throws {
    #expect(try DerivedID.from(label: "", fallback: "K", taken: ["\u{212A}"]) == "K")
    #expect(try DerivedID.from(label: "", fallback: "K", taken: ["K"]) == "K-2")
    #expect(SeededID(parsing: "\u{E9}-1") != SeededID(parsing: "e\u{301}-1"))
    #expect(Set([SeededID(parsing: "\u{E9}-1"), SeededID(parsing: "e\u{301}-1")]).count == 2)
  }
}
