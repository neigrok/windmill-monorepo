import SyncCore
import SyncReplica
import SyncTesting
import Testing

// K-3 under a write map (§7.7, E-8): every value the journal, its inverse requests and its cancellations recorded for a
// field follows the map as the record's field would, wherever it holds a typed reference. The corpus reaches what a probe
// type can hold end to end; this reaches a revival's registers and a recipe's default too.

struct JournalTests {
  @Test func aWriteMapRenamesTheTypedReferencesInEveryValueTheJournalRecorded() throws {
    let registry = try Corpus.probeRegistry()
    let opens: JSON = ["scope": "self/overlay/b_00000001", "t": "mark", "id": "oak", "slot": ["kind": "field", "name": "opens"]]
    let lap: JSON = ["scope": "self/probe", "t": "lap", "id": "lap00001"]
    let lapLife: JSON = ["scope": "self/probe", "t": "lap", "id": "lap00001", "slot": ["kind": "life"]]
    let absent: JSON = ["kind": "recordAbsent", "epoch": "ep-1"]
    let stamp: JSON = "1100:0:r_aaaaaaaaaaaa"
    let act = try ReversibleAct(json: [
      "version": 1, "actId": "g1", "retained": true, "sourceEntries": [[
        "localId": "g1/0", "originScope": "self/overlay/b_00000001", "attempts": [],
        "recipes": [["kind": "fields", "restoreCommand": "probe.restoreOverlay", "targets": [["target": opens, "defaultValue": "b_00000002"]]]],
        "preimages": [
          ["target": opens, "value": "b_00000002", "rowSeq": 1, "epoch": "ep-1"],
          ["target": lapLife, "value": "alive", "rowSeq": 2, "epoch": "ep-1",
           "record": ["born": stamp, "f": ["runId": ["run00002", stamp], "weight": [40, stamp]]]],
        ],
        "written": [["target": opens, "value": "b_00000002"]],
      ]],
    ])
    let request = try InverseRequest(json: [
      "version": 1, "requestId": "g3", "sourceActId": "g1", "inverseActId": "g2", "state": "waiting", "requestedAt": 9000, "slots": [
        ["localId": "g2/0", "commitOrder": 2, "originScope": "self/overlay/b_00000001", "state": "waiting",
         "recipe": ["kind": "restore", "command": "probe.restoreOverlay", "operations": [["kind": "field", "target": opens, "before": "b_00000002"]]]],
        ["localId": "g2/1", "commitOrder": 3, "originScope": "self/probe", "state": "waiting",
         "recipe": ["kind": "restore", "command": "probe.restore", "operations": [
           ["kind": "createRecord", "record": lap, "values": ["f": ["runId": "run00002", "at": 5100]], "reference": absent],
         ]]],
      ],
    ])
    let cancellation = try CancellationReceipt(json: [
      "version": 1, "inverseActId": "g5", "cancelledActId": "g4", "sourceEntries": [["localId": "g4/0", "originScope": "self/overlay/b_00000001"]],
      "units": [
        ["kind": "field", "ownerLocalId": "g4/0", "target": opens, "redoValue": "b_00000002", "restoredValue": "b_00000002",
         "restored": ["kind": "accepted", "epoch": "ep-1", "version": ["kind": "stamp", "stamp": "1400:0:r_aaaaaaaaaaaa"]]],
        ["kind": "createdRecord", "ownerLocalId": "g4/0", "record": lap, "redoValues": ["f": ["runId": "run00002", "at": 5100]], "restored": absent],
      ],
    ])
    var replica = LoadedReplica(meta: ReplicaMeta(replica: "rp_00000000000000000000000000000001", state: .anon),
                                journal: .whole(Journal(acts: [act], inverses: [request], cancellations: [cancellation])), wholeScopes: true)
    replica.remapJournal(by: RecordMap(registry: registry, mappings: [
      RecordMap.Mapping(type: "board", from: "b_00000002", to: "b_00000009", scope: .product("probe")),
      RecordMap.Mapping(type: "run", from: "run00002", to: "run00009", scope: .product("probe")),
    ]), registry: registry)

    let stored = replica.journal.json
    let source: JSON = stored.acts.first?["sourceEntries"].flatMap { try? $0.asArray().first } ?? .null
    let recipes: JSON = [["kind": "fields", "restoreCommand": "probe.restoreOverlay", "targets": [["target": opens, "defaultValue": "b_00000009"]]]]
    let preimages: JSON = [
      ["target": opens, "value": "b_00000009", "rowSeq": 1, "epoch": "ep-1"],
      ["target": lapLife, "value": "alive", "rowSeq": 2, "epoch": "ep-1", "record": ["born": stamp, "f": ["runId": ["run00009", stamp], "weight": [40, stamp]]]],
    ]
    let written: JSON = [["target": opens, "value": "b_00000009"]]
    #expect(source["recipes"] == recipes)
    #expect(source["preimages"] == preimages)
    #expect(source["written"] == written)
    let slots: [JSON] = (try? stored.inverses.first?["slots"]?.asArray()) ?? []
    let operations: [JSON] = slots.map { (slot: JSON) -> JSON in (try? slot["recipe"]?["operations"]?.asArray().first) ?? .null }
    let field: JSON = ["kind": "field", "target": opens, "before": "b_00000009"]
    let created: JSON = ["kind": "createRecord", "record": lap, "values": ["f": ["runId": "run00009", "at": 5100]], "reference": absent]
    #expect(operations == [field, created])
    let units: JSON = stored.cancellations.first?["units"] ?? .null
    let unit: JSON = ["kind": "field", "ownerLocalId": "g4/0", "target": opens, "redoValue": "b_00000009", "restoredValue": "b_00000009",
                      "restored": ["kind": "accepted", "epoch": "ep-1", "version": ["kind": "stamp", "stamp": "1400:0:r_aaaaaaaaaaaa"]]]
    let record: JSON = ["kind": "createdRecord", "ownerLocalId": "g4/0", "record": lap, "redoValues": ["f": ["runId": "run00009", "at": 5100]],
                        "restored": absent]
    let expected: JSON = [unit, record]
    #expect(units == expected)
  }
}
