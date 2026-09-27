import DomainKit
import DomainKitTesting
import Foundation
import SyncAPI
import SyncCore
import Testing

// §14.4 the checks a product runs over its declarations, against a small registry built for them: `item` (minted, life,
// ordered, capped, a quantum, nested value objects, a serial), `page` (keyed, a text field) and `flag` (keyed, no life).
struct ChecksTests {
  static let registry = try! Registry(json: JSON(parsing: """
    {"registry": "check", "version": 1, "minVersion": 1,
     "products": {"chk": {"surfaces": ["ios"], "device": {}}},
     "types": [
       {"type": "item", "scope": "product:chk", "identity": "minted", "idSpace": "global", "idPattern": "^[a-z0-9]{8}$",
        "mint": {"prefix": "", "alphabet": "abcdefghijklmnopqrstuvwxyz0123456789", "length": 8},
        "life": true, "revivable": false, "deadRows": "spent", "origins": ["replica", "server"], "cap": 5,
        "fields": {
          "name": {"kind": "lww", "writer": "client", "unit": "chars", "min": 1, "max": 20, "domain": {"type": "string"}},
          "ord": {"kind": "lww", "writer": "client", "domain": {"type": "fracKey"}},
          "weight": {"kind": "lww", "writer": "client", "domain": {"type": "number", "min": -100, "max": 100, "nullable": true}, "quantum": 0.5},
          "tags": {"kind": "lww", "writer": "client", "unit": "bytes", "max": 400,
                   "domain": {"type": "array", "maxItems": 4, "items": {"type": "object", "required": ["label"],
                              "properties": {"label": {"type": "string", "unit": "chars", "max": 10}}}}},
          "count": {"kind": "serial", "writer": "server", "serialNext": []}}},
       {"type": "page", "scope": "product:chk", "identity": "keyed", "idPattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", "life": false,
        "origins": ["replica", "server"],
        "fields": {
          "body": {"kind": "text", "writer": "client", "unit": "bytes", "max": 100},
          "mood": {"kind": "lww", "writer": "client", "domain": {"type": "number", "integer": true, "min": 0, "max": 10, "nullable": true}}}},
       {"type": "flag", "scope": "product:chk", "identity": "keyed", "idPattern": "^[a-z]+$", "life": false, "origins": ["replica"],
        "fields": {"on": {"kind": "lww", "writer": "client", "domain": {"type": "boolean"}}}},
       {"type": "task", "scope": "product:chk", "identity": "keyed", "idPattern": "^[a-z]+$", "life": false, "origins": ["replica"],
        "fields": {"state": {"kind": "ranked", "writer": "client", "rank": {"open": 0, "done": 1}}}},
       {"type": "shelf", "scope": "product:chk", "identity": "keyed", "idPattern": "^[a-z]+$", "life": false, "origins": ["replica"],
        "fields": {"tags": {"kind": "lww", "writer": "client", "unit": "bytes", "max": 400,
                            "domain": {"type": "array", "maxItems": 5, "items": {"type": "string", "unit": "chars", "max": 10}}}}}],
     "commands": [
       {"name": "chk.ask", "scope": "product:chk", "origins": ["replica", "server"], "serverInternal": false,
        "args": {"text": {"type": "json", "domain": {"type": "string", "unit": "chars", "max": 50}}, "itemId": {"type": "ref<item>"}}}]}
    """))

  static let rules: [Rule] = [.local(Item.name), .local(Item.weight), .local(Item.tags), .local(Item.label), .local(Page.body),
                              .local(Page.mood), .serverDecided("item.duplicate", codes: ["duplicate-name"], subject: "item")]
  static let book = RuleBook(registry: registry, entities: [Item.self, Page.self], rules: rules)
  static let item = Item(id: ID("item0001"), name: "Bench", weight: 60, tags: [Tag(label: "push")])
  static let page = Page(id: ID("2027-01-15"), body: "Slept well", mood: 7)

  static func failure(_ step: Int, _ path: String, _ reason: String) -> CheckFailure {
    CheckFailure("RegistryCheck", step: step, path: path, reason)
  }

  static func book(_ rules: [Rule]) -> RuleBook {
    RuleBook(registry: registry, entities: [Item.self, Page.self], rules: rules)
  }

  // MARK: RegistryCheck

