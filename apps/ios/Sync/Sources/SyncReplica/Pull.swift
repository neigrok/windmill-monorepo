import SyncAPI
import SyncCore

// §7.5 the puller's local side: a pull answer as its ordered steps, each page one local transaction; boots into
// staging, replace-by-seq, resolution, the digest check, and live frames. An answer or frame served as anyone but the
// replica's account is a 401 (§9.1): it pauses sync, and nothing is applied or forgotten. §7.9: which subscribed scopes
// are pulled.

public enum PageOutcome: String, Sendable, Hashable {
  case applied, stale, reset, gone
  case notFound = "not-found"
  // An end the client does not apply (`ignoresEnd`): nothing is forgotten or recorded.
  case ignored
}

public enum FrameOutcome: String, Sendable, Hashable {
  case applied, pull, gone, ignored
  case notFound = "not-found"
  // Served as anyone but the replica's account: handled as a 401, nothing applied.
  case paused
}

// One local transaction of a pull answer, in the order `PageApplier.steps` gives them.
public enum PullStep: Sendable, Hashable {
  case sample(serverTime: Int64)
  case pauseAuth
  // A null serverEpoch takes it; another one is an epoch change, before any page.
  case epoch(String)
  // `requested`: the cursor the page was asked under.
  case page(PullPage, requested: String?)
}

// What the scopes asked for make of the next request: the scopes pulled, at most PULL_MAX_SCOPES in the order asked, each
// with its stored cursor (a scope with none boots), and nil when none is, so nothing is sent (§7.5); `later`, the rest of
// them for the next request; and `waiting`, the scopes that wait for their governing record's create (§7.9).
public struct PullPlan: Sendable, Hashable {
  public let request: PullRequest?
  public let later: [ScopeRef]
  public let waiting: [ScopeRef]
}

public struct PageApplier: Sendable {
  public let registry: Registry
  let lifecycle: ReplicaLifecycle

  public init(registry: Registry) {
    self.registry = registry
    lifecycle = ReplicaLifecycle(registry: registry)
  }

  // The scopes asked for, less those the replica knows gone or not found, and those that wait.
  public func plan(_ scopes: [ScopeRef], in replica: LoadedReplica) -> PullPlan {
    let unknown = scopes.filter { replica.known[$0] == nil }
    let waiting = unknown.filter { awaitsGoverningCreate($0, in: replica) }
    let pulled = unknown.filter { !waiting.contains($0) }
    let asked = pulled.prefix(Constants.pullMaxScopes).map { PullRequest.Pulled(scope: $0, cursor: replica.cursors[$0]?.cursor) }
    return PullPlan(
      request: asked.isEmpty ? nil : PullRequest(scopes: Array(asked)), later: Array(pulled.dropFirst(Constants.pullMaxScopes)),
      waiting: waiting)
  }

  // §7.9: a subscribed scope is pulled, and followed live, unless the replica knows it gone or not found, or it waits
  // for its governing record's create.
  public func pulls(_ scope: ScopeRef, in replica: LoadedReplica) -> Bool {
    replica.known[scope] == nil && !awaitsGoverningCreate(scope, in: replica)
  }

  // §7.9: a tree or overlay scope waits while its governing record's create is still in the outbox, held, ready or sent,
  // by a delta or a prediction, since the server holds no such scope yet. It is pulled once that entry has its result.
  public func awaitsGoverningCreate(_ scope: ScopeRef, in replica: LoadedReplica) -> Bool {
    guard let tree = scope.tree, let governing = registry.governingType else { return false }
    let key = RecordKey(governing.name, RecordID(tree))
    return replica.outbox.contains { entry in
      entry.state != .acked && entry.drawnDeltas.contains { $0.key == key && $0.creates }
    }
  }

  // §7.5: the scopes a page wants pulled next. Its own after a stale or reset page, a page with more rows, a digest check
  // that reset its cursor to boot it, or a not-found ignored while the scope waits, so it is pulled once it waits no
  // more. And, from applied rows, the tree and overlay scopes an alive governing row brought back (§7.9). `before` is
  // the replica as the page found it.
  public func wants(after page: PullPage, _ outcome: PageOutcome, from before: LoadedReplica, in replica: LoadedReplica) -> [ScopeRef] {
    switch outcome {
    case .stale, .reset: return [page.scope]
    case .gone, .notFound: return []
    case .ignored: return awaitsGoverningCreate(page.scope, in: replica) ? [page.scope] : []
    case .applied:
      guard case .rows(let rows) = page.body else { return [] }
      let again = rows.more || replica.cursors[page.scope]?.cursor == nil
      return (again ? [page.scope] : []) + rejoins(rows.rows, in: before)
    }
  }

