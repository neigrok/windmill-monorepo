import DomainKit
import DomainKitTesting
import JournalDomain
import SyncAPI
import SyncCore
import SyncSchema
import Testing

struct JournalRulesTests {
  @Test func everySharedFileHasARunner() throws {
    let handled = ["echo-quotes.json", "page-actions.json", "rules.json", "values.json"].map { "journal/domain/" + $0 }
    #expect(try Contract.files(under: "journal") == handled)
  }

  @Test func theBookIsThePinnedOne() throws {
    try RuleBookParity.check(JournalRules.book, file: "journal/domain/rules.json")
  }

  @Test func everyCodeMapsAndEveryLocalRuleHasVectors() throws {
    try RuleBookCheck.check(JournalRules.book, refusal: JournalRefusal.self, vectors: "journal/domain/values.json",
      actionVectors: ["journal/domain/page-actions.json"])
  }

  @Test func pageIsReadOnlyInTheRegistry() throws {
    try RegistryCheck.entity(Page.self, registry: SyncSchema.registry)
  }

  @Test func stateMatchesTheRegistry() throws {
    try RegistryCheck.entity(JournalState.self,
      sample: JournalState(placeholder: "retired", privacyLine: "retired", firstPage: "retired", scales: "retired"),
      book: JournalRules.book, registry: SyncSchema.registry)
  }

  @Test func saveCommandMatchesTheRegistry() throws {
    try RegistryCheck.command(SavePageCommand.self, book: JournalRules.book, registry: SyncSchema.registry)
  }

  @Test func claimCommandMatchesTheRegistry() throws {
    try RegistryCheck.command(ClaimPageCommand.self, book: JournalRules.book, registry: SyncSchema.registry)
  }

