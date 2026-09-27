import SyncCore

// §6.1 admit(origin, intent) → Result over the model's tables, as an ordered, fail-fast pipeline. A refusal leaves
// the tables as they were (step R's rollback); push and request bookkeeping belong to the caller (§6.2, §6.3).

// D-23 where an intent comes from: a replica's push, or the server (MCP, REST, tending, internal commands).
public enum IntentOrigin: Sendable, Hashable {
  case replica(account: String, replica: String, n: Int64)
  case server(account: String, requestId: String?)

  public var account: String {
    switch self {
    case .replica(let account, _, _), .server(let account, _): account
    }
  }

  public var isReplica: Bool {
    if case .replica = self { return true }
    return false
  }

  var kind: Origin { isReplica ? .replica : .server }
}

public struct Refusal: Error, Sendable, Hashable {
  public let code: RefusalCode
  public let detail: JSON?

  public init(_ code: RefusalCode, detail: JSON? = nil) {
    self.code = code
    self.detail = detail
  }
}

// D-16 the server's one final answer for an intent, as `sync_results` stores it (§9.3 without `n`).
public enum AdmitResult: Sendable, Hashable {
  case ok(seq: Int64, write: [JSON]?, detail: JSON?)
  case refused(Refusal)

  public var json: JSON {
    switch self {
    case .ok(let seq, let write, let detail):
      var object: JSON.Object = ["s": "ok", "seq": JSON(seq)]
      object["write"] = write.map(JSON.array)
      object["detail"] = detail
      return .object(object)
    case .refused(let refusal):
      var object: JSON.Object = ["s": "refused", "code": refusal.code.json]
      object["detail"] = refusal.detail
      return .object(object)
    }
  }

  public var isRefused: Bool {
    if case .refused = self { return true }
    return false
  }
}

public struct Admitted: Sendable, Hashable {
  public let result: AdmitResult
  public let events: [LiveEvent]
}

// An exception that is no refusal: a registry the rows break, or a rule the core cannot apply. §6.6 counts it.
public struct AdmissionFault: Error, Sendable, Hashable, CustomStringConvertible {
  public let description: String
}

// The limits a deployment runs with (§9.7); the corpus shrinks some per vector.
public struct ServerLimits: Sendable, Hashable {
  public var maxRecordBytes = Constants.maxRecordBytes
  public var pushMaxIntents = Constants.pushMaxIntents
  public var pushMaxBytes = Constants.pushMaxBytes
  public var pullPageBytes = Constants.pullPageBytes
  public var pullMaxScopes = Constants.pullMaxScopes
  public var liveInlineBytes = Constants.liveInlineBytes

  public init() {}

  // The corpus's `limits` knobs, by their spec names.
  public init(json: JSON?) throws {
    let knobs = try json?.asObject() ?? JSON.Object()
    try knobs.expectKeys(required: [], optional: ["MAX_RECORD_BYTES", "PUSH_MAX_INTENTS", "PUSH_MAX_BYTES", "PULL_PAGE_BYTES"])
    maxRecordBytes = try knobs["MAX_RECORD_BYTES"].map { Int(try $0.asInteger(atLeast: 1)) } ?? maxRecordBytes
    pushMaxIntents = try knobs["PUSH_MAX_INTENTS"].map { Int(try $0.asInteger(atLeast: 1)) } ?? pushMaxIntents
    pushMaxBytes = try knobs["PUSH_MAX_BYTES"].map { Int(try $0.asInteger(atLeast: 1)) } ?? pushMaxBytes
    pullPageBytes = try knobs["PULL_PAGE_BYTES"].map { Int(try $0.asInteger(atLeast: 1)) } ?? pullPageBytes
  }
}

public struct Admission: Sendable {
  public let registry: Registry
  public let rules: any ServerRules
  public let limits: ServerLimits

  public init(registry: Registry, rules: any ServerRules, limits: ServerLimits = ServerLimits()) {
    self.registry = registry
    self.rules = rules
    self.limits = limits
  }

  // Steps 1–16; `state` changes only when the intent is admitted.
  public func admit(_ intent: JSON, from origin: IntentOrigin, at serverNow: Int64,
                    in state: inout ServerState) throws(AdmissionFault) -> Admitted {
    do {
      let checked = try IntentShape.check(intent, isReplica: origin.isReplica, registry: registry, serverNow: serverNow)
      guard let scope = ScopeKey(checked.scope, account: origin.account) else { throw Refusal(.invalid) }
      var run = AdmissionRun(admission: self, origin: origin, serverNow: serverNow, scope: scope, state: state)
      let result = try run.admit(checked)
      state = run.state
      return Admitted(result: result, events: run.changeEvents + run.deathEvents)
    } catch let refusal as Refusal {
      return Admitted(result: .refused(refusal), events: [])
    } catch let fault as AdmissionFault {
      throw fault
    } catch {
      throw AdmissionFault(description: "\(error)")
    }
  }
}

