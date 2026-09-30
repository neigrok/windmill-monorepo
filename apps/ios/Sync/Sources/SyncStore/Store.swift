import GRDB
import SyncAPI
import SyncCore
import SyncReplica

// The local store (§2.5): one SQLite database, WAL with `synchronous=FULL`, behind GRDB. Every Action is one
// transaction: its loaders read through a `StoreTransaction`, a pure planner decides, and the batch it returns is
// written before the transaction commits.

public final class Store: Sendable {
  let writer: any DatabaseWriter
  public let registry: Registry
  public let limits: Limits
  let crashPoints: CrashPoints
  let planners: Planners

  // A file store: a `DatabasePool` in WAL mode. `rewriteDeviceValue` is the products' hook for a write map's joined id
  // in their device rows (§7.7 write map step 1).
  public convenience init(path: String, registry: Registry, limits: Limits = Limits(), crashPoints: CrashPoints = .none,
                          rewriteDeviceValue: @escaping DeviceValueRewrite = PushPlanner.keepDeviceValue) throws {
    try self.init(writer: DatabasePool(path: path, configuration: Schema.configuration()), registry: registry, limits: limits,
                  crashPoints: crashPoints, rewriteDeviceValue: rewriteDeviceValue)
  }

  // The same schema, migrations and writer over one in-memory connection, for the step-mode harness.
  public static func inMemory(registry: Registry, limits: Limits = Limits(), crashPoints: CrashPoints = .none,
                              rewriteDeviceValue: @escaping DeviceValueRewrite = PushPlanner.keepDeviceValue) throws -> Store {
    try Store(writer: DatabaseQueue(configuration: Schema.configuration()), registry: registry, limits: limits, crashPoints: crashPoints,
              rewriteDeviceValue: rewriteDeviceValue)
  }

  init(writer: any DatabaseWriter, registry: Registry, limits: Limits, crashPoints: CrashPoints,
       rewriteDeviceValue: @escaping DeviceValueRewrite) throws {
    self.writer = writer
    self.registry = registry
    self.limits = limits
    self.crashPoints = crashPoints
    planners = Planners(registry: registry, limits: limits, rewriteDeviceValue: rewriteDeviceValue)
    try Schema.migrator.migrate(writer)
    try writer.write { db in
      let built = try Int.fetchOne(db, sql: "SELECT ref_index_version FROM device")
      if let built, built != registry.version { try BatchWriter(db: db, registry: registry).rebuildDerivedColumns() }
    }
  }

  // One Action: load and plan inside the transaction, write the batch, and commit.
  public func write<Value>(_ tx: TxName, _ body: (StoreTransaction) throws -> Planned<Value>) throws -> Written<Value> {
    try transaction(tx) { db in
      let planned = try body(StoreTransaction(db: db, registry: registry))
      try BatchWriter(db: db, registry: registry).apply(planned.batch)
      return Written(value: planned.value, events: planned.batch.events, change: planned.batch.change)
    }
  }

  // §2.5 the deferred deletion, one transaction: up to `limit` rows no view reads any more. True while any are left.
  public func sweep(limit: Int = 512) throws -> Written<Bool> {
    try transaction(.sweep) { db in
      Written(value: try BatchWriter(db: db, registry: registry).sweep(limit: limit), events: [], change: StoreChange())
    }
  }

  // A crash point before the commit rolls the transaction back; one after it stands for death between transactions.
  func transaction<Value>(_ tx: TxName, _ body: (Database) throws -> Value) throws -> Value {
    let value = try writer.write { db in
      let value = try body(db)
      try crashPoints.hit(.beforeCommit(tx))
      return value
    }
    try crashPoints.hit(.afterCommit(tx))
    return value
  }

  // A consistent snapshot.
  public func read<Value>(_ body: (StoreTransaction) throws -> Value) throws -> Value {
    try writer.read { db in try body(StoreTransaction(db: db, registry: registry)) }
  }

  // A connection setting as SQLite reports it.
  func pragma(_ name: String) throws -> String {
    try writer.read { db in try String.fetchOne(db, sql: "PRAGMA \(name)") ?? "" }
  }
}

// A planner's decision inside an Action: its answer, and the batch to write.
public struct Planned<Value> {
  public let value: Value
  public let batch: ReplicaBatch

  public init(_ value: Value, _ batch: ReplicaBatch) {
    self.value = value
    self.batch = batch
  }
}

// A committed Action: its answer, the events to publish, and what views must refresh.
public struct Written<Value> {
  public let value: Value
  public let events: [EngineEvent]
  public let change: StoreChange
}

// The transactions of the design's §3.5 table, by name.
public enum TxName: String, Sendable, Hashable, CaseIterable {
  case firstLaunch, commit, undo, release, engineStart, number, offset, results, localRefusal, authPause, authResume, reidentify
  case epochChange, pullPage, liveFrame, subscriptions, signInBegin, signInComplete, signOutRelease, signOutCount
  case signOutFinish, discardDormant, dismissNotice, sweep
}

public enum CrashPoint: Sendable, Hashable {
  case beforeCommit(TxName)
  case afterCommit(TxName)
}

// The kill-at-every-step hook: a no-op in production; a test throws at the point it kills.
public struct CrashPoints: Sendable {
  let hit: @Sendable (CrashPoint) throws -> Void

  public init(_ hit: @escaping @Sendable (CrashPoint) throws -> Void) {
    self.hit = hit
  }

  public static let none = CrashPoints { _ in }
}

// The pure planners an Action calls, built once from the registry and limits.
struct Planners: Sendable {
  let commits: CommitPlanner
  let hold: Hold
  let pushes: PushPlanner
  let pages: PageApplier
  let lifecycle: ReplicaLifecycle

  init(registry: Registry, limits: Limits, rewriteDeviceValue: @escaping DeviceValueRewrite) {
    commits = CommitPlanner(registry: registry, limits: limits)
    hold = Hold(registry: registry)
    pushes = PushPlanner(registry: registry, limits: limits, rewriteDeviceValue: rewriteDeviceValue)
    pages = PageApplier(registry: registry)
    lifecycle = ReplicaLifecycle(registry: registry)
  }
}
