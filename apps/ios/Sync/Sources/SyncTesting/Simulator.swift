import SyncAPI
import SyncCore
import SyncEngine
import struct SyncModelServer.ModelServer
import struct SyncModelServer.ProbeServerRules
import struct SyncModelServer.PushFaults
import struct SyncModelServer.ScopeKey
import struct SyncModelServer.ServerCall
import struct SyncModelServer.ServerState
import SyncReplica
import SyncStore
import Synchronization

// §11.3 the replay simulator (design §9.3): phones, each a `SteppedEngine` on a clock of its own, against one
// `ModelServer` over a network that drops, loses, duplicates, delays and reorders, driven by a seeded schedule of what
// people, phones and servers do: gestures of every kind, holds, Undo and retire, leaving the app, process death and
// reboots, sign-in and sign-out under each lineage outcome, revoked sessions, going offline, clock skew and jumps,
// poison, scripted refusals, epoch changes and restores, restored and cloned stores. Then every fault heals, every phone
// signs in and drains, and the checks run. The server's clock is true time; each phone's is its own. A run is a pure
// function of its seed, and every violation names what it saw.
package final class Simulator {
  package struct Report: Sendable {
    package let seed: UInt64
    package let violations: [String]
    package let coverage: [String: Int]
    package let log: [String]
    package let server: JSON
  }

  // A phone as a run starts it: its person's account, signed in or out, its clock's error, and the kill hook on its
  // store, if a test kills it.
  package struct PhoneSpec: Sendable {
    let name: String
    let account: String
    let signedIn: Bool
    let skewMs: Int64
    let killer: Killer?

    package init(_ name: String, account: String, signedIn: Bool, skewMs: Int64 = 0, killer: Killer? = nil) {
      self.name = name
      self.account = account
      self.signedIn = signedIn
      self.skewMs = skewMs
      self.killer = killer
    }
  }

  // What one action is. Most draw what they act on from the seed: which gesture, which Undo, which frame.
  package enum Action: Sendable {
    case gesture
    case commit(ScopeRef, Gesture)
    case idleBody
    case send(SimNetwork.Fate, PushFaults)
    case pull(SimNetwork.Fate)
    case follow, receiveFrame, frameFault
    case release, undo, foreground
    case leave(flushing: Bool)
    case relaunch(reboot: Bool)
    case loseForkGuardCopy
    case corruptDigest
    case signIn(LineageAnswer?)
    case signOut(SignOutChoice?)
    case discardDormant, revokeSession, reauthenticate
    case online(Bool)
    case poison
    case refuse(RefusalCode)
    case backupServer, restoreServer, changeEpoch
    case backupPhone, restorePhone(keepingForkGuardCopy: Bool)
    case clone
    case skew(ms: Int64), jump(ms: Int64)
    case advance(ms: Int64)
    case setVisibility, admitDelayed, dismissNotice, subscribe, unsubscribe
  }

  // One phone of the run, and what the checks hold it to: every entry its commits returned (INV-3) and what each last
  // held, every entry that ended, the notices its person discarded, and a backup of its store.
  final class Phone {
    struct Backup {
      let store: LoadedDevice
      let committed: [String]
      let contents: [String: EntryContent]
      let ended: [EngineEvent]
      let endedUnseen: Set<String>
      let discardedNotices: Set<String>
    }

    let name: String
    let account: String
    let device: SteppedEngine
    var committed: [String] = []
    let contents = ContentLedger()
    var ended: [EngineEvent] = []
    // Entries that ended in a transaction the phone's process died after, whose events died with it.
    var endedUnseen: Set<String> = []
    var discardedNotices: Set<String> = []
    var backup: Backup?
    var opened: [ScopeRef] = []
    // Trees of another account the person opened, which the owner made open to read.
    var foreignTrees: [String] = []
    var seenTags: [String: [RecordID]] = [:]
    // The simulation corrupted a digest this phone keeps, so the mismatch it then finds is expected (INV-15).
    var digestCorrupted = false

    // What every entry the phone holds writes is read after each transaction its store commits, so an entry's content is
    // known as it stood when a later transaction refused it, a joining write map's rewrite of its keys included.
    init(name: String, account: String, device: SteppedEngine) {
      self.name = name
      self.account = account
      self.device = device
      let contents = contents
      device.commits.observe { [weak device] in
        guard let outbox = try? device?.store.read({ try $0.device().replicas.flatMap(\.outbox) }) else { return }
        contents.record(outbox)
      }
    }

    var engine: SyncEngine { device.engine }

    // The active replica's meta and outbox, its rows not read.
    func active() throws -> LoadedReplica {
      try device.store.read { tx in
        guard let replica = try tx.replica(tx.activeReplica()) else { throw StoreError.noDevice }
        return replica
      }
    }

    // Every notice every replica of the phone holds, dismissed ones included.
    func noticeIDs() -> Set<String> {
      Set((try? device.store.read { try $0.device().replicas.flatMap { $0.notices.map(\.id) } }) ?? [])
    }
  }

  static let startMs: Int64 = 1_800_000_000_000
  static let maxPhones = 5

  package let seed: UInt64
  let registry: Registry
  let world: SimClock
  let fleet: Fleet
  let pushes = PushLedger()
  var rng: SeededRandom
  var faults: Bool
  var phones: [Phone] = []
  var log: [String] = []
  var tally: [String: Int] = [:]
  var violations: [String] = []
  var serverBackups: [(state: ServerState, deaths: [String: Stamp])] = []
  // Each record the server has held dead, and the latest life stamp it died at (INV-2).
  var deaths: [String: Stamp] = [:]
  var epochs = 0
  var rowsSeen: ModelServerHandle.RowsVersion

  // The standard run: a phone signed in as A on true time, another of A signed out and up to ten minutes off, one of B
  // up to five minutes off.
  package convenience init(seed: UInt64, registry: Registry, faults: Bool = true) async {
    var rng = SeededRandom(seed: seed)
    let phones = [
      PhoneSpec("a1", account: "A", signedIn: true),
      PhoneSpec("a2", account: "A", signedIn: false, skewMs: Int64(rng.below(1_200_000) - 600_000)),
      PhoneSpec("b1", account: "B", signedIn: true, skewMs: Int64(rng.below(600_000) - 300_000)),
    ]
    await self.init(seed: seed, rng: rng, registry: registry, phones: phones, faults: faults)
  }

  package init(seed: UInt64, rng: SeededRandom? = nil, registry: Registry, phones specs: [PhoneSpec], faults: Bool) async {
    self.seed = seed
    self.registry = registry
    self.faults = faults
    self.rng = rng ?? SeededRandom(seed: seed)
    world = SimClock(wallMs: Self.startMs)
    let server = ModelServerHandle(
      ModelServer(registry: registry, rules: ProbeServerRules(), state: ServerState(epoch: "ep-0", accounts: ["A": "Ann", "B": "Bob"])),
      clock: world)
    fleet = Fleet(registry: registry, network: SimNetwork(server: server), seed: seed)
    rowsSeen = server.rowsVersion
    let (pushes, fleet) = (pushes, fleet)
    fleet.network.watchPushes { [weak fleet] served in pushes.record(served, devices: fleet?.devices ?? []) }
    for spec in specs {
      let clock = SimClock(wallMs: Self.startMs)
      clock.skew(ms: spec.skewMs)
      let phone = Phone(name: spec.name, account: spec.account,
                        device: SteppedEngine(joining: fleet, name: spec.name, clock: clock, account: spec.account, killer: spec.killer))
      phones.append(phone)
      await phone.device.start()
      if spec.signedIn { await signIn(phone, answering: .add) }
    }
    settleAccounts()
  }

  package var server: ModelServerHandle { fleet.network.server }
  var network: SimNetwork { fleet.network }

  // The device of phone `index`, as a test scripting it holds it.
  package func device(_ index: Int) -> SteppedEngine { phones[index].device }

  // The phone's process died after a transaction committed, and what the transaction's caller would have seen died
  // with it. An entry the store holds that the ledger does not was committed by a commit the kill cut short, and joins
  // the ledger. An entry of the ledger the store no longer holds, with no event seen, ended in that transaction, its
  // event lost. A kill test holds the store to an unkilled run's at the same commit, whose own ledger saw that ending.
  package func processDied(on index: Int) {
    let phone = phones[index]
    let held = (try? phone.device.store.read { try $0.device().replicas.flatMap { $0.outbox.map(\.localId) } }) ?? []
    let seen = Set(phone.ended.compactMap { if case .ended(let localId, _, _, _) = $0 { localId } else { nil } })
    phone.endedUnseen.formUnion(phone.committed.filter { !held.contains($0) && !seen.contains($0) })
    phone.committed += held.filter { !phone.committed.contains($0) }
  }

  // MARK: - Running

  // `actions` scheduled actions, then quiescence and the checks.
  package func run(actions: Int) async -> Report {
    for _ in 0..<actions { await step() }
    await quiesce()
    return report()
  }

  package func report() -> Report {
    let violations = check()
    return Report(seed: seed, violations: violations, coverage: coverage(), log: log, server: server.state.json)
  }

  // Time moves up to 4 s, then one phone takes one action the schedule draws; the faults only while faults are on.
  func step() async {
    advance(ms: Int64(rng.below(4_000)))
    let phone = rng.below(phones.count)
    let roll = rng.below(1_000)
    let action: Action? = switch roll {
    case ..<300: .gesture
    case ..<410: .send(faults ? pushFate() : .deliver, faults ? serverFaults() : PushFaults())
    case ..<480: .pull(faults ? pullFate() : .deliver)
    case ..<520: .follow
    case ..<600: .receiveFrame
    case ..<630: .release
    case ..<650: .undo
    case ..<660: .leave(flushing: rng.chance(0.5))
    case ..<670: .foreground
    case ..<680: .idleBody
    case ..<690: .dismissNotice
    case ..<705: rng.chance(0.7) ? .subscribe : .unsubscribe
    case _ where !faults: nil
    case ..<720: .frameFault
    case ..<740: .relaunch(reboot: rng.chance(0.3))
    case ..<752: .signIn(rng.chance(0.2) ? nil : rng.chance(0.8) ? .add : .discard)
    case ..<762: .signOut(rng.chance(0.2) ? nil : rng.chance(0.8) ? .keep : .discard)
    case ..<767: .discardDormant
    case ..<774: .revokeSession
    case ..<780: .reauthenticate
    case ..<795: .online(rng.chance(0.5))
    case ..<802: .poison
    case ..<808: .refuse(rng.pick([RefusalCode.invalid, .stale, .internal]))
    case ..<818: serverBackups.isEmpty || rng.chance(0.5) ? .backupServer : .restoreServer
    case ..<822: .changeEpoch
    case ..<834: phones[phone].backup == nil || rng.chance(0.5) ? .backupPhone : .restorePhone(keepingForkGuardCopy: rng.chance(0.2))
    case ..<838: .clone
    case ..<860: .skew(ms: Int64(rng.below(1_200_000) - 600_000))
    case ..<878: .jump(ms: Int64(rng.below(1_200_000) - 600_000))
    case ..<888: .setVisibility
    case ..<900: .admitDelayed
    default: .advance(ms: Int64(rng.below(60_000)))
    }
    guard let action else { return }
    await perform(action, on: phone)
  }

  // What the wire does to a push: mostly it arrives.
  func pushFate() -> SimNetwork.Fate {
    switch rng.below(100) {
    case ..<72: .deliver
    case ..<78: .drop
    case ..<84: .loseReply
    case ..<88: .duplicate
    case ..<92: .delay
    case ..<94: .answer(status: 400)
    case ..<96: .answer(status: 413)
    default: .answer(status: 503)
    }
  }

  func pullFate() -> SimNetwork.Fate {
    switch rng.below(100) {
    case ..<80: .deliver
    case ..<87: .drop
    case ..<94: .loseReply
    case ..<97: .duplicate
    default: .answer(status: 503)
    }
  }

  // The server's own faults (§6.6): a budget that stops the push with a retry, a transient failure before any intent, a
  // transient failure of the first intent.
  func serverFaults() -> PushFaults {
    switch rng.below(100) {
    case ..<12: PushFaults(budget: 1 + rng.below(2))
    case ..<15: PushFaults(transientAtBind: true)
    default: PushFaults()
    }
  }

  // MARK: - Property 3

  // §11.2 property 3 (INV-6): the first phone makes gestures that each change one record, with no guard, no command and
  // no hold, round after round over a network that works. After each round's results and a pull to the head its outbox
  // is empty, and in every scope it follows, its drawn view is the server's alive rows, record by record, with the
  // server's digest. The violations of every round.
  package func convergeByRounds(_ rounds: Int) async -> [String] {
    let phone = phones[0]
    var found: [String] = []
    for round in 0..<rounds {
      for _ in 0..<(1 + rng.below(5)) {
        advance(ms: 10)
        guard let view = probeView(of: phone) else { continue }
        var rng = rng
        let planned = rng.plainGesture(on: view) { board in tree(of: board, on: phone) }
        self.rng = rng
        if let planned { await commit(planned, on: phone) }
      }
      guard await fleet.settle() else { return found + ["round \(round): no quiescence"] }
      settleAccounts()
      found += violations.map { "round \(round): \($0)" }
      violations = []
      found += drawnDiffers(on: phone).map { "round \(round): \($0)" }
    }
    return found
  }

  // Where the phone's drawn view, its outbox or its digests differ from the server's rows.
  func drawnDiffers(on phone: Phone) -> [String] {
    guard let active = try? phone.device.store.read({ try $0.device(rows: true).activeReplica }), let account = active.meta.account else {
      return ["\(phone.name) cannot be read"]
    }
    var found = active.outbox.isEmpty ? [] : ["\(phone.name) still holds \(active.outbox.map(\.localId))"]
    for scope in [ScopeRef.product("probe")] + phone.opened {
      let truth = server.rows(scope, of: account)
      count("checked scopes")
      tally["checked rows", default: 0] += truth.count
      let drawn = (try? phone.engine.read(scope) { reader in
        try truth.map { row in try reader.drawn(row.key.type, row.key.id).map(Self.view) ?? .null }
      }) ?? []
      if JSON.array(drawn) != JSON.array(truth.map(Self.view)) {
        found.append("INV-6 \(scope): drawn \(JSON.array(drawn).jcsText) but the server holds \(JSON.array(truth.map(Self.view)).jcsText)")
      }
      let types = registry.types.filter { $0.scope == registry.scopeKind(of: scope) }.map(\.name)
      let visible = (try? phone.engine.read(scope) { reader in try types.flatMap { try reader.drawn($0) } }) ?? []
      for record in visible where !truth.contains(where: { $0.key == RecordKey(record.type, record.id) }) {
        found.append("INV-6 \(scope): \(record.type) \(record.id) is drawn but not on the server")
      }
      let digest = ScopeKey(scope, account: account).flatMap { server.state.scopes[$0]?.digest } ?? .zero
      if let cursor = active.cursors[scope], cursor.digest != digest { found.append("\(scope): digest \(cursor.digest) but the server's is \(digest)") }
    }
    return found
  }

  // A record's lattice values, texts and serials, as the drawn view and the server's row both give them.
  static func view(_ row: Row) -> JSON {
    view(RecordKey: row.key, alive: row.isAlive, values: row.lattice.fields.mapValues(\.value), texts: row.texts.mapValues(\.text),
         serials: row.serials)
  }

  static func view(_ record: Record) -> JSON {
    view(RecordKey: RecordKey(record.type, record.id), alive: record.life?.isAlive ?? true, values: record.values,
         texts: record.texts.mapValues(\.text), serials: record.serials)
  }

  static func view(RecordKey key: RecordKey, alive: Bool, values: [String: JSON], texts: [String: String], serials: [String: JSON]) -> JSON {
    [
      "t": .string(key.type), "id": key.id.json, "alive": .bool(alive), "f": .object(JSON.Object(uniqueKeysWithValues: values.map { ($0.key, $0.value) })),
      "x": .object(JSON.Object(uniqueKeysWithValues: texts.map { ($0.key, .string($0.value)) })),
      "v": .object(JSON.Object(uniqueKeysWithValues: serials.map { ($0.key, $0.value) })),
    ]
  }

  // MARK: - Actions

  package func perform(_ action: Action, on index: Int) async {
    let phone = phones[index]
    note("\(phone.name) \(action)")
    switch action {
    case .gesture: await gesture(on: phone)
    case .commit(let scope, let gesture): await commit(PlannedGesture("given", in: scope, gesture), on: phone)
    case .idleBody: idleBody(on: phone)
    case .send(let fate, let faults): await send(on: phone, fate, faults)
    case .pull(let fate): await pull(on: phone, fate)
    case .follow: await follow(on: phone)
    case .receiveFrame: await receiveFrame(on: phone)
    case .frameFault: await frameFault(on: phone)
    case .release:
      phone.device.releaseDue()
    case .undo: undo(on: phone)
    case .leave(let flushing): await leave(phone, flushing: flushing)
    case .foreground:
      phone.engine.foreground()
    case .relaunch(let reboot): await relaunch(phone, rebooting: reboot)
    case .loseForkGuardCopy:
      phone.device.loseForkGuardCopy()
      count("fork guard copy lost")
    case .corruptDigest: corruptDigest(on: phone)
    case .signIn(let answer): await signIn(phone, answering: answer)
    case .signOut(let choice): await signOut(phone, choosing: choice)
    case .discardDormant: discardDormant(on: phone)
    case .revokeSession:
      if let token = phone.device.tokens.token(for: phone.account) {
        server.revoke(token)
        count("session revoked")
      }
    case .reauthenticate: reauthenticate(phone)
    case .online(let online):
      phone.device.connectivity.set(online: online)
      count(online ? "online" : "offline")
    case .poison: poison(on: phone)
    case .refuse(let code):
      server.refuse(code: code)
      count("scripted refusal \(code)")
    case .backupServer:
      serverBackups.append((server.state, deaths))
    case .restoreServer: restoreServer()
    case .changeEpoch:
      epochs += 1
      server.restore(server.state, epoch: "ep-\(epochs)")
      count("epoch change")
    case .backupPhone: backUp(phone)
    case .restorePhone(let kept): await restore(phone, keepingForkGuardCopy: kept)
    case .clone: await clone(phone)
    case .skew(let ms):
      phone.device.clock.skew(ms: ms)
      count("clock skewed")
    case .jump(let ms):
      phone.device.clock.jump(ms: ms)
      count("clock jumped")
    case .advance(let ms): advance(ms: ms)
    case .setVisibility: setVisibility()
    case .admitDelayed:
      guard network.delayedPushes > 0 else { break }
      network.admitDelayed(at: rng.below(network.delayedPushes))
      count("delayed push admitted")
    case .dismissNotice: dismissNotice(on: phone)
    case .subscribe: subscribe(phone)
    case .unsubscribe: unsubscribe(phone)
    }
    settleAccounts()
  }

  // The person makes a gesture on what the phone shows.
  func gesture(on phone: Phone) async {
    guard let view = probeView(of: phone) else { return }
    var rng = rng
    let planned = rng.probeGesture(on: view) { board in tree(of: board, on: phone) }
    self.rng = rng
    guard let planned else { return }
    await commit(planned, on: phone)
  }

  // Each tree and overlay the gesture needs is held open first; a tree known gone takes no gesture. A commit's localIds
  // join the ledger; a whole gesture refused too-large must leave a notice holding it.
  func commit(_ planned: PlannedGesture, on phone: Phone) async {
    let engine = phone.engine
    for scope in planned.opens where !phone.opened.contains(scope) {
      guard (try? engine.subscribe(scope)) == .subscribed else {
        count("gesture into a tree known gone")
        return
      }
      phone.opened.append(scope)
    }
    let notices = phone.noticeIDs()
    do {
      switch try engine.commit(planned.scope, planned.gesture) {
      case .committed(let receipt):
        phone.committed += receipt.localIds
        count("gesture \(planned.label)")
        if !receipt.retired.isEmpty { count("retired") }
        if receipt.releaseAt != nil, rng.chance(0.2), (try? engine.undo(receipt.gestureId)) == true { count("undo at once") }
      case .refused(let code, _):
        count("commit refused \(code)")
        if code == .tooLarge, phone.noticeIDs().subtracting(notices).isEmpty {
          violations.append("INV-3 \(phone.name): \(planned.label) refused too-large at commit with no notice")
        }
      }
    } catch let failure as CommitFailure where failure.kind == .notWritable {
      count("commit not writable")
    } catch {
      guard phone.device.killer?.isDead != true else { return }
      violations.append("\(phone.name): \(planned.label) in \(planned.scope) failed: \(error)")
    }
  }

  // A read-and-commit that decides nothing (ER-2): nothing is written, no clock ticks.
  func idleBody(on phone: Phone) {
    guard (try? phone.engine.commit(.product("probe")) { context in (nil as Gesture?, try context.drawn("card").count) }) != nil else { return }
    count("read-and-commit decided nothing")
  }

  func send(on phone: Phone, _ fate: SimNetwork.Fate, _ faults: PushFaults) async {
    network.arm(fate, for: .push)
    network.arm(faults)
    let step = await phone.engine.sender.step()
    if !network.disarm(), fate != .deliver { count("wire push \(fate)") }
    count("sender \(Self.caseName(step))")
  }

  func pull(on phone: Phone, _ fate: SimNetwork.Fate) async {
    network.arm(fate, for: .pull)
    if rng.chance(0.7) { phone.engine.puller.wants.all() }
    let step = await phone.engine.puller.step()
    if !network.disarm(), fate != .deliver { count("wire pull \(fate)") }
    count("puller \(Self.caseName(step))")
  }

  func follow(on phone: Phone) async {
    if faults, rng.chance(0.1) { network.arm(.drop, for: .live) }
    let step = await phone.engine.live.step()
    network.disarm()
    count("live \(Self.caseName(step))")
  }

  // The socket's next frame reaches the engine, and the puller applies it.
  func receiveFrame(on phone: Phone) async {
    let live = phone.engine.live
    guard let connection = await live.connection as? FakeLiveConnection, connection.canReceive else { return }
    guard await live.receiveNext() else { return }
    count("frame \(Self.caseName(await phone.engine.puller.step()))")
  }

  func frameFault(on phone: Phone) async {
    guard let connection = await phone.engine.live.connection as? FakeLiveConnection, connection.waitingFrames > 0 else { return }
    let index = rng.below(connection.waitingFrames)
    switch rng.below(3) {
    case 0:
      connection.dropFrame(at: index)
      count("frame dropped")
    case 1:
      connection.duplicateFrame(at: index)
      count("frame duplicated")
    default:
      connection.overtake(at: index)
      count("frame overtook")
    }
  }

  // The digest the phone keeps of its product scope goes wrong, as a flipped bit would: the next check at the head finds
  // the mismatch, resets the scope and boots it again (§7.5 step 4).
  func corruptDigest(on phone: Phone) {
    let scope = ScopeRef.product("probe")
    let corrupted = try? phone.device.store.write(.pullPage) { tx in
      guard let replica = try tx.replica(tx.activeReplica()), var cursor = replica.cursors[scope] else { return Planned(false, ReplicaBatch()) }
      cursor.digest = ScopeDigest(row: ["corrupted": true])
      return Planned(true, ReplicaBatch(writes: [.replica(replica.id, .putCursor(scope, cursor))]))
    }
    guard corrupted?.value == true else { return }
    phone.digestCorrupted = true
    count("digest corrupted")
  }

  func undo(on phone: Phone) {
    guard let offers = try? phone.engine.currentUndoOffers(), !offers.isEmpty else { return }
    if (try? phone.engine.undo(rng.pick(offers).id)) == true { count("undo") }
  }

  // Leaving the app: holds released, then, when `flushing`, the leave flush over whatever the wire does.
  func leave(_ phone: Phone, flushing: Bool) async {
    do {
      try phone.engine.leave()
    } catch {
      return
    }
    count("leave")
    guard flushing else { return }
    if faults { network.arm(pushFate(), for: .push) }
    await phone.engine.flushOnLeave()
    network.disarm()
  }

  // The process dies between transactions; another launches over the same store, its trees opened again as the person
  // visits them.
  func relaunch(_ phone: Phone, rebooting reboot: Bool) async {
    if reboot { phone.device.clock.reboot() }
    if faults, rng.chance(0.1) { network.arm(.drop, for: .hello) }
    do {
      try await phone.device.relaunch()
      phone.opened = []
      count(reboot ? "reboot" : "relaunch")
    } catch {
      count("relaunch killed")
    }
    network.disarm()
  }

  // A sign-in as the phone's account with a session of its own: complete at once, or the person answers the signed-out
  // decision, adding or discarding, or leaves it pending (nil).
  func signIn(_ phone: Phone, answering answer: LineageAnswer?) async {
    guard let meta = try? phone.active().meta, meta.state != .bound else { return }
    do {
      let session = try await phone.engine.signIn(account: phone.account, token: server.issueToken(for: phone.account))
      guard !session.isComplete else { return count("sign-in with no decision") }
      guard let answer else {
        session.cancel()
        return count("sign-in left pending")
      }
      let notices = phone.noticeIDs()
      try await session.complete(["probe": answer])
      discard(notices.subtracting(phone.noticeIDs()), on: phone, by: answer == .discard ? nil : "sign-in adding")
      count("sign-in \(answer)")
    } catch {
      count("sign-in failed \(error)")
    }
  }

  // A sign-out: with nothing unsent the person confirms, which is Keep; otherwise they keep, discard, or stay signed in
  // (nil).
  func signOut(_ phone: Phone, choosing choice: SignOutChoice?) async {
    guard let meta = try? phone.active().meta, meta.state == .bound else { return }
    do {
      let session = try await phone.engine.signOut()
      if session.unsent == 0 {
        try await session.finish(.keep)
        return count("sign-out with nothing unsent")
      }
      guard let choice else {
        await session.cancel()
        return count("sign-out cancelled")
      }
      let notices = phone.noticeIDs()
      try await session.finish(choice)
      discard(notices.subtracting(phone.noticeIDs()), on: phone, by: choice == .discard ? nil : "sign-out keeping")
      count("sign-out \(choice)")
    } catch {
      count("sign-out failed \(error)")
    }
  }

  func discardDormant(on phone: Phone) {
    let notices = phone.noticeIDs()
    guard (try? phone.engine.discardDormant(account: phone.account)) == true else { return }
    discard(notices.subtracting(phone.noticeIDs()), on: phone, by: nil)
    count("dormant discarded")
  }

  // Notices gone from the phone: its person discarded them, or, when an action that discards nothing is named, they
  // were lost (D-17: a notice leaves only with its replica).
  func discard(_ gone: Set<String>, on phone: Phone, by keeping: String?) {
    guard let keeping else { return phone.discardedNotices.formUnion(gone) }
    for notice in gone.sorted() { violations.append("INV-3 \(phone.name): \(keeping) lost \(notice)") }
  }

  // A new session for a bound phone, which clears a pause a 401 set (§8.2).
  func reauthenticate(_ phone: Phone) {
    guard let meta = try? phone.active().meta, meta.state == .bound else { return }
    do {
      try phone.engine.reauthenticate(token: server.issueToken(for: phone.account))
      count("reauthenticated")
    } catch {
      count("reauthentication failed")
    }
  }

  // The intent the phone numbers next faults at every admission, until it ends `internal` (§6.6).
  func poison(on phone: Phone) {
    guard let meta = try? phone.active().meta, meta.state == .bound else { return }
    network.poison(replica: meta.replica, n: meta.nextN)
    count("poisoned")
  }

  // A restore from an earlier backup under a new epoch: what died since may live again, so the deaths seen are those the
  // backup had seen.
  func restoreServer() {
    guard !serverBackups.isEmpty else { return }
    let backup = rng.pick(serverBackups)
    epochs += 1
    server.restore(backup.state, epoch: "ep-\(epochs)")
    deaths = backup.deaths
    rowsSeen = server.rowsVersion
    count("server restored")
  }

  func backUp(_ phone: Phone) {
    guard let store = try? phone.device.store.read({ try $0.device(rows: true) }) else { return }
    phone.backup = Phone.Backup(store: store, committed: phone.committed, contents: phone.contents.all, ended: phone.ended,
                                endedUnseen: phone.endedUnseen, discardedNotices: phone.discardedNotices)
  }

  // The phone restored from its backup: what the person did since is gone from it, and from what it is held to.
  func restore(_ phone: Phone, keepingForkGuardCopy kept: Bool) async {
    guard let backup = phone.backup else { return }
    do {
      try await phone.device.restore(backup.store, keepingForkGuardCopy: kept)
    } catch {
      return count("restore killed")
    }
    phone.committed = backup.committed
    phone.contents.replace(with: backup.contents)
    phone.ended = backup.ended
    phone.endedUnseen = backup.endedUnseen
    phone.discardedNotices = backup.discardedNotices
    phone.opened = []
    count(kept ? "store rolled back in place" : "store restored from a backup")
  }

  // Another phone holding a copy of this one's store, and so held to the same ledger.
  func clone(_ phone: Phone) async {
    guard phones.count < Self.maxPhones else { return }
    let name = "\(phone.name)c\(phones.count)"
    guard let copy = try? await phone.device.clone(named: name, on: SimClock(wallMs: phone.device.clock.nowMs())) else { return }
    let clone = Phone(name: name, account: phone.account, device: copy)
    clone.committed = phone.committed
    clone.contents.replace(with: phone.contents.all)
    clone.ended = phone.ended
    clone.endedUnseen = phone.endedUnseen
    clone.discardedNotices = phone.discardedNotices
    phones.append(clone)
    count("store cloned")
  }

  // Time passes for the server and every phone alike.
  func advance(ms: Int64) {
    world.advance(ms: ms)
    for phone in phones { phone.device.clock.advance(ms: ms) }
  }

  // A server-origin write (§6.3): the owner opens or closes a tree.
  func setVisibility() {
    let trees = server.state.scopes.filter { key, scope in
      guard case .tree = key.kind else { return false }
      return scope.state == .alive
    }.sorted { $0.key < $1.key }
    guard !trees.isEmpty else { return }
    let (key, scope) = rng.pick(trees)
    let visibility = rng.pick(["private", "unlisted", "public"])
    let intent: JSON = ["scope": key.ref.json, "d": [["t": "meta", "id": "meta", "f": ["visibility": [.string(visibility), .null]]]]]
    _ = network.call(ServerCall(account: scope.owner, requestId: nil, tool: "visibility", args: ["visibility": .string(visibility)],
                                intents: [intent]))
    count("visibility set")
  }

  func dismissNotice(on phone: Phone) {
    guard let notices = try? phone.engine.currentNotices("probe"), !notices.isEmpty else { return }
    try? phone.engine.dismissNotice(rng.pick(notices).id)
    count("notice dismissed")
  }

  // The person opens a board: its tree, and while signed in its overlay, are followed. A third of the time it is a tree
  // of another account the owner made open to read, whose rows must leave the phone once it is closed to it (INV-7).
  func subscribe(_ phone: Phone) {
    if rng.chance(0.33) { return openForeignTree(on: phone) }
    guard let boards = try? phone.engine.read(.product("probe"), { try $0.drawn("board") }), !boards.isEmpty,
          let board = rng.pick(boards).id.string else { return }
    let bound = (try? phone.active().meta.state) == .bound
    for scope in bound ? [ScopeRef.tree(board), .overlay(board)] : [.tree(board)] where !phone.opened.contains(scope) {
      guard (try? phone.engine.subscribe(scope)) == .subscribed else { return }
      phone.opened.append(scope)
    }
    count("tree opened")
  }

  func openForeignTree(on phone: Phone) {
    let state = server.state
    let open = state.scopes.filter { key, scope in
      guard case .tree = key.kind, scope.state == .alive, !scope.owner.utf8.elementsEqual(phone.account.utf8) else { return false }
      let visibility = state.rows[key]?[RecordKey("meta", "meta")]?.lattice.fields["visibility"]?.value
      return visibility == "unlisted" || visibility == "public"
    }.keys.sorted().compactMap(\.tree)
    guard !open.isEmpty else { return }
    let tree = rng.pick(open)
    guard (try? phone.engine.subscribe(.tree(tree))) == .subscribed else { return }
    if !phone.opened.contains(.tree(tree)) { phone.opened.append(.tree(tree)) }
    if !phone.foreignTrees.contains(tree) { phone.foreignTrees.append(tree) }
    count("foreign tree opened")
  }

  func unsubscribe(_ phone: Phone) {
    guard !phone.opened.isEmpty else { return }
    let scope = phone.opened.remove(at: rng.below(phone.opened.count))
    try? phone.engine.unsubscribe(scope)
    count("scope closed")
  }

  // MARK: - What a person sees

  // The product's views, and the held gestures of its scope that only remove one record, carrying no command: what a
  // retire names.
  func probeView(of phone: Phone) -> ProbeView? {
    let engine = phone.engine
    guard let active = try? phone.active(), let now = try? engine.physNow() else { return nil }
    let heldRemovals = active.outbox.compactMap { entry -> RecordKey? in
      guard entry.state == .held, entry.scope == .product("probe"), entry.intent.command == nil, entry.intent.deltas.count == 1,
            entry.intent.deltas[0].removes else { return nil }
      return entry.intent.deltas[0].key
    }
    return try? engine.read(.product("probe")) { reader in
      ProbeView(
        now: now, bound: active.meta.state == .bound, cards: try reader.drawn("card"), storedCards: try reader.stored("card"),
        runs: try reader.drawn("run"), boards: try reader.drawn("board"), heldRemovals: heldRemovals)
    }
  }

  // A board's tree as the phone shows it; every tag seen is remembered, so one dead later can be revived.
  func tree(of board: RecordID, on phone: Phone) -> ProbeView.Tree {
    guard let id = board.string else { return ProbeView.Tree() }
    let engine = phone.engine
    let tags = (try? engine.read(.tree(id)) { try $0.drawn("tag") }) ?? []
    let seen = (phone.seenTags[id] ?? []) + tags.map(\.id).filter { tag in !(phone.seenTags[id] ?? []).contains(tag) }
    phone.seenTags[id] = seen
    let dead = seen.filter { tag in
      !tags.contains { $0.id == tag } && (try? engine.read(.tree(id)) { try $0.drawn("tag", tag) }).flatMap { $0 }?.life?.isAlive == false
    }
    let marks = (try? engine.read(.overlay(id)) { try $0.drawn("mark") }) ?? []
    return ProbeView.Tree(
      tags: tags, deadTags: dead,
      memos: Dictionary(uniqueKeysWithValues: marks.compactMap { mark in mark.texts["memo"].map { (mark.id, $0.text) } }))
  }

  // MARK: - Quiescence

  // Every fault heals: the wire, the network path, sessions, pending sign-ins; every phone launches anew, which releases
  // its holds, and signs in as its account, adding what it did signed out. Then, round after round, time passes beyond
  // any pause a server asked for, every phone opens the trees of its boards, and every phone sends and pulls, until
  // every outbox of every phone is empty and nothing moves.
  package func quiesce() async {
    faults = false
    network.heal()
    for phone in phones {
      phone.device.connectivity.set(online: true)
      do {
        try await phone.device.relaunch()
      } catch {
        violations.append("\(phone.name) did not launch at quiescence: \(error)")
      }
      phone.opened = []
      await signIn(phone, answering: .add)
      reauthenticate(phone)
      settleAccounts()
    }
    for round in 0..<40 {
      advance(ms: Constants.backoffCeilingMs + 1_000)
      for phone in phones {
        phone.device.releaseDue()
        openTrees(of: phone)
      }
      guard await fleet.settle() else {
        violations.append("round \(round) of quiescence found no rest: a sender or puller never stopped")
        break
      }
      settleAccounts()
      guard phones.allSatisfy(isDrained) else { continue }
      for phone in phones { openTrees(of: phone) }
      guard await fleet.settle() else { continue }
      settleAccounts()
      if phones.allSatisfy(isDrained) { return }
    }
    violations.append("no quiescence within 40 rounds")
  }

  // The person opens every board the phone holds, again if it is open: a tree the phone knows not found is looked for
  // again (§7.9).
  func openTrees(of phone: Phone) {
    guard let boards = try? phone.engine.read(.product("probe"), { try $0.stored("board") }) else { return }
    let own = boards.compactMap(\.id.string).flatMap { [ScopeRef.tree($0), .overlay($0)] }
    for scope in own + phone.foreignTrees.map(ScopeRef.tree) where (try? phone.engine.subscribe(scope)) == .subscribed {
      if !phone.opened.contains(scope) { phone.opened.append(scope) }
    }
  }

  // Every replica of the phone holds no entry.
  func isDrained(_ phone: Phone) -> Bool {
    (try? phone.device.store.read { try $0.device().replicas.allSatisfy(\.outbox.isEmpty) }) ?? false
  }

  // MARK: - Bookkeeping

  // After each action: every event the phones published joins their ledgers, and a change of the server's rows is
  // watched for a resurrection (INV-2).
  func settleAccounts() {
    for phone in phones { phone.ended += phone.device.events.drain() }
    let version = server.rowsVersion
    guard version != rowsSeen else { return }
    rowsSeen = version
    watchDeaths()
  }

  // INV-2: a record the server held dead is alive there again only by a revive or a newer keyed put, which a lattice
  // join lets win only with a life stamp after its death; a minted record that cannot be revived is never alive again.
  func watchDeaths() {
    let state = server.state
    for (scope, spent) in state.spent {
      for (key, row) in spent { deaths["\(scope) \(key)"] = max(deaths["\(scope) \(key)"] ?? row.lifeStamp, row.lifeStamp) }
    }
    for (scope, rows) in state.rows.sorted(by: { $0.key < $1.key }) {
      for row in rows.values.sorted(by: { $0.key < $1.key }) {
        guard let life = row.lattice.life, let type = registry.type(row.key.type) else { continue }
        let key = "\(scope) \(row.key)"
        if !row.isAlive {
          deaths[key] = max(deaths[key] ?? life.stamp, life.stamp)
        } else if let death = deaths[key], type.hasBorn && type.revivable != true || life.stamp <= death {
          violations.append("INV-2 \(key) is alive again at \(life.stamp) after dying at \(death)")
        }
      }
    }
  }

  func note(_ line: String) {
    log.append("\(world.nowMs() - Self.startMs) \(line)")
  }

  func count(_ key: String) {
    tally[key, default: 0] += 1
  }

  static func caseName(_ value: some Any) -> String {
    String(String(describing: value).prefix { $0 != "(" })
  }

  // MARK: - Checks (§11.3)

  package func check() -> [String] {
    var found = violations
    for phone in phones { found += check(phone) }
    found += server.admittedTwice.map { "INV-4 \($0) was admitted twice" }
    found += pushes.refusedSkewTwice.map { "INV-14 \($0) was refused clock-skew twice" }
    found += checkCaps()
    found += checkExistence()
    return found
  }

  // A phone after quiescence: no entry left in any replica; no dormant replica of its account; every entry it committed
  // ended once, a refused one in a notice unless its person discarded it (INV-3); no digest mismatch (INV-15); no rows of
  // a scope its account may not read (INV-7); and each scope it follows holds the server's rows, with the server's
  // digest (INV-6).
  func check(_ phone: Phone) -> [String] {
    var found: [String] = []
    guard let device = try? phone.device.store.read({ try $0.device(rows: true) }) else { return ["\(phone.name): its store cannot be read"] }
    for replica in device.replicas where !replica.outbox.isEmpty {
      let entries = replica.outbox.map { "\($0.localId) \($0.state) in \($0.scope)\($0.resultSeq.map { " at \($0)" } ?? "")" }
      found.append("\(phone.name): a \(replica.meta.state) replica still holds \(entries); it follows \(phone.opened), knows \(replica.known)")
    }
    let active = device.activeReplica
    if active.meta.state != .bound || active.meta.account.map({ !$0.utf8.elementsEqual(phone.account.utf8) }) ?? true {
      found.append("\(phone.name): not signed in as \(phone.account) after quiescence")
    }
    if device.replicas.contains(where: { $0.meta.state == .dormant && $0.meta.account.map { $0.utf8.elementsEqual(phone.account.utf8) } == true }) {
      found.append("\(phone.name): a dormant replica of \(phone.account) outlived its sign-in")
    }
    found += checkLedger(phone, notices: Dictionary(device.replicas.flatMap { $0.notices.map { ($0.id, $0) } }) { first, _ in first })
    guard active.meta.state == .bound, let account = active.meta.account else { return found }
    for scope in active.confirmed.keys.sorted() where active.confirmed[scope]?.all.isEmpty == false {
      guard let key = ScopeKey(scope, account: account), server.state.canRead(key, as: account, registry: registry) else {
        found.append("INV-7 \(phone.name) holds rows of \(scope), which \(account) may not read")
        continue
      }
    }
    for scope in [ScopeRef.product("probe")] + phone.opened where active.known[scope] == nil {
      let mine = active.confirmed[scope]?.all ?? []
      let truth = server.rows(scope, of: account)
      count("checked scopes")
      tally["checked rows", default: 0] += truth.count
      if JSON.array(mine.map(\.json)) != JSON.array(truth.map(\.json)) {
        found.append("INV-6 \(phone.name) \(scope): confirmed \(JSON.array(mine.map(\.json)).jcsText) but the server holds \(JSON.array(truth.map(\.json)).jcsText)")
      }
      let digest = ScopeKey(scope, account: account).flatMap { server.state.scopes[$0]?.digest } ?? .zero
      if let cursor = active.cursors[scope], cursor.digest != digest {
        found.append("digest \(phone.name) \(scope): \(cursor.digest) but the server's is \(digest)")
      }
    }
    return found
  }

  // INV-3: every entry the phone committed ended once, and one refused is in the notice holding it, what it wrote and
  // the command it carried, a joining write map's id followed; unless the person discarded that notice.
  func checkLedger(_ phone: Phone, notices: [String: Notice]) -> [String] {
    var found: [String] = []
    var ends: [String: Int] = [:]
    let joins = pushes.joins
    for event in phone.ended {
      switch event {
      case .ended(let localId, let outcome, let by, let orphanOf):
        ends[localId, default: 0] += 1
        let holder = "notice:\(orphanOf ?? localId)"
        guard outcome == .refused, !phone.discardedNotices.contains(holder) else { continue }
        guard let notice = notices[holder] else {
          found.append("INV-3 \(phone.name): \(localId) refused (\(by.rawValue)) with no notice holding it")
          continue
        }
        guard let content = phone.contents[localId] else { continue }
        let held = Self.parts(of: notice.content)
        let keys = Set(held.flatMap { $0.deltas.map(\.key) })
        let commands = Set(held.compactMap { $0.command?.name })
        for key in content.keys where !keys.contains(key) && !(joins[key].map(keys.contains) ?? false) {
          found.append("INV-3 \(phone.name): \(localId) refused (\(by.rawValue)); its \(key) is in no part of \(holder)")
        }
        if let command = content.command, !commands.contains(command) {
          found.append("INV-3 \(phone.name): \(localId) refused (\(by.rawValue)); its \(command) is in no part of \(holder)")
        }
      case .digestMismatch(let kind, let seq):
        if !phone.digestCorrupted { found.append("INV-15 \(phone.name): a digest mismatch in a \(kind) scope at \(seq)") }
      case .pushMalformed:
        break
      }
    }
    tally["checked entries", default: 0] += phone.committed.count
    found += ends.filter { $0.value > 1 }.keys.sorted().map { "INV-3 \(phone.name): \($0) ended \(ends[$0]!) times" }
    found += phone.committed.filter { ends[$0] == nil && !phone.endedUnseen.contains($0) }.map { "INV-3 \(phone.name): \($0) never ended" }
    return found
  }

  // A notice's content and every dependent folded into it, however deep.
  static func parts(of content: NoticeContent) -> [NoticeContent] {
    [content] + content.dependents.flatMap(parts)
  }

  // INV-8: no scope holds more visible records of a capped type than its cap, and its counter counts them.
  func checkCaps() -> [String] {
    let state = server.state
    var found: [String] = []
    for (key, scope) in state.scopes.sorted(by: { $0.key < $1.key }) {
      for type in registry.types {
        guard let cap = type.cap else { continue }
        let alive = (state.rows[key] ?? [:]).values.filter { $0.key.type.utf8.elementsEqual(type.name.utf8) && $0.isAlive }.count
        if alive > cap { found.append("INV-8 \(key): \(alive) \(type.name) records above the cap of \(cap)") }
        if (scope.counters[type.name] ?? 0) != alive {
          found.append("INV-8 \(key): the \(type.name) counter is \(scope.counters[type.name] ?? 0) but \(alive) are alive")
        }
      }
    }
    return found
  }

  // INV-7: to B, a tree it may not read answers as an absent one does, whether private, dead or never made.
  func checkExistence() -> [String] {
    let state = server.state
    let unreadable = state.scopes.filter { key, scope in
      guard case .tree = key.kind, !scope.owner.utf8.elementsEqual("B".utf8) else { return false }
      let visibility = state.rows[key]?[RecordKey("meta", "meta")]?.lattice.fields["visibility"]?.value
      return scope.state == .dead || !(visibility == "unlisted" || visibility == "public")
    }
    var answers: [(tree: String, page: String)] = []
    for tree in unreadable.keys.sorted().compactMap(\.tree) + ["b_ffffffff"] {
      let page = try? server.pull(PullRequest(scopes: [.init(scope: .tree(tree), cursor: nil)]), asAccount: "B")["pages"]?.asArray().first
      answers.append((tree, (page?.jcsText ?? "none").replacingOccurrences(of: tree, with: "T")))
    }
    guard Set(answers.map(\.page)).count > 1 else { return [] }
    return ["INV-7 existence answers differ: \(answers.map { "\($0.tree) \($0.page)" })"]
  }

  // How often each path ran: the tally of actions, what the server answered every push, and how every entry ended.
  func coverage() -> [String: Int] {
    var coverage = tally.merging(pushes.tally) { $0 + $1 }
    for phone in phones {
      for case .ended(_, let outcome, let by, _) in phone.ended { coverage["ended \(outcome.rawValue) by \(by.rawValue)", default: 0] += 1 }
    }
    return coverage
  }
}

