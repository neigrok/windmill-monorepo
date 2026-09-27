import SyncCore

// The probe product's binding (corpus README "The probe product"): `probe.start` with its join and receipts,
// `probe.end`, `probe.copy` into a board it creates, the `beforePull` `probe.tick`, the run checks, and one kept
// revision per text field. Receipts live in the product state as `receipts[<scope key>][<called id>]` and copies as
// `copies[<scope key>][<dst>]`.

public struct ProbeServerRules: ServerRules {
  static let tickAfterMs: Int64 = 600_000

  public init() {}

  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool {
    switch command.name {
    case "probe.start": receipt(of: command.string("id"), in: context) != nil
    case "probe.copy": copySource(of: command.string("dst"), in: context).map { $0 == command.string("src") } ?? false
    default: false
    }
  }

  public func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    switch command.name {
    case "probe.start": try start(command, in: context)
    case "probe.end": try end(command, in: context)
    case "probe.copy": try copy(command, in: context)
    case "probe.tick": tick(in: context)
    default: throw Refusal(.invalid)
    }
  }

  // A run is created only by `probe.start`; a run that dies here takes every lap under it, the ones this intent
  // deletes included, at the next pass's server stamp.
  public func check(_ changes: [RecordChange], in context: RuleContext) throws(Refusal) -> [PlannedDelta] {
    if changes.contains(where: { $0.key.type == "run" && $0.op == .create }) { throw Refusal(.invalid) }
    let dying = Set(changes.filter { $0.key.type == "run" && $0.diesHere }.compactMap(\.key.id.string))
    guard !dying.isEmpty else { return [] }
    var laps = Dictionary(uniqueKeysWithValues: context.records(ofType: "lap").filter(\.isAlive).map { ($0.key, $0) })
    for change in changes where change.key.type == "lap" {
      if case .alive(let locked) = change.before { laps[change.key] = locked }
    }
    return laps.values.sorted { $0.key < $1.key }
      .filter { lap in
        guard case .string(let run)? = lap.lattice.fields["runId"]?.value else { return false }
        return dying.contains(run)
      }
      .map { PlannedDelta.serverDelete($0.key, born: $0.lattice.born) }
  }

  public func keptRevisions(_ revisions: [Revision]) -> [Revision] {
    var latest: [String: Revision] = [:]
    for revision in revisions {
      let slot = revision.key.description + "#" + revision.field
      if latest[slot].map({ $0.rev < revision.rev }) ?? true { latest[slot] = revision }
    }
    return latest.values.sorted()
  }

  // MARK: - Commands

  func start(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let called = command.string("id")
    if let resolved = receipt(of: called, in: context) {
      guard case .alive(let run) = context.idState(of: RecordKey("run", RecordID(resolved))) else {
        return CommandOutcome(product: context.product)
      }
      return CommandOutcome(write: [joined(run, called: called)], product: context.product)
    }
    if let open = context.records(ofType: "run").first(where: isOpen) {
      guard command.args["join"] == .bool(true) else { throw Refusal(.invalid) }
      return CommandOutcome(
        write: [joined(open, called: called)],
        product: recording(open.key.id.description, under: "receipts", at: called, in: context))
    }
    var fields: [String: JSON] = ["startedAt": command.args["startedAt"] ?? .null]
    fields["label"] = command.args["label"]
    let key = RecordKey("run", RecordID(called))
    return CommandOutcome(
      deltas: [.serverCreate(key, fields: fields)],
      write: [WriteClaim(key: key, born: .minted, fields: fields.keys.sorted())],
      product: recording(called, under: "receipts", at: called, in: context))
  }

  func end(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let key = RecordKey("run", RecordID(command.string("runId")))
    let run: Row
    switch context.idState(of: key) {
    case .none, .foreign: throw Refusal(.unknownRecord)
    case .dead: throw Refusal(.recordDead)
    case .alive(let row): run = row
    }
    let endedAt = (try? command.args["endedAt"]?.asInteger()) ?? 0
    if let startedAt = try? run.lattice.fields["startedAt"]?.value.asInteger(), endedAt < startedAt { throw Refusal(.invalid) }
    guard isOpen(run) else { return CommandOutcome(product: context.product) }
    return CommandOutcome(
      deltas: [.serverUpdate(key, born: run.lattice.born, fields: ["endedAt": JSON(endedAt)])],
      write: [WriteClaim(key: key, fields: ["endedAt"])], product: context.product)
  }

  // The source's title register and its alive tags and links, as stored; visibility stays behind.
  func copy(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let source = command.string("src")
    let board = RecordKey("board", RecordID(command.string("dst")))
    if replays(command, in: context) {
      guard case .alive(let row) = context.idState(of: board), let born = row.lattice.born else {
        return CommandOutcome(product: context.product)
      }
      return CommandOutcome(write: [WriteClaim(key: board, born: .stored(born))], product: context.product)
    }
    guard context.canRead(tree: source) else { throw Refusal(.notFound) }
    guard case .none = context.idState(of: board) else { throw Refusal(.idTaken) }
    var copies: [PlannedDelta] = []
    for row in context.rows(ofTree: source) {
      switch row.key.type {
      case "meta":
        guard let title = row.lattice.fields["title"] else { continue }
        var meta = row
        meta.lattice.fields = ["title": title]
        copies.append(.copy(of: meta))
      case "tag", "link":
        if row.isAlive { copies.append(.copy(of: row)) }
      default:
        continue
      }
    }
    return CommandOutcome(
      deltas: [.serverCreate(board)], write: [WriteClaim(key: board, born: .minted)],
      product: recording(source, under: "copies", at: board.id.description, in: context),
      created: [ScopeKey(.tree(board.id.description)): copies])
  }

  func tick(in context: RuleContext) -> CommandOutcome {
    let stale = context.records(ofType: "run").filter { run in
      guard isOpen(run), let startedAt = try? run.lattice.fields["startedAt"]?.value.asInteger() else { return false }
      return startedAt <= context.serverNow - Self.tickAfterMs
    }
    return CommandOutcome(
      deltas: stale.map { .serverUpdate($0.key, born: $0.lattice.born, fields: ["endedAt": JSON(context.serverNow)]) },
      product: context.product)
  }

  // MARK: - Product state

  func joined(_ run: Row, called: String) -> WriteClaim {
    let from = run.key.id.string?.isSameID(as: called) == true ? nil : RecordID(called)
    return WriteClaim(key: run.key, from: from, born: run.lattice.born.map(WriteClaim.Born.stored))
  }

  func isOpen(_ run: Row) -> Bool {
    run.isAlive && (run.lattice.fields["endedAt"]?.value ?? .null).isNull
  }

  func receipt(of called: String, in context: RuleContext) -> String? {
    try? context.product["receipts"]?[context.scope.text]?[called]?.asString()
  }

  func copySource(of destination: String, in context: RuleContext) -> String? {
    try? context.product["copies"]?[context.scope.text]?[destination]?.asString()
  }

  func recording(_ value: String, under table: String, at key: String, in context: RuleContext) -> JSON.Object {
    var product = context.product
    var tables = (try? product[table]?.asObject()) ?? JSON.Object()
    var entries = (try? tables[context.scope.text]?.asObject()) ?? JSON.Object()
    entries[key] = .string(value)
    tables[context.scope.text] = .object(entries)
    product[table] = .object(tables)
    return product
  }
}

extension CheckedCommand {
  func string(_ argument: String) -> String {
    (try? args[argument]?.asString()) ?? ""
  }
}
