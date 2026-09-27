import Foundation
import Network
import SyncAPI
import SyncCore
import SyncReplica
import Synchronization

// The engine's ports to the device and the products: clocks, randomness, the session token and the fork guard's copy,
// connectivity, and the product bindings; their platform-neutral production implementations; and `Wake`, the signal
// every loop sleeps on.

// MARK: - Clocks (§10)

public protocol WallClock: Sendable {
  // The device wall clock, epoch ms: deviceWallMs() of §10.2.
  func nowMs() -> Int64
  // Wall ms, monotonic ms and the boot's identifier at one moment, for the offset sample and jump detection (§10.4).
  func reading() -> ClockReading
}

// The wall clock that stamps and times releases, and the clock every timer and backoff sleeps on.
public struct EngineClock: Sendable {
  public let wall: any WallClock
  public let sleeper: any Clock<Duration>

  public init(wall: any WallClock, sleeper: any Clock<Duration>) {
    self.wall = wall
    self.sleeper = sleeper
  }

  public static let system = EngineClock(wall: SystemClock(), sleeper: ContinuousClock())
}

// Darwin's clocks: the wall clock, CLOCK_MONOTONIC (which keeps counting through sleep), and the boot session's uuid.
public struct SystemClock: WallClock {
  static let boot: String = {
    var size = 0
    guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0 else { return "boot-unknown" }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0 else { return "boot-unknown" }
    return String(decoding: bytes.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }()

  public init() {}

  public func nowMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
  }

  public func reading() -> ClockReading {
    ClockReading(wall: nowMs(), mono: Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000), boot: Self.boot)
  }
}

// MARK: - Randomness and ids (D-2, D-3, D-8)

public protocol RandomSource: Sendable {
  // 64 uniformly random bits; the engine's only randomness.
  func next() -> UInt64
}

public struct SystemRandom: RandomSource {
  public init() {}

  public func next() -> UInt64 {
    var generator = SystemRandomNumberGenerator()
    return generator.next()
  }
}

// A source as the standard library's generator, for uniform draws in a range.
struct Draws: RandomNumberGenerator {
  let source: any RandomSource

  mutating func next() -> UInt64 { source.next() }
}

// Every identity the engine mints, drawn from its random source: record ids by a type's mint, gesture ids, replica ids
// (`rp_` + 32 hex), actors (`r_` + 12 of [a-z0-9]) and fork guards.
public final class Identities: IdentitySource, Sendable {
  static let hex = Array("0123456789abcdef")
  static let lowercase = Array("0123456789abcdefghijklmnopqrstuvwxyz")

  let random: any RandomSource

  public init(random: any RandomSource) {
    self.random = random
  }

  public func draw(below bound: Int) -> Int {
    var draws = Draws(source: random)
    return Int.random(in: 0..<bound, using: &draws)
  }

  public func gestureID() -> String { "g_" + symbols(24, from: Self.lowercase) }
  public func replicaID() -> String { "rp_" + symbols(32, from: Self.hex) }
  public func actor() throws -> Stamp.Actor { try Stamp.Actor("r_" + symbols(12, from: Self.lowercase)) }
  public func forkGuard() -> String { "fg_" + symbols(32, from: Self.hex) }

  func symbols(_ count: Int, from alphabet: [Character]) -> String {
    String((0..<count).map { _ in alphabet[draw(below: alphabet.count)] })
  }
}

extension IdentitySource {
  // A CSPRNG id of `type` by its registry `mint`; a type that mints none throws malformed.
  func mint(_ type: String, in registry: Registry) throws -> RecordID {
    guard let mint = registry.type(type)?.mint else { throw CommitFailure.malformed("\(type) mints no ids") }
    return RecordID(try mint.id(drawing: draw(below:)))
  }
}

// MARK: - The session token and the fork guard's copy (§7.4, §7.11)

public struct SessionToken: Sendable, Hashable {
  public let value: String

  public init(_ value: String) {
    self.value = value
  }

  public static func == (lhs: SessionToken, rhs: SessionToken) -> Bool { lhs.value.utf8.elementsEqual(rhs.value.utf8) }
  public func hash(into hasher: inout Hasher) { hasher.combine(Array(value.utf8)) }
}

