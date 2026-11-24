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

  public static func == (lhs: IntentOrigin, rhs: IntentOrigin) -> Bool {
    switch (lhs, rhs) {
    case (.replica(let a, let r, let n), .replica(let b, let s, let m)): a.isSameID(as: b) && r.isSameID(as: s) && n == m
    case (.server(let a, let r), .server(let b, let s)): a.isSameID(as: b) && r.map { Array($0.utf8) } == s.map { Array($0.utf8) }
    default: false
    }
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(isReplica)
    hasher.combine(Array(account.utf8))
  }
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
  public var effectMaxBytes = Constants.effectMaxBytes
  public var receiptMaxBytes = Constants.receiptMaxBytes
  public var scopedResponseMaxBytes = Constants.scopedResponseMaxBytes
  public var pullPageBytes = Constants.pullPageBytes
  public var pullMaxScopes = Constants.pullMaxScopes
  public var pullMaxBytes = Constants.pullMaxBytes
  public var liveInlineBytes = Constants.liveInlineBytes
  public var mergeWorkCells = Constants.mergeWorkCells

  public init() {}

  // The corpus's `limits` knobs, by their spec names. The effect, receipt and scoped response bounds only shrink.
  public init(json: JSON?) throws {
    let knobs = try json?.asObject() ?? JSON.Object()
    try knobs.expectKeys(required: [], optional: [
      "MAX_RECORD_BYTES", "PUSH_MAX_INTENTS", "PUSH_MAX_BYTES", "EFFECT_MAX_BYTES", "RECEIPT_MAX_BYTES", "SCOPED_RESPONSE_MAX_BYTES",
      "PULL_PAGE_BYTES", "PULL_MAX_BYTES",
    ])
    let shrunk = { (name: String, bound: Int) throws -> Int in
      let value = try knobs[name].map { Int(try $0.asInteger(atLeast: 1)) } ?? bound
      guard value <= bound else { throw JSONError.shape("\(name) exceeds its default") }
      return value
    }
    maxRecordBytes = try knobs["MAX_RECORD_BYTES"].map { Int(try $0.asInteger(atLeast: 1)) } ?? maxRecordBytes
    pushMaxIntents = try knobs["PUSH_MAX_INTENTS"].map { Int(try $0.asInteger(atLeast: 1)) } ?? pushMaxIntents
    pushMaxBytes = try knobs["PUSH_MAX_BYTES"].map { Int(try $0.asInteger(atLeast: 1)) } ?? pushMaxBytes
    effectMaxBytes = try shrunk("EFFECT_MAX_BYTES", Constants.effectMaxBytes)
    receiptMaxBytes = try shrunk("RECEIPT_MAX_BYTES", Constants.receiptMaxBytes)
    scopedResponseMaxBytes = try shrunk("SCOPED_RESPONSE_MAX_BYTES", Constants.scopedResponseMaxBytes)
    pullPageBytes = try knobs["PULL_PAGE_BYTES"].map { Int(try $0.asInteger(atLeast: 1)) } ?? pullPageBytes
    pullMaxBytes = try knobs["PULL_MAX_BYTES"].map { Int(try $0.asInteger(atLeast: 1)) } ?? pullMaxBytes
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

// A record is keyed by its scope and identity throughout admission.
struct Place: Hashable {
  let scope: ScopeKey
  let key: RecordKey
}

// A delta, the scope it writes, and where it comes from.
struct PlacedDelta: Hashable {
  let scope: ScopeKey
  let delta: PlannedDelta
  let source: ChangeSource

  var place: Place { Place(scope: scope, key: delta.key) }
}

// One record the intent touches: its state as locked, the row its joins build with its fields as the last join wrote them
// (before G1 drops a dead record's), the ops that joined it, and the source of each create among them.
struct Touched {
  let locked: IdState
  var joined: Row?
  var joinedFields: [String: Register] = [:]
  var ops: Set<Op> = []
  var createdBy: [ChangeSource] = []
  var superseded: [String: TextState] = [:]
  var archives: [String: JSON.Object] = [:]

  var changed: Bool { joined.map { $0.content != locked.row?.content } ?? false }
  var diesHere: Bool { locked.isAlive && joined?.isAlive == false }
}

// Admission owns a copy of all tables; the caller keeps it only after every scope succeeds.
struct AdmissionRun {
  static let serverActor = try! Stamp.Actor("srv")

  let admission: Admission
  let origin: IntentOrigin
  let serverNow: Int64
  let scope: ScopeKey
  var state: ServerState
  var locks: [Place: IdState] = [:]
  var touched: [Place: Touched] = [:]
  var order: [Place] = []
  var firstPassStamp: Stamp?
  var declared: Set<ScopeKey> = []
  // E-7: the seq of every scope the origin's account owns as discovery found it, and the scopes this admission creates
  // and kills, which an opted command's receipt covers.
  var beforeSeqs: [ScopeKey: Int64] = [:]
  var created: Set<ScopeKey> = []
  var killed: Set<ScopeKey> = []
  var effectBytes = 0
  var changeEvents: [LiveEvent] = []
  var deathEvents: [LiveEvent] = []
  var intentDeltas: [PlannedDelta] = []
  var intentGuards: [Guard] = []

  init(admission: Admission, origin: IntentOrigin, serverNow: Int64, scope: ScopeKey, state: ServerState) {
    self.admission = admission
    self.origin = origin
    self.serverNow = serverNow
    self.scope = scope
    self.state = state
  }

  var registry: Registry { admission.registry }

  mutating func admit(_ intent: CheckedIntent) throws -> AdmitResult {
    intentDeltas = intent.deltas
    intentGuards = intent.guards
    try lockScope(for: intent)
    let deltas = try lockIdentities(intent.deltas, in: scope, from: .intent)
    let replay = intent.command.map { $0.definition.engine == nil && admission.rules.replays($0, in: context()) } ?? false
    if !replay { try checkGuards(intent.guards, writtenBy: deltas) }
    try discoverEffectScopes(command: intent.command)
    let outcome = try runCommand(intent.command)
    state.product = outcome?.product ?? state.product
    var commandEffects = outcome?.into ?? [:]
    commandEffects[scope, default: []].insert(contentsOf: outcome?.deltas ?? [], at: 0)
    let commandDeltas = try admitEffects(Effects(byScope: commandEffects), from: .command)
    firstPassStamp = try join(deltas + commandDeltas, observing: deltas)
    var checking = context()
    let appended = try admission.rules.effects(changes(), in: &checking)
    state.product = checking.product
    _ = try join(try admitEffects(appended, from: .check), observing: deltas)
    try checkParents()
    assignSerials()
    try checkCaps()
    try createScopes(scopedEffects: intent.command?.definition.scopedEffects == true)
    apply(scope)
    for written in Set(order.map(\.scope)).subtracting([scope]).sorted() { apply(written) }
    applyDeaths()
    deathEvents.sort { $0.key < $1.key }
    let write = outcome.map { outcome in
      outcome.write.map { $0.json(minted: firstPassStamp, born: touched[Place(scope: scope, key: $0.key)]?.joined?.lattice.born) }
    }
    let result = AdmitResult.ok(seq: state.scopes[scope]!.seq, write: write, detail: outcome?.detail)
    guard let command = intent.command?.definition, command.scopedEffects else { return result }
    return try scoped(result)
  }

  // §6.4 an opted command's success: its detail wrapped beside the receipt of every scope it declared, created or killed
  // of its own, each with its changed rows at their committed versions. The receipt and the complete response it rides
  // are bounded before anything commits.
  func scoped(_ result: AdmitResult) throws(Refusal) -> AdmitResult {
    guard case .ok(let seq, let write, let detail) = result else { return result }
    let owned = killed.filter { state.scopes[$0]?.owner.isSameID(as: origin.account) == true }
    let keys = Dictionary(declared.union(created).union(owned).map { ($0.ref, $0) }) { first, _ in first }
    let effects = EffectReceipt.ordered(origin: scope.ref, keys.keys).map { ref -> EffectReceipt in
      let key = keys[ref]!
      let after = state.scopes[key]?.seq
      let rows = order.filter { $0.scope == key && touched[$0]!.changed }.map { place in
        var row = touched[place]!.joined!
        row.seq = after!
        return EffectRow(before: touched[place]!.locked.row, after: row)
      }
      return EffectReceipt(scope: ref, beforeSeq: beforeSeqs[key], seq: after, rows: rows.sorted { $0.key < $1.key })
    }
    let scoped = AdmitResult.ok(seq: seq, write: write, detail: ScopedDetail.wrapping(effects, command: detail))
    let receiptBytes = ScopedDetail.metadata(effects).jcs.count
    let responseBytes = ScopedDetail.responseBytes(of: scoped.json, epoch: state.epoch, account: origin.account)
    guard receiptBytes <= admission.limits.receiptMaxBytes, responseBytes <= admission.limits.scopedResponseMaxBytes else {
      throw Refusal(.tooLarge)
    }
    return scoped
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

  mutating func discoverEffectScopes(command: CheckedCommand?) throws {
    beforeSeqs = state.scopes.filter { $0.value.owner.isSameID(as: origin.account) }.mapValues(\.seq)
    declared = try admission.rules.discoverEffectScopes(in: context(), command: command).union([scope])
    for target in declared.subtracting([scope]).sorted() {
      guard ScopeKey(target.ref, account: origin.account) == target else {
        throw Refusal(.forbidden)
      }
      guard registry.scopeKind(of: target.ref) != nil, registry.isScopeID(target.ref) else { throw Refusal(.invalid) }
      if let stored = state.scopes[target] {
        guard stored.owner.isSameID(as: origin.account) else { throw Refusal(.forbidden) }
        guard stored.isAlive else { throw Refusal(.scopeDead) }
      }
      if case .overlay = target.kind {
        switch state.access(target, as: origin.account, registry: registry) {
        case .writable, .absent: break
        case .gone: throw Refusal(.scopeDead)
        case .notFound: throw Refusal(.notFound)
        case .readable: throw Refusal(.forbidden)
        }
      }
    }
  }

  mutating func admitEffects(_ effects: Effects, from source: ChangeSource) throws -> [PlacedDelta] {
    var deltas: [PlacedDelta] = []
    let targets = (effects.byScope[scope] == nil ? [] : [scope]) + effects.byScope.keys.filter { $0 != scope }.sorted()
    for target in targets {
      guard declared.contains(target) else { throw AdmissionFault(description: "undeclared effect target") }
      let written = effects.byScope[target]!
      for delta in written {
        let parsed = try IntentShape.effect(delta.json, in: target, source: source, registry: registry)
        guard parsed.op == delta.op else { throw Refusal(.invalid) }
        let wire: JSON = ["scope": .string(target.text), "delta": delta.json]
        effectBytes += wire.jcs.count
        if effectBytes > admission.limits.effectMaxBytes { throw Refusal(.tooLarge) }
      }
      deltas += try lockIdentities(written, in: target, from: source)
    }
    return deltas
  }

  // MARK: - Steps 5–6: each record locked, each delta through §4.3, and §4.4's const and time rule

  mutating func lock(_ place: Place) -> IdState {
    if let locked = locks[place] { return locked }
    var locked = state.idState(of: place.key, in: place.scope, registry: registry)
    if case .none = locked, admission.rules.elsewhere(place.key, product: state.product) { locked = .foreign }
    locks[place] = locked
    return locked
  }

  // The deltas that apply in `scope`; a delta §4.3 answers `ok` changes nothing and is dropped.
  mutating func lockIdentities(_ deltas: [PlannedDelta], in scope: ScopeKey, from source: ChangeSource) throws(Refusal) -> [PlacedDelta] {
    var applying: [PlacedDelta] = []
    for delta in deltas {
      let type = registry.type(delta.key.type)!
      let place = Place(scope: scope, key: delta.key)
      let locked = lock(place)
      let present: IdState
      if source == .check, let joined = touched[place]?.joined {
        present = joined.isAlive ? .alive(joined) : .dead(joined)
      } else { present = locked }
      switch IdentityRules.verdict(delta.op, on: present, born: delta.born, revivable: type.revivable == true) {
      case .refuse(let code): throw Refusal(code)
      case .ok: continue
      case .apply: break
      }
      if source == .intent && origin.isReplica { try checkWriteOnce(delta, type: type, locked: locked) }
      applying.append(PlacedDelta(scope: scope, delta: delta, source: source))
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

  mutating func checkGuards(_ guards: [Guard], writtenBy deltas: [PlacedDelta]) throws(Refusal) {
    for check in guards {
      let stored = lock(Place(scope: scope, key: check.key)).row?.lattice.fields[check.field]
      let written = deltas.first { $0.delta.key == check.key }?.delta.fields[check.field]?.slot.stamp
      let holds = stored?.stamp == check.stamp || (stored != nil && written == stored?.stamp)
      guard holds else {
        throw Refusal(.stale, detail: [
          "t": .string(check.key.type), "id": check.key.id.json, "field": .string(check.field), "current": stored?.stamp.json ?? .null,
        ])
      }
    }
  }

  // MARK: - Step 8: the command's handler

  // A capture command mutates nothing of its own: the intent's deltas, checks and consequences are its effects.
  func runCommand(_ command: CheckedCommand?) throws -> CommandOutcome? {
    guard let command else { return nil }
    switch command.definition.engine {
    case .capture?: return CommandOutcome(product: state.product)
    case .restore?: return try restore(registry.restoreArguments(.object(command.args), of: command.definition))
    case nil:
      let outcome = try admission.rules.run(command, in: context())
      if command.definition.inverse, (try? InverseOutcome.reported(in: outcome.detail, count: 1)) == nil {
        throw AdmissionFault(description: "an inverse command reports no outcome")
      }
      return outcome
    }
  }

  // §6.4 restore (K-3): each operation, in order, holds or skips by its own condition against the scope as stored, a
  // create also against what earlier operations created; what holds becomes one server delta a record, at the stamp
  // step 9 mints. The detail reports one outcome an operation.
  func restore(_ arguments: RestoreArguments) -> CommandOutcome {
    var outcomes: [InverseOutcome] = []
    var deltas: [RecordKey: PlannedDelta] = [:]
    var order: [RecordKey] = []
    let text = { (value: JSON) -> String in
      guard case .string(let text) = value else { return "" }
      return text
    }
    let members = { (value: JSON?) -> [(key: String, value: JSON)] in
      guard case .object(let object)? = value else { return [] }
      return object.members
    }
    // The registers a create's or a keyed revival's values write under the server stamp, each text onto an empty head.
    let registers = { (values: JSON.Object) -> (fields: [String: PlannedRegister], texts: [String: TextWrite]) in
      (Dictionary(uniqueKeysWithValues: members(values["f"]).map { (member: (key: String, value: JSON)) -> (String, PlannedRegister) in
        (member.key, PlannedRegister(member.value, .server))
      }),
      Dictionary(uniqueKeysWithValues: members(values["x"]).map { (member: (key: String, value: JSON)) -> (String, TextWrite) in
        (member.key, TextWrite(text: text(member.value), base: .rev(0)))
      }))
    }
    for (index, operation) in arguments.operations.enumerated() {
      guard arguments.expectedEpoch.isSameID(as: state.epoch) else {
        outcomes.append(InverseOutcome(index: index, skipped: "epoch-changed"))
        continue
      }
      let key = operation.key
      let type = registry.type(key.type)!
      let row: Row? = state.rows[scope]?[key]
      if !order.contains(key) { order.append(key) }
      let written = { () -> PlannedDelta in
        if let delta = deltas[key] { return delta }
        let keepsLife = type.life && (type.identity == .keyed || row?.isAlive == false)
        return PlannedDelta(key: key, op: .write, life: keepsLife ? row?.lattice.life.map { PlannedLife($0.state, .given($0.stamp)) } : nil,
                            born: type.hasBorn ? row?.lattice.born.map(StampSlot.given) : nil)
      }
      switch operation {
      case .field(_, let slot, let expected, let before, let values):
        let holds: Bool = switch expected {
        case .absent(let born): row != nil && (!type.hasBorn || row?.lattice.born == born) && row?.version(of: slot) == nil
        case .version(let version): row?.version(of: slot) == version
        }
        guard holds, let row else {
          outcomes.append(InverseOutcome(index: index, skipped: "version-changed"))
          continue
        }
        if slot != .life, type.life, !row.isAlive || row.lattice.life == nil, type.revivable != true, type.identity != .keyed {
          outcomes.append(InverseOutcome(index: index, skipped: "record-dead"))
          continue
        }
        var delta = written()
        switch slot {
        case .life:
          delta.life = PlannedLife(before == "alive" ? .alive : .dead, .server)
          let revived = registers(values ?? [:])
          delta.fields.merge(revived.fields) { $1 }
          delta.texts.merge(revived.texts) { $1 }
        case .field(let name): delta.fields[name] = PlannedRegister(before, .server)
        case .text(let name): delta.replacements[name] = TextReplacement(text(before))
        case .born: preconditionFailure("born is never restored")
        }
        deltas[key] = delta
      case .createdRecord(_, let rowSeq, let footprint):
        guard let row, row.isAlive, row.lattice.life != nil, row.seq == rowSeq, row.footprint == footprint else {
          outcomes.append(InverseOutcome(index: index, skipped: "record-changed"))
          continue
        }
        var delta = written()
        delta.life = PlannedLife(.dead, .server)
        deltas[key] = delta
      case .createRecord(_, let values):
        guard row == nil, deltas[key] == nil, case .none = state.idState(of: key, in: scope, registry: registry) else {
          outcomes.append(InverseOutcome(index: index, skipped: "record-present"))
          continue
        }
        let created = registers(values)
        deltas[key] = PlannedDelta(key: key, op: .create, life: PlannedLife(.alive, .server), born: type.hasBorn ? .server : nil,
                                   fields: created.fields, texts: created.texts)
      }
      outcomes.append(InverseOutcome(index: index))
    }
    let restored: [PlannedDelta] = order.compactMap { (key: RecordKey) -> PlannedDelta? in
      guard var delta = deltas[key], let type = registry.type(key.type) else { return nil }
      delta.op = IdentityRules.op(of: type, life: delta.life, born: delta.born) ?? delta.op
      return delta
    }
    return CommandOutcome(deltas: restored, detail: InverseOutcome.detail(outcomes), product: state.product)
  }

  // MARK: - Step 9: one pass of server stamps, the joins, text merges and the record bound

  mutating func join(_ deltas: [PlacedDelta], observing clientDeltas: [PlacedDelta]) throws -> Stamp? {
    let stamp = mintStamp(for: deltas, observing: clientDeltas)
    for placed in deltas { try join(placed, minted: stamp) }
    try checkRecordBound()
    return stamp
  }

  // §10.3: one tick per pass that holds server deltas, after observing every register they write, as stored and as a
  // client delta of this intent writes it.
  mutating func mintStamp(for deltas: [PlacedDelta], observing clientDeltas: [PlacedDelta]) -> Stamp? {
    let serverDeltas = deltas.filter(\.delta.hasServerSlots)
    guard !serverDeltas.isEmpty else { return nil }
    for placed in serverDeltas {
      let stored = lock(placed.place).row
      for register in placed.delta.serverRegisters {
        if let stamp = stored?.stamp(of: register) { state.clock.observe(stamp) }
        for client in clientDeltas where client.place == placed.place {
          if let stamp = client.delta.givenStamp(of: register) { state.clock.observe(stamp) }
        }
      }
    }
    return state.clock.tick(physNow: serverNow, actor: Self.serverActor)
  }

  mutating func join(_ placed: PlacedDelta, minted stamp: Stamp?) throws {
    let delta = placed.delta.minted(with: stamp)
    let place = placed.place
    let type = registry.type(delta.key.type)!
    var record = touched[place] ?? Touched(locked: lock(place))
    var row = record.joined ?? record.locked.row ?? Row(key: delta.key, seq: 0)
    row.lattice = try Join.record(type, row.lattice, delta.lattice)
    for (name, value) in placed.delta.serials { row.serials[name] = value }
    record.joinedFields = row.lattice.fields
    for (name, write) in delta.texts.sorted(by: { $0.key < $1.key }) {
      try merge(write, into: &row, in: place.scope, field: type.field(name)!, superseded: &record.superseded)
    }
    for (name, replacement) in placed.delta.replacements {
      guard let field = type.field(name), case .text = field.kind else { throw Refusal(.invalid) }
      if let bounds = field.bounds, bounds.unit.length(of: replacement.text) > bounds.max ?? .max { throw Refusal(.tooLarge) }
      if let head = row.texts[name], !replacement.archiveNonempty || !head.text.isEmpty {
        record.superseded[name] = head
        record.archives[name] = replacement.archive
      }
      row.texts[name] = TextState(text: replacement.text, rev: nextSeq(of: place.scope), merged: false)
    }
    if row.lattice.life?.isAlive == false && type.revivable != true {
      row.lattice.fields = [:]
      row.texts = [:]
      row.serials = [:]
    }
    if touched[place] == nil { order.append(place) }
    record.joined = row
    record.ops.insert(placed.delta.op)
    if placed.delta.op == .create { record.createdBy.append(placed.source) }
    touched[place] = record
  }

  // §6.11 onto the head this intent has so far; a new head takes its scope's next seq as its rev.
  func merge(_ write: TextWrite, into row: inout Row, in scope: ScopeKey, field: FieldDef,
             superseded: inout [String: TextState]) throws(Refusal) {
    let head = row.texts[field.name] ?? TextState(text: "", rev: 0, merged: false)
    let key = row.key
    let merged = try TextMerge.merge(head: head, base: write.base, mine: write.text, workCells: admission.limits.mergeWorkCells) { rev in
      state.revisionText(of: key, field: field.name, rev: rev, in: scope)
    }
    if let bounds = field.bounds, bounds.unit.length(of: merged.text) > bounds.max ?? .max { throw Refusal(.tooLarge) }
    if merged.text.utf8.elementsEqual(head.text.utf8) && merged.merged == head.merged { return }
    if let stored = row.texts[field.name], superseded[field.name] == nil { superseded[field.name] = stored }
    row.texts[field.name] = TextState(text: merged.text, rev: nextSeq(of: scope), merged: merged.merged)
  }

  // Each changed row as step 13 would store it, text bases and the serial step 11 has yet to give aside, stays within
  // MAX_RECORD_BYTES.
  func checkRecordBound() throws(Refusal) {
    for place in order {
      guard let record = touched[place], record.changed, let row = record.joined else { continue }
      if stored(row, at: place).json.jcs.count > admission.limits.maxRecordBytes { throw Refusal(.tooLarge) }
    }
  }

  // A scope step 15 has yet to create stands at seq 0.
  func nextSeq(of scope: ScopeKey) -> Int64 { (state.scopes[scope]?.seq ?? 0) + 1 }

  func stored(_ joined: Row, at place: Place) -> Row {
    var row = joined
    row.seq = nextSeq(of: place.scope)
    row.rc = state.rows[place.scope]?[place.key]?.rc ?? serverNow
    row.ru = serverNow
    return row
  }

  // MARK: - Step 10: product rules, then the parent rule, on the joined records

  func changes() -> [RecordChange] {
    order.compactMap { place in
      guard let record = touched[place], let after = record.joined else { return nil }
      return RecordChange(scope: place.scope, key: place.key, before: record.locked, after: after, createdBy: record.createdBy)
    }
  }

  func context() -> RuleContext {
    let joined = touched.filter { $0.key.scope == scope }.compactMap { place, record in record.joined.map { (place.key, $0) } }
    return RuleContext(
      registry: registry, scope: scope, originScope: scope, origin: origin, deltas: intentDeltas, guards: intentGuards,
      serverNow: serverNow, product: state.product, rules: admission.rules, state: state,
      joined: Dictionary(uniqueKeysWithValues: joined), declared: declared.union([scope]),
      scopedJoins: Dictionary(grouping: order, by: \.scope).mapValues { places in
        Dictionary(uniqueKeysWithValues: places.compactMap { place in touched[place]?.joined.map { (place.key, $0) } })
      }, ruleProducts: Set(registry.products.map(\.name)))
  }

  // Every create or update, a command's or an appended one's included, whose parent is not alive among the joined
  // records is `parent-dead`. The reference is read as the join wrote it, before G1 drops a dead record's fields.
  mutating func checkParents() throws(Refusal) {
    for place in order {
      guard let record = touched[place], !record.ops.isDisjoint(with: [.create, .update]),
            let parent = registry.type(place.key.type)?.fields.first(where: \.parent), let target = parent.ref,
            case .string(let id)? = record.joinedFields[parent.name]?.value
      else { continue }
      guard let parentScope = registry.scope(ofType: target, from: place.scope.ref)
        .flatMap({ ScopeKey($0, account: state.scopes[scope]!.owner) }) else { throw Refusal(.parentDead) }
      let parentPlace = Place(scope: parentScope, key: RecordKey(target, RecordID(id)))
      if !(touched[parentPlace]?.joined?.isAlive ?? lock(parentPlace).isAlive) { throw Refusal(.parentDead) }
    }
  }

  // MARK: - Step 11: serials for new alive records, in admission order

  mutating func assignSerials() {
    var numbered: [ScopeKey: [Row]] = [:]
    for place in order {
      guard var record = touched[place], var row = record.joined, row.isAlive,
            record.locked.row == nil, let type = registry.type(place.key.type) else { continue }
      for field in type.fields {
        guard case .serial(let next) = field.kind, row.serials[field.name] == nil else { continue }
        let shared = next.map { row.lattice.fields[$0]?.value }
        let peers = Array((state.rows[place.scope] ?? [:]).values) + (numbered[place.scope] ?? [])
        let highest = peers
          .filter { peer in peer.key.type == place.key.type && peer.key != place.key && peer.isAlive && next.map { peer.lattice.fields[$0]?.value } == shared }
          .compactMap { try? $0.serials[field.name]?.asInteger() }
          .max() ?? 0
        row.serials[field.name] = JSON(highest + 1)
      }
      record.joined = row
      touched[place] = record
      numbered[place.scope, default: []].append(row)
    }
  }

  // MARK: - Step 12: caps by the growth rule, in each scope the intent writes

  func netAliveChange(of type: String, in scope: ScopeKey) -> Int {
    touched.filter { $0.key.scope == scope && $0.key.key.type == type }.reduce(0) { sum, entry in
      sum + (entry.value.joined?.isAlive == true ? 1 : 0) - (entry.value.locked.isAlive ? 1 : 0)
    }
  }

  func checkCaps() throws(Refusal) {
    for written in Set(order.map(\.scope)) {
      for type in registry.types {
        guard let cap = type.cap else { continue }
        let before = state.scopes[written]?.counters[type.name] ?? 0
        let after = before + netAliveChange(of: type.name, in: written)
        if after > cap && after > before {
          throw Refusal(.cap, detail: ["type": .string(type.name), "cap": JSON(cap)])
        }
      }
    }
  }

  // MARK: - Step 13: apply at the next seq, with counters, spent rows, receipt times, digest and revisions

  mutating func apply(_ written: ScopeKey) {
    let changed = order.filter { $0.scope == written && touched[$0]!.changed }
    guard !changed.isEmpty else { return }
    var record = state.scopes[written]!
    let rows = changed.map { stored(touched[$0]!.joined!, at: $0) }
    record.seq = nextSeq(of: written)
    for type in registry.types where type.cap != nil {
      let net = netAliveChange(of: type.name, in: written)
      if net != 0 || record.counters[type.name] != nil { record.counters[type.name] = (record.counters[type.name] ?? 0) + net }
    }
    let superseded = changed.flatMap { place in
      touched[place]!.superseded.map { field, head in
        let metadata = touched[place]!.archives[field] ?? [:]
        return Revision(key: place.key, field: field, rev: head.rev, text: head.text, metadata: metadata)
      }
    }
    if !superseded.isEmpty {
      state.revisions[written] = admission.rules.pruneRevisions((state.revisions[written] ?? []) + superseded, archived: superseded, serverNow: serverNow, scope: written, product: &state.product).sorted()
    }
    commit(rows, into: written, as: record)
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

  // Missing targets require the exact governing record to be created by this admission; an opted command may declare an
  // absent target it leaves alone.
  mutating func createScopes(scopedEffects: Bool) throws(Refusal) {
    var creates: [ScopeKey: String] = [:]
    for place in order {
      guard let record = touched[place], registry.type(place.key.type)?.governsTree == true,
            case .none = record.locked, record.joined?.isAlive == true else { continue }
      let tree = ScopeKey(.tree(place.key.id.description))
      if state.scopes[tree] == nil { creates[tree] = ScopeRecord.governor(scope: place.scope, key: place.key) }
    }
    for target in declared where state.scopes[target] == nil && creates[target] == nil {
      if scopedEffects && !order.contains(where: { $0.scope == target }) { continue }
      throw Refusal(.notFound)
    }
    for (tree, governor) in creates {
      state.scopes[tree] = ScopeRecord(owner: origin.account, born: .governingCreate, governedBy: governor)
    }
    created = Set(creates.keys)
  }

  mutating func applyDeaths() {
    for place in order {
      guard let record = touched[place], record.changed, record.diesHere,
            registry.type(place.key.type)?.governsTree == true else { continue }
      kill(tree: place.key.id.description)
    }
  }

  mutating func kill(tree: String) {
    let governed = state.scopes.keys.filter { $0 == ScopeKey(.tree(tree)) || $0.isOverlay(of: tree) }
    killed.formUnion(governed)
    for key in governed.sorted() {
      guard state.scopes[key]!.die(at: serverNow) else { continue }
      deathEvents.append(.death(key))
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
