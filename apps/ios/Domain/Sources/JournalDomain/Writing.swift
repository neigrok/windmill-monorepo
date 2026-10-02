import DomainKit
import SyncAPI
import SyncCore
import SyncSchema

public struct EditorDraft: Sendable {
  public static let key = "pendingClaim:__editorDraft__"
  public let day: LocalDay
  public let document: PageDocument
  public init(day: LocalDay, document: PageDocument) { self.day = day; self.document = document }
  public init(json: JSON) throws {
    guard let day = LocalDay(try json.member("day").asString()) else { throw JSONError.shape("invalid draft day") }
    self.day = day; document = try PageDocument(json: json.member("document"))
  }
  public var json: JSON { ["day": .string(day.text), "document": .object(JSON.Object(uniqueKeysWithValues: document.fields.map { ($0.key, $0.value) }))] }
}

public struct PreserveEditorDraft: Action {
  public typealias Refusal = JournalRefusal
  public let scope = Journal.scope
  public let draft: EditorDraft
  public init(day: LocalDay, document: PageDocument) { draft = EditorDraft(day: day, document: document) }
  public func load(_ read: Reader) throws -> Void {}
  public func decide(_ loaded: Void, ids: IDSource) throws(Violation) -> Decision<Void, JournalRefusal> {
    var plan = Plan(); plan.device(EditorDraft.key, draft.json)
    return .write(plan)
  }
}

public struct SavePageCommand: ServerCommand {
  public static let name = Journal.Commands.savePage
  public static let specs: [any ValueSpec] = [JournalRules.body]
  public let args: [String: JSON]
  public init(day: LocalDay, document: PageDocument, stamp: JSON) throws(Violation) {
    try JournalRules.check(document)
    guard ContentClock.valid(stamp) else { throw Violation(rule: "journal.documentStamp", path: "stamp", reason: .custom("invalidStamp")) }
    args = document.fields.merging(["day": .string(day.text), "stamp": stamp]) { $1 }
  }
}

public struct ClaimPageCommand: ServerCommand {
  public static let name = Journal.Commands.claimPage
  public static let body = TextSpec("journal.claimPage.body", unit: .bytes, min: 0, max: 131_072, trim: false, nfc: false)
  public static let specs: [any ValueSpec] = [body]
  public let args: [String: JSON]
  public init(day: LocalDay, document: PageDocument, claimId: String) throws(Violation) {
    try JournalRules.check(document)
    guard !claimId.isEmpty, claimId.utf8.count <= 128, !claimId.utf8.contains(0) else { throw Violation(rule: "journal.claimId", path: "claimId", reason: .custom("invalidClaimId")) }
    args = document.fields.merging(["day": .string(day.text), "claimId": .string(claimId)]) { $1 }
  }
}

public struct PendingClaim: Sendable {
  public let day: LocalDay
  public let claimId: String
  public let base: PageDocument
  public var latest: PageDocument
  public var touched: [String]
  public var retirements: [String: JSON]
  public var result: JSON?
  public var refusal: JSON?
  public var key: String { "pendingClaim:\(claimId)" }

  public init(day: LocalDay, claimId: String, document: PageDocument, retirements: [String: JSON]) {
    self.day = day; self.claimId = claimId; base = document; latest = document
    touched = []; self.retirements = retirements; result = nil; refusal = nil
  }

  public init(json: JSON) throws {
    guard let day = LocalDay(try json.member("day").asString()) else { throw JSONError.shape("invalid pending day") }
    self.day = day; claimId = try json.member("claimId").asString()
    base = try PageDocument(json: json.member("base")); latest = try PageDocument(json: json.member("latest"))
    touched = try json.member("touched").asArray().map { try $0.asString() }
    retirements = try Dictionary(uniqueKeysWithValues: json.member("retirements").asObject().members)
    let result = try json.member("claimResult"), refusal = try json.member("refusal")
    self.result = result.isNull ? nil : result; self.refusal = refusal.isNull ? nil : refusal
  }

