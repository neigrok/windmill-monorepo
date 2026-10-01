import SyncAPI
import SyncCore

// §7.5 the puller's local side: a pull answer or a live frame as ordered transactions, each page's settling slices after it.

public enum PageOutcome: String, Sendable, Hashable {
  case applied, stale, reset, gone
  case notFound = "not-found"
  // An end the client does not apply (`ignoresEnd`): nothing is forgotten or recorded, and the scope is in doubt (§7.9).
  case ignored
  // A scope outside the subscription set: nothing applied, nothing pulled again.
  case outside
}

public enum FrameOutcome: String, Sendable, Hashable {
  case applied, pull, gone, ignored, outside
  case notFound = "not-found"
  // Served as anyone but the replica's account: handled as a 401, nothing applied.
  case paused
}

// One local transaction of a pull answer, in the order `PullSteps` gives them.
public enum PullStep: Sendable, Hashable {
  case sample(serverTime: Int64)
  case pauseAuth
  // A null serverEpoch takes it; another one is an epoch change, before any page.
  case epoch(String)
  // `requested`: the cursor the page was asked under; `chunk`: the rows of the page this transaction applies.
  case page(PullPage, requested: String?, chunk: PageChunk)
}

// §7.5 step 2 the rows of a page one transaction applies, in page order, the last settling `settles`; a whole page is one.
public struct PageChunk: Sendable, Hashable {
  public let rows: Range<Int>
  public let isLast: Bool
  public let settles: Int

  public init(rows: Range<Int>, isLast: Bool, settles: Int = 0) {
    self.rows = rows
    self.isLast = isLast
    self.settles = isLast ? settles : 0
  }

  // The chunk of `page` from row `start`: its next rows, at most `size` of them and one at least; a page without rows is one chunk.
  public init(of page: PullPage, from start: Int, size: Int, settles: Int) {
    guard case .rows(let rows) = page.body else {
      self.init(rows: 0..<0, isLast: true, settles: settles)
      return
    }
    let size = max(1, size)
    let end = rows.rows.count - start > size ? start + size : rows.rows.count
    self.init(rows: start..<end, isLast: end == rows.rows.count, settles: settles)
  }

  public var isFirst: Bool { rows.lowerBound == 0 }

  public static func whole(_ page: PullPage, settles: Int) -> PageChunk {
    PageChunk(of: page, from: 0, size: .max, settles: settles)
  }
}

// §7.5 steps 1–2 a pull answer's transactions in order: the sample, then a 401's pause or a 200's epoch and pages, each chunk cut as taken.
public struct PullSteps: Sendable {
  enum Part: Sendable {
    case step(PullStep)
    // A page whose rows from `row` on are not yet taken.
    case page(PullPage, requested: String?, row: Int)
  }

  var parts: [Part]

  // The next transaction: a chunk takes as many rows as `sizes` gives its scope now, the last settling `settles` covered entries.
  public mutating func next(sizes: WriterSlices, settles: Int) -> PullStep? {
    guard let part = parts.first else { return nil }
    switch part {
    case .step(let step):
      parts.removeFirst()
      return step
    case .page(let page, let requested, let row):
      let chunk = PageChunk(of: page, from: row, size: sizes.size(.chunk(page.scope)), settles: settles)
      if chunk.isLast { parts.removeFirst() } else { parts[0] = .page(page, requested: requested, row: chunk.rows.upperBound) }
      return .page(page, requested: requested, chunk: chunk)
    }
  }