// One record the intent touches: its state as locked, the row its joins build, and the ops that joined it.
struct Touched {
  let locked: IdState
  var joined: Row?
  var intentOp: Op?
  var ops: Set<Op> = []
  var superseded: [String: TextState] = [:]

  var changed: Bool { joined.map { $0.content != locked.row?.content } ?? false }
  var diesHere: Bool { locked.isAlive && joined?.isAlive == false }
}

// One admission in progress: its own copy of the tables, which the caller keeps only on success.
struct AdmissionRun {
  static let serverActor = try! Stamp.Actor("srv")

  let admission: Admission
  let origin: IntentOrigin
  let serverNow: Int64
  let scope: ScopeKey
  var state: ServerState
  var locks: [RecordKey: IdState] = [:]
  var touched: [RecordKey: Touched] = [:]
  var order: [RecordKey] = []
  var firstPassStamp: Stamp?
  var createdScopes: [ScopeKey] = []
  var changeEvents: [LiveEvent] = []
  var deathEvents: [LiveEvent] = []

  init(admission: Admission, origin: IntentOrigin, serverNow: Int64, scope: ScopeKey, state: ServerState) {
    self.admission = admission
    self.origin = origin
    self.serverNow = serverNow
    self.scope = scope
    self.state = state
  }

  var registry: Registry { admission.registry }

  mutating func admit(_ intent: CheckedIntent) throws -> AdmitResult {
    try lockScope(for: intent)
    let deltas = try lockIdentities(intent.deltas, fromIntent: true)
    let replay = intent.command.map { admission.rules.replays($0, in: context()) } ?? false
    if !replay { try checkGuards(intent.guards, writtenBy: deltas) }
    let outcome = try runCommand(intent.command)
    state.product = outcome?.product ?? state.product
    let serverDeltas = try lockIdentities(outcome?.deltas ?? [], fromIntent: false)
    firstPassStamp = try join(deltas + serverDeltas, observing: deltas)
    let appended = try admission.rules.check(changes(), in: context())
    _ = try join(try lockIdentities(appended, fromIntent: false), observing: deltas)
    try checkParents()
    assignSerials()
    try checkCaps()
    apply()
    applyLifecycle()
    try writeCreatedScopes(outcome?.created ?? [:])
    let write = outcome.map { $0.write.map { $0.json(minted: firstPassStamp, born: touched[$0.key]?.joined?.lattice.born) } }
    return .ok(seq: state.scopes[scope]!.seq, write: write, detail: outcome?.detail)
  }

  // MARK: - Step 3: the scope, inserted when absent, and who may write it

  mutating func lockScope(for intent: CheckedIntent) throws(Refusal) {
    switch state.access(scope, as: origin.account, registry: registry) {
    case .notFound: throw Refusal(.notFound)
    case .gone: throw Refusal(.scopeDead)
    case .readable: throw Refusal(.forbidden)
    case .absent:
      state.scopes[scope] = ScopeRecord(owner: origin.account, born: .firstWrite, governedBy: scope.tree.map { ScopeKey(.tree($0)).text })
    case .writable: break
    }
    if let command = intent.command?.definition,
       (command.serverInternal && origin.isReplica) || !command.origins.contains(origin.kind) {
      throw Refusal(.forbidden)
    }
    if intent.deltas.contains(where: { !(registry.type($0.key.type)?.origins.contains(origin.kind) ?? false) }) {
      throw Refusal(.forbidden)
    }
  }

  // MARK: - Steps 5–6: each record locked, each delta through §4.3, and §4.4's const and time rule

  mutating func lock(_ key: RecordKey) -> IdState {
    if let locked = locks[key] { return locked }
    let locked = state.idState(of: key, in: scope, registry: registry)
    locks[key] = locked
    return locked
  }

  // The deltas that apply; a delta §4.3 answers `ok` changes nothing and is dropped.
  mutating func lockIdentities(_ deltas: [PlannedDelta], fromIntent: Bool) throws(Refusal) -> [PlannedDelta] {
    var applying: [PlannedDelta] = []
    for delta in deltas {
      let type = registry.type(delta.key.type)!
      let locked = lock(delta.key)
      switch IdentityRules.verdict(delta.op, on: locked, born: delta.born, revivable: type.revivable == true) {
      case .refuse(let code): throw Refusal(code)
      case .ok: continue
      case .apply: break
      }
      if fromIntent && origin.isReplica { try checkWriteOnce(delta, type: type, locked: locked) }
      applying.append(delta)
    }
    return applying
  }

