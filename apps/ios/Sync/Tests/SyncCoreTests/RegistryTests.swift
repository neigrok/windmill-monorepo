import SyncCore
import SyncTesting
import Testing

// The registry against the probe (a JCS round trip), each rule by its exact error, quanta and measures.

struct RegistryTests {
  @Test func theProbeRegistryRoundTripsByJCS() throws {
    let file = try Corpus.probeRegistryFile()
    var expected = try file.asObject()
    expected["$schema"] = nil
    #expect(try Registry(json: file).json.jcs == JSON.object(expected).jcs)
  }

  @Test(arguments: [
    (registry(note { $0["colour"] = "red" }), #"type "note": JSON shape: unexpected key "colour""#),
    (registry(note { $0["origins"] = nil }), #"type "note": JSON shape: missing key "origins""#),
    (registry(note { $0["type"] = "Note" }), #"type "Note": Note is not a type name"#),
    (registry(note { $0["idSpace"] = nil }),
     #"type "note": a minted or derived type has idSpace, idPattern, revivable, deadRows, mint and life"#),
    (registry(note { $0["mint"] = nil }),
     #"type "note": a minted or derived type has idSpace, idPattern, revivable, deadRows, mint and life"#),
    (registry(note { $0["mint"] = ["prefix": "", "alphabet": "a", "length": 8] }),
     #"type "note": a mint alphabet has at least two characters"#),
    (registry(note { $0["mint"] = ["prefix": "", "alphabet": "abc", "length": 4] }),
     #"type "note": a minted id of a does not match ^[a-z]{8}$"#),
    (registry(note { $0["mint"] = ["prefix": "", "alphabet": "ab!", "length": 8] }),
     #"type "note": a minted id of ! does not match ^[a-z]{8}$"#),
    (registry(note { $0["identity"] = "derived" }), #"type "note": a derived type has derive"#),
    (registry(note { $0["identity"] = "singleton"; $0["singletonId"] = "meta" }),
     #"type "note": a singleton has singletonId and idPattern, and no life"#),
    (registry(note { $0["revivable"] = true }), #"type "note": a revivable type keeps its dead rows"#),
    (registry(note { $0["origins"] = ["server"] }), #"type "note": origins always include replica"#),
    (registry(note { $0["origins"] = ["replica", "replica"] }), #"type "note": JSON shape: "replica" appears twice"#),
    (registry(note { $0["cap"] = 0 }), #"type "note": JSON shape: expected an integer of at least 1, found 0"#),
    (registry(note {
      $0["idPattern"] = "^(?:e\u{301}|x){3}$"
      $0["mint"] = ["prefix": "", "alphabet": "e\u{301}x", "length": 3]
    }),
     "type \"note\": a minted id of e does not match ^(?:e\u{301}|x){3}$"),
    (registry(note { $0["visibleWhen"] = ["title"]; $0["fields"] = ["title": ["kind": "lww", "writer": "client"]] }),
     #"type "note": visibleWhen is for types without life"#),
    (registry(note { $0["scope"] = "tree"; $0["governs"] = "tree" }),
     #"type "note": a governing type lives in a product scope"#),
    (registry(note { $0["governs"] = "tree"; $0["revivable"] = true; $0["deadRows"] = "keep" }),
     #"type "note": a governing type is minted and not revivable"#),
    (registry(note { $0["governs"] = "tree"; $0["idSpace"] = "scope" }), #"type "note": a governing type's ids are global"#),
    (registry(note(field: "title", ["kind": "lww", "writer": "client", "max": 12])),
     #"type "note": field title: a bound states its unit"#),
    (registry(note(field: "title", ["kind": "lww", "writer": "client", "domain": ["type": "string", "min": 1]])),
     #"type "note": field title: a bound states its unit"#),
    (registry(note { $0["seeded"] = ["seedMax": 0, "ordinalMax": 9] }),
     #"type "note": JSON shape: expected an integer of at least 1, found 0"#),
    (registry(note(field: "tier", ["kind": "ranked", "writer": "client"])),
     #"type "note": field tier: kind ranked goes with rank iff ranked and serialNext iff serial"#),
    (registry(note(field: "no", ["kind": "serial", "writer": "client", "serialNext": []])),
     #"type "note": field no: a serial field is server-written"#),
    (registry(note(field: "memo", ["kind": "text", "writer": "client", "unit": "bytes"])),
     #"type "note": field memo: a text field has unit and max"#),
    (registry(note(field: "size", ["kind": "lww", "writer": "client", "quantum": 0.01])),
     #"type "note": field size: a quantum needs a number domain"#),
    (registry(note(field: "size", ["kind": "lww", "writer": "client", "quantum": 0.3, "domain": ["type": "number"]])),
     #"type "note": field size: a quantum is an integer or 1/k"#),
    (registry(note(field: "runId", ["kind": "const", "writer": "client", "parent": true])),
     #"type "note": field runId: the parent field is a ref"#),
    (registry(note(field: "claim", ["kind": "lww", "writer": "client", "opens": ["x"]])),
     #"type "note": field claim: opens lists values of a server-written field"#),
    (registry(note(field: "claim", ["kind": "lww", "writer": "server", "opens": ["x"]])),
     #"type "note": field claim: opens is for a field of a tree singleton"#),
    (registry(meta(opens: ["secret"])),
     #"type "meta": field visibility: opens the value secret outside its domain"#),
    (registry(note {
      $0["identity"] = "keyed"; $0["idSpace"] = nil; $0["mint"] = nil; $0["revivable"] = nil
      $0["fields"] = ["ord": ["kind": "lww", "writer": "client", "domain": ["type": "fracKey"]]]
    }),
     #"type "note": field ord: an order field belongs to a minted or derived type"#),
    (registry(note {
      $0["identity"] = "singleton"; $0["singletonId"] = "meta"; $0["idPattern"] = "^meta$"; $0["idSpace"] = nil; $0["mint"] = nil
      $0["revivable"] = nil; $0["deadRows"] = nil; $0["life"] = false
      $0["fields"] = ["ord": ["kind": "lww", "writer": "client", "domain": ["type": "fracKey"]]]
    }),
     #"type "note": field ord: an order field belongs to a minted or derived type"#),
    (registry(note(field: "t\u{EF}tle", ["kind": "lww", "writer": "client"])),
     "type \"note\": field t\u{EF}tle: not a field name"),
    (registry(note(field: "runId", ["kind": "const", "writer": "client", "ref": "run"])),
     "type note refers to the unknown type run"),
    (registry(note { $0["scope"] = "product:elsewhere" }), "type note lives in the undeclared product elsewhere"),
    (registry(note { _ in }, note { _ in }), "type note is declared twice"),
    (registry(note { _ in }, commands: [command { $0["origins"] = ["replica", "server"]; $0["serverInternal"] = true }]),
     #"command "p.go": a server-internal command has server origin only"#),
    (registry(note { _ in }, commands: [command { $0["args"] = ["runId": ["type": "ref<run>"]] }]),
     "command p.go refers to the unknown type run"),
    (registry(note { _ in }, commands: [command { $0["origins"] = ["server"]; $0["beforePull"] = true }]),
     #"command "p.go": a beforePull command is server-internal"#),
  ])
  func aBrokenRegistryIsRefusedNamingWhereAndWhy(_ registry: JSON, _ message: String) {
    let error = #expect(throws: RegistryError.self) { try Registry(json: registry) }
    #expect(error?.description == message)
  }

  @Test func aPatternSearchesAsECMAScriptTestDoesAndDollarEndsTheText() throws {
    #expect(try Pattern("^a|b$").matches("ab"))
    #expect(try !Pattern("^[a-z]{3}$").matches("abc\n"))
    #expect(try Pattern("^[a-z]{3}$").matches("abc"))
  }

  @Test(arguments: [
    (1.005, 0.01, 1), (0.125, 0.01, 0.13), (-0.125, 0.01, -0.13), (-2.675, 0.01, -2.68), (10.235, 0.01, 10.24),
    (82.525, 0.01, 82.53),
    (3, 0.1, 3), (0.30000000000000004, 0.1, 0.3), (1.25, 0.5, 1.5), (0.49999999999999994, 1, 0), (2.5, 1, 3), (-2.5, 1, -3),
    (12.5, 5, 15), (-12.5, 5, -15),
  ])
  func aQuantumRoundsHalfAwayFromZeroInDoubles(_ value: Double, _ step: Double, _ rounded: Double) throws {
    let quantum = try #require(Quantum(step))
    #expect(quantum.rounded(value) == rounded)
    #expect(quantum.holds(rounded))
  }

  @Test func aQuantumHoldsOnlyTheValuesItRoundsToThemselves() throws {
    let cents = try #require(Quantum(0.01))
    #expect([1.005, 1.01, 0.3, 0.30000000000000004].map(cents.holds) == [false, true, true, false])
    #expect(cents.rounded(-0.001).sign == .plus)
  }

  @Test(arguments: [0, -1, 0.3, 0.7, Double.infinity, Double.nan])
  func aQuantumIsAnIntegerOrOneOverK(_ step: Double) {
    #expect(Quantum(step) == nil)
  }

  // Registry names, argument types and mints are the same only byte for byte, never by canonical equivalence.
  @Test func declarationsThatDifferOnlyByCanonicalEquivalenceAreDifferent() throws {
    let mints = try ["\u{E9}", "e\u{301}"].map { prefix in
      try Registry(json: Self.registry(Self.note {
        $0["idPattern"] = "^.{9,10}$"
        $0["mint"] = ["prefix": .string(prefix), "alphabet": "abcdefghijklmnopqrstuvwxyz", "length": 8]
      })).type("note")?.mint
    }
    let kinds: Set<ScopeKind> = [.product("\u{212A}"), .product("K"), .tree]
    let arguments: Set<ArgumentType> = [.ref("\u{212A}"), .ref("K"), .json]
    #expect([kinds.count, arguments.count, Set(mints).count] == [3, 3, 2])
  }

  @Test func charsCountCodePointsAndBytesCountUTF8() {
    let text = "e\u{301}👍🏽"
    #expect(MeasureUnit.chars.length(of: text) == 4)
    #expect(MeasureUnit.bytes.length(of: text) == 11)
    #expect(text.count == 2)
  }

  static func note(_ edit: (inout JSON.Object) -> Void) -> JSON {
    var type: JSON.Object = [
      "type": "note", "scope": "product:p", "identity": "minted", "idSpace": "global", "idPattern": "^[a-z]{8}$",
      "mint": ["prefix": "", "alphabet": "abcdefghijklmnopqrstuvwxyz", "length": 8], "life": true, "revivable": false,
      "deadRows": "spent", "origins": ["replica"], "fields": [:],
    ]
    edit(&type)
    return .object(type)
  }

  static func meta(opens: [JSON]) -> JSON {
    [
      "type": "meta", "scope": "tree", "identity": "singleton", "singletonId": "meta", "idPattern": "^meta$", "life": false,
      "origins": ["replica"],
      "fields": [
        "visibility": [
          "kind": "lww", "writer": "server", "domain": ["type": "string", "enum": ["private", "public"]], "opens": .array(opens),
        ],
      ],
    ]
  }

  static func note(field name: String, _ definition: JSON) -> JSON {
    note { $0["fields"] = .object([name: definition]) }
  }

  static func registry(_ types: JSON..., commands: [JSON] = []) -> JSON {
    [
      "registry": "test", "version": 1, "minVersion": 1, "products": ["p": [:]], "types": .array(types),
      "commands": .array(commands),
    ]
  }

  static func command(_ edit: (inout JSON.Object) -> Void) -> JSON {
    var command: JSON.Object = [
      "name": "p.go", "scope": "product:p", "origins": ["replica"], "serverInternal": false, "args": [:],
    ]
    edit(&command)
    return .object(command)
  }
}