  public var json: JSON {
    ["day": .string(day.text), "claimId": .string(claimId), "base": .object(JSON.Object(uniqueKeysWithValues: base.fields.map { ($0.key, $0.value) })),
      "latest": .object(JSON.Object(uniqueKeysWithValues: latest.fields.map { ($0.key, $0.value) })), "touched": .array(touched.map(JSON.string)),
      "retirements": .object(JSON.Object(uniqueKeysWithValues: retirements.map { ($0.key, $0.value) })), "claimResult": result ?? .null, "refusal": refusal ?? .null]
  }

  public mutating func edit(_ document: PageDocument, retiring: [String: JSON]) {
    for name in ["body", "mood", "energy", "source"] where document.fields[name] != latest.fields[name] {
      if !touched.contains(name) { touched.append(name) }
    }
    latest = document; retirements.merge(retiring) { $1 }
  }
}

public struct JournalWriteState: Sendable {
  let moment: Moment
  let actor: String
  let anonymous: Bool
  let clock: JSON?
  let page: Record?
  let state: JournalState
  let pending: [PendingClaim]
  let commands: [QueuedCommand]
  let checkpoint: ScopeCheckpoint

  public init(_ read: Reader, day: LocalDay) throws {
    moment = read.moment; actor = read.actor; anonymous = read.isAnonymous
    clock = try read.device("contentClock"); page = try read.confirmed(Page.self, ID(day))
    state = try read.repository(JournalState.self).find(ID(RecordID("journalState")), in: .drawn) ?? JournalState()
    pending = try read.devices(prefix: "pendingClaim:").members.filter { $0.key != EditorDraft.key }.map { try PendingClaim(json: $0.value) }
    commands = try read.commands(); checkpoint = try read.checkpoint()
  }
}

// Local saves are durable commands; a bound day with an outstanding claim remains in its pending record.
public struct SavePage: Action {
  public typealias Refusal = JournalRefusal
  public let scope = Journal.scope
  public let day: LocalDay
  public let document: PageDocument
  public let retirements: [String]
  public init(day: LocalDay, document: PageDocument, retiring: [String] = []) { self.day = day; self.document = document; retirements = retiring }
  public func load(_ read: Reader) throws -> JournalWriteState { try JournalWriteState(read, day: day) }

  public func decide(_ loaded: JournalWriteState, ids: IDSource) throws(Violation) -> Decision<String?, JournalRefusal> {
    guard day == loaded.moment.today else { throw Violation(rule: "journal.day", path: "day", reason: .custom("readOnlyDay")) }
    try JournalRules.check(document)
    var retiring = JournalWriting.retired(loaded.state)
    for field in retirements {
      guard loaded.state.fields[field] != nil else { throw Violation(rule: "journalState", path: Path(field), reason: .custom("unknownState")) }
      retiring[field] = "retired"
    }
    if !document.body.isEmpty { retiring["placeholder"] = "retired" }
    if document.isWritten { retiring["privacyLine"] = "retired"; retiring["firstPage"] = "retired" }
    if document.mood != nil || document.energy != nil { retiring["scales"] = "retired" }
    if !loaded.anonymous, var pending = loaded.pending.first(where: { $0.day == day }) {
      pending.edit(document, retiring: retiring)
      var plan = Plan(); plan.device(pending.key, pending.json); plan.device(EditorDraft.key, nil)
      return .write(plan, pending.claimId)
    }
    if loaded.anonymous {
      let prior = loaded.commands.filter { $0.command.name == Journal.Commands.claimPage && $0.command.args["day"] == .string(day.text) }
      guard prior.allSatisfy(\.canSupersede) else { throw Violation(rule: "journal.claim", path: "day", reason: .custom("claimInFlight")) }
      for pending in loaded.pending where pending.day == day { retiring.merge(pending.retirements) { $1 } }
      let claimId = ids.opaqueID()
      let command = try ClaimPageCommand(day: day, document: document, claimId: claimId)
      var plan = try Plan(running: command, predicting: [JournalWriting.prediction(day: day, document: document)])
      plan.supersede(prior.map(\.gestureId))
      for pending in loaded.pending where pending.day == day { plan.device(pending.key, nil) }
      let pending = PendingClaim(day: day, claimId: claimId, document: document, retirements: retiring)
      plan.device(pending.key, pending.json); plan.device(EditorDraft.key, nil)
      try JournalWriting.retire(retiring, in: &plan, at: loaded.moment)
      return .write(plan, claimId)
    }
    let stamp = try JournalWriting.stamp(loaded, observed: loaded.page?.values["documentStamp"])
    var plan = try Plan(running: SavePageCommand(day: day, document: document, stamp: stamp),
      predicting: [JournalWriting.prediction(day: day, document: document, stamp: stamp)])
    plan.device("contentClock", ContentClock.pair(stamp)); plan.device(EditorDraft.key, nil)
    try JournalWriting.retire(retiring, in: &plan, at: loaded.moment)
    return .write(plan, nil)
  }
}

