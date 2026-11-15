import Foundation
import Security
import Agent
import SyncAPI
import SyncCore
import SyncEngine
#if canImport(UIKit)
import UIKit
#endif

@MainActor public protocol CoachWorkLease: AnyObject {
  func acquire(expired: @escaping @MainActor () -> Void)
  func release()
}

@MainActor public final class CoachRuntime: TurnRuntime {
  let clock: any AiClock
  let lease: any CoachWorkLease
  let expired: @MainActor () -> Void
  var held = false
  public init(clock: any AiClock, lease: any CoachWorkLease, expired: @escaping @MainActor () -> Void) {
    self.clock = clock; self.lease = lease; self.expired = expired
  }
  public var nowMs: Int64 { clock.nowMs }
  public func callID() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw AiTransportFailure.transport }
    return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  public func acquire() async throws {
    guard !held else { return }
    held = true
    lease.acquire { [weak self] in self?.expired(); self?.release() }
  }
  public func release() {
    guard held else { return }
    held = false
    lease.release()
  }
}

#if canImport(UIKit)
@MainActor public final class CoachBackgroundLease: CoachWorkLease {
  var identifier: UIBackgroundTaskIdentifier = .invalid
  public init() {}
  public func acquire(expired: @escaping @MainActor () -> Void) {
    guard identifier == .invalid else { return }
    identifier = UIApplication.shared.beginBackgroundTask(withName: "Coach") { expired() }
  }
  public func release() {
    guard identifier != .invalid else { return }
    let previous = identifier
    identifier = .invalid
    UIApplication.shared.endBackgroundTask(previous)
  }
}
#endif

@MainActor public final class CoachCommitGuard {
  let replica: any Replica
  let scope: ScopeRef
  let recordType: String
  let seat: @MainActor () -> Seat
  var generation: UInt64 = 0

  public init(replica: any Replica, scope: ScopeRef, recordType: String, seat: @escaping @MainActor () -> Seat) {
    self.replica = replica; self.scope = scope; self.recordType = recordType; self.seat = seat
  }

  public func seatDidChange() { generation &+= 1 }

  public func open<T>(_ input: TurnInput, _ body: (any CommitContext, HostLease) throws -> (Gesture?, T)) throws -> T {
    let expected = generation
    let result = try replica.commit(scope) { context in
      guard expected == generation, input.seat == seat() else { throw HostFailure.staleSeat }
      let lease = HostLease(turnId: input.turnId, seat: input.seat, generation: generation, replica: context.replica)
      return try body(context, lease)
    }
    if case .refused(let code, _, _)? = result.outcome { throw HostFailure.refused(code.text) }
    return result.value
  }

  public func commit<T>(_ lease: HostLease, id: RecordID,
                        _ body: (any CommitContext, Record) throws -> (Gesture?, T)) throws -> T {
    let result = try replica.commit(scope) { context in
      guard lease.generation == generation, lease.seat == seat(), lease.replica == context.replica else { throw HostFailure.staleSeat }
      guard let record = try context.drawn(recordType, id), record.isVisible else { throw HostFailure.recordGone }
      return try body(context, record)
    }
    if case .refused(let code, _, _)? = result.outcome { throw HostFailure.refused(code.text) }
    return result.value
  }

  public func interruptStale(_ id: RecordID, stateField: String = "state") throws -> Bool {
    let result = try replica.commit(scope) { context in
      guard let record = try context.drawn(recordType, id), record.isVisible,
            let state = try record.values[stateField]?.asString() else { return (nil, false) }
      let freshness = try context.freshness()
      guard TurnFreshness.isStale(state: state, syncLive: freshness.live, serverNow: freshness.serverNow, serverUpdatedAt: record.ru)
      else { return (nil, false) }
      return (Gesture(changes: [.update(recordType, id, [stateField: "interrupted"])]), true)
    }
    if case .refused(let code, _, _)? = result.outcome { throw HostFailure.refused(code.text) }
    return result.value
  }
}
