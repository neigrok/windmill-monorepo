import DomainKit
import DomainKitTesting
import Foundation
import SyncAPI
import SyncCore
import SyncTesting
import Testing

// §14.4 a product's corpus opens or creates an editor draft, decides its save, and reads only its own scope.
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

  @Test func aNewMintedDraftIsValidatedThroughItsEditorSave() throws {
    let vector = try ProductCorpusTests.vector(["records": ["drawn": []], "now": 1_800_000_000_000, "offsetSeconds": 0])
    let result = try ProductCorpusTests.corpus().save(SaveDraft<Card, ProbeRefusal>.self, vector, opening: Card(id: ID("cardA001")),
                                                   edit: { _ in }, result: \.form, refusal: \.form)
    #expect(result == ["decision": ["refuse": ["violation": ["rule": "card.title", "path": "title", "reason": "blank"]]]])
  }

  @Test func aDraftSaveWhoseEditNamesAnotherRecordTrapsAsSaveDoes() async {
    await #expect(processExitsWith: .failure) {
      let vector = try ProductCorpusTests.vector(["records": ["drawn": []], "now": 1_800_000_000_000, "offsetSeconds": 0])
      _ = try ProductCorpusTests.corpus().save(SaveDraft<Fact, ProbeRefusal>.self, vector, opening: Fact(id: ID("2027-01-10")),
                                               edit: { $0 = Fact(id: ID("2027-01-11"), value: 81) }, result: \.form, refusal: \.form)
    }
  }

  // A scene's read takes its scope's records and the scene's device rows; a scope the scene leaves out holds none.
  @Test func aReadOverASceneReadsItsOwnScope() throws {
    let meta: JSON = ["t": "meta", "id": "meta", "seq": 1, "f": ["title": ["Kept", "1000:0:r_aaaaaaaaaaaa"]]]
    let scopes: JSON = ["tree/b_00000001": ["drawn": [meta]], "self/probe": ["drawn": [ProductCorpusTests.fact]]]
    let vector = try ProductCorpusTests.vector(["scopes": scopes, "device": ["rack": 2], "now": 1_800_000_000_000, "offsetSeconds": 0])
    let titles = { (read: Reader) throws -> JSON in
      let drawn: [JSON] = try read.repository(Meta.self).all(in: .drawn).map { (meta: Meta) -> JSON in .string(meta.title) }
      let rack: JSON = try read.device("rack") ?? .null
      return .array(drawn + [rack])
    }
    #expect(try ProductCorpusTests.corpus().read(vector, in: Probe.tree, titles) == ["result": ["Kept", 2]])
    #expect(try ProductCorpusTests.corpus().read(vector, in: .tree("b_00000002"), titles) == ["result": [2]])
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

  static func tag(_ id: String, _ label: String, seq: Int64 = 1, life: String = "alive") -> JSON {
    ["t": "tag", "id": .string(id), "seq": JSON(seq), "born": "1000:0:r_aaaaaaaaaaaa", "life": [.string(life), "1000:0:r_aaaaaaaaaaaa"],
     "f": ["label": [.string(label), "1000:0:r_aaaaaaaaaaaa"]]]
  }

  // A scope's `confirmed` is the server's copy as the device pulled it, each row with its `seq`, by default what it
  // stores; its `spent` ids are what it keeps of records deleted elsewhere, each with its born and the `seq` it keeps; and
  // its records are listed whole, a dead one among them, by the repository and by the reader.
  @Test func aSceneReadsEachScopesConfirmedRecordsSpentIdsAndEveryRecord() throws {
    let born: JSON = "900:0:r_bbbbbbbbbbbb"
    let scopes: JSON = [
      "tree/b_00000001": ["drawn": [ProductCorpusTests.tag("tag00004", "Dropped", life: "dead"), ProductCorpusTests.tag("tag00001", "Mine"),
                                    ProductCorpusTests.tag("tag00002", "Kept")],
                          "confirmed": [ProductCorpusTests.tag("tag00001", "Theirs", seq: 5)],
                          "spent": [["t": "tag", "id": "tag00003", "born": born, "seq": 7], ["t": "tag", "id": "tag00005", "born": born]]],
      "tree/b_00000002": ["drawn": [ProductCorpusTests.tag("tag00001", "Other", seq: 2)]],
    ]
    let vector = try ProductCorpusTests.vector(["scopes": scopes, "now": 1_800_000_000_000, "offsetSeconds": 0])
    let held = { (read: Reader) throws -> JSON in
      let tags = read.repository(Tag.self)
      let confirmed: [JSON] = try ["tag00001", "tag00002"].map { (id: String) throws -> JSON in
        let record = try read.confirmed(Tag.self, ID(RecordID(id)))
        return [record?.values["label"] ?? .null, record?.seq.map { JSON($0) } ?? .null]
      }
      let spent: [JSON] = try ["tag00002", "tag00003", "tag00005"].map { (id: String) throws -> JSON in
        [try tags.spentBorn(ID(RecordID(id)))?.json ?? .null, try tags.spentSeq(ID(RecordID(id))).map { JSON($0) } ?? .null]
      }
      let listed: [[Record]] = [try tags.records(in: .drawn), try tags.records(in: .stored), try read.records(in: .drawn)]
      let every: [JSON] = listed.map { (records: [Record]) -> JSON in
        .array(records.map { (record: Record) -> JSON in [record.id.json, .bool(record.isVisible)] })
      }
      return ["confirmed": .array(confirmed), "spent": .array(spent), "every": .array(every),
              "visible": .array(try tags.all(in: .drawn).map(\.id.json))]
    }
    let tree: JSON = [["tag00001", true], ["tag00002", true], ["tag00004", false]]
    #expect(try ProductCorpusTests.corpus().read(vector, in: Probe.tree, held) == ["result": [
      "confirmed": [["Theirs", 5], [.null, .null]], "spent": [[.null, .null], [born, 7], [born, .null]], "every": [tree, tree, tree],
      "visible": ["tag00001", "tag00002"],
    ]])
    let other: JSON = [["tag00001", true]]
    #expect(try ProductCorpusTests.corpus().read(vector, in: .tree("b_00000002"), held) == ["result": [
      "confirmed": [["Other", 2], [.null, .null]], "spent": [[.null, .null], [.null, .null], [.null, .null]], "every": [other, other, other],
      "visible": ["tag00001"],
    ]])
  }

  struct Relabel: ActAction {
    func load(_ read: ActReader) throws -> (moment: Moment, tags: [Tag]) {
      (read.moment, try ["tag00001", "tag00002", "tag00003"].map { (id: String) throws -> Tag in try Tag.decoding(RecordID(id), [:]) })
    }

    func decide(_ loaded: (moment: Moment, tags: [Tag]), ids: ActIDSource) throws(Violation) -> ActDecision<JSON, ProbeRefusal> {
      var renamed = loaded.tags[0]
      renamed.label = "Renamed"
      var relabel = Plan()
      relabel.revive(try Valid(renamed, fields: ["label"], at: loaded.moment), fields: ["label"])
      relabel.undoBy(.fields(restoreCommand: "probe.restoreTree", targets: [(target: .field(renamed.id, "label"), default: "")]))
      var evidence = Plan()
      evidence.revive(try Valid(loaded.tags[1], fields: [], at: loaded.moment), fields: [])
      evidence.evidenceForUndo()
      var plain = Plan()
      plain.revive(try Valid(loaded.tags[2], fields: [], at: loaded.moment), fields: [])
      return .write(ActPlan([ScopedPlan(Probe.tree, relabel), ScopedPlan(Probe.tree, evidence), ScopedPlan(.tree("b_00000002"), plain)]), .null)
    }
  }

  // A segment whose plan opts into Undo names its recipes, one named for evidence alone names none, and any other no `undo`.
  @Test func anActsSegmentThatOptsIntoUndoNamesItsRecipes() throws {
    let vector = try ProductCorpusTests.vector(["scopes": [:], "now": 1_800_000_000_000, "offsetSeconds": 0])
    let result = try ProductCorpusTests.corpus().act(Relabel(), vector, result: { $0 }, refusal: \.form)
    let revive = { (id: String, values: JSON?) -> JSON in
      var change: JSON.Object = ["op": "revive", "t": "tag", "id": .string(id)]
      change["f"] = values
      return ["changes": [.object(change)], "atomic": false, "hold": false, "guards": [], "retire": [], "cmd": .null, "predict": [], "local": []]
    }
    let restored: JSON = ["kind": "fields", "restoreCommand": "probe.restoreTree", "targets": [
      ["target": ["scope": "tree/b_00000001", "t": "tag", "id": "tag00001", "slot": ["kind": "field", "name": "label"]], "defaultValue": ""],
    ]]
    #expect(result == ["decision": ["write": ["segments": [
      ["scope": "tree/b_00000001", "gesture": revive("tag00001", ["label": "Renamed"]), "undo": [restored]],
      ["scope": "tree/b_00000001", "gesture": revive("tag00002", nil), "undo": []],
      ["scope": "tree/b_00000002", "gesture": revive("tag00003", nil)],
    ], "result": .null]]])
  }

  @Test func aVectorsRecordsReverseWhereverItListsThem() throws {
    let (one, two) = (ProductCorpusTests.tag("tag00001", "One"), ProductCorpusTests.tag("tag00002", "Two"))
    let spent: [JSON] = [["t": "tag", "id": "tag00003", "born": "900:0:r_bbbbbbbbbbbb"], ["t": "tag", "id": "tag00004", "born": "900:0:r_bbbbbbbbbbbb"]]
    let vector = try ProductCorpusTests.vector([
      "scopes": ["tree/b_00000001": ["drawn": [one, two], "stored": [two, one], "confirmed": [one, two], "spent": .array(spent)]],
      "records": ["drawn": [one, two]], "ids": ["a", "b"],
    ])
    #expect(vector.withRecordsReversed.input == [
      "scopes": ["tree/b_00000001": ["drawn": [two, one], "stored": [one, two], "confirmed": [one, two], "spent": .array(spent.reversed())]],
      "records": ["drawn": [two, one]], "ids": ["a", "b"],
    ])
  }
}