public protocol TokenStore: Sendable {
  // The token of `account`; nil when none is kept or it cannot be read, which pauses the replica (§7.4).
  func token(for account: String) -> SessionToken?
  func save(_ token: SessionToken, for account: String) throws
  func delete(for account: String) throws
  // Every account a token is kept for, so engine start can delete those no sign-in needs.
  func accounts() -> [String]
}

// The fork guard's backup-excluded copy (§7.11): nil when it is missing, as on a restored or cloned device.
public protocol ForkGuardStore: Sendable {
  func load() -> String?
  func save(_ forkGuard: String) throws
}

// MARK: - Connectivity

public protocol Connectivity: Sendable {
  var isOnline: Bool { get }
  // `handler` runs, on any thread, each time `isOnline` changes.
  func onChange(_ handler: @escaping @Sendable (Bool) -> Void)
}

// The device's network path, from `NWPathMonitor`; online until the monitor first reports.
public final class PathConnectivity: Connectivity {
  struct State {
    var online = true
    var handlers: [@Sendable (Bool) -> Void] = []
  }

  let monitor = NWPathMonitor()
  let state = Mutex(State())

  public init() {
    monitor.pathUpdateHandler = { [weak self] path in self?.update(online: path.status == .satisfied) }
    monitor.start(queue: DispatchQueue(label: "windmill.sync.path"))
  }

  deinit {
    monitor.cancel()
  }

  public var isOnline: Bool { state.withLock(\.online) }

  public func onChange(_ handler: @escaping @Sendable (Bool) -> Void) {
    state.withLock { $0.handlers.append(handler) }
  }

  func update(online: Bool) {
    let handlers = state.withLock { state -> [@Sendable (Bool) -> Void] in
      guard state.online != online else { return [] }
      state.online = online
      return state.handlers
    }
    for handler in handlers { handler(online) }
  }
}

// MARK: - Product bindings (design §5.5)

// The only product code the engine calls.
public protocol ProductBinding: Sendable {
  var product: String { get }
  // Appendix A: the product's live hint, which lowers the sender's backoff ceiling to 30 s while it holds.
  func liveHint(_ reader: any ScopeReader, physNow: Int64) throws -> Bool
  // A sign-in or sign-out transaction that may change the replica the products write to is about to run: the product
  // ends what cannot outlive the seat, as the Coach ends a running turn (Coach D-10). One sign-in or sign-out may call it
  // more than once.
  func seatWillChange() async
}

extension ProductBinding {
  public func liveHint(_ reader: any ScopeReader, physNow: Int64) throws -> Bool { false }
  public func seatWillChange() async {}
}

// MARK: - Loop primitives

// A loop's wake-up: `kick` is synchronous and never blocks, so a commit can call it; the loop waits for the next kick,
// or for a kick or a timeout. Kicks are counted, so a kick that lands while the loop works is never lost, and a loop
// that waits has handled every kick so far, which is what a test of the running loops waits for.
package final class Wake: Sendable {
  struct State {
    var kicks: UInt64 = 0
    var waiter: CheckedContinuation<Void, Never>?
    var watchers: [(kicks: UInt64, continuation: CheckedContinuation<Void, Never>)] = []
  }

  let state = Mutex(State())

  package init() {}

  package var kicks: UInt64 { state.withLock(\.kicks) }

  package func kick() {
    let waiter = state.withLock { state in
      state.kicks &+= 1
      defer { state.waiter = nil }
      return state.waiter
    }
    waiter?.resume()
  }

  // Returns once a kick lands after the loop read `seen`; at once if one already has, or the task is cancelled.
  package func wait(past seen: UInt64) async {
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        let (now, asleep) = state.withLock { state -> (Bool, [CheckedContinuation<Void, Never>]) in
          if state.kicks != seen || Task.isCancelled { return (true, []) }
          precondition(state.waiter == nil, "one loop waits on a wake")
          state.waiter = continuation
          let kicks = state.kicks
          defer { state.watchers.removeAll { $0.kicks <= kicks } }
          return (false, state.watchers.filter { $0.kicks <= kicks }.map(\.continuation))
        }
        if now { continuation.resume() }
        for watcher in asleep { watcher.resume() }
      }
    } onCancel: {
      let waiter = state.withLock { state in
        defer { state.waiter = nil }
        return state.waiter
      }
      waiter?.resume()
    }
  }

  // The same, for at most `duration` on `clock`.
  package func wait(past seen: UInt64, atMost duration: Duration, clock: any Clock<Duration>) async {
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.wait(past: seen) }
      group.addTask { try? await clock.sleep(for: duration) }
      await group.next()
      group.cancelAll()
    }
  }

  // Returns once the loop waits on this wake having seen `kicks` kicks or more, so it has handled each of them; at once
  // if it waits so now.
  package func asleep(seen kicks: UInt64) async {
    await withCheckedContinuation { continuation in
      let now = state.withLock { state -> Bool in
        if state.waiter != nil && state.kicks >= kicks { return true }
        state.watchers.append((kicks, continuation))
        return false
      }
      if now { continuation.resume() }
    }
  }
}

