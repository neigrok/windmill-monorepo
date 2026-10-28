import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

// The replica executor against the ability conformance corpus (Coach §3.5, INV-1, INV-2): every case of
// packages/api-contract/gym/abilities/ run over its given records as the case's seat at its moment, the result's
// canonical bytes and digest and the records it wrote compared with the server's golden; then the catalog's agent rules
// and the schema check, keyword by keyword.
struct CoachAbilitiesTests {
  static let files = ["create_exercise", "create_routine", "get_last_times", "get_session", "get_sessions", "get_stats", "last_time",
                      "list_bodyweight", "list_exercises", "list_notes", "list_routines", "list_sessions", "propose_routine_change",
                      "propose_routine_removal", "revoke_share", "save_note", "share_session"]
  static let turn = ID<CoachMessage>("turnAAAAAAAAAAA1")
  static let thread = ID<CoachThread>("thrdAAAAAAAAAAA1")

  @Test func everyAbilityFileHasARunner() throws {
    #expect(try Contract.files(under: "gym/abilities") == Self.files.map { "gym/abilities/\($0).json" })
  }

  // One vector per case: the given records beside a running Coach message of this turn, at the case's moment.
  static func cases() throws -> [(Vector, JSON)] {
    try files.flatMap { file throws -> [(Vector, JSON)] in
      try Contract.json("gym/abilities/\(file).json").asArray().map { spec in
        let given = try spec.member("given")
        guard try spec.member("zone").asString() == "UTC" else { throw ContractError("\(file): a zone the runner does not place") }
        let now = try spec.member("now").asInteger()
        let stamp = JSON.string("\(now):0:r_aaaaaaaaaaaa")
        let conversation: [JSON] = [
          ["t": "thread", "id": thread.json, "seq": 1_000_000, "life": ["alive", stamp], "f": ["title": ["How heavy today?", stamp]]],
          ["t": "message", "id": turn.json, "seq": 1_000_001, "life": ["alive", stamp],
           "f": ["threadId": [thread.json, stamp], "role": ["coach", stamp], "replica": ["rp_00000000000000000000000000000001", stamp],
                 "state": ["running", stamp], "at": [JSON(now), stamp]]],
        ]
        let input: JSON = ["records": ["drawn": .array(try given.member("records").asArray() + conversation)], "now": JSON(now),
                           "offsetSeconds": 0, "ids": [], "seat": try spec.member("seat"), "call": try spec.member("call"),
                           "appBaseUrl": given["appBaseUrl"] ?? "https://windmill.works"]
        return (Vector(file: "gym/abilities/\(file).json", name: try spec.member("case").asString(), input: input, expect: try spec.member("expect")),
                try given.member("records"))
      }
    }
  }

  @Test(arguments: try CoachAbilitiesTests.cases())
  func ability(_ vector: Vector, given: JSON) throws {
    let call = try vector.input.member("call")
    let request = AbilityRequest(callId: "call-1", name: try call.member("name").asString(), input: try call.member("input"))
    let seat: Seat = try vector.input.member("seat").asString() == "anon" ? .anon : .bound
    let action = RunAbility(request, on: Self.turn, seat: seat, appBaseUrl: try vector.input.member("appBaseUrl").asString())
    let decision = try ProductCorpus(GymRules.book).decision(of: action, vector, result: Self.form, refusal: \.form)
    let answered = try Self.answer(decision, given: given)
    // Shares are server records: a phone turn’s gate runs these on the server executor (Coach §4.3 step 5), and the phone
    // refuses one that reaches it. The server's golden stays the server's.
    if AbilityExecutor.serverRun.contains(request.name) {
      #expect(answered == ["refused": "not-offered", "writes": []], "\(vector.file) · \(vector.name)\n  got    \(answered.jcsText)")
      return
    }
    let expect = vector.expect
    if let refused = expect["refused"] {
      // The corpus is the server tool's golden; on the phone the gate's G-3 stands before the tool, so an input the schema
      // refuses answers `invalid-input` where the tool answered `invalid-arguments`.
      let gated = refused == "invalid-arguments" && JSONSchema(Catalog.ability(named: request.name)!.input).fault(in: request.input) != nil
      #expect(answered == ["refused": gated ? "invalid-input" : refused, "writes": []], "\(vector.file) · \(vector.name)\n  got    \(answered.jcsText)")
      return
    }
    let expected: JSON = ["result": try expect.member("result"), "sha256": try expect.member("sha256"), "writes": try expect.member("writes")]
    #expect(answered == expected, "\(vector.file) · \(vector.name)\n  got    \(answered.jcsText)\n  expect \(expected.jcsText)")
  }

