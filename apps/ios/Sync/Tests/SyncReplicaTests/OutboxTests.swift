import SyncAPI
import SyncCore
import SyncReplica
import SyncTesting
import Testing

// §7.2 cancel: a join cancels only an entry whose delta holds an alive life and a born, without which the record is
// alive in neither drawn nor stored. A delete that absorbed a revive of a live record fails the first, and a revive of a
// record only a held delete kills fails the second, so a later delete joining either is still sent.
// §7.2 join: a joined entry folds whole (§7.7 step 3), so an entry joins only one that depends on the same earlier deltas
// as it and their join do.

struct OutboxTests {
  static let probe = try! Corpus.probeRegistry()

  // A tag the server holds alive, in a board's tree.
  static let device = """
    {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
      "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
      "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false},
     "confirmed": {
       "self/probe": [{"t": "board", "id": "b_00000001", "life": ["alive", "900:0:r_bbbbbbbbbbbb"], "born": "900:0:r_bbbbbbbbbbbb", "seq": 1, "rc": 900, "ru": 900}],
       "tree/b_00000001": [{"t": "tag", "id": "tone", "life": ["alive", "901:0:r_bbbbbbbbbbbb"], "born": "901:0:r_bbbbbbbbbbbb",
         "f": {"label": ["one", "901:0:r_bbbbbbbbbbbb"]}, "seq": 1, "rc": 901, "ru": 901}]}}]}
    """

