import DomainKit
import DomainKitTesting
import Foundation
import SyncAPI
import SyncCore
import SyncTesting
import Testing

// §14.4 a product's corpus decides as the runner does: a draft's save opens its draft as `open(_:orNew:)` does and saves
// it as `save` does, and a read reads only its own scope, over the probe declarations.
struct ProductCorpusTests {
  static func vector(_ input: JSON) throws -> Vector {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("product-corpus-\(UUID().uuidString).json")
    try Data(JSON.array([["name": "case", "input": input, "expect": [:]]]).jcs).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    return try #require(try Contract.vectors(file.path).first)
  }

  static func corpus() throws -> ProductCorpus {
    ProductCorpus(RuleBook(registry: try Corpus.probeRegistry(), entities: [Fact.self, Card.self], rules: [.local(Fact.value)]))
  }

  static let fact: JSON = ["t": "fact", "id": "2027-01-10", "seq": 1, "life": ["alive", "1000:0:r_aaaaaaaaaaaa"],
                           "f": ["value": [80, "1000:0:r_aaaaaaaaaaaa"], "at": [1_799_990_000_000, "1000:0:r_aaaaaaaaaaaa"]]]

  @Test func aDraftSaveOpensTheDrawnRecordEditsItAndSavesItWhole() throws {
    let vector = try ProductCorpusTests.vector(["records": ["drawn": [ProductCorpusTests.fact]], "now": 1_800_000_000_000,
                                                "offsetSeconds": 0])
    let result = try ProductCorpusTests.corpus().save(SaveDraft<Fact, ProbeRefusal>.self, vector, opening: Fact(id: ID("2027-01-10")),
                                                      edit: { $0.value = 81.04 }, result: \.form, refusal: \.form)
    let written: JSON = ["value": 81, "at": 1_800_000_000_000]
    #expect(result == ["decision": ["write": [
      "gesture": ["changes": [["op": "put", "t": "fact", "id": "2027-01-10", "present": true, "f": written]], "atomic": false,
                  "hold": false, "guards": [], "retire": [["t": "fact", "id": "2027-01-10"]], "cmd": .null, "predict": [], "local": []],
      "result": ["values": written, "exists": true]]]])
  }

  @Test func aDraftSaveOfAMintedTypeTrapsAsOpenOrNewDoes() async {
    await #expect(processExitsWith: .failure) {
      let vector = try ProductCorpusTests.vector(["records": ["drawn": []], "now": 1_800_000_000_000, "offsetSeconds": 0])
      _ = try ProductCorpusTests.corpus().save(SaveDraft<Card, ProbeRefusal>.self, vector, opening: Card(id: ID("cardA001")),
                                               edit: { $0.title = "Alpha" }, result: \.form, refusal: \.form)
    }
  }

  @Test func aDraftSaveWhoseEditNamesAnotherRecordTrapsAsSaveDoes() async {
    await #expect(processExitsWith: .failure) {
      let vector = try ProductCorpusTests.vector(["records": ["drawn": []], "now": 1_800_000_000_000, "offsetSeconds": 0])
      _ = try ProductCorpusTests.corpus().save(SaveDraft<Fact, ProbeRefusal>.self, vector, opening: Fact(id: ID("2027-01-10")),
                                               edit: { $0 = Fact(id: ID("2027-01-11"), value: 81) }, result: \.form, refusal: \.form)
    }
  }

  @Test func aReadOfATypeOfAnotherScopeThrowsAsTheEnginesReadersDo() throws {
    let vector = try ProductCorpusTests.vector(["records": ["drawn": [ProductCorpusTests.fact]], "now": 1_800_000_000_000,
                                                "offsetSeconds": 0])
    let facts = { (read: Reader) throws -> JSON in .array(try read.repository(Fact.self).all(in: .drawn).map { .object(fields: $0.fields) }) }
    #expect(try ProductCorpusTests.corpus().read(vector, in: Probe.scope, facts)
      == ["result": [["value": 80, "at": 1_799_990_000_000]]])
    #expect(throws: CommitFailure.malformed("fact is no type of tree/b_00000001")) {
      try ProductCorpusTests.corpus().read(vector, in: Probe.tree, facts)
    }
  }
}