public struct ClaimPage: Action {
  public typealias Refusal = JournalRefusal
  public let scope = Journal.scope
  let save: SavePage
  public init(day: LocalDay, document: PageDocument, retiring: [String] = []) { save = SavePage(day: day, document: document, retiring: retiring) }
  public func load(_ read: Reader) throws -> JournalWriteState { try save.load(read) }
  public func decide(_ loaded: JournalWriteState, ids: IDSource) throws(Violation) -> Decision<String?, JournalRefusal> {
    guard loaded.anonymous else { throw Violation(rule: "journal.claim", path: "day", reason: .custom("boundClaim")) }
    return try save.decide(loaded, ids: ids)
  }
}

public struct ReconcileClaim: Action {
  public typealias Refusal = JournalRefusal
  public let scope = Journal.scope
  public let day: LocalDay
  public let claimId: String
  public init(day: LocalDay, claimId: String) { self.day = day; self.claimId = claimId }
  public func load(_ read: Reader) throws -> JournalWriteState { try JournalWriteState(read, day: day) }

  public func decide(_ loaded: JournalWriteState, ids: IDSource) throws(Violation) -> Decision<Bool, JournalRefusal> {
    guard var pending = loaded.pending.first(where: { $0.claimId == claimId }), pending.refusal == nil,
          let result = pending.result, let epoch = try? result.member("epoch").asString(),
          let seq = try? result.member("seq").asInteger() else { return .unchanged(false) }
    if let current = loaded.checkpoint.epoch, current != epoch {
      let outstanding = loaded.commands.contains { $0.command.name == Journal.Commands.claimPage && $0.command.args["claimId"] == .string(claimId) }
      var plan = outstanding ? Plan() : try Plan(running: ClaimPageCommand(day: day, document: pending.base, claimId: claimId))
      pending.result = nil; plan.device(pending.key, pending.json)
      return .write(plan, false)
    }
    guard loaded.checkpoint.epoch == epoch, let covered = loaded.checkpoint.cleanSeq, covered >= seq, let row = loaded.page else { return .unchanged(false) }
    var plan = Plan()
    if !pending.touched.isEmpty {
      var document = pending.latest
      let joined = row.texts["body"]?.text ?? ""
      document.body = pending.touched.contains("body") ? JournalWriting.reconcileBody(joined, base: pending.base.body, latest: pending.latest.body) : joined
      if !pending.touched.contains("mood") { document.mood = row.values["mood"].flatMap { try? Int($0.asInteger()) } }
      if !pending.touched.contains("energy") { document.energy = row.values["energy"].flatMap { try? Int($0.asInteger()) } }
      if !pending.touched.contains("source") { document.source = (try? row.values["source"]?.asString()) ?? "typed" }
      try JournalRules.check(document)
      let stamp = try JournalWriting.stamp(loaded, observed: row.values["documentStamp"])
      plan = try Plan(running: SavePageCommand(day: day, document: document, stamp: stamp), predicting: [JournalWriting.prediction(day: day, document: document, stamp: stamp)])
      plan.device("contentClock", ContentClock.pair(stamp))
    }
    try JournalWriting.retire(pending.retirements, in: &plan, at: loaded.moment)
    plan.device(pending.key, nil)
    return .write(plan, true)
  }
}