  @Test func entitiesThatAgreeWithTheRegistryPass() throws {
    try RegistryCheck.entity(Item.self, sample: ChecksTests.item, book: ChecksTests.book, registry: ChecksTests.registry)
    try RegistryCheck.entity(Page.self, sample: ChecksTests.page, book: ChecksTests.book, registry: ChecksTests.registry)
    try RegistryCheck.command(Ask.self, book: ChecksTests.book(ChecksTests.rules + [.local(Ask.text)]), registry: ChecksTests.registry)
  }

  @Test func stepOneRefusesAnEntityOfAnotherScope() {
    #expect(throws: ChecksTests.failure(1, "item", "the registry declares no item in the product scope self/elsewhere")) {
      try RegistryCheck.entity(Stray.self, registry: ChecksTests.registry)
    }
  }

  @Test func stepTwoRefusesARemovableTypeWithoutLife() {
    #expect(throws: ChecksTests.failure(2, "flag", "a removable type without life")) {
      try RegistryCheck.entity(Flag.self, registry: ChecksTests.registry)
    }
  }

  @Test func stepThreeRefusesAnOrderFieldThatIsNoFractionalKey() {
    #expect(throws: ChecksTests.failure(3, "item.name", "the order field is no client lww fracKey")) {
      try RegistryCheck.entity(Misordered.self, registry: ChecksTests.registry)
    }
  }

  @Test func stepFourRefusesASampleWritingASerial() {
    #expect(throws: ChecksTests.failure(4, "item.count", "the sample writes a field that is no client-written field")) {
      try RegistryCheck.entity(Counting.self, sample: Counting(id: ID("item0001")), book: ChecksTests.book, registry: ChecksTests.registry)
    }
  }

  @Test func stepSixRefusesASpecTheRegistryWouldRefuse() {
    let wide = TextSpec("item.name", unit: .chars, min: 1, max: 30, trim: true, nfc: true)
    #expect(throws: ChecksTests.failure(6, "item.name", "admits 30 chars, beyond the registry's 20 chars")) {
      try RegistryCheck.entity(Item.self, sample: ChecksTests.item, book: ChecksTests.book([.local(wide)] + ChecksTests.rules.dropFirst()),
                               registry: ChecksTests.registry)
    }
    let offGrid = NumberSpec("item.weight", min: -100, max: 100, quantum: 0.25)
    let rules = ChecksTests.rules.filter { $0.name != "item.weight" } + [.local(offGrid)]
    #expect(throws: ChecksTests.failure(6, "item.weight", "admits a value off the registry's quantum 0.5")) {
      try RegistryCheck.entity(Item.self, sample: ChecksTests.item, book: ChecksTests.book(rules), registry: ChecksTests.registry)
    }
    let crowded = CountSpec("item.tags", min: 0, max: 5)
    #expect(throws: ChecksTests.failure(6, "item.tags", "admits 5 items, beyond the registry's 4")) {
      try RegistryCheck.entity(Item.self, sample: ChecksTests.item,
                               book: ChecksTests.book(ChecksTests.rules.filter { $0.name != "item.tags" } + [.local(crowded)]),
                               registry: ChecksTests.registry)
    }
    let astray = TextSpec("item.tags.color", unit: .chars, min: 0, max: 10, trim: true, nfc: true)
    #expect(throws: ChecksTests.failure(6, "item.tags.color", "the spec names no registry path")) {
      try RegistryCheck.entity(Item.self, sample: ChecksTests.item, book: ChecksTests.book(ChecksTests.rules + [.local(astray)]),
                               registry: ChecksTests.registry)
    }
  }

  @Test func aChoiceOnARankedFieldHoldsToTheRank() throws {
    let registry = ChecksTests.registry
    let task = Task(id: ID("chores"), state: "open")
    let book = { (spec: ChoiceSpec) in RuleBook(registry: registry, entities: [Task.self], rules: [.local(spec)]) }
    try RegistryCheck.entity(Task.self, sample: task, book: book(Task.state), registry: registry)
    #expect(throws: ChecksTests.failure(6, "task.state", "admits archived, outside the registry's enum")) {
      try RegistryCheck.entity(Task.self, sample: task, book: book(ChoiceSpec("task.state", values: ["open", "done", "archived"])),
                               registry: registry)
    }
  }

  @Test func aTextSpecReachesEachStringOfAnArray() throws {
    let book = RuleBook(registry: ChecksTests.registry, entities: [Shelf.self], rules: [.local(Shelf.tag)])
    try RegistryCheck.entity(Shelf.self, sample: Shelf(id: ID("pantry"), tags: ["oats", "rice"]), book: book, registry: ChecksTests.registry)
  }

  @Test func aCommandAppliesTheSpecTheBookPinsWithinTheRegistry() {
    #expect(throws: ChecksTests.failure(6, "chk.ask.text", "admits 500 chars, beyond the registry's 50 chars")) {
      try RegistryCheck.command(Wide.self, book: ChecksTests.book(ChecksTests.rules + [.local(Wide.text)]), registry: ChecksTests.registry)
    }
    let pinned = TextSpec("chk.ask.text", unit: .chars, min: 1, max: 12, trim: true, nfc: true)
    #expect(throws: ChecksTests.failure(6, "chk.ask.text", "the command applies a spec the book does not pin")) {
      try RegistryCheck.command(Ask.self, book: ChecksTests.book(ChecksTests.rules + [.local(pinned)]), registry: ChecksTests.registry)
    }
  }

  @Test func stepSevenRefusesADraftThatDoesNotDecodeItsOwnFields() {
    #expect(throws: ChecksTests.failure(7, "item", #"the sample's fields {"name":"Bench"} decode as {"name":""}"#)) {
      try RegistryCheck.entity(Lossy.self, sample: Lossy(id: ID("item0001"), name: "Bench"), book: ChecksTests.book([]),
                               registry: ChecksTests.registry)
    }
  }

  @Test func stepEightRefusesAGuardedDraftWithATextField() {
    #expect(throws: ChecksTests.failure(8, "page", "a type whose saves are guarded has a text field")) {
      try RegistryCheck.entity(GuardedPage.self, sample: GuardedPage(id: ID("2027-01-15")), book: ChecksTests.book([]),
                               registry: ChecksTests.registry)
    }
  }

  @Test func stepNineRefusesAQuantumWithNoSpecOnIt() {
    #expect(throws: ChecksTests.failure(9, "item.weight", "a field with a quantum has no number spec on it")) {
      try RegistryCheck.entity(Item.self, sample: ChecksTests.item, book: ChecksTests.book(ChecksTests.rules.filter { $0.name != "item.weight" }),
                               registry: ChecksTests.registry)
    }
  }

  @Test func stepTenRefusesAStringWithNoSpec() {
    let reason = "a string with no text or choice spec, so a pasted U+0000 is no violation"
    #expect(throws: ChecksTests.failure(10, "item.tags.label", reason)) {
      try RegistryCheck.entity(Item.self, sample: ChecksTests.item, book: ChecksTests.book(ChecksTests.rules.filter { $0.name != "item.tags.label" }),
                               registry: ChecksTests.registry)
    }
    #expect(throws: ChecksTests.failure(10, "chk.ask.text", reason)) {
      try RegistryCheck.command(Ask.self, book: ChecksTests.book, registry: ChecksTests.registry)
    }
    #expect(throws: ChecksTests.failure(10, "chk.ask.text", reason)) {
      try RegistryCheck.command(Unspecced.self, book: ChecksTests.book(ChecksTests.rules + [.local(Ask.text)]), registry: ChecksTests.registry)
    }
  }

  // MARK: The rule book, RuleBookCheck and RuleBookParity

  @Test func theBookAddsEachEntitysStandardRulesInByteOrder() {
    #expect(ChecksTests.book.json == Expected.book)
  }

  @Test func aBookWhoseRulesHaveVectorsAndMapPassesItsCheck() throws {
    try withVectors(Expected.vectors) { file in try RuleBookCheck.check(ChecksTests.book, refusal: ItemRefusal.self, vectors: file) }
  }

  @Test func aLocalRuleWithNoVectorFailsTheCheck() throws {
    let vectors = Expected.vectors.filter { $0["input"]?["spec"]?["path"] != "page.mood" }
    try withVectors(vectors) { file in
      #expect(throws: CheckFailure("RuleBookCheck", step: 0, path: "page.mood", "a LOCAL spec with no spec case in \(file)")) {
        try RuleBookCheck.check(ChecksTests.book, refusal: ItemRefusal.self, vectors: file)
      }
    }
    let unbound = Expected.vectors.filter { $0["expect"]?["violation"]?["rule"] != "item.tags.label" }
    try withVectors(unbound) { file in
      #expect(throws: CheckFailure("RuleBookCheck", step: 0, path: "item.tags.label", "a LOCAL rule bound to a field with no entity case in \(file)")) {
        try RuleBookCheck.check(ChecksTests.book, refusal: ItemRefusal.self, vectors: file)
      }
    }
  }

  @Test func aCodeThatMapsToTheGenericRefusalFailsTheCheck() throws {
    try withVectors(Expected.vectors) { file in
      #expect(throws: CheckFailure("RuleBookCheck", step: 0, path: "item.cap", "cap on the predicted path maps to the generic refusal")) {
        try RuleBookCheck.check(ChecksTests.book, refusal: GenericRefusal.self, vectors: file)
      }
    }
  }

  @Test func twoRulesOfOneNameFailTheCheck() throws {
    let book = ChecksTests.book(ChecksTests.rules + [.serverDecided("item.gone", codes: [.unknownRecord], subject: "item")])
    try withVectors(Expected.vectors) { file in
      #expect(throws: CheckFailure("RuleBookCheck", step: 0, path: "item.gone", "two rules share the name")) {
        try RuleBookCheck.check(book, refusal: ItemRefusal.self, vectors: file)
      }
    }
  }

  @Test func parityHoldsTheBookToItsPinnedFile() throws {
    try withVectors(Expected.book) { file in try RuleBookParity.check(ChecksTests.book, file: file) }
    let drifted = ChecksTests.book(ChecksTests.rules.filter { $0.name != "item.duplicate" })
    try withVectors(Expected.book) { file in
      #expect(throws: CheckFailure("RuleBookParity", step: 0, path: file,
                                   "the book is \(drifted.json.jcsText), and the file pins \(Expected.book.jcsText)")) {
        try RuleBookParity.check(drifted, file: file)
      }
    }
  }

  func withVectors(_ json: JSON, _ body: (String) throws -> Void) throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("domain-kit-checks-\(UUID().uuidString).json")
    try Data(json.jcs).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    try body(file.path)
  }

  func withVectors(_ vectors: [JSON], _ body: (String) throws -> Void) throws {
    try withVectors(.array(vectors), body)
  }
}