  // A client rewriting a const or time field set under another stamp to another value is `invalid`.
  func checkWriteOnce(_ delta: PlannedDelta, type: TypeDef, locked: IdState) throws(Refusal) {
    for (name, register) in delta.fields {
      switch type.field(name)?.kind {
      case .const?, .time?: break
      default: continue
      }
      guard let stored = locked.row?.lattice.fields[name] else { continue }
      if register.slot.stamp != stored.stamp && register.value != stored.value { throw Refusal(.invalid) }
    }
  }

  // MARK: - Step 7: guards, unless the command is a replay

  mutating func checkGuards(_ guards: [Guard], writtenBy deltas: [PlannedDelta]) throws(Refusal) {
    for check in guards {
      let stored = lock(check.key).row?.lattice.fields[check.field]
      let written = deltas.first { $0.key == check.key }?.fields[check.field]?.slot.stamp
      let holds = stored?.stamp == check.stamp || (stored != nil && written == stored?.stamp)
      guard holds else {
        throw Refusal(.stale, detail: [
          "t": .string(check.key.type), "id": check.key.id.json, "field": .string(check.field), "current": stored?.stamp.json ?? .null,
        ])
      }
    }
  }

  // MARK: - Step 8: the command's handler

  func runCommand(_ command: CheckedCommand?) throws(Refusal) -> CommandOutcome? {
    guard let command else { return nil }
    return try admission.rules.run(command, in: context())
  }

  // MARK: - Step 9: one pass of server stamps, the joins, text merges and the record bound

  mutating func join(_ deltas: [PlannedDelta], observing clientDeltas: [PlannedDelta]) throws -> Stamp? {
    let stamp = mintStamp(for: deltas, observing: clientDeltas)
    for delta in deltas { try join(delta.minted(with: stamp), op: delta.op, fromIntent: clientDeltas.contains(delta)) }
    try checkRecordBound()
    return stamp
  }

  // §10.3: one tick per pass that holds server deltas, after observing every register they write, as stored and as a
  // client delta of this intent writes it.
  mutating func mintStamp(for deltas: [PlannedDelta], observing clientDeltas: [PlannedDelta]) -> Stamp? {
    let serverDeltas = deltas.filter(\.hasServerSlots)
    guard !serverDeltas.isEmpty else { return nil }
    for delta in serverDeltas {
      let stored = lock(delta.key).row
      for register in delta.serverRegisters {
        if let stamp = stored?.stamp(of: register) { state.clock.observe(stamp) }
        for client in clientDeltas where client.key == delta.key {
          if let stamp = client.givenStamp(of: register) { state.clock.observe(stamp) }
        }
      }
    }
    return state.clock.tick(physNow: serverNow, actor: Self.serverActor)
  }

  mutating func join(_ delta: Delta, op: Op, fromIntent: Bool) throws {
    let type = registry.type(delta.key.type)!
    var record = touched[delta.key] ?? Touched(locked: lock(delta.key))
    var row = record.joined ?? record.locked.row ?? Row(key: delta.key, seq: 0)
    row.lattice = try Join.record(type, row.lattice, delta.lattice)
    for (name, write) in delta.texts.sorted(by: { $0.key < $1.key }) {
      try merge(write, into: &row, field: type.field(name)!, superseded: &record.superseded)
    }
    if row.lattice.life?.isAlive == false && type.revivable != true {
      row.lattice.fields = [:]
      row.texts = [:]
      row.serials = [:]
    }
    if touched[delta.key] == nil { order.append(delta.key) }
    record.joined = row
    record.ops.insert(op)
    if fromIntent { record.intentOp = op }
    touched[delta.key] = record
  }

  // §6.11 onto the head this intent has so far; a new head takes this intent's seq as its rev.
  func merge(_ write: TextWrite, into row: inout Row, field: FieldDef, superseded: inout [String: TextState]) throws(Refusal) {
    let head = row.texts[field.name] ?? TextState(text: "", rev: 0, merged: false)
    let key = row.key
    let merged = try TextMerge.merge(head: head, base: write.base, mine: write.text) { rev in
      state.revisionText(of: key, field: field.name, rev: rev, in: scope)
    }
    guard (field.unit ?? .bytes).length(of: merged.text) <= (field.max ?? .max) else { throw Refusal(.tooLarge) }
    if merged.text.utf8.elementsEqual(head.text.utf8) && merged.merged == head.merged { return }
    if let stored = row.texts[field.name], superseded[field.name] == nil { superseded[field.name] = stored }
    row.texts[field.name] = TextState(text: merged.text, rev: nextSeq, merged: merged.merged)
  }