public enum JournalWriting {
  public static let pendingWork: PendingDeviceWork = { product, rows in
    guard product == "journal" else { return [] }
    return rows.members.compactMap { key, value in
      if key == EditorDraft.key { return key }
      guard key.hasPrefix("pendingClaim:"), let pending = try? PendingClaim(json: value),
            !pending.touched.isEmpty || !pending.retirements.isEmpty else { return nil }
      return key
    }
  }

  // Install this product binding on Store; it runs before the generic result handler in the same transaction.
  public static let resultWrites: CommandResultDeviceWrites = { command, result, epoch, rows in
    guard command.name == Journal.Commands.claimPage, let id = try? command.args.member("claimId").asString(),
          var pending = try? rows["pendingClaim:\(id)"]?.asObject() else { return [] }
    switch result.verdict {
    case .ok(let seq, _): pending["claimResult"] = ["seq": JSON(seq), "epoch": .string(epoch)]
    case .refused(let code) where code != .clockSkew && code != .baseUnknown: pending["refusal"] = code.json
    case .refused: break
    }
    return [DeviceWrite(key: "pendingClaim:\(id)", value: .object(pending))]
  }

  static func retired(_ state: JournalState) -> [String: JSON] { state.fields.filter { $0.value == "retired" } }
  static func retire(_ fields: [String: JSON], in plan: inout Plan, at moment: Moment) throws(Violation) {
    guard !fields.isEmpty else { return }
    let state = JournalState(placeholder: fields["placeholder"] == "retired" ? "retired" : "pending",
      privacyLine: fields["privacyLine"] == "retired" ? "retired" : "pending", firstPage: fields["firstPage"] == "retired" ? "retired" : "pending", scales: fields["scales"] == "retired" ? "retired" : "pending")
    plan.create(try Valid(state, fields: fields.keys.sorted(), at: moment), fields: fields.keys.sorted())
  }
  static func prediction(day: LocalDay, document: PageDocument, stamp: JSON? = nil) -> Prediction {
    var fields = document.fields; fields["body"] = nil; fields["documentStamp"] = stamp
    return .write(Page.self, ID(day), fields, texts: ["body": document.body])
  }
  static func stamp(_ loaded: JournalWriteState, observed: JSON?) throws(Violation) -> JSON {
    do { return try ContentClock.next(pair: loaded.clock, observed: observed, now: loaded.moment.now.ms, actor: loaded.actor) }
    catch { throw Violation(rule: "journal.contentClock", path: "stamp", reason: .custom("exhausted")) }
  }

  public static func reconcileBody(_ joined: String, base: String, latest: String) -> String {
    if joined.utf8.elementsEqual(base.utf8) { return latest }
    let suffix = "\n\n" + trim(base, leading: true)
    if !trim(trim(base, leading: true), leading: false).isEmpty && joined.utf8.suffix(suffix.utf8.count).elementsEqual(suffix.utf8) {
      return claimBody(String(decoding: joined.utf8.dropLast(suffix.utf8.count), as: UTF8.self), latest)
    }
    return claimBody(joined, latest)
  }

  public static func claimBody(_ account: String, _ here: String) -> String {
    let a = trim(trim(account, leading: true), leading: false), h = trim(trim(here, leading: true), leading: false)
    if a.isEmpty { return here }; if h.isEmpty { return account }
    let needle = Array(a.utf8), bytes = Array(here.utf8)
    if needle.count <= bytes.count && (0...(bytes.count - needle.count)).contains(where: { bytes[$0..<($0 + needle.count)].elementsEqual(needle) }) { return here }
    return trim(account, leading: false) + "\n\n" + trim(here, leading: true)
  }

  static func trim(_ text: String, leading: Bool) -> String {
    let whitespace: (Unicode.Scalar) -> Bool = { [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279].contains($0.value) || (8192...8202).contains($0.value) }
    var scalars = Array(text.unicodeScalars)
    if leading { scalars = Array(scalars.drop(while: whitespace)) }
    else { while let last = scalars.last, whitespace(last) { scalars.removeLast() } }
    return String(String.UnicodeScalarView(scalars))
  }
}