// MARK: - The expected forms

enum Expected {
  static let book: JSON = [
    "entities": [
      ["type": "item", "removable": true, "held": true, "ordered": true, "guarded": true],
      ["type": "page", "removable": false, "held": false, "ordered": false, "guarded": false],
    ],
    "rules": [
      ["name": "item.cap", "subject": "item", "kind": "server", "codes": ["cap"]],
      ["name": "item.duplicate", "subject": "item", "kind": "server", "codes": ["duplicate-name"]],
      ["name": "item.gone", "subject": "item", "kind": "server", "codes": ["unknown-record", "record-dead"]],
      ["name": "item.name", "subject": "item", "kind": "local",
       "spec": ["path": "item.name", "kind": "text", "unit": "chars", "min": 1, "max": 20, "trim": true, "nfc": true]],
      ["name": "item.stale", "subject": "item", "kind": "server", "codes": ["stale"]],
      ["name": "item.tags", "subject": "item", "kind": "local", "spec": ["path": "item.tags", "kind": "count", "min": 0, "max": 4]],
      ["name": "item.tags.label", "subject": "item", "kind": "local",
       "spec": ["path": "item.tags.label", "kind": "text", "unit": "chars", "min": 0, "max": 10, "trim": true, "nfc": true]],
      ["name": "item.taken", "subject": "item", "kind": "server", "codes": ["id-taken", "id-spent"]],
      ["name": "item.weight", "subject": "item", "kind": "local",
       "spec": ["path": "item.weight", "kind": "number", "min": -100, "max": 100, "integer": false, "quantum": 0.5]],
      ["name": "page.body", "subject": "page", "kind": "local",
       "spec": ["path": "page.body", "kind": "text", "unit": "bytes", "min": 0, "max": 100, "trim": false, "nfc": false]],
      ["name": "page.mood", "subject": "page", "kind": "local",
       "spec": ["path": "page.mood", "kind": "number", "min": 0, "max": 10, "integer": true]],
      ["name": "page.size", "subject": "page", "kind": "server", "codes": ["too-large"]],
    ],
  ]

