import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct Page: Entity, Equatable {
  public static let type = Journal.Types.page
  public static let scope = Journal.scope
  public let id: ID<Page>
  public let document: PageDocument
  public let documentStamp: JSON

  public init(_ fields: Fields) throws(DecodeError) {
    id = ID(fields.id)
    document = PageDocument(body: try fields.string("body"), mood: try fields.optionalInt("mood"),
      energy: try fields.optionalInt("energy"), source: try fields.string("source"))
    documentStamp = fields.json("documentStamp") ?? ["ms": 0, "counter": 0, "actor": ""]
  }
}

public struct PageDocument: Equatable, Sendable {
  public var body: String
  public var mood: Int?
  public var energy: Int?
  public var source: String

  public init(body: String = "", mood: Int? = nil, energy: Int? = nil, source: String = "typed") {
    self.body = body; self.mood = mood; self.energy = energy; self.source = source
  }

  public var isWritten: Bool { !body.isEmpty || mood != nil || energy != nil }
  public var fields: [String: JSON] { ["body": .string(body), "mood": mood.map(JSON.init) ?? .null, "energy": energy.map(JSON.init) ?? .null, "source": .string(source)] }

  public init(json: JSON) throws {
    body = try json.member("body").asString()
    mood = try json.member("mood").isNull ? nil : Int(json.member("mood").asInteger())
    energy = try json.member("energy").isNull ? nil : Int(json.member("energy").asInteger())
    source = try json.member("source").asString()
  }

  public static func == (a: PageDocument, b: PageDocument) -> Bool {
    a.body.utf8.elementsEqual(b.body.utf8) && a.mood == b.mood && a.energy == b.energy && a.source.utf8.elementsEqual(b.source.utf8)
  }
}

public enum EchoQuote {
  public static func locate(body: String, text: String, occurrenceHint: Int? = nil) -> Range<Int>? {
    // Character equality is canonically equivalent; indices still address the unchanged body.
    guard !text.isEmpty, let first = body.firstRange(of: text) else { return nil }
    var selected = first
    for _ in 0..<max(0, occurrenceHint ?? 0) {
      guard let next = body[selected.upperBound...].firstRange(of: text) else {
        selected = first
        break
      }
      selected = next
    }
    return selected.lowerBound.utf16Offset(in: body)..<selected.upperBound.utf16Offset(in: body)
  }
}

public struct JournalState: Writable, Equatable {
  public static let type = Journal.Types.journalState
  public static let scope = Journal.scope
  public let id = ID<JournalState>(RecordID("journalState"))
  public var placeholder: String
  public var privacyLine: String
  public var firstPage: String
  public var scales: String

  public init(placeholder: String = "pending", privacyLine: String = "pending", firstPage: String = "pending", scales: String = "pending") {
    self.placeholder = placeholder; self.privacyLine = privacyLine; self.firstPage = firstPage; self.scales = scales
  }

  public init(_ fields: Fields) throws(DecodeError) {
    placeholder = try fields.string("placeholder", default: Journal.Defaults.JournalState.placeholder)
    privacyLine = try fields.string("privacyLine", default: Journal.Defaults.JournalState.privacyLine)
    firstPage = try fields.string("firstPage", default: Journal.Defaults.JournalState.firstPage)
    scales = try fields.string("scales", default: Journal.Defaults.JournalState.scales)
  }

  public var fields: [String: JSON] { ["placeholder": .string(placeholder), "privacyLine": .string(privacyLine), "firstPage": .string(firstPage), "scales": .string(scales)] }
  static let specs = ["placeholder", "privacyLine", "firstPage", "scales"].map {
    ChoiceSpec("journalState.\($0)", values: ["pending", "retired"])
  }
  public static let checks: [Check<JournalState>] = specs.map { spec in
    let name = String(spec.path.dropFirst(type.count + 1))
    return Check(name) { state, _ in
      guard case .string(let value)? = state.fields[name] else {
        throw Violation(rule: spec.path, path: Path(name), reason: .notOneOf)
      }
      _ = try spec.apply(value, at: Path(name)) as String
    }
  }

  public var scaleInvitationDue: Bool { firstPage == "retired" && scales == "pending" }
  public var keepDue: Bool { firstPage == "retired" && scales == "retired" }
}

public enum JournalRules {
  public static let body = TextSpec("journal.savePage.body", unit: .bytes, min: 0, max: 131_072, trim: false, nfc: false)
  public static let book = RuleBook(registry: SyncSchema.registry, entities: [Page.self, JournalState.self], rules: [
      .local(body), .local(SavePageCommand.source), .local(SavePageCommand.actor),
      .local(ClaimPageCommand.body), .local(ClaimPageCommand.source), .local(ClaimPageCommand.claimId),
      .local("journal.day", subject: Page.type), .local("journal.documentStamp", subject: Page.type),
      .local("journal.mood", subject: Page.type), .local("journal.energy", subject: Page.type),
      .local("journal.contentClock", subject: Page.type), .local("journalState", subject: JournalState.type),
      .serverDecided("journal.claim", codes: [Journal.Codes.claimConflict], subject: Page.type),
    ] + JournalState.specs.map { .local($0) })

  public static func check(_ document: PageDocument) throws(Violation) {
    try check(document, body: body, source: SavePageCommand.source)
  }

  static func check(_ document: PageDocument, body: TextSpec, source: ChoiceSpec) throws(Violation) {
    _ = try body.apply(document.body, at: "body") as String
    for (name, value) in [("mood", document.mood), ("energy", document.energy)] {
      if let value, !(0...10).contains(value) { throw Violation(rule: "journal.\(name)", path: Path(name), reason: .custom("invalidScale")) }
    }
    _ = try source.apply(document.source, at: "source") as String
  }
}

public enum JournalRefusal: ProductRefusal, Equatable {
  case invalid(Violation), tooLarge, claimConflict, other(Refused)
  public init(_ violation: Violation) { self = .invalid(violation) }
  public init(_ refused: Refused) {
    switch refused.code {
    case .tooLarge: self = .tooLarge
    case Journal.Codes.claimConflict: self = .claimConflict
    default: self = .other(refused)
    }
  }
  public var isGeneric: Bool { if case .other = self { return true }; return false }
}
