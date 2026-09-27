import SyncAPI
import SyncCore

// §7.4 the sender's local side: numbering ready entries into a push, and a push answer as its ordered steps, each one
// local transaction. §7.7 what a result does: acks and write maps, refusals with their fold and notice, and automatic
// recovery with the restamp rule.

// The device clocks' readings around one request, for its offset sample (§10.4).
public struct Timing: Sendable, Hashable {
  public let send: ClockReading
  public let recv: ClockReading

  public init(send: ClockReading, recv: ClockReading) {
    self.send = send
    self.recv = recv
  }

  // Readings of clocks that never jumped: monotonic ms equal to wall ms, one boot.
  public static func steady(send: Int64, recv: Int64) -> Timing {
    Timing(send: ClockReading(wall: send, mono: send, boot: "boot-1"), recv: ClockReading(wall: recv, mono: recv, boot: "boot-1"))
  }
}

// One local transaction of a push answer, in the order `PushPlanner.steps` gives them.
public enum PushStep: Sendable, Hashable {
  // §10.4, before any stamp of the answer is observed.
  case sample(serverTime: Int64)
  case pauseAuth
  case reidentify
  // A 400 or 413 on several intents: resend the first `limit` entries by n; a 400 also reports itself.
  case halve(limit: Int, malformed: Bool)
  // A 400 or 413 on one intent: rewind to its n, and refuse it `invalid` or `too-large`.
  case refuseLocally(n: Int64, malformed: Bool)
  case result(PushResult, lastN: Int64, epoch: String)
  case ack(lastN: Int64)
  case epoch(String)
}

// §7.7 write map step 1's product hook: a device row of `product` at `key`, with the id of `type` a join mapped `from`
// replaced by `to`.
public typealias DeviceValueRewrite = @Sendable (_ product: String, _ key: String, _ value: JSON, _ type: String,
                                                 _ from: RecordID, _ to: RecordID) -> JSON

public struct PushPlanner: Sendable {
  public let registry: Registry
  public let limits: Limits
  let lifecycle: ReplicaLifecycle
  let rewriteDeviceValue: DeviceValueRewrite

  // A product without device rows naming ids keeps every value.
  public static let keepDeviceValue: DeviceValueRewrite = { _, _, value, _, _, _ in value }

  public init(registry: Registry, limits: Limits = Limits(), rewriteDeviceValue: @escaping DeviceValueRewrite = keepDeviceValue) {
    self.registry = registry
    self.limits = limits
    lifecycle = ReplicaLifecycle(registry: registry)
    self.rewriteDeviceValue = rewriteDeviceValue
  }

  // MARK: Numbering

  // Numbers ready entries in commit order up to the batch limits, stopping after the first command entry, and never
  // while a command entry is sent. `limit`, after a several-intent 400 or 413, sends at most that many sent entries and
  // numbers none beyond them. The request, or nil when there is nothing to send.
  public func number(_ replica: inout LoadedReplica, limit: Int? = nil) throws -> PushRequest? {
    guard replica.meta.state == .bound, !replica.meta.authPaused else { return nil }
    let maxIntents = min(limits.pushMaxIntents, limit ?? .max)
    let sent = { (replica: LoadedReplica) in replica.outbox.filter { $0.state == .sent }.sorted { $0.n! < $1.n! } }
    if !sent(replica).contains(where: { $0.intent.command != nil }) {
      var count = sent(replica).count
      var bytes = sent(replica).reduce(0) { $0 + $1.intent.json.jcs.count }
      for entry in replica.outbox where entry.state == .ready {
        var intent = entry.intent
        intent.n = replica.meta.nextN
        let size = intent.json.jcs.count
        if count >= maxIntents || (count > 0 && bytes + size > limits.pushMaxBytes) { break }
        try replica.move(entry.localId, .number) { entry in
          entry.intent = intent
          entry.digest = intent.digest
          entry.numbered = true
        }
        replica.update { $0.nextN += 1 }
        count += 1
        bytes += size
        if intent.command != nil { break }
      }
    }
    let batch = sent(replica).prefix(maxIntents)
    guard !batch.isEmpty else { return nil }
    return PushRequest(replica: replica.meta.replica, ackThrough: replica.meta.ackThrough, intents: batch.map(\.intent))
  }