  // One spec case and one entity case per LOCAL rule, in values.json's forms (§15.3).
  static let vectors: [JSON] = ["item.name", "item.weight", "item.tags", "item.tags.label", "page.body", "page.mood"].flatMap { rule -> [JSON] in
    [["name": .string("\(rule) spec"), "input": ["spec": ["path": .string(rule)], "value": ""], "expect": ["value": ""]],
     ["name": .string("\(rule) entity"), "input": ["entity": .string(String(rule.prefix { $0 != "." })), "fields": [:]],
      "expect": ["violation": ["rule": .string(rule)]]]]
  }
}

// MARK: - Declarations over the check registry

extension ChecksTests {
  struct Item: Draftable, Removable, Ordered {
    static let type = "item"
    static let scope = ScopeRef.product("chk")
    static let orderField = "ord"
    static let savesGuarded = true
    static let heldRemoval = true
    static let name = TextSpec("item.name", unit: .chars, min: 1, max: 20, trim: true, nfc: true)
    static let weight = NumberSpec("item.weight", min: -100, max: 100, quantum: 0.5)
    static let tags = CountSpec("item.tags", min: 0, max: 4)
    static let label = TextSpec("item.tags.label", unit: .chars, min: 0, max: 10, trim: true, nfc: true)

    let id: ID<Item>
    var name: String
    var weight: Double?
    var tags: [Tag]

