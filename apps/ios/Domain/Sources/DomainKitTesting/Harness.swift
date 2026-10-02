import DomainKit
import SyncAPI
import SyncCore
import SyncTesting

// §14.2 the real engine in step mode (`SteppedEngine`) over an in-memory store, its model server, a simulated clock and
// seeded ids. No engine loop starts: every call runs the engine's step functions on the calling thread.
public final class Harness {
  public let runner: ActionRunner
  let engine: SteppedEngine
  let registry: Registry
  let zone: any Zone

  public convenience init(registry: Registry, start: Instant, zone: any Zone = FixedZone(offsetSeconds: 0), seed: UInt64 = 1,
                          account: String? = "acct-1", rules: any ServerRules = NoServerRules(),
                          commandResultWrites: @escaping CommandResultDeviceWrites = { _, _, _, _ in [] },
                          pendingDeviceWork: @escaping PendingDeviceWork = { _, _ in [] }) {
    let engine = SteppedEngine(registry: registry, startMs: start.ms, seed: seed, account: account, rules: rules,
                               commandResultWrites: commandResultWrites, pendingDeviceWork: pendingDeviceWork)
    self.init(engine, registry: registry, zone: zone)
  }

  init(_ engine: SteppedEngine, registry: Registry, zone: any Zone) {
    self.engine = engine
    self.registry = registry
    self.zone = zone
    runner = ActionRunner(replica: engine.replica, registry: registry, zone: zone)
  }

  public var clock: SimClock { engine.clock }

  // Shared by every device of this harness.
  public var server: ModelServerHandle { engine.server }

  // Another device, on the same account, server and clock.
  public func device() -> Harness {
    Harness(engine.device(), registry: registry, zone: zone)
  }

  // Every device's sender and puller, to quiescence.
  public func sync() {
    engine.sync()
  }

  // The clock; every hold due by then releases.
  public func advance(ms: Int64) {
    engine.advance(ms: ms)
  }

  // Engine §7.3 leaving the app.
  public func leave() {
    engine.leave()
  }

  // The next commit throws before its transaction commits, whether or not its body decides a gesture (ER-9).
  public func failNextCommit() {
    engine.failNextCommit()
  }

  public func drawn<E: Entity>(_ type: E.Type) throws -> [E] {
    try Repository<E>.decode(engine.drawn(E.scope, E.type))
  }

  public func stored<E: Entity>(_ type: E.Type) throws -> [E] {
    try Repository<E>.decode(engine.stored(E.scope, E.type))
  }

  // The notices of every product of the registry not dismissed, each product's in the order they were written.
  public func notices<R: ProductRefusal>(_ type: R.Type) throws -> [DomainNotice<R>] {
    var notices: [DomainNotice<R>] = []
    for product in registry.products {
      notices += try engine.notices(product.name).map { DomainNotice<R>($0, registry: registry) }
    }
    return notices
  }

  // An offer's id is its gesture id, which `runner.undo` takes.
  public func undoOffers() -> [UndoOffer] {
    engine.undoOffers()
  }
}

// A product with no server rules of its own.
public struct NoServerRules: ServerRules {
  public init() {}
}

// A test's result readers.
public func saved<R>(_ result: SaveResult<R>) -> Bool {
  guard case .saved = result else { return false }
  return true
}

public func refused<R>(_ result: SaveResult<R>) -> R? {
  guard case .refused(let refusal) = result else { return nil }
  return refusal
}

public func failed<R>(_ result: SaveResult<R>) -> (any Error)? {
  guard case .failed(let error) = result else { return nil }
  return error
}

public func committed<Result, Refusal>(_ outcome: Outcome<Result, Refusal>) -> Result? {
  guard case .committed(let result, _) = outcome else { return nil }
  return result
}

public func unchanged<Result, Refusal>(_ outcome: Outcome<Result, Refusal>) -> Result? {
  guard case .unchanged(let result) = outcome else { return nil }
  return result
}