// MARK: - What entries hold

// The records an entry writes and the command it carries, as the notice holding it must hold them (INV-3).
struct EntryContent: Sendable {
  let keys: [RecordKey]
  let command: String?
}

// What each entry of a phone last held, by local id, as its store's transactions commit.
final class ContentLedger: Sendable {
  let contents = Mutex<[String: EntryContent]>([:])

  var all: [String: EntryContent] { contents.withLock { $0 } }

  subscript(localId: String) -> EntryContent? { contents.withLock { $0[localId] } }

  func record(_ outbox: [OutboxEntry]) {
    contents.withLock { contents in
      for entry in outbox {
        contents[entry.localId] = EntryContent(keys: entry.intent.deltas.map(\.key), command: entry.intent.command?.name)
      }
    }
  }

  func replace(with contents: [String: EntryContent]) {
    self.contents.withLock { $0 = contents }
  }
}

// MARK: - The pushes served

// What the server answered each push, as a simulation checks it: the results by code, the HTTP failures, the retries, and
// every entry refused `clock-skew`, by each (replica, n) it was refused under, which INV-14 allows once. An entry is found
// by its `n` in the store of the device whose replica sent it, which holds it `sent` while its push is served.
final class PushLedger: Sendable {
  struct State {
    var tally: [String: Int] = [:]
    var skewed: [String: Set<String>] = [:]
    var joins: [RecordKey: RecordKey] = [:]
  }

