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

// One local transaction of a push answer, in the order `PushSteps` gives them.
public enum PushStep: Sendable, Hashable {
  // §10.4, before any stamp of the answer is observed.
  case sample(serverTime: Int64)
  case pauseAuth
  case reidentify(epoch: String)
  // A 400 or 413 on several intents: resend the first `limit` entries by n; a 400 also reports itself.
  case halve(limit: Int, malformed: Bool)
  // A 400 or 413 on one intent: rewind to its n, and refuse it `invalid` or `too-large`.
  case refuseLocally(n: Int64, malformed: Bool)
  case results(ResultBatch)
  case epoch(String)

  // A refusal may fold an orphan's dependents into its origin's stored notice, so its Action loads the notices.
  public var readsNotices: Bool {
    switch self {
    case .results(let batch): batch.results.contains { if case .refused = $0.verdict { true } else { false } }
    case .refuseLocally: true
    case .sample, .pauseAuth, .reidentify, .halve, .epoch: false
    }
  }

  // What of the outbox a step reads in a replica holding `meta`: a batch of `ok`s with no write map their own entries; a
  // step of the meta alone, or an epoch that is the replica's already or its first, none; and any other every entry,
  // which a refusal's fold, a write map, a re-identify or an epoch change may rewrite.
  public func entries(of meta: ReplicaMeta) -> EntrySelection {
    switch self {
    case .sample, .pauseAuth, .halve:
      return EntrySelection()
    case .results(let batch):
      guard batch.replica.utf8.elementsEqual(meta.replica.utf8) else { return EntrySelection() }
      if let epoch = meta.serverEpoch, !epoch.utf8.elementsEqual(batch.epoch.utf8) { return .every }
      guard batch.results.allSatisfy({ if case .ok(_, nil) = $0.verdict { true } else { false } }) else { return .every }
      return EntrySelection(numbered: Set(batch.results.map(\.n)))
    case .epoch(let epoch):
      guard let held = meta.serverEpoch, !held.utf8.elementsEqual(epoch.utf8) else { return EntrySelection() }
      return .every
    case .reidentify, .refuseLocally:
      return .every
    }
  }
}

// §7.4 the next results of an answer in ascending n, pinned to the request's replica; an epoch reset drops the remaining batches.
// The last batch, which may hold none, moves ackThrough.
public struct ResultBatch: Sendable, Hashable {
  public let replica: String
  public let results: [PushResult]
  public let lastN: Int64
  public let epoch: String
  public let isLast: Bool

  public init(replica: String, results: [PushResult], lastN: Int64, epoch: String, isLast: Bool) {
    self.replica = replica
    self.results = results
    self.lastN = lastN
    self.epoch = epoch
    self.isLast = isLast
  }
}

// §7.4 a push answer's transactions in order: the sample, then a 401's pause, a 200's epoch recovery or result batches, or a failure's own move.
public struct PushSteps: Sendable {
  enum Part: Sendable {
    case step(PushStep)
    // A 200's results not yet taken, ascending by n.
    case results(ArraySlice<PushResult>, replica: String, lastN: Int64, epoch: String)
  }

  var parts: [Part]

  // The next transaction: a batch takes, in ascending n, as many results as `sizes` gives now, one at least; the last moves ackThrough.
  public mutating func next(sizes: WriterSlices) -> PushStep? {
    guard let part = parts.first else { return nil }
    switch part {
    case .step(let step):
      parts.removeFirst()
      return step
    case .results(let results, let replica, let lastN, let epoch):
      let batch = results.prefix(sizes.size(.results))
      let rest = results.dropFirst(batch.count)
      if rest.isEmpty { parts.removeFirst() } else { parts[0] = .results(rest, replica: replica, lastN: lastN, epoch: epoch) }
      return .results(ResultBatch(replica: replica, results: Array(batch), lastN: lastN, epoch: epoch, isLast: rest.isEmpty))
    }
  }
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
  let commandResultWrites: CommandResultDeviceWrites

  // A product without device rows naming ids keeps every value.
  public static let keepDeviceValue: DeviceValueRewrite = { _, _, value, _, _, _ in value }