  // The scopes a frame wants pulled next: its own when it was not admitted, its digest check reset the cursor, or it was a
  // not-found ignored while the scope waits; and those an alive governing row of an applied change brought back.
  public func wants(after frame: LiveFrame, _ outcome: FrameOutcome, from before: LoadedReplica, in replica: LoadedReplica) -> [ScopeRef] {
    switch (outcome, frame) {
    case (.pull, .change(let change)): return [change.scope]
    case (.ignored, .notFound(let scope, _)): return awaitsGoverningCreate(scope, in: replica) ? [scope] : []
    case (.applied, .change(let change)):
      let again = replica.cursors[change.scope]?.cursor == nil
      return (again ? [change.scope] : []) + rejoins(change.rows ?? [], in: before)
    default: return []
    }
  }

  // §7.9: the tree and overlay scopes the replica knows not found whose governing record `rows` holds alive. The answer
  // that recorded each is stale (a restore, then a create re-sent after it), so the rows delete the record, and the
  // scopes rejoin the subscription set.
  public func rejoins(_ rows: [Row], in replica: LoadedReplica) -> [ScopeRef] {
    rows.filter(\.isAlive).flatMap(governed).filter { replica.known[$0] == .notFound }
  }

  // The tree and overlay scopes a row of the governing type governs; none for any other row.
  func governed(by row: Row) -> [ScopeRef] {
    guard registry.type(row.key.type)?.governsTree == true, let tree = row.key.id.string else { return [] }
    return [.tree(tree), .overlay(tree)]
  }

  // §7.5 step 2: the ends a client does not apply, forgetting and recording nothing. Any gone or not-found of a product
  // scope: a product scope never dies, and the server answers one only to a request served as anonymous, which a bound
  // replica has already handled as a 401 (§9.1); defence in depth. And a not-found for a scope that waits for its
  // governing record's create (§7.9), since the server holds no such scope yet.
  public func ignoresEnd(of scope: ScopeRef, _ kind: KnownKind, in replica: LoadedReplica) -> Bool {
    if case .product = scope.kind { return true }
    return kind == .notFound && awaitsGoverningCreate(scope, in: replica)
  }

  // The rows a page or frame reads, for its Action to load first: the stored rows of the records it carries.
  public func reads(of step: PullStep) -> [ScopeRef: RowSelection] {
    guard case .page(let page, _) = step, case .rows(let rows) = page.body else { return [:] }
    return [page.scope: RowSelection(keys: Set(rows.rows.map(\.key)))]
  }

  public func reads(of frame: LiveFrame) -> [ScopeRef: RowSelection] {
    guard case .change(let change) = frame, let rows = change.rows else { return [:] }
    return [change.scope: RowSelection(keys: Set(rows.map(\.key)))]
  }

  // The answer to a pull the replica of `account` made: its offset sample first; then, for an answer handled as a 401
  // (§9.1), the pause and nothing more; for a 200, the epoch and one step per page.
  public func steps(for answer: Answer<PullResponse>, to request: PullRequest, account: String?) -> [PullStep] {
    let sample = answer.serverTime.map { [PullStep.sample(serverTime: $0)] } ?? []
    guard !answer.isUnauthenticated(for: account) else { return sample + [.pauseAuth] }
    guard case .ok(let response) = answer else { return sample }
    return sample + [.epoch(response.epoch)] + response.pages.map { page in
      .page(page, requested: request.scopes.first { $0.scope == page.scope }?.cursor)
    }
  }

  // One step, one local transaction; a page answers its outcome.
  @discardableResult
  public func apply(_ step: PullStep, to replica: inout LoadedReplica, instance: inout Instance, timing: Timing,
                    identities: IdentitySource) throws -> PageOutcome? {
    switch step {
    case .sample(let serverTime):
      replica.update { $0.sample(serverTime: serverTime, send: timing.send, recv: timing.recv) }
    case .pauseAuth:
      replica.update { $0.authPaused = true }
    case .epoch(let epoch):
      try lifecycle.checkEpoch(epoch, in: &replica, instance: &instance, identities: identities)
    case .page(let page, let requested):
      return try apply(page, requestedUnder: requested, to: &replica, instance: instance)
    }
    return nil
  }