  let state = Mutex(State())

  var tally: [String: Int] { state.withLock(\.tally) }

  // Every record a joining write map gave another id (§7.7): the id a client wrote, and the id the server joined it to.
  var joins: [RecordKey: RecordKey] { state.withLock(\.joins) }

  var refusedSkewTwice: [String] {
    state.withLock { $0.skewed.filter { $0.value.count > 1 }.keys.sorted() }
  }

  func record(_ served: SimNetwork.ServedPush, devices: [SteppedEngine]) {
    var counts: [String] = []
    var skewed: [(entry: String, under: String)] = []
    if served.status != 200 {
      counts.append("http \(served.status) \((try? served.body["error"]?.asString()) ?? "")")
    }
    if served.body["retry"] != nil { counts.append("retry") }
    var joins: [(RecordKey, RecordKey)] = []
    for result in (try? served.body["results"]?.asArray()) ?? [] {
      let code = (try? result["code"]?.asString()) ?? ""
      let writes = (try? result["write"]?.asArray()) ?? []
      let joining = writes.contains { $0["from"] != nil }
      for write in writes {
        guard let type = try? write.member("t").asString(), let from = write["from"], let id = write["id"],
              let fromID = try? RecordID(json: from), let joinedID = try? RecordID(json: id) else { continue }
        joins.append((RecordKey(type, fromID), RecordKey(type, joinedID)))
      }
      counts.append(result["s"] == "ok" ? (joining ? "ok with a joining write map" : "ok") : "refused \(code)")
      guard code == "clock-skew", let n = try? result["n"]?.asInteger() else { continue }
      for device in devices {
        let sent = try? device.store.read { try $0.replica(served.request.replica)?.outbox.first { $0.n == n } }
        if let entry = sent { skewed.append(("\(device.name) \(entry.localId)", "\(served.request.replica) \(n)")) }
      }
    }
    state.withLock { state in
      for key in counts { state.tally[key, default: 0] += 1 }
      for (entry, under) in skewed { state.skewed[entry, default: []].insert(under) }
      for (from, joined) in joins { state.joins[from] = joined }
    }
  }
}