  // Each changed row as step 13 would store it, text bases aside, stays within MAX_RECORD_BYTES.
  func checkRecordBound() throws(Refusal) {
    for key in order {
      guard let record = touched[key], record.changed, let row = record.joined else { continue }
      if stored(row, key: key).json.jcs.count > admission.limits.maxRecordBytes { throw Refusal(.tooLarge) }
    }
  }

  var nextSeq: Int64 { state.scopes[scope]!.seq + 1 }

  func stored(_ joined: Row, key: RecordKey) -> Row {
    var row = joined
    row.seq = nextSeq
    row.rc = state.rows[scope]?[key]?.rc ?? serverNow
    row.ru = serverNow
    return row
  }

  // MARK: - Step 10: product rules, then the parent rule, on the joined records

  func changes() -> [RecordChange] {
    order.compactMap { key in
      guard let record = touched[key], let after = record.joined else { return nil }
      return RecordChange(key: key, before: record.locked, after: after, op: record.intentOp)
    }
  }

  func context() -> RuleContext {
    RuleContext(
      registry: registry, scope: scope, origin: origin, serverNow: serverNow, state: state,
      joined: touched.compactMapValues(\.joined))
  }

  // A create or update whose parent is not alive among the joined records is `parent-dead`. The reference is read
  // before a death in this intent thinned the row (G1).
  mutating func checkParents() throws(Refusal) {
    for key in order {
      guard let record = touched[key], !record.ops.isDisjoint(with: [.create, .update]), let row = record.joined,
            let parent = registry.type(key.type)?.fields.first(where: \.parent), let target = parent.ref,
            case .string(let id)? = (row.lattice.fields[parent.name] ?? record.locked.row?.lattice.fields[parent.name])?.value
      else { continue }
      let parentKey = RecordKey(target, RecordID(id))
      let parentScope = registry.scope(ofType: target, from: scope.ref).flatMap { ScopeKey($0, account: state.scopes[scope]!.owner) }
      let alive = parentScope == scope
        ? (touched[parentKey]?.joined?.isAlive ?? lock(parentKey).isAlive)
        : parentScope.map { state.idState(of: parentKey, in: $0, registry: registry).isAlive } ?? false
      if !alive { throw Refusal(.parentDead) }
    }
  }

  // MARK: - Step 11: serials for new records, in admission order

  mutating func assignSerials() {
    for key in order {
      guard var record = touched[key], var row = record.joined, row.isAlive, !record.locked.isAlive,
            let type = registry.type(key.type) else { continue }
      for field in type.fields {
        guard case .serial(let next) = field.kind, row.serials[field.name] == nil else { continue }
        let shared = next.map { row.lattice.fields[$0]?.value }
        let highest = joinedRows(ofType: key.type)
          .filter { peer in peer.key != key && peer.isAlive && next.map { peer.lattice.fields[$0]?.value } == shared }
          .compactMap { try? $0.serials[field.name]?.asInteger() }
          .max() ?? 0
        row.serials[field.name] = JSON(highest + 1)
      }
      record.joined = row
      touched[key] = record
    }
  }

  func joinedRows(ofType type: String) -> [Row] {
    var byKey = (state.rows[scope] ?? [:]).filter { $0.key.type == type }
    for (key, record) in touched where key.type == type { byKey[key] = record.joined }
    return Array(byKey.values)
  }

  // MARK: - Step 12: caps by the growth rule

  func netAliveChange(of type: String) -> Int {
    touched.filter { $0.key.type == type }.reduce(0) { sum, entry in
      sum + (entry.value.joined?.isAlive == true ? 1 : 0) - (entry.value.locked.isAlive ? 1 : 0)
    }
  }

  func checkCaps() throws(Refusal) {
    for type in registry.types {
      guard let cap = type.cap else { continue }
      let before = state.scopes[scope]!.counters[type.name] ?? 0
      let after = before + netAliveChange(of: type.name)
      if after > cap && after > before {
        throw Refusal(.cap, detail: ["type": .string(type.name), "cap": JSON(cap)])
      }
    }
  }

  // MARK: - Step 13: apply at the next seq, with counters, spent rows, receipt times, digest and revisions

