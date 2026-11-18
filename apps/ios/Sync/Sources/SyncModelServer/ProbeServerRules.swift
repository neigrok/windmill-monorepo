import SyncCore

// The probe product's binding (corpus README "The probe product"): `probe.start` with its join and receipts,
// `probe.end`, `probe.copy` into a board it creates, the opted `probe.branch` across three scopes and its inverse
// `probe.unbranch` (K-3), `probe.sprout` and `probe.adopt` over typed references (E-8), the `beforePull` `probe.tick`, the
// run checks, and one kept revision per text field. Receipts live in the product state as `receipts[<scope key>][<called id>]` and copies as
// `copies[<scope key>][<dst>]`.

public struct ProbeServerRules: ServerRules {
  static let tickAfterMs: Int64 = 600_000

  public init() {}

  public var localCheckTypes: Set<String>? { ["run"] }

  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool {
    switch command.name {
    case "probe.start": receipt(of: command.string("id"), in: context) != nil
    case "probe.copy": copySource(of: command.string("dst"), in: context)?.isSameID(as: command.string("src")) ?? false
    case "probe.branch": branchReceipt(of: command.string("child"), in: context) == branched(command)
    case "probe.sprout": owner(of: step(command), in: context) != nil
    case "probe.adopt": labelled(command.args["label"] ?? .null, in: context) != nil
    default: false
    }
  }

  public func discoverEffectScopes(in context: RuleContext, command: CheckedCommand?) -> Set<ScopeKey> {
    if let command, command.name == "probe.branch" {
      return [ScopeKey(.tree(command.string("parent"))), ScopeKey(.tree(command.string("child")))]
    }
    if let command, command.name == "probe.unbranch" {
      return [ScopeKey(.tree(command.input("parent"))), ScopeKey(.tree(command.input("child")))]
    }
    guard let command, command.name == "probe.copy", !replays(command, in: context),
          case .none = context.idState(of: RecordKey("board", RecordID(command.string("dst")))) else { return [] }
    return [ScopeKey(.tree(command.string("dst")))]
  }

  public func run(_ command: CheckedCommand, in context: RuleContext) throws -> CommandOutcome {
    switch command.name {
    case "probe.start": try start(command, in: context)
    case "probe.end": try end(command, in: context)
    case "probe.copy": try copy(command, in: context)
    case "probe.branch": try branch(command, in: context)
    case "probe.sprout": try sprout(command, in: context)
    case "probe.adopt": try adopt(command, in: context)
    case "probe.unbranch": try unbranch(command, in: context)
    case "probe.tick": tick(in: context)
    default: throw Refusal(.invalid)
    }
  }

