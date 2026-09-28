import SyncCore
import SyncTesting
import Testing

// The registry against the probe (a JCS round trip), each rule by its exact error, composition, patterns, quanta and
// measures.

struct RegistryTests {
  @Test func theProbeRegistryRoundTripsByJCS() throws {
    let file = try Corpus.registryFile("probe")
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
    (registry(note { $0["mint"] = ["prefix": "", "alphabet": "e\u{301}x", "length": 8] }),
     "type \"note\": a minted id of \u{301} does not match ^[a-z]{8}$"),
    (registry(note { $0["idPattern"] = "^.{8}$" }), #"type "note": the pattern ^.{8}$ is outside §2.4's patterns"#),
    (registry(note { $0["idPattern"] = "^a{0,65536}$" }), #"type "note": the pattern ^a{0,65536}$ is outside §2.4's patterns"#),
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
    (registry(note(field: "tags", [
      "kind": "lww", "writer": "client", "domain": ["type": "array", "items": ["type": "string", "max": 8]],
    ])),
     #"type "note": field tags: a bound states its unit"#),
    (registry(note(field: "attachment", [
      "kind": "lww", "writer": "client", "domain": ["type": "object", "properties": ["id": ["type": "string", "min": 1]]],
    ])),
     #"type "note": field attachment: a bound states its unit"#),
    (registry(note(field: "attachment", [
      "kind": "lww", "writer": "client",
      "domain": ["type": "object", "properties": ["id": ["type": "string", "pattern": #"^\S{8,64}$"#]]],
    ])),
     #"type "note": field attachment: the pattern ^\S{8,64}$ is outside §2.4's patterns"#),
    (registry(note { $0["seeded"] = ["seedMax": 0, "ordinalMax": 9] }),
     #"type "note": JSON shape: expected an integer of at least 1, found 0"#),
    (registry(note(field: "tier", ["kind": "ranked", "writer": "client"])),
     #"type "note": field tier: kind ranked goes with rank iff ranked and serialNext iff serial"#),
    (registry(note(field: "no", ["kind": "serial", "writer": "client", "serialNext": []])),
     #"type "note": field no: a serial field is server-written"#),
    (registry(note(field: "memo", ["kind": "text", "writer": "client", "unit": "bytes"])),
     #"type "note": field memo: a text field has unit and max"#),
    (registry(note(field: "size", ["kind": "lww", "writer": "client", "quantum": 0.01, "domain": ["type": "number"]])),
     #"type "note": field size: JSON shape: unexpected key "quantum""#),
    (registry(note(field: "size", ["kind": "lww", "writer": "client", "domain": ["type": "string", "quantum": 0.01]])),
     #"type "note": field size: JSON shape: unexpected key "quantum""#),
    (registry(note(field: "size", ["kind": "lww", "writer": "client", "domain": ["type": "number", "quantum": 0.3]])),
     #"type "note": field size: a quantum is an integer or 1/k"#),
    (registry(note(field: "sets", [
      "kind": "lww", "writer": "client",
      "domain": ["type": "array", "items": ["type": "object", "properties": ["kg": ["type": "number", "quantum": 0.3]]]],
    ])),
     #"type "note": field sets: a quantum is an integer or 1/k"#),
    (registry(note(field: "no", ["kind": "serial", "writer": "server", "serialNext": [], "default": 1])),
     #"type "note": field no: a default is for a lattice field"#),
    (registry(note(field: "memo", ["kind": "text", "writer": "client", "unit": "bytes", "max": 8, "default": ""])),
     #"type "note": field memo: a default is for a lattice field"#),
    (registry(note(field: "size", ["kind": "lww", "writer": "client", "domain": ["type": "number", "max": 10], "default": 11])),
     "type note field size: the default 11 is no value of the field"),
    (registry(note(field: "size", ["kind": "lww", "writer": "client", "domain": ["type": "number", "quantum": 0.5], "default": 0.25])),
     "type note field size: the default 0.25 is no value of the field"),
    (registry(note(field: "size", ["kind": "lww", "writer": "client", "domain": ["type": "number"], "default": .null])),
     "type note field size: the default null is no value of the field"),
    (registry(fact { $0["wholePut"] = false }), #"type "fact": wholePut is true or absent"#),
    (registry(note { $0["wholePut"] = true }), #"type "note": a wholePut type is keyed with life"#),
    (registry(fact { $0["life"] = false; $0["deadRows"] = nil }), #"type "fact": a wholePut type is keyed with life"#),
    (registry(fact { $0["fields"] = ["memo": ["kind": "text", "writer": "client", "unit": "bytes", "max": 8]] }),
     #"type "fact": a wholePut type has no text field"#),
    (registry(fact { $0["fields"] = ["value": ["kind": "fww", "writer": "client"]] }),
     #"type "fact": field value: a wholePut type's client-written fields are lww"#),
    (registry(note { _ in }, fact { _ in }, commands: [command { $0["predicts"] = ["fact"] }]),
     "command p.go predicts fact, a wholePut type only deltas write"),
    (registry(note { _ in }, products: ["p": ["codes": ["not-found"]]]), "product p: not-found is an engine code"),
    (registry(note { _ in }, products: ["p": ["codes": ["Late"]]]), "product p: Late is not a refusal code"),
    (registry(note { _ in }, products: ["p": ["codes": ["late", "late"]]]), #"product p: JSON shape: "late" appears twice"#),
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
    (registry(note { _ in }, commands: [command {
      $0["args"] = ["label": ["type": "json", "domain": ["type": "string", "max": 12]]]
    }]),
     #"command "p.go": argument label: a bound states its unit"#),
    (registry(note { _ in }, commands: [command {
      $0["args"] = ["label": ["type": "json", "domain": ["type": "string", "pattern": "^a|b$"]]]
    }]),
     #"command "p.go": argument label: the pattern ^a|b$ is outside §2.4's patterns"#),
    (registry(note { _ in }, products: ["p": ["device": ["picture": ["keyPattern": "^picture:[^/]{8,64}$"]]]]),
     #"product p: device row picture: the pattern ^picture:[^/]{8,64}$ is outside §2.4's patterns"#),
    (registry(keyed("link", ["ref": "link"])), "type link: its key leads back to its own type"),
    (registry(keyed("link", ["ref": "mark"]), keyed("mark", ["ref": "link"])), "type link: its key leads back to its own type"),
    (registry(note { _ in }, keyed("link", ["tuple": [["name": "from", "ref": "note"], ["name": "to", "ref": "mark"]]]),
              keyed("mark", ["ref": "tag"]), keyed("tag", ["ref": "link"])),
     "type link: its key leads back to its own type"),
  ])
  func aBrokenRegistryIsRefusedNamingWhereAndWhy(_ registry: JSON, _ message: String) {
    let error = #expect(throws: RegistryError.self) { try Registry(json: registry) }
    #expect(error?.description == message)
  }

  // §2.4: only the portable subset is a pattern, read alike by every dialect: no class beginning with `:` or holding
  // `--`, and no count above 65 535. Swift compiles the portable ones here.
  @Test func onlyThePortableSubsetIsAPattern() {
    let patterns = [
      "^b_[0-9a-f]{8}$", "^[A-Za-z0-9_-]{8,64}$", "^[-a]$", "^(?:ab|cd)+$", "^(a|b)?c{2,}$", #"^a\.b\/c$"#, #"^[\]\-]$"#,
      #"^[\[-a]$"#, "^[a-]$", "^[-:]$", "^a{65535}$", "^a{1,65535}$", "^[a:]$",
      "b_[0-9a-f]{8}$", "^b_[0-9a-f]{8}", "^a|b$", "^.{1,64}$", #"^\s+$"#, #"^\d+$"#, #"^\w+$"#, #"^a\b$"#, #"^\_$"#,
      "^[^/]+$", "^[]$", "^[z-a]$", "^[a-b-c]$", "^[a--]$", "^[a&&b]$", "^[[a]]$", "^a+?$", "^a**$", "^a{3,2}$", "^a{,2}$",
      "^(?=a)a$", #"^(a)\1$"#, "^a$b$", "^\u{E9}$", #"^a\$"#,
      "^a{65536}$", "^a{2,65536}$", "^[:a]$", "^[:alpha:]$", "^[--]$", #"^[\--a]$"#,
    ]
    let portable = [
      true, true, true, true, true, true, true,
      true, true, true, true, true, true,
      false, false, false, false, false, false, false, false, false,
      false, false, false, false, false, false, false, false, false, false, false,
      false, false, false, false, false,
      false, false, false, false, false, false,
    ]
    #expect(patterns.map(Pattern.isPortable) == portable)
    #expect(patterns.map { (try? Pattern($0)) != nil } == portable)
  }

  // A pattern matches the whole value, so `$` never stops before a final newline; a class's `:` and bare `-` stay
  // literals.
  @Test func aPatternMatchesTheWholeValue() throws {
    let cases: [(pattern: String, text: String)] = [
      ("^[a-z]+$", "abc"), ("^[a-z]+$", "abc\n"), ("^[a-z]+$", "abc1"), ("^(?:ab|cd)+$", "abcd"), ("^(?:ab|cd)+$", "abcda"),
      (#"^a\.b\/c$"#, "a.b/c"), (#"^[\]\-]$"#, "-"), ("^[a:]$", ":"), ("^[a:]$", "b"), ("^[a-z]{2}$", "e\u{301}"),
      (#"^[\[-a]$"#, "_"), (#"^[\[-a]$"#, "-"), ("^[a-]$", "-"), ("^[a-]$", "b"), ("^[-:]$", ":"), ("^[-:]$", "5"),
      ("^a{65535}$", String(repeating: "a", count: 65_535)), ("^a{65535}$", String(repeating: "a", count: 65_534)),
    ]
    #expect(try cases.map { try Pattern($0.pattern).matches($0.text) } == [
      true, false, false, true, false, true, true, true, false, false, true, false, true, false, true, false, true, false,
    ])
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

  @Test(arguments: [0, -1, 0.3, 0.7, 2.5, 1.5, Double.infinity, Double.nan])
  func aQuantumIsAnIntegerOrOneOverK(_ step: Double) {
    #expect(Quantum(step) == nil)
  }

  // §2.4: a positive integer, or 1/k for an integer k, so that 1 / step is an integer in doubles.
  @Test(arguments: [1, 5, 0.5, 0.25, 0.1, 0.01, 0.001])
  func aQuantumOfAnIntegerOrOneOverKIsTaken(_ step: Double) {
    #expect(Quantum(step)?.step == step)
  }

  // §2.4: a key names other types, as a chain of keys may, that never lead back to the keyed type; a key that names
  // another keyed type, whose own key leads elsewhere, is taken.
  @Test func aKeyChainThatDoesNotLeadBackIsTaken() throws {
    let registry = try Registry(json: Self.registry(Self.note { _ in }, Self.keyed("mark", ["ref": "note"]), Self.keyed(
      "link", ["tuple": [["name": "from", "ref": "mark"], ["name": "to", "ref": "note"]]])))
    #expect(registry.types.map(\.name) == ["note", "mark", "link"])
  }

  // Scope kinds and argument types are the same only byte for byte, never by canonical equivalence.
  @Test func declarationsThatDifferOnlyByCanonicalEquivalenceAreDifferent() {
    let kinds: Set<ScopeKind> = [.product("\u{212A}"), .product("K"), .tree]
    let arguments: Set<ArgumentType> = [.ref("\u{212A}"), .ref("K"), .json]
    #expect([kinds.count, arguments.count] == [3, 3])
  }

  @Test func charsCountCodePointsAndBytesCountUTF8() {
    let text = "e\u{301}👍🏽"
    #expect(MeasureUnit.chars.length(of: text) == 4)
    #expect(MeasureUnit.bytes.length(of: text) == 11)
    #expect(text.count == 2)
  }

  // The registries that ship together compose into one: their products, types and commands in part order, under their
  // one version.
  @Test func registriesComposeIntoOne() throws {
    let first = Self.part("first", product: "p", type: "note", command: "p.go")
    let second = Self.part("second", product: "q", type: "page", command: "q.go")
    let composed = try Registry(name: "both", composing: [Registry(json: first), Registry(json: second)])
    let expected: JSON = [
      "registry": "both", "version": 1, "minVersion": 1, "products": ["p": [:], "q": [:]],
      "types": .array(try first.member("types").asArray() + second.member("types").asArray()),
      "commands": .array(try first.member("commands").asArray() + second.member("commands").asArray()),
    ]
    #expect(composed.json == expected)
  }

  @Test(arguments: [
    ("both", [JSON](), "a composed registry has at least one part"),
    ("Both", [part("first", product: "p", type: "note", command: "p.go")], "Both is not a registry name"),
    ("both", [part("first", product: "p", type: "note", command: "p.go"), part("second", product: "q", type: "page", command: "q.go", version: 2)],
     "second declares version 2 and minVersion 1, first 1 and 1: the registries composed declare one"),
    ("both", [part("first", product: "p", type: "note", command: "p.go", version: 2),
              part("second", product: "q", type: "page", command: "q.go", version: 2, minVersion: 2)],
     "second declares version 2 and minVersion 2, first 2 and 1: the registries composed declare one"),
    ("both", [part("first", product: "p", type: "note", command: "p.go"), part("second", product: "p", type: "page", command: "p.run")],
     "product p is declared twice"),
    ("both", [part("first", product: "p", type: "note", command: "p.go"), part("second", product: "q", type: "note", command: "q.go")],
     "type note is declared twice"),
    ("both", [part("first", product: "p", type: "note", command: "p.go"), part("second", product: "q", type: "page", command: "p.go")],
     "command p.go is declared twice"),
    ("both", [part("first", product: "p", type: "note", command: "p.go", codes: ["late"]),
              part("second", product: "q", type: "page", command: "q.go", codes: ["early", "late"])],
     "refusal code late is declared twice"),
  ])
  func aCompositionIsRefusedNamingWhy(_ name: String, _ parts: [JSON], _ message: String) throws {
    let registries = try parts.map { try Registry(json: $0) }
    let error = #expect(throws: RegistryError.self) { try Registry(name: name, composing: registries) }
    #expect(error?.description == message)
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

  // A keyed type saved whole, as the probe's `fact`.
  static func fact(_ edit: (inout JSON.Object) -> Void) -> JSON {
    var type: JSON.Object = [
      "type": "fact", "scope": "product:p", "identity": "keyed", "idPattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", "life": true,
      "wholePut": true, "deadRows": "spent", "origins": ["replica"],
      "fields": ["value": ["kind": "lww", "writer": "client", "domain": ["type": "number", "quantum": 0.1]]],
    ]
    edit(&type)
    return .object(type)
  }

  // A lifeless keyed type of product p whose natural key is `key`.
  static func keyed(_ name: String, _ key: JSON) -> JSON {
    ["type": .string(name), "scope": "product:p", "identity": "keyed", "key": key, "life": false, "origins": ["replica"], "fields": [:]]
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

  static func registry(_ types: JSON..., commands: [JSON] = [], products: JSON = ["p": [:]]) -> JSON {
    [
      "registry": "test", "version": 1, "minVersion": 1, "products": products, "types": .array(types),
      "commands": .array(commands),
    ]
  }

  // A whole registry of one product, with one type and one command.
  static func part(_ name: String, product: String, type: String, command: String, version: Int = 1, minVersion: Int = 1,
                   codes: [String] = []) -> JSON {
    [
      "registry": .string(name), "version": JSON(version), "minVersion": JSON(minVersion),
      "products": .object([product: codes.isEmpty ? [:] : ["codes": .array(codes.map(JSON.string))]]),
      "types": [note { $0["type"] = .string(type); $0["scope"] = .string("product:\(product)") }],
      "commands": [Self.command { $0["name"] = .string(command); $0["scope"] = .string("product:\(product)") }],
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
