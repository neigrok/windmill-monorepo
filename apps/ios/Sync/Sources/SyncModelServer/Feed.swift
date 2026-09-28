import SyncCore

// §6.7 pull pages and §6.8 live frames, read from one snapshot of the tables: every page carries the scope's seq and
// the digest committed with it (§6.12), and every frame the digest of its seq.

// A committed change of one scope, or its death, as the live channel publishes it at step 17.
public enum LiveEvent: Sendable, Hashable {
  case change(ScopeKey, frame: JSON)
  case death(ScopeKey)

  // `{op: change, scope, epoch, seq, digest, rows?}`; rows travel as a page carries them, left out past the inline bound.
  static func change(_ key: ScopeKey, epoch: String, seq: Int64, digest: ScopeDigest, rows: [Row], inlineLimit: Int) -> LiveEvent {
    let pageRows = JSON.array(rows.sorted { $0.key < $1.key }.map(\.pageForm.json))
    var frame: JSON.Object = [
      "op": "change", "scope": key.ref.json, "epoch": .string(epoch), "seq": JSON(seq), "digest": .string(digest.hex),
    ]
    if pageRows.jcs.count <= inlineLimit { frame["rows"] = pageRows }
    return .change(key, frame: .object(frame))
  }

  public var key: ScopeKey {
    switch self {
    case .change(let key, _), .death(let key): key
    }
  }

  // `{key, frame}` or `{key, dead: true}`.
  public var json: JSON {
    switch self {
    case .change(let key, let frame): ["key": .string(key.text), "frame": frame]
    case .death(let key): ["key": .string(key.text), "dead": true]
    }
  }
}

extension Row {
  var pageForm: Row { isAlive ? self : thin }
}

struct Feed {
  let registry: Registry
  let limits: ServerLimits

  // One requested scope's page (§6.7 steps 1–6); `requested` is the reference as the request spelled it.
  func page(_ requested: String, cursor: String?, account: String?, in state: ServerState) -> JSON {
    let answer = { (kind: String) -> JSON in ["scope": .string(requested), "kind": .string(kind)] }
    guard let ref = try? ScopeRef(requested), registry.scopeKind(of: ref) != nil, let key = ScopeKey(ref, account: account) else {
      return answer("not-found")
    }
    let access = state.access(key, as: account, registry: registry)
    switch access {
    case .notFound: return answer("not-found")
    case .gone: return answer("gone")
    case .absent, .readable, .writable: break
    }
    let record = state.scopes[key]
    let seq = record?.seq ?? 0
    let rows = access == .absent ? [] : state.feedRows(of: key).sorted { ($0.seq, $0.key) < ($1.seq, $1.key) }
    var page: JSON.Object = ["scope": .string(requested), "kind": "rows", "seq": JSON(seq), "digest": .string((record?.digest ?? .zero).hex)]
    if case .tree = key.kind, let owner = record?.owner {
      page["header"] = ["owner": ["name": .string(state.accounts[AccountKey(owner)] ?? "")]]
    }
    // Step 2; an absent scope answers, past the same cursor checks, an empty live page at seq 0.
    let body: Page
    switch cursor.map(Cursor.init(decoding:)) {
    case .some(nil):
      return answer("reset")
    case .some(let cursor?) where !cursor.epoch.isSameID(as: state.epoch) || cursor.seq > seq:
      return answer("reset")
    case .some(let cursor?) where cursor.mode == .boot && access != .absent:
      body = boot(rows, asOf: cursor.asOf ?? seq, after: cursor, epoch: state.epoch)
    case .some(let cursor?):
      body = live(rows, afterSeq: cursor.seq, key: cursor.key, epoch: state.epoch)
    case nil where access == .absent:
      body = live(rows, afterSeq: 0, key: nil, epoch: state.epoch)
    case nil:
      body = boot(rows, asOf: seq, after: nil, epoch: state.epoch)
    }
    page["rows"] = .array(body.rows.map(\.json))
    page["cursor"] = .string(body.cursor.text)
    page["more"] = .bool(!(body.cursor.isLiveAtSeq && body.cursor.seq == seq))
    page["total"] = body.total.map { JSON($0) }
    return .object(page)
  }