  // Deleted, revived (roadmap: the Undo of a released delete) and deleted again before the first delete is numbered,
  // plainly or with the first delete held and released: the person's last act is a delete, so it is drawn and sent.
  @Test(arguments: [false, true])
  func aDeleteThatAbsorbedAReviveOfALiveRecordIsStillSent(_ held: Bool) throws {
    let release = held ? #"{"op": "release", "localId": "g1/0", "deviceNow": 1000},"# : ""
    let input = try JSON(parsing: """
      {"device": \(Self.device), "steps": [
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "delete", "t": "tag", "id": "tone"}], "opts": {"hold": \(held)}, "deviceNow": 1000},
        \(release)
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "revive", "t": "tag", "id": "tone"}], "deviceNow": 1001},
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "delete", "t": "tag", "id": "tone"}], "deviceNow": 1002},
        {"op": "push", "deviceNow": 1003}]}
      """)
    let answer = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }
    let push = try answer.member("returns").asArray().last
    #expect(push == ["replica": "rp_00000000000000000000000000000001", "ackThrough": 0, "intents": [
      ["n": 1, "scope": "tree/b_00000001", "gestureId": "g1",
       "d": [["t": "tag", "id": "tone", "born": "901:0:r_bbbbbbbbbbbb", "life": ["dead", "1002:0:r_aaaaaaaaaaaa"]]]],
    ]])
    #expect(try answer.member("ended") == [
      ["localId": "g2/0", "outcome": "coalesced", "event": "coalesce"], ["localId": "g3/0", "outcome": "coalesced", "event": "coalesce"],
    ])
  }

  // A held delete, then a revive, then a delete that joins the revive: only the held delete kills the tag in drawn, and
  // stored still holds it alive, so the revive does not cancel. The Undo of the held delete leaves the person's final
  // delete, which is drawn and sent.
  @Test func aDeleteJoiningAReviveOfARecordOnlyAHeldDeleteKillsSurvivesItsUndo() throws {
    let input = try JSON(parsing: """
      {"device": \(Self.device), "steps": [
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "delete", "t": "tag", "id": "tone"}], "opts": {"hold": true}, "deviceNow": 1000},
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "revive", "t": "tag", "id": "tone"}], "deviceNow": 1001},
        {"op": "commit", "scope": "tree/b_00000001", "changes": [{"op": "delete", "t": "tag", "id": "tone"}], "deviceNow": 1002},
        {"op": "undo", "gestureId": "g1", "deviceNow": 1003},
        {"op": "push", "deviceNow": 1004}]}
      """)
    let answer = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }
    #expect(try answer.member("returns").asArray().suffix(2) == [true, [
      "replica": "rp_00000000000000000000000000000001", "ackThrough": 0, "intents": [
        ["n": 1, "scope": "tree/b_00000001", "gestureId": "g2",
         "d": [["t": "tag", "id": "tone", "born": "901:0:r_bbbbbbbbbbbb", "life": ["dead", "1002:0:r_aaaaaaaaaaaa"]]]],
      ],
    ]])
    #expect(try answer.member("ended") == [
      ["localId": "g3/0", "outcome": "coalesced", "event": "coalesce"], ["localId": "g1/0", "outcome": "undone", "event": "undo"],
    ])
  }

  // A put carrying the death a held put wrote folds with that put's Undo, and a put reviving the day does not. So the
  // revive stays apart, and the Undo leaves the confirmed score, not the one written on the absent day.
  @Test func aPutCarryingAHeldPutsDeathJoinsNoPutThatRevives() throws {
    let input = try JSON(parsing: """
      {"device": {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
         "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
         "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false},
        "confirmed": {"self/probe": [{"t": "day", "id": "2026-09-01", "life": ["alive", "900:0:r_bbbbbbbbbbbb"],
          "f": {"score": [1, "900:0:r_bbbbbbbbbbbb"]}, "seq": 1, "rc": 900, "ru": 900}]}}]},
       "steps": [
        {"op": "commit", "scope": "self/probe", "changes": [{"op": "put", "t": "day", "id": "2026-09-01", "present": false}], "opts": {"hold": true}, "deviceNow": 1000},
        {"op": "commit", "scope": "self/probe", "changes": [{"op": "put", "t": "day", "id": "2026-09-01", "present": false, "f": {"score": 10}}], "deviceNow": 1001},
        {"op": "commit", "scope": "self/probe", "changes": [{"op": "put", "t": "day", "id": "2026-09-01", "present": true}], "deviceNow": 1002},
        {"op": "undo", "gestureId": "g1", "deviceNow": 1003},
        {"op": "view", "scope": "self/probe", "withHeld": true, "deviceNow": 1003},
        {"op": "push", "deviceNow": 1004}]}
      """)
    let answer = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }
    #expect(try answer.member("returns").asArray().suffix(3) == [true, [
      "records": [["t": "day", "id": "2026-09-01", "life": ["alive", "1002:0:r_aaaaaaaaaaaa"], "f": ["score": [1, "900:0:r_bbbbbbbbbbbb"]]]],
      "capCount": ["card": 0],
    ], [
      "replica": "rp_00000000000000000000000000000001", "ackThrough": 0, "intents": [
        ["n": 1, "scope": "self/probe", "gestureId": "g3", "d": [["t": "day", "id": "2026-09-01", "life": ["alive", "1002:0:r_aaaaaaaaaaaa"]]]],
      ],
    ]])
    #expect(try answer.member("ended") == [
      ["localId": "g1/0", "outcome": "undone", "event": "undo"], ["localId": "g2/0", "outcome": "coalesced", "event": "cancel"],
    ])
  }

  // A lap update depends on the held start only through the lap create it follows, so it joins the create, and the
  // start's Undo folds the joined create as it would fold the two apart.
  @Test func anUpdateJoinsTheCreateThroughWhichItDependsOnAHeldCommand() throws {
    let input = try JSON(parsing: """
      {"device": {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
         "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
         "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false}}]},
       "steps": [
        {"op": "commit", "scope": "self/probe", "changes": [], "opts": {"hold": true,
          "cmd": {"name": "probe.start", "args": {"id": "run00009", "label": "Go", "startedAt": 1000, "join": true}},
          "predict": [{"op": "create", "t": "run", "id": "run00009", "f": {"label": "Go", "startedAt": 1000}}]}, "deviceNow": 1000},
        {"op": "commit", "scope": "self/probe", "changes": [{"op": "create", "t": "lap", "id": "lap00001", "f": {"runId": "run00009", "weight": 40}}], "deviceNow": 1001},
        {"op": "commit", "scope": "self/probe", "changes": [{"op": "update", "t": "lap", "id": "lap00001", "f": {"weight": 50}}], "deviceNow": 1002},
        {"op": "undo", "gestureId": "g1", "deviceNow": 1003}]}
      """)
    let answer = try ClientSteps.run(input, registry: Self.probe) { PlannedDevice($0, registry: Self.probe, limits: $1) }
    #expect(try answer.member("returns").asArray().last == true)
    #expect(try answer.member("device").member("replicas").asArray().first?["outbox"] == nil)
    #expect(try answer.member("ended") == [
      ["localId": "g3/0", "outcome": "coalesced", "event": "coalesce"], ["localId": "g1/0", "outcome": "undone", "event": "undo"],
      ["localId": "g2/0", "outcome": "coalesced", "event": "cancel"],
    ])
  }

  // An item created in a held list and moved to a confirmed one folds with the list's Undo through its create, but their
  // join names only the confirmed list and would survive it. So the move stays apart, and the Undo folds both.
  @Test func anUpdateMovingAReferenceOffAHeldCreateJoinsNoCreateNamingIt() throws {
    let shelf = try Registry(json: JSON(parsing: """
      {"registry": "shelf", "version": 1, "minVersion": 1, "products": {"shelf": {"surfaces": ["ios"]}}, "commands": [],
       "types": [
         {"type": "list", "scope": "product:shelf", "identity": "minted", "idSpace": "global", "idPattern": "^l_[a-z]{4}$",
          "mint": {"prefix": "l_", "alphabet": "abcdefghijklmnopqrstuvwxyz", "length": 4}, "life": true, "revivable": false,
          "deadRows": "spent", "origins": ["replica"], "primary": true, "fields": {}},
         {"type": "item", "scope": "product:shelf", "identity": "minted", "idSpace": "global", "idPattern": "^i_[a-z]{4}$",
          "mint": {"prefix": "i_", "alphabet": "abcdefghijklmnopqrstuvwxyz", "length": 4}, "life": true, "revivable": false,
          "deadRows": "spent", "origins": ["replica"], "primary": true,
          "fields": {"listId": {"kind": "lww", "writer": "client", "ref": "list", "domain": {"type": "string"}}}}
       ]}
      """))
    let input = try JSON(parsing: """
      {"device": {"active": "rp_00000000000000000000000000000001", "replicas": [{"meta": {"replica": "rp_00000000000000000000000000000001",
         "state": "bound", "account": "A", "nextN": 1, "hlc": {"ms": 0, "counter": 0}, "hlcHigh": "0:0:", "admittedHigh": "0:0:",
         "serverOffsetMs": 0, "offsetSamples": [], "serverEpoch": "ep-1", "ackThrough": 0, "authPaused": false},
        "confirmed": {"self/shelf": [{"t": "list", "id": "l_kept", "life": ["alive", "900:0:r_bbbbbbbbbbbb"], "born": "900:0:r_bbbbbbbbbbbb",
          "seq": 1, "rc": 900, "ru": 900}]}}]},
       "steps": [
        {"op": "commit", "scope": "self/shelf", "changes": [{"op": "create", "t": "list", "id": "l_held"}], "opts": {"hold": true}, "deviceNow": 1000},
        {"op": "commit", "scope": "self/shelf", "changes": [{"op": "create", "t": "item", "id": "i_card", "f": {"listId": "l_held"}}], "deviceNow": 1001},
        {"op": "commit", "scope": "self/shelf", "changes": [{"op": "update", "t": "item", "id": "i_card", "f": {"listId": "l_kept"}}], "deviceNow": 1002},
        {"op": "undo", "gestureId": "g1", "deviceNow": 1003},
        {"op": "view", "scope": "self/shelf", "withHeld": true, "deviceNow": 1003}]}
      """)
    let answer = try ClientSteps.run(input, registry: shelf) { PlannedDevice($0, registry: shelf, limits: $1) }
    #expect(try answer.member("returns").asArray().suffix(2) == [true, [
      "records": [["t": "list", "id": "l_kept", "life": ["alive", "900:0:r_bbbbbbbbbbbb"], "born": "900:0:r_bbbbbbbbbbbb"]],
      "capCount": [:],
    ]])
    #expect(try answer.member("device").member("replicas").asArray().first?["outbox"] == nil)
    #expect(try answer.member("ended") == [
      ["localId": "g1/0", "outcome": "undone", "event": "undo"], ["localId": "g2/0", "outcome": "coalesced", "event": "cancel"],
      ["localId": "g3/0", "outcome": "coalesced", "event": "cancel"],
    ])
  }
}
