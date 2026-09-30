import SyncCore
import SyncEngine
import SyncReplica
import SyncStore
import Synchronization

// Doubles of the engine's device ports, each deterministic and driven by the test: a clock that moves only when told,
// a seeded random source, in-memory token and fork-guard stores, a connectivity switch, a log of the events the engine
// publishes, and the store's crash-point hook armed to fail the next commit.

// MARK: - The clock

// The device's wall clock and the clock the engine sleeps on, both moved only by the test. `advance` moves the wall
// and monotonic clocks together and wakes every sleeper whose deadline it passes; `jump` moves the wall clock alone, as
// a person setting the time does; `skewMs` offsets the wall clock from true time; `reboot` starts a new boot. A test of
// the running loops learns from `asleep(until:)` that a loop sleeps, and until when.
public final class SimClock: WallClock, Clock, Sendable {
  public struct Instant: InstantProtocol {
    public let ms: Int64

    public init(ms: Int64) {
      self.ms = ms
    }

    public func advanced(by duration: Duration) -> Instant { Instant(ms: ms + duration.ms) }
    public func duration(to other: Instant) -> Duration { .milliseconds(other.ms - ms) }
    public static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.ms < rhs.ms }
  }

  struct Sleeper {
    let id: Int
    let deadline: Int64
    let continuation: CheckedContinuation<Void, any Error>
  }

  struct State {
    var mono: Int64 = 0
    var wall: Int64
    var skewMs: Int64 = 0
    var boot = 1
    var nextSleeper = 0
    var sleepers: [Sleeper] = []
    var watchers: [(deadline: Int64, continuation: CheckedContinuation<Void, Never>)] = []
  }

  let state: Mutex<State>

  // `wallMs`: the device wall clock at the start, epoch ms.
  public init(wallMs: Int64) {
    state = Mutex(State(wall: wallMs))
  }

  // MARK: WallClock

  public func nowMs() -> Int64 { state.withLock { $0.wall + $0.skewMs } }

  public func reading() -> ClockReading {
    state.withLock { ClockReading(wall: $0.wall + $0.skewMs, mono: $0.mono, boot: "boot-\($0.boot)") }
  }

  // MARK: Clock

  public var now: Instant { Instant(ms: state.withLock(\.mono)) }
  public var minimumResolution: Duration { .milliseconds(1) }

  public func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    let id = state.withLock { state in
      state.nextSleeper += 1
      return state.nextSleeper
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let (now, watching) = state.withLock { state -> (Bool, [CheckedContinuation<Void, Never>]) in
          if deadline.ms <= state.mono || Task.isCancelled { return (true, []) }
          state.sleepers.append(Sleeper(id: id, deadline: deadline.ms, continuation: continuation))
          defer { state.watchers.removeAll { $0.deadline == deadline.ms } }
          return (false, state.watchers.filter { $0.deadline == deadline.ms }.map(\.continuation))
        }
        if now { continuation.resume() }
        for watcher in watching { watcher.resume() }
      }
    } onCancel: {
      let cancelled = state.withLock { state in
        defer { state.sleepers.removeAll { $0.id == id } }
        return state.sleepers.first { $0.id == id }
      }
      cancelled?.continuation.resume(throwing: CancellationError())
    }
    try Task.checkCancellation()
  }

  // MARK: The test's hands

  // Returns once a task sleeps on this clock until `deadline`, in monotonic ms; at once if one does now.
  public func asleep(until deadline: Int64) async {
    await withCheckedContinuation { continuation in
      let now = state.withLock { state -> Bool in
        if state.sleepers.contains(where: { $0.deadline == deadline }) { return true }
        state.watchers.append((deadline, continuation))
        return false
      }
      if now { continuation.resume() }
    }
  }

  public func advance(ms: Int64) {
    let woken = state.withLock { state in
      state.mono += ms
      state.wall += ms
      let mono = state.mono
      defer { state.sleepers.removeAll { $0.deadline <= mono } }
      return state.sleepers.filter { $0.deadline <= mono }
    }
    for sleeper in woken { sleeper.continuation.resume() }
  }

  public func jump(ms: Int64) {
    state.withLock { $0.wall += ms }
  }

  public func skew(ms: Int64) {
    state.withLock { $0.skewMs = ms }
  }

  public func reboot() {
    state.withLock { $0.boot += 1 }
  }

  // The engine's clock pair, both this clock.
  public var engineClock: EngineClock { EngineClock(wall: self, sleeper: self) }
}

extension Duration {
  var ms: Int64 {
    let (seconds, attoseconds) = components
    return seconds * 1000 + attoseconds / 1_000_000_000_000_000
  }
}

// MARK: - Randomness

// The engine's randomness from a seed: the same seed draws the same ids, actors and backoff sleeps.
public final class SeededRandomSource: RandomSource {
  let generator: Mutex<SeededRandom>

  public init(seed: UInt64) {
    generator = Mutex(SeededRandom(seed: seed))
  }

  public func next() -> UInt64 {
    generator.withLock { $0.next() }
  }
}

// MARK: - Stores and connectivity

public final class InMemoryTokenStore: TokenStore {
  let tokens: Mutex<[String: SessionToken]>

  public init(_ tokens: [String: SessionToken] = [:]) {
    self.tokens = Mutex(tokens)
  }