  struct Page {
    let rows: [Row]
    let cursor: Cursor
    let total: Int?
  }

  // Step 3: rows up to `asOf`, alive or without life, and dead derived rows thin; the scan's end turns the cursor live.
  func boot(_ rows: [Row], asOf: Int64, after cursor: Cursor?, epoch: String) -> Page {
    let kept = rows.filter { row in
      row.seq <= asOf && (row.lattice.life == nil || row.isAlive || registry.type(row.key.type)?.identity == .derived)
    }
    let (sent, cut) = cutPage(kept.filter { row in cursor.map { Self.isAfter(row, seq: $0.seq, key: $0.key) } ?? true })
    guard cut, let last = sent.last else { return Page(rows: sent, cursor: Cursor(epoch: epoch, mode: .live, seq: asOf), total: kept.count) }
    return Page(rows: sent, cursor: Cursor(epoch: epoch, mode: .boot, seq: last.seq, key: last.key, asOf: asOf), total: kept.count)
  }

  // Step 4: every row past the cursor, dead ones thin; a page cut inside a seq keeps its last key.
  func live(_ rows: [Row], afterSeq seq: Int64, key: RecordKey?, epoch: String) -> Page {
    let remaining = rows.filter { Self.isAfter($0, seq: seq, key: key) }
    let (sent, cut) = cutPage(remaining)
    guard let last = sent.last else { return Page(rows: [], cursor: Cursor(epoch: epoch, mode: .live, seq: seq), total: nil) }
    let insideSeq = cut && remaining[sent.count].seq == last.seq
    return Page(rows: sent, cursor: Cursor(epoch: epoch, mode: .live, seq: last.seq, key: insideSeq ? last.key : nil), total: nil)
  }

  // `(seq, type, id) > (cursor.seq, cursor.key)`; a cursor without a key stands after its whole seq.
  static func isAfter(_ row: Row, seq: Int64, key: RecordKey?) -> Bool {
    guard let key else { return row.seq > seq }
    return (row.seq, row.key) > (seq, key)
  }

  // Rows up to PULL_PAGE_BYTES of their JCS, at least one; true when rows were left over.
  func cutPage(_ rows: [Row]) -> ([Row], Bool) {
    var sent: [Row] = []
    var bytes = 0
    for row in rows {
      let size = row.json.jcs.count
      if !sent.isEmpty && bytes + size > limits.pullPageBytes { return (sent, true) }
      sent.append(row)
      bytes += size
    }
    return (sent, false)
  }

  // §9.2 `holdsRecords[p]`: `acct:A/p` holds a visible row of a primary type (§7.6).
  func holdsRecords(_ account: String, in state: ServerState) -> JSON {
    .object(JSON.Object(uniqueKeysWithValues: registry.products.map { product in
      let rows = state.rows[ScopeKey(.product(account: account, name: product.name))] ?? [:]
      return (product.name, .bool(rows.values.contains { row in
        registry.type(row.key.type).map { $0.primary && isVisible(row, of: $0) } ?? false
      }))
    }))
  }

  // §2.4: a lifeless record is visible when a `visibleWhen` field holds a value other than null or "", or, without
  // `visibleWhen`, when it holds any lattice register or text, whatever the value. Serial values never count.
  func isVisible(_ row: Row, of type: TypeDef) -> Bool {
    if type.identity == .singleton { return true }
    if type.life { return row.lattice.life?.isAlive == true }
    guard let visibleWhen = type.visibleWhen else { return !row.lattice.fields.isEmpty || !row.texts.isEmpty }
    return visibleWhen.contains { name in
      if let text = row.texts[name] { return !text.text.isEmpty }
      guard let value = row.lattice.fields[name]?.value else { return false }
      return !value.isNull && value != ""
    }
  }
}

// §6.8 the sockets the model serves: each subscribed scope gets its frames while its principal may read it, a death as
// a pull of the scope would answer it, and a lost read access as `not-found`. Every change, gone and not-found frame
// carries the socket's `as` (§9.5).
struct LiveChannel: Sendable {
  struct Subscriber: Sendable {
    // The principal the socket's upgrade was served as, nil for anonymous.
    let account: String?
    var scopes: Set<ScopeKey> = []
    var frames: [JSON] = []
  }