  public init(registry: Registry, limits: Limits = Limits(), rewriteDeviceValue: @escaping DeviceValueRewrite = keepDeviceValue,
              commandResultWrites: @escaping CommandResultDeviceWrites = { _, _, _, _ in [] }) {
    self.registry = registry
    self.limits = limits
    lifecycle = ReplicaLifecycle(registry: registry)
    self.rewriteDeviceValue = rewriteDeviceValue
    self.commandResultWrites = commandResultWrites
  }

  // MARK: Numbering

  // Numbers ready entries in commit order up to PUSH_MAX_INTENTS and while the request body stays within
  // PUSH_MAX_BYTES (the first entry of a request always goes), passing over held-back entries, stopping after the first
  // command entry or at a held-back one, and never while a command entry is sent. An entry that no longer fits a request
  // alone grew after commit (a restamp adds digits, a write map lengthens an id): it is refused too-large at
  // `deviceNow` instead, and each later entry is read again, as its fold may have ended or changed it, and what is held
  // back is found again, as an orphan's refusal frees what waited on it. `limit`, after a several-intent 400 or 413,
  // sends at most that many sent entries and numbers none beyond them. The request, or nil when there is nothing to
  // send.
  public func number(_ replica: inout LoadedReplica, limit: Int? = nil, at deviceNow: Int64) throws -> PushRequest? {
    guard replica.meta.state == .bound, !replica.meta.authPaused, let account = replica.meta.account else { return nil }
    let maxIntents = min(limits.pushMaxIntents, limit ?? .max)
    let sent = { (replica: LoadedReplica) in replica.outbox.filter { $0.state == .sent }.sorted { $0.n! < $1.n! } }
    let request = { (replica: LoadedReplica, intents: [Intent]) in
      PushRequest(replica: replica.meta.replica, account: account, ackThrough: replica.meta.ackThrough, intents: intents)
    }
    if !sent(replica).contains(where: { $0.intent.command != nil }) {
      var intents = sent(replica).map(\.intent)
      var back = heldBack(in: replica)
      for candidate in replica.outbox where candidate.state == .ready {
        guard let entry = replica.entry(candidate.localId), entry.state == .ready else { continue }
        if back.contains(entry.commitOrder) {
          if entry.intent.command != nil { break }
          continue
        }
        var intent = entry.intent
        intent.n = replica.meta.nextN
        if request(replica, [intent]).body.count > limits.pushMaxBytes {
          try refuseOutgrown(entry, in: &replica, at: deviceNow)
          back = heldBack(in: replica)
          continue
        }
        let fits = request(replica, intents + [intent]).body.count <= limits.pushMaxBytes
        if intents.count >= maxIntents || (!intents.isEmpty && !fits) { break }
        try replica.move(entry.localId, .number) { entry in
          entry.intent = intent
          entry.digest = intent.digest
        }
        replica.update { $0.nextN += 1 }
        intents.append(intent)
        if intent.command != nil { break }
      }
    }
    let batch = sent(replica).prefix(maxIntents)
    guard !batch.isEmpty else { return nil }
    return request(replica, batch.map(\.intent))
  }

  // §7.4 held back, by commit order: the ready entries that depend (§7.7 step 3) on a held or held-back entry or on an
  // orphan awaiting its result (sent, or returned to ready), or touch, by a delta, a guard or a prediction, a record an
  // earlier held-back entry touches.
  func heldBack(in replica: LoadedReplica) -> Set<Int64> {
    var sources = Dependents(registry: registry)
    var touched: Set<ScopedKey> = []
    var back: Set<Int64> = []
    for entry in replica.outbox {
      if entry.state == .ready {
        let records = (entry.drawnDeltas.map(\.key) + entry.intent.guards.map(\.key)).map { ScopedKey(scope: entry.scope, key: $0) }
        if sources.part(of: entry).any || records.contains(where: touched.contains) {
          back.insert(entry.commitOrder)
          touched.formUnion(records)
        }
      }
      let awaitsResult = entry.orphanOf != nil && (entry.state == .sent || entry.state == .ready)
      if entry.state == .held || back.contains(entry.commitOrder) || awaitsResult {
        sources.absorb(scope: entry.scope, deltas: entry.drawnDeltas, stamp: entry.stamp)
      }
    }
    return back
  }

  // MARK: A push answer, step by step