  mutating func apply() {
    let changed = order.filter { touched[$0]!.changed }
    guard !changed.isEmpty else { return }
    var record = state.scopes[scope]!
    let rows = changed.map { stored(touched[$0]!.joined!, key: $0) }
    record.seq = nextSeq
    for type in registry.types where type.cap != nil {
      let net = netAliveChange(of: type.name)
      if net != 0 || record.counters[type.name] != nil { record.counters[type.name] = (record.counters[type.name] ?? 0) + net }
    }
    let superseded = changed.flatMap { key in
      touched[key]!.superseded.map { Revision(key: key, field: $0.key, rev: $0.value.rev, text: $0.value.text) }
    }
    if !superseded.isEmpty {
      state.revisions[scope] = admission.rules.keptRevisions((state.revisions[scope] ?? []) + superseded).sorted()
    }
    commit(rows, into: scope, as: record)
  }

  // Rows at the scope's new seq: the digest takes each, the typed and spent tables hold them, and one frame carries them.
  mutating func commit(_ rows: [Row], into key: ScopeKey, as record: ScopeRecord) {
    var record = record
    for row in rows {
      record.digest = record.digest.replacing(state.rows[key]?[row.key]?.json, with: row.json)
      store(row, in: key)
    }
    state.scopes[key] = record
    changeEvents.append(.change(key, epoch: state.epoch, seq: record.seq, digest: record.digest, rows: rows,
                                inlineLimit: admission.limits.liveInlineBytes))
  }

  // A dead row of a spent type leaves the typed table for `sync_spent`; a keyed record alive again leaves it.
  mutating func store(_ row: Row, in scope: ScopeKey) {
    let type = registry.type(row.key.type)!
    if row.isAlive || type.deadRows != .spent {
      state.rows[scope, default: [:]][row.key] = row
      state.spent[scope]?[row.key] = nil
      return
    }
    state.rows[scope]?[row.key] = nil
    state.spent[scope, default: [:]][row.key] = SpentRow(born: row.lattice.born, lifeStamp: row.lattice.life!.stamp, seq: row.seq)
  }

  // MARK: - Step 15: a governing create inserts its tree; a governing death kills the tree and its overlays

  mutating func applyLifecycle() {
    let owner = state.scopes[scope]!.owner
    for key in order {
      guard let record = touched[key], record.changed, registry.type(key.type)?.governsTree == true else { continue }
      let tree = ScopeKey(.tree(key.id.description))
      if case .none = record.locked, record.joined?.isAlive == true, state.scopes[tree] == nil {
        state.scopes[tree] = ScopeRecord(owner: owner, born: .governingCreate, governedBy: ScopeRecord.governor(scope: scope, key: key))
        createdScopes.append(tree)
      }
      if record.diesHere { kill(tree: key.id.description) }
    }
  }

  mutating func kill(tree: String) {
    let governed = state.scopes.keys.filter { $0 == ScopeKey(.tree(tree)) || $0.isOverlay(of: tree) }
    for key in governed.sorted() {
      guard state.scopes[key]!.die(at: serverNow) else { continue }
      deathEvents.append(.death(key))
    }
  }

  // MARK: - Step 14: a command's writes into the scopes this intent created, at their own seq and digest

  mutating func writeCreatedScopes(_ created: [ScopeKey: [PlannedDelta]]) throws {
    for (key, deltas) in created.sorted(by: { $0.key < $1.key }) where !deltas.isEmpty {
      guard createdScopes.contains(key), var record = state.scopes[key] else {
        throw AdmissionFault(description: "a command wrote into \(key), which this intent did not create")
      }
      record.seq += 1
      var rows: [Row] = []
      for delta in deltas {
        let written = delta.minted(with: firstPassStamp)
        let type = registry.type(delta.key.type)!
        let row = Row(
          key: delta.key, lattice: try Join.record(type, Lattice(), written.lattice),
          texts: written.texts.mapValues { TextState(text: $0.text, rev: record.seq, merged: false) },
          seq: record.seq, rc: serverNow, ru: serverNow)
        if type.cap != nil, row.isAlive { record.counters[type.name, default: 0] += 1 }
        rows.append(row)
      }
      commit(rows, into: key, as: record)
    }
  }
}

extension Row {
  func stamp(of register: RegisterName) -> Stamp? {
    switch register {
    case .life: lattice.life?.stamp
    case .born: lattice.born
    case .field(let name): lattice.fields[name]?.stamp
    }
  }
}

extension ScopeKey {
  func isOverlay(of tree: String) -> Bool {
    if case .overlay(_, let governed) = kind { return governed.utf8.elementsEqual(tree.utf8) }
    return false
  }
}