  // A run is created only by `probe.start`: a create from any other source is invalid, a delta beside the command
  // included. A run that dies here takes every lap under it, the ones this intent deletes included, at the next pass's
  // server stamp.
  public func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
    if changes.contains(where: { $0.key.type == "run" && $0.createdBy.contains { $0 != .command } }) { throw Refusal(.invalid) }
    let dying = changes.filter { $0.key.type == "run" && $0.diesHere }.map { $0.key.id.json }
    guard !dying.isEmpty else { return [] }
    var laps = Dictionary(uniqueKeysWithValues: context.records(ofType: "lap").filter(\.isAlive).map { ($0.key, $0) })
    for change in changes where change.key.type == "lap" {
      if case .alive(let locked) = change.before { laps[change.key] = locked }
    }
    return laps.values.sorted { $0.key < $1.key }
      .filter { lap in lap.lattice.fields["runId"].map { dying.contains($0.value) } ?? false }
      .map { PlannedDelta.serverDelete($0.key, born: $0.lattice.born) }
  }

  // Revisions sort by record, field and rev, so each field's latest is the last of its run.
  public func keptRevisions(_ revisions: [Revision]) -> [Revision] {
    var latest: [Revision] = []
    for revision in revisions.sorted() {
      if let last = latest.last, last.key == revision.key, last.field.isSameID(as: revision.field) { latest.removeLast() }
      latest.append(revision)
    }
    return latest
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
        product: recording(.string(open.key.id.description), under: "receipts", at: called, in: context))
    }
    var fields: [String: JSON] = ["startedAt": command.args["startedAt"] ?? .null]
    fields["label"] = command.args["label"]
    let key = RecordKey("run", RecordID(called))
    return CommandOutcome(
      deltas: [.serverCreate(key, fields: fields)],
      write: [WriteClaim(key: key, born: .minted, fields: fields.keys.sorted())],
      product: recording(.string(called), under: "receipts", at: called, in: context))
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
      product: recording(.string(source), under: "copies", at: board.id.description, in: context),
      into: [ScopeKey(.tree(board.id.description)): copies])
  }

  // A child board under `parent`: its governor in the product scope, and one meta title written into both trees. Its
  // receipt `child → {parent, title}` answers a replay, from any replica, with the board it created.
  func branch(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let (parent, child) = (command.string("parent"), command.string("child"))
    let board = RecordKey("board", RecordID(child))
    if replays(command, in: context) {
      guard case .alive(let row) = context.idState(of: board), let born = row.lattice.born else {
        return CommandOutcome(detail: ["created": false], product: context.product)
      }
      return CommandOutcome(write: [WriteClaim(key: board, born: .stored(born))], detail: ["created": false], product: context.product)
    }
    guard !parent.isSameID(as: child) else { throw Refusal(.invalid) }
    switch context.idState(of: board) {
    case .alive, .dead: throw Refusal(.idTaken)
    case .none, .foreign: break
    }
    let meta = PlannedDelta.serverUpdate(RecordKey("meta", "meta"), born: nil, fields: ["title": command.args["title"] ?? .null])
    return CommandOutcome(
      deltas: [.serverCreate(board)], write: [WriteClaim(key: board, born: .minted)], detail: ["created": true],
      product: recording(branched(command), under: "branches", at: child, in: context),
      into: [ScopeKey(.tree(parent)): [meta], ScopeKey(.tree(child)): [meta]])
  }

  // Board `child` owned by the step `{board, tag}`, its `parent`. A step that already owns an alive board answers that
  // board, so a retry, or another device's sprout of the same step, resolves to the subtree the step owns. Neither the
  // board nor the tag need exist.
  func sprout(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let child = RecordKey("board", RecordID(command.string("child")))
    if let owned = owner(of: step(command), in: context) { return resolved(owned, called: child, in: context) }
    guard case .none = context.idState(of: child) else { throw Refusal(.idTaken) }
    return CommandOutcome(
      deltas: [.serverCreate(child, fields: ["parent": step(command)])], write: [WriteClaim(key: child, born: .minted, fields: ["parent"])],
      product: context.product)
  }

  // The tree's alive tag labelled `label`, else tag `tag` created with that label: a command whose write map renames a
  // scope-local id.
  func adopt(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome {
    let tag = RecordKey("tag", RecordID(command.string("tag")))
    let label = command.args["label"] ?? .null
    if let named = labelled(label, in: context) { return resolved(named, called: tag, in: context) }
    guard case .none = context.idState(of: tag) else { throw Refusal(.idTaken) }
    return CommandOutcome(
      deltas: [.serverCreate(tag, fields: ["label": label])], write: [WriteClaim(key: tag, born: .minted, fields: ["label"])],
      product: context.product)
  }

  // K-3: the inverse of probe.branch, all or nothing. While the created board and its tree are unchanged since the branch,
  // and the parent's title is still the one the branch wrote where the evidence owns it, the board dies, killing its
  // tree, and the parent takes back its earlier title. Evidence that proves no board or tree is invalid.
  func unbranch(_ command: CheckedCommand, in context: RuleContext) throws -> CommandOutcome {
    let (parent, child) = (command.input("parent"), command.input("child"))
    let evidence = try context.registry.evidence(command.args["evidence"] ?? .null)
    let board = RecordKey("board", RecordID(child))
    let proves = evidence.unchangedCreatedRecords.contains { $0.record.scope == .product("probe") && $0.record.key == board }
      && evidence.unchangedCreatedScopes.contains { $0.scope == .tree(child) }
    guard proves, !parent.isSameID(as: child) else { throw Refusal(.invalid) }
    if let code = try context.skip(by: evidence) {
      return CommandOutcome(detail: InverseOutcome.detail([InverseOutcome(index: 0, skipped: code)]), product: context.product)
    }
    let restoresTitle = evidence.ownedFields.contains { owned in
      owned.target.scope == .tree(parent) && owned.target.key.type == "meta" && owned.target.slot == .field("title")
    }
    let title: JSON = command.args["input"]?["title"] ?? .null
    let into: [ScopeKey: [PlannedDelta]] = restoresTitle
      ? [ScopeKey(.tree(parent)): [.serverUpdate(RecordKey("meta", "meta"), born: nil, fields: ["title": title])]] : [:]
    return CommandOutcome(deltas: [.serverDelete(board, born: context.record(board)?.lattice.born)],
                          detail: InverseOutcome.detail([InverseOutcome(index: 0)]), product: context.product, into: into)
  }

  func step(_ command: CheckedCommand) -> JSON {
    let board: JSON = command.args["board"] ?? .null
    let tag: JSON = command.args["tag"] ?? .null
    return ["board": board, "tag": tag]
  }

  // The alive board a step owns, the least id first.
  func owner(of step: JSON, in context: RuleContext) -> Row? {
    context.storedRecords(ofType: "board").first { $0.isAlive && $0.lattice.fields["parent"]?.value == step }
  }

  // The alive tag a label names, the least id first.
  func labelled(_ label: JSON, in context: RuleContext) -> Row? {
    context.storedRecords(ofType: "tag").first { $0.isAlive && $0.lattice.fields["label"]?.value == label }
  }

  // A resolution to a record that already exists, from the called id when it differs.
  func resolved(_ row: Row, called: RecordKey, in context: RuleContext) -> CommandOutcome {
    let from: RecordID? = row.key == called ? nil : called.id
    let born: WriteClaim.Born? = row.lattice.born.map(WriteClaim.Born.stored)
    return CommandOutcome(write: [WriteClaim(key: row.key, from: from, born: born)], product: context.product)
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

  func branchReceipt(of child: String, in context: RuleContext) -> JSON? {
    context.product["branches"]?[context.scope.text]?[child]
  }

  // What a branch's receipt holds: the parent it named and the title it wrote.
  func branched(_ command: CheckedCommand) -> JSON {
    ["parent": command.args["parent"] ?? .null, "title": command.args["title"] ?? .null]
  }

  func recording(_ value: JSON, under table: String, at key: String, in context: RuleContext) -> JSON.Object {
    var product = context.product
    var tables = (try? product[table]?.asObject()) ?? JSON.Object()
    var entries = (try? tables[context.scope.text]?.asObject()) ?? JSON.Object()
    entries[key] = value
    tables[context.scope.text] = .object(entries)
    product[table] = .object(tables)
    return product
  }
}

extension CheckedCommand {
  func string(_ argument: String) -> String {
    (try? args[argument]?.asString()) ?? ""
  }

  // A member of an inverse command's `input`.
  func input(_ member: String) -> String {
    (try? args["input"]?[member]?.asString()) ?? ""
  }
}