  static func form(_ outcome: AbilityOutcome) -> JSON {
    switch outcome {
    case .result(let jcs, let sha256): ["result": try! JSON(parsing: jcs), "sha256": .string(sha256)]
    case .refused(let code): ["refused": .string(code.rawValue)]
    }
  }

  // The call's answer and the records its gesture wrote, less the call's own record on the Coach message, in the corpus's
  // form: `{t, id, life, f}` by type and id, an inserted note's key resolved from its anchor as the engine resolves it.
  static func answer(_ decision: JSON, given: JSON) throws -> JSON {
    let decided = try decision.member("decision").asObject()
    guard let write = decided["write"] else { throw ContractError("the executor always records the call: \(decision.jcsText)") }
    var answer = try write.member("result").asObject()
    let changes = try write.member("gesture").member("changes").asArray().filter { try $0.member("t").asString() != CoachMessage.type }
    let writes = try changes.map { change throws -> JSON in
      var fields = try change["f"]?.asObject() ?? JSON.Object()
      if let anchor = change["anchor"], !anchor.isNull {
        let below = try anchor.member("below")
        let last = try below.isNull ? nil : FractionalKey(try keyOf(below, field: try anchor.member("field").asString(), in: given))
        fields[try anchor.member("field").asString()] = .string(try FractionalKey(between: last, and: nil).text)
      }
      let dead = try change.member("op").asString() == "delete"
      return ["t": try change.member("t"), "id": try change.member("id"), "life": dead ? "dead" : "alive", "f": .object(fields)]
    }.sorted { $0.jcsPrecedes($1) }
    answer["writes"] = .array(writes)
    return .object(answer)
  }

  static func keyOf(_ id: JSON, field: String, in given: JSON) throws -> String {
    for record in try given.asArray() where try record.member("id") == id {
      return try record.member("f").member(field).asArray()[0].asString()
    }
    throw ContractError("no given record \(id.jcsText) to anchor below")
  }

  // MARK: - INV-1 beyond the corpus