  var subscribers: [Int: Subscriber] = [:]
  var opened = 0

  // A socket's id is never taken again, once it is closed.
  mutating func connect(account: String?) -> Int {
    opened += 1
    subscribers[opened] = Subscriber(account: account)
    return opened
  }

  // The server closes the socket: it sends it no other frame and answers no other `sub`.
  mutating func close(_ socket: Int) {
    subscribers[socket] = nil
  }

  // An unreadable scope answers at once, as a pull would, and is not subscribed.
  mutating func subscribe(_ socket: Int, to refs: [ScopeRef], in state: ServerState, registry: Registry) {
    guard var subscriber = subscribers[socket] else { return }
    for ref in refs {
      guard registry.scopeKind(of: ref) != nil, let key = ScopeKey(ref, account: subscriber.account) else {
        subscriber.frames.append(Self.end("not-found", of: ref, to: subscriber.account))
        continue
      }
      switch state.access(key, as: subscriber.account, registry: registry) {
      case .notFound: subscriber.frames.append(Self.end("not-found", of: ref, to: subscriber.account))
      case .gone: subscriber.frames.append(Self.end("gone", of: ref, to: subscriber.account))
      case .absent, .readable, .writable: subscriber.scopes.insert(key)
      }
    }
    subscribers[socket] = subscriber
  }

  mutating func unsubscribe(_ socket: Int, from refs: [ScopeRef]) {
    guard let account = subscribers[socket].map(\.account) else { return }
    for ref in refs {
      guard let key = ScopeKey(ref, account: account) else { continue }
      subscribers[socket]?.scopes.remove(key)
    }
  }

  mutating func take(_ socket: Int) -> [JSON] {
    defer { subscribers[socket]?.frames = [] }
    return subscribers[socket]?.frames ?? []
  }

  // A dying scope answers as a pull of it would (§6.7 step 1): `gone` to the tree's owner, for the tree and that owner's
  // overlay, and `not-found` to everyone else. An overlay never written never was a scope, and sends nothing.
  static func deathFrame(of key: ScopeKey, to account: String?, in state: ServerState, registry: Registry) -> JSON? {
    guard state.scopes[key] != nil else { return nil }
    return end(state.access(key, as: account, registry: registry) == .gone ? "gone" : "not-found", of: key.ref, to: account)
  }

  // A `gone` or `not-found` frame to a socket served as `account`.
  static func end(_ op: String, of ref: ScopeRef, to account: String?) -> JSON {
    ["op": .string(op), "as": account.map { .string($0) } ?? .null, "scope": ref.json]
  }

  // A change frame as a socket served as `account` receives it.
  static func served(_ frame: JSON, to account: String?) -> JSON {
    var object = (try? frame.asObject()) ?? JSON.Object()
    object["as"] = account.map { .string($0) } ?? .null
    return .object(object)
  }

  mutating func publish(_ events: [LiveEvent], in state: ServerState, registry: Registry) {
    for socket in subscribers.keys.sorted() {
      var subscriber = subscribers[socket]!
      for event in events where subscriber.scopes.contains(event.key) {
        switch event {
        case .change(let key, let frame):
          if state.canRead(key, as: subscriber.account, registry: registry) {
            subscriber.frames.append(Self.served(frame, to: subscriber.account))
          }
        case .death(let key):
          if let frame = Self.deathFrame(of: key, to: subscriber.account, in: state, registry: registry) {
            subscriber.frames.append(frame)
          }
          subscriber.scopes.remove(key)
        }
      }
      for key in subscriber.scopes.sorted() where !state.canRead(key, as: subscriber.account, registry: registry) {
        subscriber.scopes.remove(key)
        if key.tree.map({ state.scopes[ScopeKey(.tree($0))]?.isAlive != true }) == true { continue }
        subscriber.frames.append(Self.end("not-found", of: key.ref, to: subscriber.account))
      }
      subscribers[socket] = subscriber
    }
  }
}