  // MARK: A push answer, step by step

  // Every answer carrying `serverTime` yields its sample first; then a 200's results, ack and epoch, or a failure's move.
  public func steps(for answer: Answer<PushResponse>, to request: PushRequest) -> [PushStep] {
    switch answer {
    case .ok(let response):
      return [.sample(serverTime: response.serverTime)]
        + response.results.map { .result($0, lastN: response.lastN, epoch: response.epoch) }
        + [.ack(lastN: response.lastN), .epoch(response.epoch)]
    case .failed(let failure):
      let sample = failure.serverTime.map { [PushStep.sample(serverTime: $0)] } ?? []
      switch failure.status {
      case 401: return sample + [.pauseAuth]
      case 409: return sample + [.reidentify]
      case 400, 413:
        let malformed = failure.status == 400
        if request.intents.count > 1 { return sample + [.halve(limit: (request.intents.count + 1) / 2, malformed: malformed)] }
        guard let n = request.intents.first?.n else { return sample }
        return sample + [.refuseLocally(n: n, malformed: malformed)]
      default: return sample
      }
    }
  }

  // One step, one local transaction. A 409 or an epoch change re-identifies, and the instance takes a new actor.
  public func apply(_ step: PushStep, to replica: inout LoadedReplica, instance: inout Instance, timing: Timing,
                    identities: IdentitySource) throws {
    switch step {
    case .sample(let serverTime):
      replica.update { $0.sample(serverTime: serverTime, send: timing.send, recv: timing.recv) }
    case .pauseAuth:
      replica.update { $0.authPaused = true }
    case .reidentify:
      try lifecycle.reidentify(&replica, instance: &instance, identities: identities)
    case .halve(_, let malformed):
      if malformed { replica.record(.pushMalformed) }
    case .refuseLocally(let n, let malformed):
      if malformed { replica.record(.pushMalformed) }
      guard let entry = replica.outbox.first(where: { $0.state == .sent && $0.n == n }) else { return }
      replica.update { $0.nextN = n }
      for later in replica.outbox where later.state == .sent && later.n! > n { try replica.move(later.localId, .rewind) }
      try refuse(entry.localId, code: malformed ? .invalid : .tooLarge, detail: nil, lastN: n - 1, in: &replica, instance: instance)
    case .result(let result, let lastN, let epoch):
      try apply(result, lastN: lastN, epoch: epoch, to: &replica, instance: instance)
    case .ack(let lastN):
      replica.update { $0.ackThrough = lastN }
    case .epoch(let epoch):
      try lifecycle.checkEpoch(epoch, in: &replica, instance: &instance, identities: identities)
    }
  }

  // The whole answer at once: every step in order. The halved batch size when the server asked for one.
  public func receive(_ answer: Answer<PushResponse>, to request: PushRequest, in replica: inout LoadedReplica,
                      instance: inout Instance, timing: Timing, identities: IdentitySource) throws -> Int? {
    var limit: Int?
    for step in steps(for: answer, to: request) {
      if case .halve(let half, _) = step { limit = half }
      try apply(step, to: &replica, instance: &instance, timing: timing, identities: identities)
    }
    return limit
  }

  // MARK: Results

