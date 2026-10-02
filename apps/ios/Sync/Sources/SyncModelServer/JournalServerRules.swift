import SyncCore

public struct JournalServerRules: ServerRules {
  public init() {}

  public static func isCalendarDay(_ day: String) -> Bool {
    let bytes = Array(day.utf8)
    guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45,
          bytes.enumerated().allSatisfy({ [4, 7].contains($0.offset) || (48...57).contains($0.element) }),
          let year = Int(day.prefix(4)), year > 0,
          let month = Int(day.dropFirst(5).prefix(2)), (1...12).contains(month),
          let date = Int(day.suffix(2)) else { return false }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    return (1...[31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]).contains(date)
  }

  public static func claimBody(_ account: String, _ here: String) -> String {
    let accountTrimmed = TextMerge.trimmed(TextMerge.trimmed(account, leading: true), leading: false)
    let hereTrimmed = TextMerge.trimmed(TextMerge.trimmed(here, leading: true), leading: false)
    if accountTrimmed.isEmpty { return here }
    if hereTrimmed.isEmpty { return account }
    let needle = Array(accountTrimmed.utf8), haystack = Array(here.utf8)
    if needle.count <= haystack.count && (0...(haystack.count - needle.count)).contains(where: { haystack[$0..<($0 + needle.count)].elementsEqual(needle) }) { return here }
    return TextMerge.trimmed(account, leading: false) + "\n\n" + TextMerge.trimmed(here, leading: true)
  }

  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool {
    command.name == "journal.claimPage" && context.product["journalClaims"]?[context.scope.text]?[(try! command.args.member("claimId").asString())] != nil
  }

  public func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let args = command.args
    guard let day = try? args.member("day").asString(), Self.isCalendarDay(day), let body = try? args.member("body").asString() else { throw Refusal(.invalid) }
    guard body.utf8.count <= 131_072 else { throw Refusal(.tooLarge) }
    guard !context.deltas.contains(where: { $0.key.type == "page" }) else { throw Refusal(.invalid) }
    let key = RecordKey("page", RecordID(day))
    let current = context.idState(of: key).row
    var product = context.product
    var document = args
    if command.name == "journal.savePage" {
      guard let stamp = args["stamp"], ContentClock.valid(stamp) else { throw Refusal(.invalid) }
      if let stored = current?.lattice.fields["documentStamp"]?.value, ContentClock.compare(stamp, stored) <= 0 {
        return CommandOutcome(product: product)
      }
    } else if command.name == "journal.claimPage" {
      let id = try! args.member("claimId").asString()
      var claims = book("journalClaims", in: context, product: &product)
      let digest = ScopeDigest(row: .object(args)).hex
      if let receipt = claims[id] {
        guard receipt["digest"] == .string(digest) else { throw Refusal("claim-conflict") }
        return CommandOutcome(product: product)
      }
      let joined = Self.claimBody(current?.texts["body"]?.text ?? "", body)
      guard joined.utf8.count <= 131_072 else { throw Refusal(.tooLarge) }
      var clocks = book("journalContentClocks", in: context, product: &product)
      let stamp: JSON
      do { stamp = try ContentClock.next(pair: clocks["server"], observed: current?.lattice.fields["documentStamp"]?.value, now: context.serverNow, actor: "srv") }
      catch { throw Refusal(.invalid) }
      clocks["server"] = ContentClock.pair(stamp)
      store(clocks, name: "journalContentClocks", in: context, product: &product)
      document["stamp"] = stamp
      document["body"] = .string(joined)
      for name in ["mood", "energy"] where args[name]!.isNull { document[name] = current?.lattice.fields[name]?.value ?? .null }
      claims[id] = ["digest": .string(digest), "day": .string(day), "documentStamp": stamp]
      store(claims, name: "journalClaims", in: context, product: &product)
    } else { throw Refusal(.invalid) }
    var pages = book("journalPages", in: context, product: &product)
    pages[day] = ["updatedAt": JSON(context.serverNow)]
    store(pages, name: "journalPages", in: context, product: &product)
    var fields = JSON.Object(uniqueKeysWithValues: ["mood", "energy", "source"].map { ($0, document[$0]!) })
    fields["documentStamp"] = document["stamp"]!
    var archive: JSON.Object = ["archivedAt": JSON(context.serverNow)]
    archive["documentStamp"] = current?.lattice.fields["documentStamp"]?.value
    var delta = PlannedDelta.serverUpdate(key, born: nil, fields: Dictionary(uniqueKeysWithValues: fields.members))
    delta.replacements["body"] = TextReplacement(try! document.member("body").asString(), archiveNonempty: true, archive: archive)
    return CommandOutcome(deltas: [delta], write: [WriteClaim(key: key, fields: fields.keys.sorted())], product: product)
  }

  public func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
    guard !context.deltas.contains(where: { $0.key.type == "page" }) else { throw Refusal(.invalid) }
    return []
  }

  func book(_ name: String, in context: RuleContext, product: inout JSON.Object) -> JSON.Object {
    if product[name] == nil { product[name] = [:] }
    return (try? product[name]?[context.scope.text]?.asObject()) ?? [:]
  }

  func store(_ entries: JSON.Object, name: String, in context: RuleContext, product: inout JSON.Object) {
    var scopes = try! product[name]!.asObject()
    scopes[context.scope.text] = .object(entries)
    product[name] = .object(scopes)
  }

  public func pruneRevisions(_ revisions: [Revision], archived: [Revision], serverNow: Int64, scope: ScopeKey, product: inout JSON.Object) -> [Revision] {
    let kept = Self.prune(revisions, days: Set(archived.filter { $0.key.type == "page" && $0.field == "body" }.map(\.key.id)), serverNow: serverNow)
    if var scopes = try? product["journalRevisionProjection"]?.asObject(), let projection = try? scopes[scope.text]?.asObject() {
      let revisions = Set(kept.map { String($0.rev) })
      scopes[scope.text] = .object(JSON.Object(uniqueKeysWithValues: projection.members.filter { revisions.contains($0.key) }))
      product["journalRevisionProjection"] = .object(scopes)
    }
    return kept
  }

  public static func prune(_ revisions: [Revision], days: Set<RecordID>, serverNow: Int64) -> [Revision] {
    let newest = revisions.sorted {
      let a = (try? $0.metadata["archivedAt"]?.asInteger()) ?? 0, b = (try? $1.metadata["archivedAt"]?.asInteger()) ?? 0
      return a == b ? $0.rev > $1.rev : a > b
    }
    var daily: [RecordID: Int] = [:]
    let candidates = newest.filter { row in
      guard days.contains(row.key.id) else { return true }
      daily[row.key.id, default: 0] += 1
      return daily[row.key.id]! <= 10
    }
    var bytes = 0
    return candidates.enumerated().compactMap { index, row in
      bytes += row.text.utf8.count
      return index < 500 && bytes <= 8_388_608 && ((try? row.metadata["archivedAt"]?.asInteger()) ?? 0) >= serverNow - 90 * 86_400_000 ? row : nil
    }
  }
}