  // A chunk of `scope`'s page failed its check, so nothing more of the page applies (§7.5 step 2).
  public mutating func skipRest(of scope: ScopeRef) {
    guard case .page(let page, _, _)? = parts.first, page.scope == scope else { return }
    parts.removeFirst()
  }
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
    guard let governing = registry.governingRecord(of: scope) else { return false }
    return replica.entries(touching: governing.key, in: governing.scope).contains { entry in
      entry.state != .acked && entry.drawnDeltas.contains { $0.key == governing.key && $0.creates }
    }
  }

  // §7.9: the replica holds a tree or overlay scope's governing record alive, in `drawn` or in `stored` (§7.6): its create
  // acked but not yet confirmed, the record confirmed, or a held delete of it waiting, which leaves it alive in `stored`
  // only. The server holds the scope then, so a not-found for it was written before the create reached the server.
  public func holdsGoverningRecord(_ scope: ScopeRef, in replica: LoadedReplica) throws -> Bool {
    guard let governing = registry.governingRecord(of: scope) else { return false }
    return try [ViewMode.drawn, .stored].contains { mode in
      try ScopeView(replica, governing.scope, mode, registry: registry).record(governing.key)?.lattice.life?.isAlive == true
    }
  }

  // §7.5: what a page's transaction leaves to pull at once. Its own scope after a stale or reset page, after the last
  // chunk of a page short of its head or whose digest check reset the cursor, and after a not-found ignored while the
  // governing create waits; and the tree and overlay scopes an alive governing row of its chunk brought back (§7.9).
  // `outcome` is nil for a chunk before the last; `before` is the replica as the chunk found it.
  public func next(after page: PullPage, chunk: PageChunk, _ outcome: PageOutcome?, from before: LoadedReplica,
                   in replica: LoadedReplica) -> [ScopeRef] {
    switch outcome {
    case .stale?, .reset?: return [page.scope]
    case .gone?, .notFound?, .outside?: return []
    case .ignored?: return awaitsGoverningCreate(page.scope, in: replica) ? [page.scope] : []
    case .applied?, nil:
      guard case .rows(let rows) = page.body else { return [] }
      let again = outcome == .applied && (rows.more || replica.cursors[page.scope]?.cursor == nil)
      return (again ? [page.scope] : []) + rejoins(Array(rows.rows[chunk.rows]), in: before)
    }
  }

  // What a frame leaves to pull: its own scope when it was not admitted, its digest check reset the cursor, or it was a
  // not-found ignored while the governing create waits; and the scopes an alive governing row of an applied change
  // brought back.
  public func next(after frame: LiveFrame, _ outcome: FrameOutcome, from before: LoadedReplica, in replica: LoadedReplica) -> [ScopeRef] {
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
  // replica has already handled as a 401 (§9.1); defence in depth. And a not-found for a tree or overlay scope that waits
  // for its governing record's create, or whose governing record the replica holds alive (§7.9): the answer is stale.
  public func ignoresEnd(of scope: ScopeRef, _ kind: KnownKind, in replica: LoadedReplica) throws -> Bool {
    if case .product = scope.kind { return true }
    guard kind == .notFound else { return false }
    return try awaitsGoverningCreate(scope, in: replica) || holdsGoverningRecord(scope, in: replica)
  }

  // The rows a page's transaction or a frame reads, for its Action to load first: the stored rows of the records it
  // carries, and for a not-found the governing record `ignoresEnd` reads.
  public func reads(of step: PullStep) -> [ScopeRef: RowSelection] {
    guard case .page(let page, _, let chunk) = step else { return [:] }
    switch page.body {
    case .rows(let rows): return [page.scope: RowSelection(keys: Set(rows.rows[chunk.rows].map(\.key)))]
    case .notFound: return governingReads(of: page.scope)
    case .reset, .gone: return [:]
    }
  }

  // What of the outbox a step reads in `meta`'s replica: a last chunk what it settles and one more, an end its scope's, an epoch change all.
  public func entries(of step: PullStep, in meta: ReplicaMeta) -> EntrySelection {
    switch step {
    case .sample, .pauseAuth:
      return EntrySelection()
    case .epoch(let epoch):
      guard let held = meta.serverEpoch, !held.utf8.elementsEqual(epoch.utf8) else { return EntrySelection() }
      return .every
    case .page(let page, _, let chunk):
      switch page.body {
      case .reset: return EntrySelection()
      case .gone, .notFound: return EntrySelection(scopes: [page.scope])
      case .rows(let rows):
        guard chunk.isLast, let cursor = Cursor(decoding: rows.cursor), let cleanSeq = cursor.cleanSeq else { return EntrySelection() }
        return EntrySelection(covered: CoveredEntries(scope: page.scope, epoch: cursor.epoch, cleanSeq: cleanSeq, limit: chunk.settles.onePast))
      }
    }
  }

  // What of the outbox a frame reads (§7.5 step 3): a change what it settles and one more, an end its scope's, never every entry.
  public func entries(of frame: LiveFrame, settling count: Int) -> EntrySelection {
    switch frame {
    case .change(let change):
      return EntrySelection(covered: CoveredEntries(scope: change.scope, epoch: change.epoch, cleanSeq: change.seq, limit: count.onePast))
    case .gone(let scope, _), .notFound(let scope, _):
      return EntrySelection(scopes: [scope])
    case .pong, .other:
      return EntrySelection()
    }
  }

  // What a settling slice of `scope` reads: the first `count` entries its stored cursor covers, and one more.
  public func entries(settling scope: ScopeRef, count: Int, in replica: LoadedReplica) -> EntrySelection {
    guard let cleanSeq = replica.cursors[scope]?.cleanSeq, let epoch = replica.meta.serverEpoch else { return EntrySelection() }
    return EntrySelection(covered: CoveredEntries(scope: scope, epoch: epoch, cleanSeq: cleanSeq, limit: count.onePast))
  }

  public func reads(of frame: LiveFrame) -> [ScopeRef: RowSelection] {
    switch frame {
    case .change(let change): return change.rows.map { [change.scope: RowSelection(keys: Set($0.map(\.key)))] } ?? [:]
    case .notFound(let scope, _): return governingReads(of: scope)
    default: return [:]
    }
  }

  func governingReads(of scope: ScopeRef) -> [ScopeRef: RowSelection] {
    guard let governing = registry.governingRecord(of: scope) else { return [:] }
    return [governing.scope: RowSelection(keys: [governing.key])]
  }

  // The answer to a pull the replica of `account` made, as its transactions (`PullSteps`).
  public func steps(for answer: Answer<PullResponse>, to request: PullRequest, account: String?) -> PullSteps {
    let sample = answer.serverTime.map { [PullSteps.Part.step(.sample(serverTime: $0))] } ?? []
    guard !answer.isUnauthenticated(for: account) else { return PullSteps(parts: sample + [.step(.pauseAuth)]) }
    guard case .ok(let response) = answer else { return PullSteps(parts: sample) }
    return PullSteps(parts: sample + [.step(.epoch(response.epoch))] + response.pages.map { page in
      .page(page, requested: request.scopes.first { $0.scope == page.scope }?.cursor, row: 0)
    })
  }

  // One step, one local transaction, against the subscription set `subscribed`. A page's transaction answers its outcome,
  // nil for a chunk before the last that applied, and whether settling slices must follow it; every other step answers
  // nil.
  @discardableResult
  public func apply(_ step: PullStep, to replica: inout LoadedReplica, subscribed: Set<ScopeRef>, instance: inout Instance,
                    timing: Timing, identities: IdentitySource) throws -> (outcome: PageOutcome?, unsettled: Bool) {
    switch step {
    case .sample(let serverTime):
      replica.update { $0.sample(serverTime: serverTime, send: timing.send, recv: timing.recv) }
    case .pauseAuth:
      replica.update { $0.authPaused = true }
    case .epoch(let epoch):
      try lifecycle.checkEpoch(epoch, in: &replica, instance: &instance, identities: identities)
    case .page(let page, let requested, let chunk):
      return try apply(page, requestedUnder: requested, chunk: chunk, to: &replica, subscribed: subscribed, instance: instance)
    }
    return (nil, false)
  }

  // §7.5 step 2 one settling slice: the first `count` entries the stored cursor covers resolve; how many did, and whether any are left.
  public func settle(_ scope: ScopeRef, count: Int, in replica: inout LoadedReplica) throws -> (resolved: Int, left: Bool) {
    guard replica.cursors[scope]?.cleanSeq != nil else { return (0, false) }
    let covered = replica.covered(in: scope)
    let slice = covered.prefix(count)
    for entry in slice { try replica.move(entry.localId, .resolve) }
    return (slice.count, covered.count > count)
  }

  // MARK: Pages

  // §7.5 step 2, one transaction of a page: a scope outside the subscription set, or a page asked under a cursor the scope
  // no longer holds, applies nothing, so a cursor never moves backwards; each chunk checks both. A rows page applies its
  // chunk; the last chunk does what the page's cursor decides.
  public func apply(_ page: PullPage, requestedUnder requested: String?, chunk: PageChunk, to replica: inout LoadedReplica,
                    subscribed: Set<ScopeRef>, instance: Instance) throws -> (outcome: PageOutcome?, unsettled: Bool) {
    let scope = page.scope
    guard subscribed.contains(scope), replica.known[scope] == nil else { return (.outside, false) }
    var record = replica.cursors[scope] ?? CursorRecord()
    guard requested.map(JSON.string) == record.cursor.map(JSON.string) else { return (.stale, false) }
    switch page.body {
    case .reset:
      record.cursor = nil
      replica.apply(.putCursor(scope, record))
      if replica.staging[scope] != nil { replica.apply(.dropStaging(scope)) }
      return (.reset, false)
    case .gone where try ignoresEnd(of: scope, .gone, in: replica), .notFound where try ignoresEnd(of: scope, .notFound, in: replica):
      return (.ignored, false)
    case .gone:
      try forget(scope, as: .gone, in: &replica)
      return (.gone, false)
    case .notFound:
      try forget(scope, as: .notFound, in: &replica)
      return (.notFound, false)
    case .rows(let rows):
      guard let cursor = Cursor(decoding: rows.cursor) else { throw JSONError.shape("the page cursor \(rows.cursor) does not decode") }
      try applyChunk(Array(rows.rows[chunk.rows]), of: scope, first: chunk.isFirst, requestedUnder: requested, record: &record,
                     to: &replica)
      guard chunk.isLast else {
        replica.apply(.putCursor(scope, record))
        return (nil, false)
      }
      let unsettled = try finish(rows, at: cursor, of: scope, requestedUnder: requested, record: record, settling: chunk.settles,
                                 to: &replica, instance: instance)
      return (.applied, unsettled)
    }
  }

  // A chunk's rows into staging or the confirmed rows, `behind` until the last; a null-cursor page's first chunk restages.
  func applyChunk(_ rows: [Row], of scope: ScopeRef, first: Bool, requestedUnder requested: String?, record: inout CursorRecord,
                  to replica: inout LoadedReplica) throws {
    record.behind = true
    replica.apply(.putCursor(scope, record))
    if first && requested == nil && !replica.rows(scope).isEmpty { replica.apply(.beginStaging(scope)) }
    let booting = requested == nil || requested.flatMap(Cursor.init(decoding:))?.mode == .boot
    let staged = booting && replica.staging[scope] != nil
    var digest = staged ? replica.staging[scope]!.digest : record.digest
    for row in rows { digest = try receive(row, into: scope, staged: staged, digest: digest, in: &replica) }
    if staged { replica.apply(.stagingDigest(scope, digest)) } else { record.digest = digest }
    let stamps = rows.flatMap(\.stamps)
    replica.update { meta in
      meta.observe(stamps)
      meta.admit(stamps)
    }
  }

  // The last chunk: the cursor, `behind`, a boot's end, the first `count` covered entries settled, then the digest check.
  func finish(_ page: RowsPage, at cursor: Cursor, of scope: ScopeRef, requestedUnder requested: String?, record: CursorRecord,
              settling count: Int, to replica: inout LoadedReplica, instance: Instance) throws -> Bool {
    var record = record
    record.cursor = page.cursor
    record.behind = page.more
    let booting = requested == nil || requested.flatMap(Cursor.init(decoding:))?.mode == .boot
    if booting && cursor.mode == .live {
      if let staging = replica.staging[scope] {
        replica.apply(.swapStaging(scope))
        record.digest = staging.digest
      }
      record.booted = true
    }
    replica.apply(.putCursor(scope, record))
    let unsettled = try settle(scope, count: count, in: &replica).left
    if cursor.isLiveAtSeq && cursor.seq == page.seq && replica.staging[scope] == nil {
      let checked = checkDigest(record, of: scope, received: page.digest, seq: page.seq, appVersion: instance.appVersion, in: &replica)
      if checked != record { replica.apply(.putCursor(scope, checked)) }
    }
    return unsettled
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

  // §7.5 step 3: a change frame next in line applies as a one-page live pull, settling `count` covered entries; else a pull.
  public func apply(_ frame: LiveFrame, to replica: inout LoadedReplica, subscribed: Set<ScopeRef>, settling count: Int,
                    instance: Instance) throws -> (outcome: FrameOutcome, unsettled: Bool) {
    guard let scope = frame.scope else { return (.ignored, false) }
    guard frame.isServed(to: replica.meta.account) else {
      replica.update { $0.authPaused = true }
      return (.paused, false)
    }
    guard subscribed.contains(scope), replica.known[scope] == nil else { return (.outside, false) }
    switch frame {
    case .gone(_, _) where try ignoresEnd(of: scope, .gone, in: replica), .notFound(_, _) where try ignoresEnd(of: scope, .notFound, in: replica):
      return (.ignored, false)
    case .gone:
      try forget(scope, as: .gone, in: &replica)
      return (.gone, false)
    case .notFound:
      try forget(scope, as: .notFound, in: &replica)
      return (.notFound, false)
    case .pong, .other:
      return (.ignored, false)
    case .change(let change):
      let record = replica.cursors[scope]
      guard let stored = record?.cursor, let cursor = Cursor(decoding: stored), cursor.isLiveAtSeq, record?.behind == false,
            replica.meta.serverEpoch.map(JSON.string) == .string(change.epoch),
            change.seq == cursor.seq + 1, let rows = change.rows else { return (.pull, false) }
      let page = PullPage(scope: scope, body: .rows(RowsPage(
        rows: rows, cursor: Cursor(epoch: change.epoch, mode: .live, seq: change.seq).text, more: false, seq: change.seq,
        digest: change.digest)))
      let applied = try apply(page, requestedUnder: stored, chunk: .whole(page, settles: count), to: &replica, subscribed: subscribed,
                              instance: instance)
      return (.applied, applied.unsettled)
    }
  }
}

fileprivate extension Int {
  // A limit one past this count, which tells whether more are left; `Int.max` stays itself.
  var onePast: Int { self == .max ? .max : self + 1 }
}