  @Test(arguments: try Contract.vectors("journal/domain/values.json"))
  func value(_ vector: Vector) throws {
    let actual = try Self.value(vector)
    #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  @Test(arguments: try Contract.vectors("journal/domain/echo-quotes.json"))
  func echoQuote(_ vector: Vector) throws {
    let input = vector.input
    let range = EchoQuote.locate(body: try input.member("body").asString(), text: try input.member("text").asString(),
      occurrenceHint: try input["occurrenceHint"].map { Int(try $0.asInteger()) })
    let actual: JSON = ["range": range.map { .array([JSON($0.lowerBound), JSON($0.upperBound)]) } ?? .null]
    #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  @Test(arguments: try Contract.vectors("journal/domain/page-actions.json"))
  func action(_ vector: Vector) throws {
    let input = try vector.input.member("input")
    let actual: JSON
    switch try vector.input.member("action").asString() {
    case "SavePage":
      actual = try Self.decision(SavePage(day: Self.day(input), document: PageDocument(json: input.member("document")),
        retiring: Self.retirements(input)), vector, result: { .of($0) })
    case "ClaimPage":
      actual = try Self.decision(ClaimPage(day: Self.day(input), document: PageDocument(json: input.member("document")),
        retiring: Self.retirements(input)), vector, result: { .of($0) })
    case "ReconcileClaim":
      actual = try Self.decision(ReconcileClaim(day: Self.day(input), claimId: input.member("claimId").asString()),
        vector, result: JSON.bool)
    case "RetireJournalInvitation":
      actual = try Self.decision(RetireJournalInvitation(input.member("field").asString()), vector, result: { _ in .null })
    case let name: throw ContractError("no journal action \(name)")
    }
    #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  static func value(_ vector: Vector) throws -> JSON {
    let input = vector.input
    guard let operation = input["op"] else { return try ProductCorpus(JournalRules.book).value(vector) }
    switch try operation.asString() {
    case "command": return try command(input)
    case "ContentClock.valid": return ["valid": .bool(ContentClock.valid(try input.member("stamp")))]
    case "ContentClock.advance":
      do {
        let clock = input["clock"].flatMap { $0.isNull ? nil : $0 }
        let observed = input["observed"].flatMap { $0.isNull ? nil : $0 }
        return ["stamp": try ContentClock.next(pair: clock, observed: observed,
          now: input.member("now").asInteger(), actor: input.member("actor").asString())]
      } catch { return ["error": true] }
    case "EditorDraft.adopt":
      let incoming = try input.member("incoming"), current = try input.member("current")
      let adopted = try EditorDraft.adopt(incoming.isNull ? nil : EditorDraft(json: incoming),
        current: current.isNull ? nil : EditorDraft(json: current))
      return ["current": adopted.current?.json ?? .null, "recovered": adopted.recovered?.json ?? .null]
    case "PendingClaim.reconcileBody":
      return ["body": .string(JournalWriting.reconcileBody(try input.member("joined").asString(),
        base: try input.member("base").asString(), latest: try input.member("latest").asString()))]
    case "PendingClaim.edit":
      var pending = try PendingClaim(json: input.member("pending"))
      let retiring = try Dictionary(uniqueKeysWithValues: retirements(input).map { ($0, JSON.string("retired")) })
      pending.edit(try PageDocument(json: input.member("document")), retiring: retiring)
      return ["pending": try pendingForm(pending.json)]
    case let name: throw ContractError("no journal value operation \(name)")
    }
  }

  static func command(_ input: JSON) throws -> JSON {
    let name = try input.member("command").asString()
    guard name == "SavePage" || name == "ClaimPage" else { throw ContractError("no journal command \(name)") }
    do {
      let args = try input.member("args")
      try args.asObject().expectKeys(required: ["day", "body", "mood", "energy", "source", name == "SavePage" ? "stamp" : "claimId"])
      let day = try day(args), document = try PageDocument(json: args)
      if name == "SavePage" {
        return ["args": .object(fields: try SavePageCommand(day: day, document: document, stamp: args.member("stamp")).args)]
      }
      return ["args": .object(fields: try ClaimPageCommand(day: day, document: document, claimId: args.member("claimId").asString()).args)]
    } catch let violation as Violation {
      return ["violation": violation.form]
    } catch { return ["error": true] }
  }

  static func day(_ input: JSON) throws -> LocalDay {
    guard let day = LocalDay(try input.member("day").asString()) else { throw ContractError("invalid journal vector day") }
    return day
  }

  static func retirements(_ input: JSON) throws -> [String] {
    try (input["retiring"]?.asArray() ?? []).map { try $0.asString() }
  }

  static func pendingForm(_ json: JSON) throws -> JSON {
    var form = try json.asObject()
    let touched = try form.member("touched").asArray().map { try $0.asString() }
    form["touched"] = .array(touched.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map(JSON.string))
    return .object(form)
  }

  static func decision<D: Decider>(_ decider: D, _ vector: Vector, result: (D.Result) -> JSON) throws -> JSON where D.Refusal == JournalRefusal {
    let context = try JournalVectorReader(vector.input)
    let moment = Moment(now: Instant(ms: context.now), zone: FixedZone(offsetSeconds: Int(try vector.input["offsetSeconds"]?.asInteger() ?? 0)))
    let loaded = try decider.load(Reader(context, scope: decider.scope, moment: moment, registry: SyncSchema.registry))
    let decision = decider.decision(loaded, ids: IDSource(context: context))
    switch decision {
    case .write(let plan, let value):
      let gesture = try plan.gesture(in: decider.scope, registry: SyncSchema.registry)
      var form = try gesture.form.asObject()
      if !gesture.supersede.isEmpty { form["supersede"] = .array(gesture.supersede.map(JSON.string)) }
      form["local"] = .array(try gesture.local.sorted { $0.key.utf8.lexicographicallyPrecedes($1.key.utf8) }.map { write in
        let value = try write.value.map { value in
          write.key.hasPrefix("pendingClaim:") && value["touched"] != nil ? try pendingForm(value) : value
        }
        return ["key": .string(write.key), "value": value ?? .null]
      })
      return ["decision": ["write": ["gesture": .object(form), "result": result(value)]]]
    case .unchanged(let value): return ["decision": ["unchanged": ["result": result(value)]]]
    case .refuse(let refusal): return ["decision": ["refuse": refusal.form]]
    }
  }
}

extension JournalRefusal {
  var form: JSON {
    switch self {
    case .invalid(let violation): ["invalid": violation.form]
    case .tooLarge: ["tooLarge": true]
    case .claimConflict: ["claimConflict": true]
    case .other(let refused): ["other": refused.form]
    }
  }
}

// Journal scenes add the engine's device rows, claim queue and confirmed checkpoint to the standard row reader.
final class JournalVectorReader: CommitContext {
  let rows: VectorReader
  let confirmedRows: VectorReader
  let deviceRows: JSON.Object
  let queued: [QueuedCommand]
  let proof: ScopeCheckpoint
  let actor: String
  let isAnonymous: Bool
  var now: Int64 { rows.now }
  var replica: String { rows.replica }

  init(_ input: JSON) throws {
    let records = try input.member("records")
    let registry = SyncSchema.registry
    let now = try input["now"]?.asInteger() ?? 1_790_812_800_000
    let ids = try (input["ids"]?.asArray() ?? []).map { try RecordID(json: $0) }
    let pulled = try input["firstPullComplete"]?.asBool() ?? true
    rows = VectorReader(records: try VectorRecords(drawn: records["drawn"], stored: records["stored"] ?? records["drawn"], registry: registry),
      now: now, ids: ids, firstPullComplete: pulled, scope: (Journal.scope, registry))
    let confirmed = records["confirmed"] ?? records["stored"] ?? records["drawn"]
    confirmedRows = VectorReader(records: try VectorRecords(drawn: confirmed, stored: confirmed, registry: registry),
      now: now, firstPullComplete: pulled, scope: (Journal.scope, registry))
    actor = try input["actor"]?.asString() ?? "writer:a"
    isAnonymous = try input["anonymous"]?.asBool() ?? false
    deviceRows = try input["devices"]?.asObject() ?? [:]
    queued = try (input["commands"]?.asArray() ?? []).map { item in
      try QueuedCommand(gestureId: item.member("gestureId").asString(), command: Command(json: item.member("command")),
        canSupersede: item.member("canSupersede").asBool(), isAdmitted: item["isAdmitted"]?.asBool() ?? false)
    }
    let checkpoint = input["checkpoint"]
    proof = ScopeCheckpoint(epoch: try checkpoint?["epoch"].flatMap { $0.isNull ? nil : try $0.asString() },
      cleanSeq: try checkpoint?["cleanSeq"].flatMap { $0.isNull ? nil : try $0.asInteger() })
  }

  func drawn(_ type: String, _ id: RecordID) throws -> Record? { try rows.drawn(type, id) }
  func stored(_ type: String, _ id: RecordID) throws -> Record? { try rows.stored(type, id) }
  func drawn(_ type: String) throws -> [Record] { try rows.drawn(type) }
  func stored(_ type: String) throws -> [Record] { try rows.stored(type) }
  func drawn(_ type: String, where field: String, is id: RecordID) throws -> [Record] { try rows.drawn(type, where: field, is: id) }
  func stored(_ type: String, where field: String, is id: RecordID) throws -> [Record] { try rows.stored(type, where: field, is: id) }
  func firstPullComplete() throws -> Bool { try rows.firstPullComplete() }
  func confirmed(_ type: String, _ id: RecordID) throws -> Record? { try confirmedRows.stored(type, id) }
  func device(_ key: String) throws -> JSON? { deviceRows[key] }
  func devices(prefix: String) throws -> JSON.Object { JSON.Object(uniqueKeysWithValues: deviceRows.members.filter { $0.key.hasPrefix(prefix) }) }
  func commands() throws -> [QueuedCommand] { queued }
  func checkpoint() throws -> ScopeCheckpoint { proof }
  func mintID(_ type: String) throws -> RecordID { try rows.mintID(type) }
  func opaqueID() throws -> String { try rows.mintID("opaque").json.asString() }
}