  // A result applies only to the entry still sent with its n; any other entry moved on since the request.
  func apply(_ result: PushResult, lastN: Int64, epoch: String, to replica: inout LoadedReplica, instance: Instance) throws {
    guard let entry = replica.outbox.first(where: { $0.state == .sent && $0.n == result.n }) else { return }
    switch result.verdict {
    case .refused(let code):
      try refuse(entry.localId, code: code, detail: result.detail, lastN: lastN, in: &replica, instance: instance)
    case .ok(let seq, let write):
      guard entry.orphanOf == nil else {
        try replica.move(entry.localId, .orphanOK)
        return
      }
      try replica.move(entry.localId, .ok) { entry in
        entry.resultSeq = seq
        entry.resultEpoch = epoch
      }
      replica.update { $0.admit(entry.intent.deltas.flatMap(\.lattice.stamps)) }
      if let write { try applyWriteMap(write, of: entry.localId, in: &replica, instance: instance) }
    }
  }

  // §7.7: an orphan's refusal only ends it; clock-skew and base-unknown recover automatically; any other refusal
  // removes the entry, folds its dependents and writes its notice.
  func refuse(_ localId: String, code: RefusalCode, detail: JSON?, lastN: Int64, in replica: inout LoadedReplica,
              instance: Instance) throws {
    guard let entry = replica.entry(localId) else { return }
    if entry.orphanOf != nil {
      try replica.move(localId, .refuse)
      return
    }
    if code == .clockSkew { return try recoverSkew(localId, lastN: lastN, in: &replica, instance: instance) }
    if code == .baseUnknown { return try recoverBase(localId, in: &replica) }
    try replica.move(localId, .refuse)
    let dependents = try foldDependents(of: entry, in: &replica)
    var content = entry.content
    content.dependents = dependents
    replica.apply(.putNotice(Notice(
      id: "notice:\(localId)", product: try product(of: entry.scope), scope: entry.scope, code: code, detail: detail,
      content: content, at: instance.deviceNow)))
  }

  func product(of scope: ScopeRef) throws -> String {
    guard let product = registry.product(of: scope) else { throw CommitError("\(scope) belongs to no product") }
    return product
  }

  // §7.7 step 3: a queued dependent's dependent part is removed into the notice; a sent entry wholly dependent is an
  // orphan, in the notice; a partly dependent sent entry stays as it is.
  func foldDependents(of refused: OutboxEntry, in replica: inout LoadedReplica) throws -> [NoticeContent] {
    var dependents = Dependents(registry: registry, scope: refused.scope, deltas: refused.drawnDeltas)
    var folded: [NoticeContent] = []
    for later in replica.outbox where later.commitOrder > refused.commitOrder {
      guard let entry = replica.entry(later.localId) else { continue }
      let part = dependents.part(of: entry)
      guard part.any else { continue }
      if entry.state == .sent {
        guard part.whole else { continue }
        dependents.absorb(scope: entry.scope, deltas: entry.drawnDeltas)
        folded.append(entry.content)
        replica.update(entry: entry.localId) { $0.orphanOf = refused.localId }
        continue
      }
      guard entry.isQueued else { continue }
      dependents.absorb(scope: entry.scope, deltas: part.removed + (part.commandGone ? entry.predict : []))
      var removed = NoticeContent()
      replica.update(entry: entry.localId) { removed = Dependents.remove(part, from: &$0) }
      folded.append(removed)
      if replica.entry(entry.localId)!.isEmpty {
        replica.update(entry: entry.localId) { $0.orphanOf = refused.localId }
        try replica.move(entry.localId, .fold)
      }
    }
    return folded
  }