// Every loop's wake-up, made before the loops so any part of the engine can wake any of them.
struct Wakes: Sendable {
  let sender = Wake()
  let releaser = Wake()
  let puller = Wake()
  let live = Wake()

  // Connectivity, foreground and re-authentication: every loop looks again.
  func kickAll() {
    for wake in [sender, releaser, puller, live] { wake.kick() }
  }
}

// One round at a time, whoever runs it (a loop, a flush, the simulator): a caller waits for the round in flight to end,
// in the order callers came, and one cancelled while it waits gives up its place.
package final class Turns: Sendable {
  struct State {
    var busy = false
    var nextWaiter = 0
    var waiting: [(id: Int, continuation: CheckedContinuation<Bool, Never>)] = []
    var watchers: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  }

  let state = Mutex(State())

  package init() {}

  // True once the caller holds the turn, which it then passes on; false when it was cancelled first.
  package func take() async -> Bool {
    let (id, taken) = state.withLock { state -> (Int, Bool) in
      state.nextWaiter += 1
      guard !state.busy else { return (state.nextWaiter, false) }
      state.busy = true
      return (state.nextWaiter, true)
    }
    if taken { return true }
    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
        let (answer, queued) = state.withLock { state -> (Bool?, [CheckedContinuation<Void, Never>]) in
          if Task.isCancelled { return (false, []) }
          guard state.busy else {
            state.busy = true
            return (true, [])
          }
          state.waiting.append((id, continuation))
          let count = state.waiting.count
          defer { state.watchers.removeAll { $0.count <= count } }
          return (nil, state.watchers.filter { $0.count <= count }.map(\.continuation))
        }
        if let answer { continuation.resume(returning: answer) }
        for watcher in queued { watcher.resume() }
      }
    } onCancel: {
      let abandoned = state.withLock { state -> CheckedContinuation<Bool, Never>? in
        guard let index = state.waiting.firstIndex(where: { $0.id == id }) else { return nil }
        return state.waiting.remove(at: index).continuation
      }
      abandoned?.resume(returning: false)
    }
  }

  // The holder's round is over: the next caller waiting takes the turn.
  package func pass() {
    let next = state.withLock { state -> CheckedContinuation<Bool, Never>? in
      guard !state.waiting.isEmpty else {
        state.busy = false
        return nil
      }
      return state.waiting.removeFirst().continuation
    }
    next?.resume(returning: true)
  }

  // Returns once `count` callers or more wait for the turn; at once if they do now.
  package func queued(_ count: Int) async {
    await withCheckedContinuation { continuation in
      let now = state.withLock { state -> Bool in
        if state.waiting.count >= count { return true }
        state.watchers.append((count, continuation))
        return false
      }
      if now { continuation.resume() }
    }
  }
}

// §7.4's backoff, which every loop draws its retries from: a sleep of `max(floor, random(0, min(ceiling, 1 s · 2^k)))`,
// full jitter from the injected source, after which k grows by one; the bound stops doubling once it passes the ceiling.
package struct Backoff: Sendable {
  package private(set) var k = 0

  package init() {}

  package mutating func next(ceilingMs: Int64, floorMs: Int64, random: any RandomSource) -> Int64 {
    var bound = Constants.backoffBaseMs
    for _ in 0..<k where bound < ceilingMs { bound *= 2 }
    var draws = Draws(source: random)
    let sleep = Int64.random(in: 0...min(ceilingMs, bound), using: &draws)
    k += 1
    return max(floorMs, sleep)
  }

  package mutating func reset() {
    k = 0
  }
}