    init(id: ID<Item>, name: String, weight: Double?, tags: [Tag]) {
      self.id = id
      self.name = name
      self.weight = weight
      self.tags = tags
    }

    init(_ r: Fields) throws(DecodeError) {
      self.init(id: ID(r.id), name: try r.string("name"), weight: try r.optionalDouble("weight"), tags: try r.list("tags", of: Tag.self))
    }

    var fields: [String: JSON] { ["name": .string(name), "weight": .of(weight), "tags": .array(tags.map(\.json))] }

    static let checks: [Check<Item>] = [
      Check("name") { i, _ in i.name = try Item.name.apply(i.name, at: "name") },
      Check("weight") { i, _ in i.weight = try Item.weight.apply(i.weight, at: "weight") },
      Check("tags") { i, _ in i.tags = try Item.tags.apply(i.tags, at: "tags") },
    ]
  }

  struct Tag: ValueObject {
    var label: String

    init(label: String) {
      self.label = label
    }

    init(_ f: Fields) throws(DecodeError) {
      label = try f.string("label")
    }

    var json: JSON { ["label": .string(label)] }

    func validated(at path: Path) throws(Violation) -> Tag {
      Tag(label: try Item.label.apply(label, at: path + "label"))
    }
  }

  struct Page: Draftable {
    static let type = "page"
    static let scope = ScopeRef.product("chk")
    static let savesGuarded = false
    static let body = TextSpec("page.body", unit: .bytes, min: 0, max: 100, trim: false, nfc: false)
    static let mood = NumberSpec("page.mood", min: 0, max: 10, integer: true)

    let id: ID<Page>
    var body: String
    var mood: Int?

    init(id: ID<Page>, body: String, mood: Int?) {
      self.id = id
      self.body = body
      self.mood = mood
    }

    init(_ r: Fields) throws(DecodeError) {
      self.init(id: ID(r.id), body: r.text("body"), mood: try r.optionalInt("mood"))
    }

    var fields: [String: JSON] { ["body": .string(body), "mood": .of(mood)] }

    static let checks: [Check<Page>] = [
      Check("body") { p, _ in p.body = try Page.body.apply(p.body, at: "body") },
      Check("mood") { p, _ in p.mood = try Page.mood.apply(p.mood, at: "mood") },
    ]
  }

  struct GuardedPage: Draftable {
    static let type = "page"
    static let scope = ScopeRef.product("chk")
    static let savesGuarded = true

    let id: ID<GuardedPage>
    var mood: Int? = nil

    init(id: ID<GuardedPage>) {
      self.id = id
    }

    init(_ r: Fields) throws(DecodeError) {
      id = ID(r.id)
      mood = try r.optionalInt("mood")
    }

    var fields: [String: JSON] { ["mood": .of(mood)] }
    static let checks: [Check<GuardedPage>] = []
  }

  struct Flag: Removable {
    static let type = "flag"
    static let scope = ScopeRef.product("chk")
    static let heldRemoval = false
    let id: ID<Flag>
    init(_ r: Fields) throws(DecodeError) { id = ID(r.id) }
  }

  struct Stray: Entity {
    static let type = "item"
    static let scope = ScopeRef.product("elsewhere")
    let id: ID<Stray>
    init(_ r: Fields) throws(DecodeError) { id = ID(r.id) }
  }