  // §7.7 step 1 for clock-skew, after the answer's sample: the clock restarts from the pair maximum of (physNow, 0) and
  // admittedHigh; unprocessed sent entries return to ready; the refused entry and every held and ready entry take one
  // fresh tick each, in commit order, which becomes their stamp.
  func recoverSkew(_ localId: String, lastN: Int64, in replica: inout LoadedReplica, instance: Instance) throws {
    let physNow = replica.meta.physNow(deviceNow: instance.deviceNow)
    replica.update { meta in meta.hlc = HLC.pairMaximum(HLC(ms: physNow), HLC(pairOf: meta.admittedHigh)) }
    for entry in replica.outbox where entry.localId != localId && entry.state == .sent && entry.n! > lastN {
      try replica.move(entry.localId, .skewReturn)
    }
    replica.update { $0.nextN = lastN + 1 }
    try replica.move(localId, .recover)
    var clock = replica.meta.hlc
    var high = replica.meta.admittedHigh
    let plan = replica.outbox.filter(\.isQueued).map { (localId: $0.localId, own: Restamp.ownRegisters(of: $0)) }
    for (entryId, own) in plan {
      let n = try Restamp.tick(&clock, physNow: physNow, authoredBy: replica.entry(entryId)!)
      for register in own { Restamp.move(register, of: entryId, to: n, in: &replica) }
      replica.update(entry: entryId) { $0.stamp = n }
      high = max(high, n)
    }
    replica.update { meta in
      meta.hlc = HLC(pairOf: high)
      meta.hlcHigh = high
    }
  }

  // §7.7 step 1 for base-unknown: every text delta falls back to the text it was edited from, which the entry keeps
  // under the delta's key from its commit through every coalesce and rewrite.
  func recoverBase(_ localId: String, in replica: inout LoadedReplica) throws {
    replica.update(entry: localId) { entry in
      for index in entry.intent.deltas.indices {
        let key = entry.intent.deltas[index].key
        for name in entry.intent.deltas[index].texts.keys {
          guard let from = entry.baseTexts[TextRef(key, name)] else { preconditionFailure("\(localId) keeps no base text for \(key) \(name)") }
          entry.intent.deltas[index].texts[name]!.base = .text(from)
        }
      }
    }
    try replica.move(localId, .recover)
  }

  // MARK: The write map

  // §7.7 an ok result's write map, in the result's transaction: ids a join resolved are rewritten into queued entries,
  // predictions and device rows (a queued delete of the joined id ends target-merged); the prediction takes the map's
  // stamps; then queued writes of the mapped registers tick after them.
  func applyWriteMap(_ write: [WriteMapEntry], of commandId: String, in replica: inout LoadedReplica, instance: Instance) throws {
    for w in write {
      if let from = w.from {
        let fromKey = RecordKey(w.key.type, from)
        for queued in replica.outbox where queued.isQueued {
          let entry = replica.entry(queued.localId)!
          if entry.intent.deltas.contains(where: { $0.key == fromKey && $0.removes }) {
            replica.apply(.putNotice(Notice(
              id: "notice:\(entry.localId)", product: try product(of: entry.scope), scope: entry.scope, code: .targetMerged,
              detail: nil, content: entry.content, at: instance.deviceNow)))
            try replica.move(entry.localId, .targetMerged)
            continue
          }
          replica.update(entry: entry.localId) { rewrite(&$0, type: w.key.type, from: from, to: w.key.id) }
        }
        replica.update(entry: commandId) { command in
          for index in command.predict.indices { rewrite(&command.predict[index], type: w.key.type, from: from, to: w.key.id) }
        }
        rewriteDeviceRows(of: commandId, type: w.key.type, from: from, to: w.key.id, in: &replica)
      }
      guard let command = replica.entry(commandId) else { continue }
      for (index, delta) in command.predict.enumerated() where delta.key == w.key {
        for (name, stamp) in w.fields { Restamp.move(.init(part: .predict(index), register: .field(name)), of: commandId, to: stamp, in: &replica) }
        if let born = w.born { Restamp.move(.init(part: .predict(index), register: .life), of: commandId, to: born, in: &replica) }
      }
    }

    let mapped = write.flatMap(\.stamps)
    replica.update { meta in
      meta.observe(mapped)
      meta.admit(mapped)
    }
    let physNow = replica.meta.physNow(deviceNow: instance.deviceNow)
    var clock = replica.meta.hlc
    for queued in replica.outbox where queued.isQueued {
      let entry = replica.entry(queued.localId)!
      let named = Restamp.registers(of: entry, namedBy: write)
      guard !named.isEmpty else { continue }
      let n = try Restamp.tick(&clock, physNow: physNow, authoredBy: entry)
      for register in named { Restamp.move(register, of: entry.localId, to: n, in: &replica) }
      replica.update { $0.hlcHigh = max($0.hlcHigh, n) }
    }
    replica.update { $0.hlc = clock }
  }