  public func token(for account: String) -> SessionToken? { tokens.withLock { $0[account] } }
  public func save(_ token: SessionToken, for account: String) { tokens.withLock { $0[account] = token } }
  public func delete(for account: String) { tokens.withLock { $0[account] = nil } }
  public func accounts() -> [String] { tokens.withLock { $0.keys.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) } } }
}

public final class InMemoryForkGuardStore: ForkGuardStore {
  let copy: Mutex<String?>

  // `copy` nil: the copy is missing, as on a restored or cloned device.
  public init(_ copy: String? = nil) {
    self.copy = Mutex(copy)
  }

  public func load() -> String? { copy.withLock { $0 } }
  public func save(_ forkGuard: String) { copy.withLock { $0 = forkGuard } }
}

// A network switch the test flips; each flip runs the engine's handlers at once, on the test's thread.
public final class SwitchedConnectivity: Connectivity {
  struct State {
    var online: Bool
    var handlers: [@Sendable (Bool) -> Void] = []
  }

  let state: Mutex<State>

  public init(online: Bool = true) {
    state = Mutex(State(online: online))
  }

  public var isOnline: Bool { state.withLock(\.online) }

  public func onChange(_ handler: @escaping @Sendable (Bool) -> Void) {
    state.withLock { $0.handlers.append(handler) }
  }

  public func set(online: Bool) {
    let handlers = state.withLock { state -> [@Sendable (Bool) -> Void] in
      guard state.online != online else { return [] }
      state.online = online
      return state.handlers
    }
    for handler in handlers { handler(online) }
  }
}

// MARK: - Events

// Every event an engine publishes, in order, as the engine's `tap` hands them over.
public final class EventLog: Sendable {
  let log = Mutex<[EngineEvent]>([])

  public init() {}

  public func append(_ event: EngineEvent) {
    log.withLock { $0.append(event) }
  }

  public var events: [EngineEvent] { log.withLock { $0 } }

  // The events since the last drain, which leave the log.
  public func drain() -> [EngineEvent] {
    log.withLock { log in
      defer { log = [] }
      return log
    }
  }
}

// MARK: - Store faults

// The domain kit's `failNextCommit()` (kit ER-9), on the store's crash-point hook: once armed, the next commit throws
// before its transaction commits, as a full disk would, whether or not its body decided a gesture, and nothing of it is
// stored.
public final class CommitFaults: Sendable {
  public struct Injected: Error, Hashable {
    public init() {}
  }

  let armed = Atomic(false)

  public init() {}

  public func failNextCommit() {
    armed.store(true, ordering: .relaxed)
  }

  public func hit(_ point: CrashPoint) throws {
    guard point == .beforeCommit(.commit), armed.exchange(false, ordering: .relaxed) else { return }
    throw Injected()
  }

  // The hook to build the store with.
  public var crashPoints: CrashPoints {
    CrashPoints { [self] point in try hit(point) }
  }
}

// The kill-at-every-step hook (design §9.5) over one store. Once begun, the crash points the store reaches are counted
// from 0; the one armed kills the process (by its count, or as the first commit of a kind), and so does every later one,
// since a dead process commits nothing more.
// Begun unarmed, it records the store after every commit, the store as it was begun first, so a kill at point `k` must
// leave the store as `recorded.states[(k + 1) / 2]` holds it: every commit before the point, and none after.
public final class Killer: Sendable {
  public struct Killed: Error {}

  struct State {
    var store: Store?
    var armed: Int?
    var armedAfter: TxName?
    var dead = false
    var points: [CrashPoint] = []
    var states: [JSON] = []
  }

  let state = Mutex(State())

  public init() {}

  public var crashPoints: CrashPoints { CrashPoints { [self] point in try hit(point) } }

  public func begin(killingAt point: Int?, store: Store) {
    let now = Self.dump(store)
    state.withLock { $0 = State(store: store, armed: point, states: [now]) }
  }

  // Armed to kill the process once the first `tx` has committed.
  public func begin(killingAfter tx: TxName, store: Store) {
    let now = Self.dump(store)
    state.withLock { $0 = State(store: store, armedAfter: tx, states: [now]) }
  }

  public func end() {
    state.withLock { $0 = State() }
  }

  public var isDead: Bool { state.withLock(\.dead) }
  public var recorded: (points: [CrashPoint], states: [JSON]) { state.withLock { ($0.points, $0.states) } }

  public func hit(_ point: CrashPoint) throws {
    let (kill, recording) = state.withLock { state -> (Bool, Store?) in
      guard let store = state.store else { return (false, nil) }
      if state.dead { return (true, nil) }
      state.points.append(point)
      if state.armed == state.points.count - 1 || state.armedAfter.map({ point == .afterCommit($0) }) == true {
        state.dead = true
        return (true, nil)
      }
      guard state.armed == nil, state.armedAfter == nil, case .afterCommit = point else { return (false, nil) }
      return (false, store)
    }
    if kill { throw Killed() }
    if let recording {
      let now = Self.dump(recording)
      state.withLock { $0.states.append(now) }
    }
  }

  // The whole store as the corpus writes a device down; null before its first launch.
  public static func dump(_ store: Store) -> JSON {
    (try? store.read { try $0.device(rows: true).json }) ?? .null
  }
}
