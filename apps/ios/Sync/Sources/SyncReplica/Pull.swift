import SyncAPI
import SyncCore

// §7.5 the puller's local side: a pull answer as its ordered steps, each page one local transaction; boots into
// staging, replace-by-seq, resolution, the digest check, and live frames.

public enum PageOutcome: String, Sendable, Hashable {
  case applied, stale, reset, gone
  case notFound = "not-found"
  // The replica's own product scope answered gone or not-found: the request was not taken as its account, since an
  // account always reads its own products. Nothing is forgotten, and the pull pauses as a 401 does.
  case unauthenticated
}

public enum FrameOutcome: String, Sendable, Hashable {
  case applied, pull, gone, ignored
  case notFound = "not-found"
}

// One local transaction of a pull answer, in the order `PageApplier.steps` gives them.
public enum PullStep: Sendable, Hashable {
  case sample(serverTime: Int64)
  case pauseAuth
  // A null serverEpoch takes it; another one is an epoch change, before any page.
  case epoch(String)
  // `requested`: the cursor the page was asked under.
  case page(Page, requested: String?)
}

public struct PageApplier: Sendable {
  public let registry: Registry
  let lifecycle: ReplicaLifecycle

  public init(registry: Registry) {
    self.registry = registry
    lifecycle = ReplicaLifecycle(registry: registry)
  }

  // One request: the scopes asked for, less those the replica knows gone or not found, at most PULL_MAX_SCOPES of them in
  // the order asked, each with its stored cursor (a scope with none boots); `later` holds the rest, for the next request.
  public func request(_ scopes: [ScopeRef], in replica: LoadedReplica) -> (request: PullRequest, later: [ScopeRef]) {
    let pulled = scopes.filter { replica.known[$0] == nil }
    let request = PullRequest(scopes: pulled.prefix(Constants.pullMaxScopes).map { PullRequest.Pulled(scope: $0, cursor: replica.cursors[$0]?.cursor) })
    return (request, Array(pulled.dropFirst(Constants.pullMaxScopes)))
  }

  // §7.5: a page's scope is pulled again after a stale or reset page, a page with more rows, or a digest check that reset
  // its cursor to boot it.
  public func pullsAgain(after page: Page, _ outcome: PageOutcome, in replica: LoadedReplica) -> Bool {
    switch outcome {
    case .stale, .reset, .unauthenticated: return true
    case .gone, .notFound: return false
    case .applied:
      if case .rows(let rows) = page.body, rows.more { return true }
      return replica.cursors[page.scope]?.cursor == nil
    }
  }

  // A frame's scope is pulled again when the frame was not admitted, or its digest check reset the cursor.
  public func pullsAgain(after frame: LiveFrame, _ outcome: FrameOutcome, in replica: LoadedReplica) -> Bool {
    switch outcome {
    case .pull: return true
    case .gone, .notFound, .ignored: return false
    case .applied:
      guard case .change(let change) = frame else { return false }
      return replica.cursors[change.scope]?.cursor == nil
    }
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

  public func steps(for answer: Answer<PullResponse>, to request: PullRequest) -> [PullStep] {
    switch answer {
    case .ok(let response):
      return [.sample(serverTime: response.serverTime), .epoch(response.epoch)] + response.pages.map { page in
        .page(page, requested: request.scopes.first { $0.scope == page.scope }?.cursor)
      }
    case .failed(let failure):
      let sample = failure.serverTime.map { [PullStep.sample(serverTime: $0)] } ?? []
      return failure.status == 401 ? sample + [.pauseAuth] : sample
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
    for step in steps(for: answer, to: request) {
      let outcome = try apply(step, to: &replica, instance: &instance, timing: timing, identities: identities)
      if case .page(let page, _) = step, let outcome { outcomes.append((page.scope, outcome)) }
    }
    return outcomes
  }

  // MARK: Pages

  // A page asked under a cursor the scope no longer holds is stale, so a cursor never moves backwards.
  public func apply(_ page: Page, requestedUnder requested: String?, to replica: inout LoadedReplica,
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
    case .gone where scope.tree == nil, .notFound where scope.tree == nil:
      return .unauthenticated
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
  // governing record makes its tree and overlay known gone. The target's digest after the row.
  func receive(_ row: Row, into scope: ScopeRef, staged: Bool, digest: ScopeDigest, in replica: inout LoadedReplica) throws -> ScopeDigest {
    let previous = staged ? replica.staging[scope]!.rows.row(row.key) : replica.rows(scope).row(row.key)
    if let previous, row.seq < previous.seq { return digest }
    guard row.isAlive else {
      let type = registry.type(row.key.type)
      if type?.identity == .derived {
        guard let born = row.lattice.born else { throw JSONError.shape("the dead derived row \(row.key) carries no born") }
        replica.apply(.putSpent(scope, SpentID(key: row.key, born: born)))
      }
      if type?.governsTree == true, let tree = row.key.id.string {
        replica.apply(.putKnown(.tree(tree), .gone))
        replica.apply(.putKnown(.overlay(tree), .gone))
      }
      if previous != nil { replica.apply(staged ? .deleteStagedRow(scope, row.key) : .deleteRow(scope, row.key)) }
      return digest.replacing(previous?.json, with: nil)
    }
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

  // §7.5 step 3: a change frame applies as a one-page live pull iff the cursor is live at a whole seq, the epoch
  // matches, the frame is the next seq and carries its rows; otherwise the scope is pulled.
  public func apply(_ frame: LiveFrame, to replica: inout LoadedReplica, instance: Instance) throws -> FrameOutcome {
    switch frame {
    case .gone(let scope) where scope.tree == nil, .notFound(let scope) where scope.tree == nil:
      return .pull
    case .gone(let scope):
      try forget(scope, as: .gone, in: &replica)
      return .gone
    case .notFound(let scope):
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
      _ = try apply(Page(scope: change.scope, body: .rows(page)), requestedUnder: stored, to: &replica, instance: instance)
      return .applied
    }
  }
}