  // The whole answer at once: every step in order, and each page's outcome.
  public func receive(_ answer: Answer<PullResponse>, to request: PullRequest, in replica: inout LoadedReplica,
                      instance: inout Instance, timing: Timing, identities: IdentitySource) throws -> [(scope: ScopeRef, outcome: PageOutcome)] {
    var outcomes: [(scope: ScopeRef, outcome: PageOutcome)] = []
    for step in steps(for: answer, to: request, account: replica.meta.account) {
      let outcome = try apply(step, to: &replica, instance: &instance, timing: timing, identities: identities)
      if case .page(let page, _) = step, let outcome { outcomes.append((page.scope, outcome)) }
    }
    return outcomes
  }

  // MARK: Pages

  // A page asked under a cursor the scope no longer holds is stale, so a cursor never moves backwards.
  public func apply(_ page: PullPage, requestedUnder requested: String?, to replica: inout LoadedReplica,
                    instance: Instance) throws -> PageOutcome {
    let scope = page.scope
    var record = replica.cursors[scope] ?? CursorRecord()
    guard requested.map(JSON.string) == record.cursor.map(JSON.string) else { return .stale }
    switch page.body {
    case .reset:
      record.cursor = nil
      replica.apply(.putCursor(scope, record))
      if replica.staging[scope] != nil { replica.apply(.dropStaging(scope)) }
      return .reset
    case .gone where ignoresEnd(of: scope, .gone, in: replica), .notFound where ignoresEnd(of: scope, .notFound, in: replica):
      return .ignored
    case .gone:
      try forget(scope, as: .gone, in: &replica)
      return .gone
    case .notFound:
      try forget(scope, as: .notFound, in: &replica)
      return .notFound
    case .rows(let rows):
      try applyRows(rows, of: scope, requestedUnder: requested, record: record, to: &replica, instance: instance)
      return .applied
    }
  }

  func applyRows(_ page: RowsPage, of scope: ScopeRef, requestedUnder requested: String?, record: CursorRecord,
                 to replica: inout LoadedReplica, instance: Instance) throws {
    guard let cursor = Cursor(decoding: page.cursor) else { throw JSONError.shape("the page cursor \(page.cursor) does not decode") }
    var record = record
    if replica.known[scope] != nil { replica.apply(.deleteKnown(scope)) }
    replica.apply(.putCursor(scope, record))
    let booting = requested == nil || requested.flatMap(Cursor.init(decoding:))?.mode == .boot
    if requested == nil && !replica.rows(scope).isEmpty { replica.apply(.beginStaging(scope)) }

    let staged = booting && replica.staging[scope] != nil
    var digest = staged ? replica.staging[scope]!.digest : record.digest
    for row in page.rows { digest = try receive(row, into: scope, staged: staged, digest: digest, in: &replica) }
    if staged { replica.apply(.stagingDigest(scope, digest)) } else { record.digest = digest }
    record.cursor = page.cursor
    let stamps = page.rows.flatMap(\.stamps)
    replica.update { meta in
      meta.observe(stamps)
      meta.admit(stamps)
    }

    if booting && cursor.mode == .live {
      if let staging = replica.staging[scope] {
        replica.apply(.swapStaging(scope))
        record.digest = staging.digest
      }
      record.booted = true
      try resolveAcked(in: scope, through: cursor.seq, in: &replica)
    }
    if let cleanSeq = cursor.cleanSeq { try resolveAcked(in: scope, through: cleanSeq, in: &replica) }
    if cursor.isLiveAtSeq && cursor.seq == page.seq && replica.staging[scope] == nil {
      record = checkDigest(record, of: scope, received: page.digest, seq: page.seq, appVersion: instance.appVersion, in: &replica)
    }
    replica.apply(.putCursor(scope, record))
  }

  // A row replaces the stored one by seq (§3.4); a dead row deletes it, a dead derived row adds a spent id, and a dead
  // governing record makes its tree and overlay known gone, which §7.1 step 2 refuses. An alive governing record deletes
  // a not-found record of either (`rejoins`). The target's digest after the row.
  func receive(_ row: Row, into scope: ScopeRef, staged: Bool, digest: ScopeDigest, in replica: inout LoadedReplica) throws -> ScopeDigest {
    let previous = staged ? replica.staging[scope]!.rows.row(row.key) : replica.rows(scope).row(row.key)
    if let previous, row.seq < previous.seq { return digest }
    guard row.isAlive else {
      if registry.type(row.key.type)?.identity == .derived {
        guard let born = row.lattice.born else { throw JSONError.shape("the dead derived row \(row.key) carries no born") }
        replica.apply(.putSpent(scope, SpentID(key: row.key, born: born)))
      }
      for governed in governed(by: row) { replica.apply(.putKnown(governed, .gone)) }
      if previous != nil { replica.apply(staged ? .deleteStagedRow(scope, row.key) : .deleteRow(scope, row.key)) }
      return digest.replacing(previous?.json, with: nil)
    }
    for rejoined in rejoins([row], in: replica) { replica.apply(.deleteKnown(rejoined)) }
    replica.apply(staged ? .putStagedRow(scope, row) : .putRow(scope, row))
    return digest.replacing(previous?.json, with: row.json)
  }