  struct Misordered: Ordered {
    static let type = "item"
    static let scope = ScopeRef.product("chk")
    static let orderField = "name"
    let id: ID<Misordered>
    init(_ r: Fields) throws(DecodeError) { id = ID(r.id) }
  }

  struct Counting: Writable {
    static let type = "item"
    static let scope = ScopeRef.product("chk")
    let id: ID<Counting>
    init(id: ID<Counting>) { self.id = id }
    init(_ r: Fields) throws(DecodeError) { id = ID(r.id) }
    var fields: [String: JSON] { ["count": 1] }
    static let checks: [Check<Counting>] = []
  }

  struct Lossy: Draftable {
    static let type = "item"
    static let scope = ScopeRef.product("chk")
    static let savesGuarded = false
    let id: ID<Lossy>
    var name: String
    init(id: ID<Lossy>, name: String) {
      self.id = id
      self.name = name
    }
    init(_ r: Fields) throws(DecodeError) {
      id = ID(r.id)
      name = ""
    }
    var fields: [String: JSON] { ["name": .string(name)] }
    static let checks: [Check<Lossy>] = []
  }

  struct Ask: ServerCommand {
    static let name = "chk.ask"
    static let text = TextSpec("chk.ask.text", unit: .chars, min: 1, max: 50, trim: true, nfc: true)
    static let specs: [any ValueSpec] = [text]
    let args: [String: JSON]
  }

  struct Wide: ServerCommand {
    static let name = "chk.ask"
    static let text = TextSpec("chk.ask.text", unit: .chars, min: 0, max: 500, trim: true, nfc: true)
    static let specs: [any ValueSpec] = [text]
    let args: [String: JSON]
  }

  struct Task: Writable {
    static let type = "task"
    static let scope = ScopeRef.product("chk")
    static let state = ChoiceSpec("task.state", values: ["open", "done"])
    let id: ID<Task>
    var state: String
    init(id: ID<Task>, state: String) {
      self.id = id
      self.state = state
    }
    init(_ r: Fields) throws(DecodeError) {
      id = ID(r.id)
      state = try r.string("state")
    }
    var fields: [String: JSON] { ["state": .string(state)] }
    static let checks: [Check<Task>] = [Check("state") { t, _ in t.state = try Task.state.apply(t.state, at: "state") }]
  }

  struct Shelf: Writable {
    static let type = "shelf"
    static let scope = ScopeRef.product("chk")
    static let tag = TextSpec("shelf.tags", unit: .chars, min: 0, max: 10, trim: true, nfc: true)
    let id: ID<Shelf>
    var tags: [String]
    init(id: ID<Shelf>, tags: [String]) {
      self.id = id
      self.tags = tags
    }
    init(_ r: Fields) throws(DecodeError) {
      id = ID(r.id)
      guard case .array(let items)? = r.json("tags") else { throw DecodeError(type: "shelf", field: "tags", reason: "not an array") }
      tags = items.compactMap { if case .string(let tag) = $0 { tag } else { nil } }
    }
    var fields: [String: JSON] { ["tags": .array(tags.map { .string($0) })] }
    static let checks: [Check<Shelf>] = [
      Check("tags") { s, _ in
        var checked: [String] = []
        for (index, tag) in s.tags.enumerated() { checked.append(try Shelf.tag.apply(tag, at: Path("tags") + index)) }
        s.tags = checked
      },
    ]
  }

  struct Unspecced: ServerCommand {
    static let name = "chk.ask"
    static let specs: [any ValueSpec] = []
    let args: [String: JSON]
  }

  enum ItemRefusal: ProductRefusal {
    case invalid(Violation), known(Refused), other(Refused)

    init(_ violation: Violation) { self = .invalid(violation) }

    init(_ refused: Refused) {
      let known: [RefusalCode] = [.stale, .unknownRecord, .recordDead, .idTaken, .idSpent, .cap, .tooLarge, "duplicate-name"]
      self = known.contains(refused.code) ? .known(refused) : .other(refused)
    }

    var isGeneric: Bool {
      guard case .other = self else { return false }
      return true
    }
  }

  enum GenericRefusal: ProductRefusal {
    case invalid(Violation), other(Refused)
    init(_ violation: Violation) { self = .invalid(violation) }
    init(_ refused: Refused) { self = .other(refused) }
    var isGeneric: Bool { true }
  }
}