  // Replaces the id a join mapped `from` by `to` in an entry's deltas, predictions, guards, base texts and command
  // arguments: as a record's id, a key part, or a ref field's value.
  func rewrite(_ entry: inout OutboxEntry, type: String, from: RecordID, to: RecordID) {
    for index in entry.intent.deltas.indices { rewrite(&entry.intent.deltas[index], type: type, from: from, to: to) }
    for index in entry.predict.indices { rewrite(&entry.predict[index], type: type, from: from, to: to) }
    for index in entry.intent.guards.indices {
      entry.intent.guards[index].key = rekey(entry.intent.guards[index].key, type: type, from: from, to: to)
    }
    entry.baseTexts = Dictionary(entry.baseTexts.map { (TextRef(rekey($0.key.key, type: type, from: from, to: to), $0.key.field), $0.value) }) { own, _ in own }
    if let command = entry.intent.command, case .object(var args) = command.args {
      for reference in Dependents.references(of: command, registry: registry) where reference.key == RecordKey(type, from) {
        args[reference.argument] = to.json
      }
      entry.intent.command = Command(name: command.name, args: .object(args))
    }
  }

  func rewrite(_ delta: inout Delta, type: String, from: RecordID, to: RecordID) {
    delta.key = rekey(delta.key, type: type, from: from, to: to)
    guard let def = registry.type(delta.key.type) else { return }
    for (name, register) in delta.lattice.fields where def.field(name)?.ref == type && register.value == from.json {
      delta.lattice.fields[name] = Register(to.json, register.stamp)
    }
  }

  // A record's key with the joined id replaced: the record itself, a key naming it, or a tuple key's part.
  func rekey(_ key: RecordKey, type: String, from: RecordID, to: RecordID) -> RecordKey {
    if key == RecordKey(type, from) { return RecordKey(type, to) }
    switch registry.type(key.type)?.key {
    case .ref(let target)? where target == type && key.id == from:
      return RecordKey(key.type, to)
    case .tuple(let parts)?:
      guard let ids = key.id.parts, let joined = to.string else { return key }
      return RecordKey(key.type, RecordID(tuple: zip(parts, ids).map { part, id in part.ref == type && RecordID(id) == from ? joined : id }))
    default:
      return key
    }
  }

  func rewriteDeviceRows(of commandId: String, type: String, from: RecordID, to: RecordID, in replica: inout LoadedReplica) {
    guard let scope = replica.entry(commandId)?.scope, let product = registry.product(of: scope) else { return }
    for (key, value) in replica.deviceRows[product] ?? [:] {
      let rewritten = rewriteDeviceValue(product, key, value, type, from, to)
      if rewritten != value { replica.apply(.putDeviceRow(product: product, key: key, rewritten)) }
    }
  }
}

// MARK: - The restamp rule (§7.7)

// One primitive, `move`: a register an entry wrote takes a new stamp, and borns, carried lives and guards that named
// its old stamp follow it in every later held, ready or sent entry.
enum Restamp {
  struct Register: Hashable {
    enum Part: Hashable {
      case intent(Int)
      case predict(Int)
    }

    enum Name: Hashable {
      case life
      case field(String)
    }

    let part: Part
    let register: Name
  }