  // Acked entries of the scope in the replica's epoch whose result the rows now hold.
  func resolveAcked(in scope: ScopeRef, through cleanSeq: Int64, in replica: inout LoadedReplica) throws {
    for entry in replica.entries(in: scope) where entry.state == .acked
      && entry.resultEpoch.map(JSON.string) == replica.meta.serverEpoch.map(JSON.string)
      && entry.resultSeq! <= cleanSeq {
      try replica.move(entry.localId, .resolve)
    }
  }

  // §7.5 step 4: a match clears mismatchReset; a first mismatch resets the scope; a second stops checks at this app
  // version, until the version changes.
  func checkDigest(_ record: CursorRecord, of scope: ScopeRef, received: ScopeDigest, seq: Int64, appVersion: String,
                   in replica: inout LoadedReplica) -> CursorRecord {
    var record = record
    if let stop = record.digestStop {
      if stop.utf8.elementsEqual(appVersion.utf8) { return record }
      record.digestStop = nil
    }
    if record.digest == received {
      record.mismatchReset = false
      return record
    }
    replica.record(.digestMismatch(kind: kind(of: scope), seq: seq))
    if record.mismatchReset {
      record.digestStop = appVersion
      record.mismatchReset = false
      return record
    }
    record.cursor = nil
    record.mismatchReset = true
    return record
  }

  func kind(of scope: ScopeRef) -> String {
    switch scope.kind {
    case .product: "product"
    case .tree: "tree"
    case .overlay: "overlay"
    case .device: "device"
    }
  }

  // Gone or not found: the scope's rows, spent ids, cursor and staging go, it is known, and its acked entries resolve.
  // Only a tree's scopes are ever known so (§2.5); the replica's own product scope never is.
  func forget(_ scope: ScopeRef, as kind: KnownKind, in replica: inout LoadedReplica) throws {
    replica.apply(.forgetScope(scope))
    replica.apply(.putKnown(scope, kind))
    for entry in replica.entries(in: scope) where entry.state == .acked { try replica.move(entry.localId, .resolve) }
  }

  // MARK: Frames

  // §7.5 step 3: a frame served as anyone but the replica's account pauses sync and applies nothing (§9.1). A change frame
  // applies as a one-page live pull iff the cursor is live at a whole seq, the epoch matches, the frame is the next seq
  // and carries its rows; otherwise the scope is pulled. A gone or not-found frame is applied as that page kind, and the
  // ends a page ignores are ignored alike. A pong, and an op the engine does not know, name no scope and are ignored.
  public func apply(_ frame: LiveFrame, to replica: inout LoadedReplica, instance: Instance) throws -> FrameOutcome {
    guard frame.scope != nil else { return .ignored }
    guard frame.isServed(to: replica.meta.account) else {
      replica.update { $0.authPaused = true }
      return .paused
    }
    switch frame {
    case .gone(let scope, _) where ignoresEnd(of: scope, .gone, in: replica),
      .notFound(let scope, _) where ignoresEnd(of: scope, .notFound, in: replica):
      return .ignored
    case .gone(let scope, _):
      try forget(scope, as: .gone, in: &replica)
      return .gone
    case .notFound(let scope, _):
      try forget(scope, as: .notFound, in: &replica)
      return .notFound
    case .pong, .other:
      return .ignored
    case .change(let change):
      let stored = replica.cursors[change.scope]?.cursor
      guard let cursor = stored.flatMap(Cursor.init(decoding:)), cursor.isLiveAtSeq,
            replica.meta.serverEpoch.map(JSON.string) == .string(change.epoch),
            change.seq == cursor.seq + 1, let rows = change.rows else { return .pull }
      let page = RowsPage(
        rows: rows, cursor: Cursor(epoch: change.epoch, mode: .live, seq: change.seq).text, more: false, seq: change.seq,
        digest: change.digest)
      _ = try apply(PullPage(scope: change.scope, body: .rows(page)), requestedUnder: stored, to: &replica, instance: instance)
      return .applied
    }
  }
}