  static func phone() throws -> (Harness, OpenTurn.Turn, AbilityExecutor) {
    let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))
    let turn = try #require(committed(try a.runner.run(OpenTurn(question: "How heavy today?"))))
    return (a, turn, AbilityExecutor(runner: a.runner, appBaseUrl: "https://windmill.works"))
  }

  static func result(_ name: String, _ input: JSON, on turn: OpenTurn.Turn, _ executor: AbilityExecutor, callId: String = "call") throws -> JSON {
    guard case .result(let jcs, _)? = committed(try executor.run(AbilityRequest(callId: callId, name: name, input: input), on: turn.coach, seat: .bound)) else {
      throw ContractError("\(name) answered no result")
    }
    return try JSON(parsing: jcs)
  }

  // The server's `ORDER BY started_at DESC, id DESC` decides a same-millisecond tie by the higher id in the Coach reads alone;
  // the UI's last time keeps the lower, as the training-reads vectors pin it.
  @Test func aSameMillisecondTieGoesToTheHigherIdAsTheServerOrders() throws {
    let (a, turn, executor) = try Self.phone()
    let at = Instant(ms: 1_799_000_000_000)
    let sessions = ["sesTIE0000000001", "sesTIE0000000002"].map { Session(id: ID(RecordID($0)), startedAt: at, finishedAt: Instant(ms: at.ms + 3_600_000), closedBy: "finish") }
    let sets = ["setTIE0000000001", "setTIE0000000002"].enumerated().map { n, id in
      TrainingSet(id: ID(RecordID(id)), sessionId: sessions[n].id, exerciseId: ID("bench-press"), weightKg: 60, reps: 5, completedAt: Instant(ms: at.ms + 60_000), setNumber: 1)
    }
    try SeedLog.run(a, sessions: sessions, sets: sets)
    let last = try Self.result("last_time", ["exerciseId": "bench-press"], on: turn, executor, callId: "call-1")
    #expect(last["session"]?["id"] == "sesTIE0000000002")
    #expect(try last.member("sets").asArray().map { $0["id"] } == ["setTIE0000000002"])
    let lasts = try Self.result("get_last_times", ["exerciseIds": ["bench-press"]], on: turn, executor, callId: "call-2")
    #expect(try lasts.member("exercises").asArray().map { $0["session"]?["id"] } == ["sesTIE0000000002"])
    #expect(try a.runner.read(Gym.scope) { try TrainingLog($0).lastTime(for: ID("bench-press")).session?.id } == ID("sesTIE0000000001"))
  }

  // `list_exercises` lists names as the server's en_US.UTF-8 collation does — letters without case or accents first, then
  // accents, then lowercase before uppercase — and a name the call gives decomposed is stored composed (§3.3).
  @Test func theCatalogueListsNamesAsTheServersCollationOrders() throws {
    let (_, turn, executor) = try Self.phone()
    let names = ["Zed row", "apple curl", "e\u{0301}clair fly", "Étude press", "Bench", "bench press", "bench", "BENCH", "bénch"]
    for (n, name) in names.enumerated() {
      let created = try Self.result("create_exercise", ["id": .string("tn7Qm2Kx9Lp4Wz8R-\(n)"), "name": .string(name), "pattern": "carry", "equipment": "cable"],
                                    on: turn, executor, callId: "create-\(n)")
      #expect(created["name"] == .string(name == "e\u{0301}clair fly" ? "éclair fly" : name))
    }
    let listed = try Self.result("list_exercises", [:], on: turn, executor)
    let custom = try listed.member("exercises").asArray().filter { $0["custom"] == true }.map { try $0.member("name").asString() }
    #expect(custom == ["apple curl", "bench", "Bench", "BENCH", "bénch", "bench press", "éclair fly", "Étude press", "Zed row"])
  }

  // A note past the server's bounds is malformed input, `invalid-arguments`, as its tool answers; a note out of the schema's
  // shape is the gate's `invalid-input`; one within both saves.
  @Test func aNotePastTheServersBoundsIsMalformedInput() throws {
    let (_, turn, executor) = try Self.phone()
    let note = { (n: Int, title: String, body: String) throws -> AbilityOutcome? in
      committed(try executor.run(AbilityRequest(callId: "note-\(n)", name: "save_note", input: ["id": .string("tn7Qm2Kx9Lp4Wz8R-\(n)"), "title": .string(title), "body": .string(body)]),
                                 on: turn.coach, seat: .bound))
    }
    #expect(try note(1, "Bound", String(repeating: "é", count: 250) + "x") == .refused(.invalidArguments))
    #expect(try note(2, String(repeating: "q\u{0307}", count: 60), "") == .refused(.invalidArguments))
    #expect(try note(3, " ", "Blunt.") == .refused(.invalidArguments))
    #expect(committed(try executor.run(AbilityRequest(callId: "note-4", name: "save_note", input: ["id": "tn7Qm2Kx9Lp4Wz8R-4", "title": "No body"]), on: turn.coach, seat: .bound))
      == .refused(.invalidInput))
    let saved: JSON = ["saved": true, "note": ["id": "tn7Qm2Kx9Lp4Wz8R-5", "position": 0, "title": "Bound", "body": .string(String(repeating: "é", count: 250))]]
    #expect(try note(5, "Bound", String(repeating: "é", count: 250)) == .result(jcs: saved.jcs, sha256: SHA256Hex.of(saved.jcs)))
  }

  // MARK: - The catalog

  @Test func theCatalogOffersBySeat() {
    let bound = Catalog.offered(seat: .bound).map(\.name)
    #expect(bound == ["list_routines", "list_exercises", "list_sessions", "get_session", "get_sessions", "last_time", "get_last_times", "get_stats",
                      "list_notes", "list_bodyweight", "create_routine", "create_exercise", "save_note", "share_session",
                      "propose_routine_change", "propose_routine_removal", "revoke_share"])
    #expect(Catalog.offered(seat: .anon).map(\.name) == bound.filter { !["save_note", "share_session", "revoke_share"].contains($0) })
    #expect(Catalog.ability(named: "log_set")?.agent == .withheld)
    #expect(Catalog.ability(named: "get_record")?.declared == false)
    #expect(Catalog.ability(named: "propose_routine_change")?.phrase == "wrote a proposal for one of your routines")
    #expect(Catalog.version == "catalog/1")
    #expect(Catalog.ability(named: "no_such_ability") == nil)
  }

  // MARK: - The schema check

  static let schema = JSONSchema([
    "type": "object", "additionalProperties": false, "required": ["id", "entries"],
    "properties": [
      "id": ["type": "string", "minLength": 8, "maxLength": 64, "pattern": "^[A-Za-z0-9_-]+$"],
      "kind": ["type": "string", "enum": ["read", "add"]],
      "saved": ["type": "boolean", "const": true],
      "limit": ["type": "integer", "minimum": 1, "maximum": 200],
      "load": ["type": "number", "minimum": -500, "maximum": 500],
      "entries": [
        "type": "array", "minItems": 1, "maxItems": 2, "uniqueItems": true,
        "items": ["type": "object", "additionalProperties": false, "required": ["exerciseId"], "properties": ["exerciseId": ["type": "string"]]],
      ],
    ],
  ])

  static let faults: [(JSON, SchemaFault)] = [
    faulted(JSON.array([]), SchemaFault(path: "", reason: "not \"object\"")),
    faulted(["entries": [["exerciseId": "a"]]], SchemaFault(path: "id", reason: "required")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "extra": 1], SchemaFault(path: "extra", reason: "not a property")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "kind": "remove"], SchemaFault(path: "kind", reason: "not one of the enum")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "saved": false], SchemaFault(path: "saved", reason: "not the constant")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "limit": 1.5], SchemaFault(path: "limit", reason: "not \"integer\"")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "limit": 0], SchemaFault(path: "limit", reason: "below 1")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"]], "load": 500.5], SchemaFault(path: "load", reason: "above 500")),
    faulted(["id": "abc", "entries": [["exerciseId": "a"]]], SchemaFault(path: "id", reason: "shorter than 8")),
    faulted(["id": .string(String(repeating: "a", count: 65)), "entries": [["exerciseId": "a"]]], SchemaFault(path: "id", reason: "longer than 64")),
    faulted(["id": "abcdefg h", "entries": [["exerciseId": "a"]]], SchemaFault(path: "id", reason: "not ^[A-Za-z0-9_-]+$")),
    faulted(["id": "abcdefgh", "entries": []], SchemaFault(path: "entries", reason: "fewer than 1 items")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"], ["exerciseId": "b"], ["exerciseId": "c"]]], SchemaFault(path: "entries", reason: "more than 2 items")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"], ["exerciseId": "a"]]], SchemaFault(path: "entries.1", reason: "repeats an item")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a"], ["exerciseId": 2]]], SchemaFault(path: "entries.1.exerciseId", reason: "not \"string\"")),
    faulted(["id": "abcdefgh", "entries": [["exerciseId": "a", "sets": []]]], SchemaFault(path: "entries.0.sets", reason: "not a property")),
  ]

  static func faulted(_ value: JSON, _ fault: SchemaFault) -> (JSON, SchemaFault) { (value, fault) }

  @Test(arguments: CoachAbilitiesTests.faults)
  func theSchemaCheckNamesTheFirstFault(_ value: JSON, _ fault: SchemaFault) {
    #expect(Self.schema.fault(in: value) == fault)
  }

  @Test func aValueInsideItsSchemaPasses() {
    #expect(Self.schema.fault(in: ["id": "abcdefgh", "entries": [["exerciseId": "a"], ["exerciseId": "b"]], "kind": "add", "saved": true, "limit": 200,
                                   "load": -500]) == nil)
    #expect(JSONSchema(Catalog.ability(named: "get_sessions")!.input).fault(in: ["sessionIds": ["a", "a"]])
      == SchemaFault(path: "sessionIds.1", reason: "repeats an item"))
  }
}