  // The registers an entry's intent itself writes: those stamped at or after its gesture stamp. A life a keyed put
  // carries unchanged from drawn is older, and only follows its source.
  static func ownRegisters(of entry: OutboxEntry) -> [Register] {
    entry.intent.deltas.enumerated().flatMap { index, delta -> [Register] in
      let life = delta.lattice.life.flatMap { $0.stamp >= entry.stamp ? Register(part: .intent(index), register: .life) : nil }
      let fields = delta.lattice.fields.sorted { $0.key.utf8.lexicographicallyPrecedes($1.key.utf8) }
        .filter { $0.value.stamp >= entry.stamp }.map { Register(part: .intent(index), register: .field($0.key)) }
      return [life].compactMap { $0 } + fields
    }
  }

  // The registers of an entry's deltas and predictions that a write map names: a field in `f`, or the life of a record
  // with `born`.
  static func registers(of entry: OutboxEntry, namedBy write: [WriteMapEntry]) -> [Register] {
    let parts = entry.intent.deltas.indices.map { Register.Part.intent($0) } + entry.predict.indices.map { Register.Part.predict($0) }
    return parts.flatMap { part -> [Register] in
      let delta = delta(part, of: entry)
      return write.filter { $0.key == delta.key }.flatMap { w -> [Register] in
        let fields = w.fields.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.filter { delta.lattice.fields[$0] != nil }
          .map { Register(part: part, register: .field($0)) }
        let life = w.born != nil && delta.lattice.life != nil ? [Register(part: part, register: .life)] : []
        return fields + life
      }
    }
  }

  static func delta(_ part: Register.Part, of entry: OutboxEntry) -> Delta {
    switch part {
    case .intent(let index): entry.intent.deltas[index]
    case .predict(let index): entry.predict[index]
    }
  }

  // A fresh tick from the shared clock, in the actor of the instance that authored the entry.
  static func tick(_ clock: inout HLC, physNow: Int64, authoredBy entry: OutboxEntry) throws -> Stamp {
    clock.tick(physNow: physNow, actor: try Stamp.Actor(entry.stamp.actor))
  }

  static func move(_ register: Register, of localId: String, to n: Stamp, in replica: inout LoadedReplica) {
    guard let entry = replica.entry(localId) else { return }
    var delta = delta(register.part, of: entry)
    let o: Stamp
    var createsRecord = false
    switch register.register {
    case .life:
      guard let life = delta.lattice.life, life.stamp != n else { return }
      o = life.stamp
      createsRecord = life.isAlive && delta.lattice.born == o
      delta.lattice.life = Life(life.state, n)
      if createsRecord { delta.lattice.born = n }
    case .field(let name):
      guard let current = delta.lattice.fields[name], current.stamp != n else { return }
      o = current.stamp
      delta.lattice.fields[name] = SyncCore.Register(current.value, n)
    }
    replica.update(entry: localId) { entry in
      switch register.part {
      case .intent(let index): entry.intent.deltas[index] = delta
      case .predict(let index): entry.predict[index] = delta
      }
    }
    let later = replica.outbox.filter { $0.commitOrder > entry.commitOrder && ($0.isQueued || $0.state == .sent) }
    for other in later {
      replica.update(entry: other.localId) { other in
        switch register.register {
        case .life:
          follow(&other.intent.deltas, key: delta.key, from: o, to: n, born: createsRecord)
          follow(&other.predict, key: delta.key, from: o, to: n, born: createsRecord)
        case .field(let name):
          for index in other.intent.guards.indices {
            let named = other.intent.guards[index]
            if named.key == delta.key && named.field.utf8.elementsEqual(name.utf8) && named.stamp == o {
              other.intent.guards[index].stamp = n
            }
          }
        }
      }
    }
  }

  // A later delta on the same record whose born is the moved create's, or that carries the moved life, follows it.
  static func follow(_ deltas: inout [Delta], key: RecordKey, from o: Stamp, to n: Stamp, born: Bool) {
    for index in deltas.indices where deltas[index].key == key {
      if born && deltas[index].lattice.born == o { deltas[index].lattice.born = n }
      if let life = deltas[index].lattice.life, life.stamp == o { deltas[index].lattice.life = Life(life.state, n) }
    }
  }
}