  // `request`'s answer as its transactions; one handled as a 401 is a 401, an `account-mismatch`, or a 200 or 409 served as another (§9.1).
  public func steps(for answer: Answer<PushResponse>, to request: PushRequest) -> PushSteps {
    let sample = answer.serverTime.map { [PushSteps.Part.step(.sample(serverTime: $0))] } ?? []
    guard !answer.isUnauthenticated(for: request.account) else { return PushSteps(parts: sample + [.step(.pauseAuth)]) }
    switch answer {
    case .ok(let response):
      let results = PushSteps.Part.results(response.results[...], replica: request.replica, lastN: response.lastN, epoch: response.epoch)
      return PushSteps(parts: sample + [results])
    case .failed(let failure):
      switch failure.status {
      case 409:
        guard failure.isRecoveryConflict, let epoch = failure.epoch else { return PushSteps(parts: []) }
        return PushSteps(parts: sample + [.step(.reidentify(epoch: epoch))])
      case 400, 413:
        let malformed = failure.status == 400
        if request.intents.count > 1 {
          return PushSteps(parts: sample + [.step(.halve(limit: (request.intents.count + 1) / 2, malformed: malformed))])
        }
        guard let n = request.intents.first?.n else { return PushSteps(parts: sample) }
        return PushSteps(parts: sample + [.step(.refuseLocally(n: n, malformed: malformed))])
      default: return PushSteps(parts: sample)
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
    case .reidentify(let epoch):
      let id = replica.id
      try lifecycle.checkEpoch(epoch, in: &replica, instance: &instance, identities: identities)
      if replica.id.utf8.elementsEqual(id.utf8) { try lifecycle.reidentify(&replica, instance: &instance, identities: identities) }
    case .halve(_, let malformed):
      if malformed { replica.record(.pushMalformed) }
    case .refuseLocally(let n, let malformed):
      if malformed { replica.record(.pushMalformed) }
      guard let entry = replica.outbox.first(where: { $0.state == .sent && $0.n == n }) else { return }
      replica.update { $0.nextN = n }
      for later in replica.outbox where later.state == .sent && later.n! > n { try replica.move(later.localId, .rewind) }
      try writeCommandRefusal(entry, code: malformed ? .invalid : .tooLarge, in: &replica)
      try refuse(entry.localId, code: malformed ? .invalid : .tooLarge, detail: nil, lastN: n - 1, in: &replica, instance: instance)
    case .results(let batch):
      guard batch.replica.utf8.elementsEqual(replica.id.utf8) else { return }
      if let epoch = replica.meta.serverEpoch, !epoch.utf8.elementsEqual(batch.epoch.utf8) {
        try lifecycle.changeEpoch(to: batch.epoch, in: &replica, instance: &instance, identities: identities)
        return
      }
      // A replica with no epoch takes the answer's with its first result, or with ackThrough (§7.4).
      let records = batch.results.contains { replica.sentEntry(numbered: $0.n) != nil }
      if replica.meta.serverEpoch == nil && (records || batch.isLast) { replica.update { $0.serverEpoch = batch.epoch } }
      for result in batch.results { try apply(result, lastN: batch.lastN, epoch: batch.epoch, to: &replica, instance: instance) }
      if batch.isLast { replica.update { $0.ackThrough = batch.lastN } }
    case .epoch(let epoch):
      try lifecycle.checkEpoch(epoch, in: &replica, instance: &instance, identities: identities)
    }
  }

  // MARK: Results

  // A result applies only to the entry still sent with its n; any other entry moved on since the request. An `ok` whose
  // seq its scope's stored cursor already covers (its own page or frame came first) resolves its own entry, and no other
  // (§7.5 step 2).
  func apply(_ result: PushResult, lastN: Int64, epoch: String, to replica: inout LoadedReplica, instance: Instance) throws {
    guard let entry = replica.sentEntry(numbered: result.n) else { return }
    try writeCommandResult(entry, result: result, epoch: epoch, in: &replica)
    switch result.verdict {
    case .refused(let code):
      try refuse(entry.localId, code: code, detail: result.detail, lastN: lastN, in: &replica, instance: instance)
    case .ok(let seq, let write):
      try replica.move(entry.localId, .ok) { entry in
        entry.resultSeq = seq
        entry.resultEpoch = epoch
      }
      replica.update { $0.admit(entry.intent.deltas.flatMap(\.lattice.stamps)) }
      if let write { try applyWriteMap(write, of: entry.localId, in: &replica, instance: instance) }
      if let acked = replica.entry(entry.localId), replica.covers(acked) { try replica.move(entry.localId, .resolve) }
    }
  }

  func writeCommandResult(_ entry: OutboxEntry, result: PushResult, epoch: String, in replica: inout LoadedReplica) throws {
    if let command = entry.intent.command, let product = registry.product(of: entry.scope) {
      for write in commandResultWrites(command, result, epoch, replica.deviceRows[product] ?? [:]) {
        guard registry.product(product)?.device.contains(where: { $0.keyPattern.matches(write.key) }) == true else {
          throw CommitFailure.malformed("a command result wrote an undeclared device row")
        }
        if let value = write.value { replica.apply(.putDeviceRow(product: product, key: write.key, value)) }
        else { replica.apply(.deleteDeviceRow(product: product, key: write.key)) }
      }
    }
  }

  func writeCommandRefusal(_ entry: OutboxEntry, code: RefusalCode, in replica: inout LoadedReplica) throws {
    guard entry.intent.command != nil else { return }
    let result = try PushResult(json: ["n": JSON(entry.n ?? 0), "s": "refused", "code": code.json])
    try writeCommandResult(entry, result: result, epoch: replica.meta.serverEpoch ?? "", in: &replica)
  }

  // §7.7: an orphan's refusal ends it into its origin's notice; clock-skew and base-unknown recover automatically; any
  // other refusal removes the entry, folds its dependents and writes its notice.
  func refuse(_ localId: String, code: RefusalCode, detail: JSON?, lastN: Int64, in replica: inout LoadedReplica,
              instance: Instance) throws {
    guard let entry = replica.entry(localId) else { return }
    if let origin = entry.orphanOf { return try refuseOrphan(entry, of: origin, by: .refuse, in: &replica) }
    if code == .clockSkew { return try recoverSkew(localId, lastN: lastN, in: &replica, instance: instance) }
    if code == .baseUnknown { return try recoverBase(localId, in: &replica) }
    try remove(entry, by: .refuse, code: code, detail: detail, in: &replica, at: instance.deviceNow)
  }

  // §7.4: a ready entry too large for a request alone ends too-large by §7.7 before it is numbered, as a one-intent 413
  // would end it: an orphan into its origin's notice, any other entry with a notice of its own.
  func refuseOutgrown(_ entry: OutboxEntry, in replica: inout LoadedReplica, at deviceNow: Int64) throws {
    try writeCommandRefusal(entry, code: .tooLarge, in: &replica)
    if let origin = entry.orphanOf { return try refuseOrphan(entry, of: origin, by: .outgrown, in: &replica) }
    try remove(entry, by: .outgrown, code: .tooLarge, detail: nil, in: &replica, at: deviceNow)
  }

  // §7.7 steps 2–4: the entry ends by `event`, its dependents fold, and its notice holds its content and theirs.
  func remove(_ entry: OutboxEntry, by event: IntentEvent, code: RefusalCode, detail: JSON?, in replica: inout LoadedReplica,
              at deviceNow: Int64) throws {
    try replica.move(entry.localId, event)
    var content = entry.content
    content.dependents = try foldDependents(of: entry, into: entry.localId, in: &replica)
    replica.apply(.putNotice(Notice(
      id: "notice:\(entry.localId)", product: product(of: entry.scope), scope: entry.scope, code: code, detail: detail,
      content: content, at: deviceNow)))
  }

  // An orphan's refusal ends it by `event` with no notice of its own; its held-back dependents fold into its origin's
  // notice, its whole content their source. That notice is never deleted while an orphan names it (D-17), and new
  // dependents show it again if it was dismissed.
  func refuseOrphan(_ orphan: OutboxEntry, of origin: String, by event: IntentEvent, in replica: inout LoadedReplica) throws {
    try replica.move(orphan.localId, event)
    let dependents = try foldDependents(of: orphan, into: origin, in: &replica)
    guard !dependents.isEmpty else { return }
    let id = "notice:\(origin)"
    guard let notice = replica.notices.first(where: { $0.id.utf8.elementsEqual(id.utf8) }) else {
      throw TransitionError(description: "\(id), which \(orphan.localId)'s orphanOf names, is gone (D-17 keeps it)")
    }
    var content = notice.content
    content.dependents += dependents
    replica.apply(.putNotice(Notice(
      id: id, product: notice.product, scope: notice.scope, code: notice.code, detail: notice.detail, content: content, at: notice.at,
      isDismissed: false)))
  }

  // An outbox entry's scope belongs to a product: a commit enqueues nowhere else.
  func product(of scope: ScopeRef) -> String {
    guard let product = registry.product(of: scope) else { preconditionFailure("\(scope) belongs to no product") }
    return product
  }

  // §7.7 step 3: the dependents of a refused `source` fold into the notice of `origin`, the refused entry itself or the
  // one whose notice an orphan's content rides. A queued dependent part is removed; a sent entry with any dependent part
  // is an orphan, whole in the notice. An orphan is no source here: its own dependents are held back (§7.4) until its
  // result, and fold only when it is refused.
  func foldDependents(of source: OutboxEntry, into origin: String, in replica: inout LoadedReplica) throws -> [NoticeContent] {
    var dependents = Dependents(registry: registry)
    dependents.absorb(scope: source.scope, deltas: source.drawnDeltas, stamp: source.stamp)
    var folded: [NoticeContent] = []
    for entry in replica.outbox where entry.commitOrder > source.commitOrder {
      let part = dependents.part(of: entry)
      guard part.any else { continue }
      if entry.state == .sent {
        folded.append(entry.content)
        replica.update(entry: entry.localId) { $0.orphanOf = origin }
        continue
      }
      guard entry.isQueued else { continue }
      dependents.absorb(part, of: entry)
      var removed = NoticeContent()
      if part.commandGone { try writeCommandRefusal(entry, code: .parentDead, in: &replica) }
      replica.update(entry: entry.localId) { removed = Dependents.remove(part, from: &$0) }
      folded.append(removed)
      if replica.entry(entry.localId)!.isEmpty {
        replica.update(entry: entry.localId) { $0.orphanOf = origin }
        try replica.move(entry.localId, .fold)
      }
    }
    return folded
  }

  // §7.7 step 1 for clock-skew, after the answer's sample: the clock restarts from the pair maximum of (physNow, 0) and
  // admittedHigh; unprocessed sent entries return to ready; the refused entry and every held and ready entry take one
  // fresh tick each of this instance's clock, in its actor whichever instance wrote the entry, in commit order, which
  // becomes their stamp; and every unsourced stamp, judged before the restamp, takes the lesser of itself and the
  // clock's reading as it restarted (step 1.5).
  func recoverSkew(_ localId: String, lastN: Int64, in replica: inout LoadedReplica, instance: Instance) throws {
    let physNow = replica.meta.physNow(deviceNow: instance.deviceNow)
    replica.update { meta in meta.hlc = HLC.pairMaximum(HLC(ms: physNow), HLC(pairOf: meta.admittedHigh)) }
    for entry in replica.outbox where !entry.localId.utf8.elementsEqual(localId.utf8) && entry.state == .sent && entry.n! > lastN {
      try replica.move(entry.localId, .skewReturn)
    }
    replica.update { $0.nextN = lastN + 1 }
    try replica.move(localId, .recover)
    var clock = replica.meta.hlc
    var high = replica.meta.admittedHigh
    let plan = replica.outbox.filter(\.isQueued).map { (localId: $0.localId, own: Restamp.ownRegisters(of: $0)) }
    let unsourced = Restamp.unsourced(in: replica)
    for (entryId, own) in plan {
      let n = clock.tick(physNow: physNow, actor: instance.actor)
      for register in own { Restamp.move(register, of: entryId, to: n, in: &replica) }
      replica.update(entry: entryId) { $0.stamp = n }
      high = max(high, n)
    }
    let reading = replica.meta.hlc.reading(actor: instance.actor)
    for stamp in unsourced { Restamp.lower(stamp, to: reading, in: &replica) }
    replica.update { meta in
      meta.hlc = HLC(pairOf: high)
      meta.hlcHigh = high
    }
  }

  // §7.7 step 1 for base-unknown: every text delta falls back to the text it was edited from, which the entry keeps
  // under the delta's key from its commit through every rewrite.
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
  // predictions and device rows (a queued delete of the joined id is refused target-merged, its dependents folded); the
  // prediction takes the map's stamps; then queued writes of the mapped registers take fresh ticks of this instance's
  // clock after them.
  func applyWriteMap(_ write: [WriteMapEntry], of commandId: String, in replica: inout LoadedReplica, instance: Instance) throws {
    for w in write {
      if let from = w.from {
        let fromKey = RecordKey(w.key.type, from)
        for queued in replica.outbox where queued.isQueued {
          guard let entry = replica.entry(queued.localId) else { continue }
          if entry.intent.deltas.contains(where: { $0.key == fromKey && $0.removes }) {
            try writeCommandRefusal(entry, code: .targetMerged, in: &replica)
            try remove(entry, by: .targetMerged, code: .targetMerged, detail: nil, in: &replica, at: instance.deviceNow)
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
      let n = clock.tick(physNow: physNow, actor: instance.actor)
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
    for (key, value) in replica.deviceRows[product]?.members ?? [] {
      let rewritten = rewriteDeviceValue(product, key, value, type, from, to)
      if rewritten != value { replica.apply(.putDeviceRow(product: product, key: key, rewritten)) }
    }
  }
}

// MARK: - The restamp rule (§7.7)

// One primitive, `move`: a register an entry wrote takes a new stamp, and borns, carried lives and guards that named
// its old stamp follow it in every later held, ready or sent entry.
package enum Restamp {
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

  // §7.7 step 1.5 a born, or a life a delta carries unchanged, in a held or ready entry.
  package struct Carried: Hashable {
    enum Part: Hashable {
      case born
      case life
    }

    let localId: String
    let delta: Int
    let part: Part

    // The stamp as `replica` holds it; nil once its entry is gone.
    package func stamp(in replica: LoadedReplica) -> Stamp? {
      guard let entry = replica.entry(localId), entry.intent.deltas.indices.contains(delta) else { return nil }
      let lattice = entry.intent.deltas[delta].lattice
      return part == .born ? lattice.born : lattice.life?.stamp
    }
  }

  // §7.7 step 1.5: the borns and carried lives above admittedHigh, in `judged` entries, that no unacked entry sources.
  package static func unsourced(in replica: LoadedReplica, judged: (OutboxEntry) -> Bool = \.isQueued) -> [Carried] {
    let written = Set(replica.outbox.filter { $0.isQueued || $0.state == .sent }.flatMap { entry in
      let own = ownRegisters(of: entry).filter { $0.register == .life }.map { delta($0.part, of: entry) } + entry.predict
      return own.compactMap { delta in delta.lattice.life.map { WrittenLife(key: delta.key, stamp: $0.stamp) } }
    })
    let unsourced = { (key: RecordKey, stamp: Stamp) in
      stamp > replica.meta.admittedHigh && !written.contains(WrittenLife(key: key, stamp: stamp))
    }
    return replica.outbox.filter(judged).flatMap { entry in
      entry.intent.deltas.enumerated().flatMap { index, delta -> [Carried] in
        let creates = delta.lattice.life.map { $0.isAlive && $0.stamp == delta.lattice.born } ?? false
        let born = delta.lattice.born.map { !creates && unsourced(delta.key, $0) } ?? false
        let life = delta.lattice.life.map { $0.stamp < entry.stamp && unsourced(delta.key, $0.stamp) } ?? false
        return [born ? Carried.Part.born : nil, life ? .life : nil].compactMap { $0 }
          .map { Carried(localId: entry.localId, delta: index, part: $0) }
      }
    }
  }

  // The life register of a record, as a delta writes it.
  struct WrittenLife: Hashable {
    let key: RecordKey
    let stamp: Stamp
  }

  // The carried stamp takes the lesser of itself and `reading`.
  static func lower(_ carried: Carried, to reading: Stamp, in replica: inout LoadedReplica) {
    replica.update(entry: carried.localId) { entry in
      var lattice = entry.intent.deltas[carried.delta].lattice
      switch carried.part {
      case .born: lattice.born = lattice.born.map { min($0, reading) }
      case .life: lattice.life = lattice.life.map { Life($0.state, min($0.stamp, reading)) }
      }
      entry.intent.deltas[carried.delta].lattice = lattice
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
