import Foundation
import SyncCore
import SyncEngine
import SyncIOS
import Synchronization

// The faults a person or a scenario turns on (design §10 "Faults"), in front of the network, connectivity and the device
// clock; and the probe's log of every exchange, live frame and lease of background time, which each report carries.

// MARK: - The network

// In front of the real transport. Offline answers no call and tells the engine's connectivity; a refusal queued answers
// the next call with its status (a forced 401 or 503) and sends nothing. Every call and its answer lands in the log, the
// answer with its `as`: whom the server served it as, null for no one or when the answer does not say.
nonisolated final class FaultInjectingTransport: SyncTransport {
  struct Switches {
    var offline = false
    var refusals: [Int] = []
  }

  enum Fault {
    case offline
    case refused(Int)
  }

  let inner: any SyncTransport
  let log: ProbeLog
  let connectivity = FaultConnectivity()
  let switches = Mutex(Switches())

  init(_ inner: any SyncTransport, log: ProbeLog) {
    self.inner = inner
    self.log = log
  }

  var isOffline: Bool { switches.withLock(\.offline) }

  func setOffline(_ offline: Bool) {
    switches.withLock { $0.offline = offline }
    connectivity.force(offline: offline)
  }

  // The next call is answered `status` without reaching the server.
  func refuseNext(_ status: Int) {
    switches.withLock { $0.refusals.append(status) }
  }

  func takeFault() -> Fault? {
    switches.withLock { switches in
      if switches.offline { return .offline }
      return switches.refusals.isEmpty ? nil : .refused(switches.refusals.removeFirst())
    }
  }

  func hello(token: SessionToken?) async -> Reply<HelloResponse> {
    await exchange(["kind": "hello", "token": .bool(token != nil)], { await inner.hello(token: token) }) { hello in
      ["epoch": .string(hello.epoch), "holdsRecords": hello.holdsRecords.map { JSON.object(JSON.Object(uniqueKeysWithValues: $0.map { ($0.key, .bool($0.value)) })) } ?? .null]
    }
  }

  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    let sent: JSON.Object = [
      "kind": "push", "replica": .string(request.replica), "account": .string(request.account),
      "n": .array(request.intents.map { JSON($0.n ?? 0) }),
    ]
    return await exchange(sent, { await inner.push(request, token: token) }) { response in
      ["epoch": .string(response.epoch), "results": .array(response.results.map(\.logged))]
    }
  }

  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> {
    let sent: JSON.Object = ["kind": "pull", "scopes": .array(request.scopes.map { $0.scope.json })]
    return await exchange(sent, { await inner.pull(request, token: token) }) { response in
      ["epoch": .string(response.epoch), "pages": .array(response.pages.map(\.logged))]
    }
  }

  func openLive(token: SessionToken) async -> Reply<any LiveConnection> {
    if let fault = takeFault() {
      log.record(["kind": "live-open", "fault": fault.logged])
      return fault.reply()
    }
    let reply = await inner.openLive(token: token)
    switch reply {
    case .answered(.ok(let connection)):
      log.record(["kind": "live-open", "status": 101])
      return .answered(.ok(LoggedLiveConnection(connection, log: log)))
    case .answered(.failed(let failure)):
      log.record(["kind": "live-open", "status": JSON(failure.status)])
    case .unreachable:
      log.record(["kind": "live-open", "status": "unreachable"])
    }
    return reply
  }

  // One call through the faults: the fault it meets answers it, or the server does; either way the log records it, with
  // what `answered` tells of a 200.
  func exchange<Body: ResponseBody & Served>(_ sent: JSON.Object, _ send: () async -> Reply<Body>,
                                             answered: (Body) -> JSON.Object) async -> Reply<Body> {
    var entry = sent
    if let fault = takeFault() {
      entry["fault"] = fault.logged
      log.record(entry)
      return fault.reply()
    }
    let reply = await send()
    switch reply {
    case .answered(.ok(let body)):
      entry["status"] = 200
      entry["as"] = body.servedAsLogged
      for (key, value) in answered(body).members { entry[key] = value }
    case .answered(.failed(let failure)):
      entry["status"] = JSON(failure.status)
      entry["error"] = failure.error.map { .string($0) }
      entry["as"] = failure.servedAsLogged
    case .unreachable:
      entry["status"] = "unreachable"
    }
    log.record(entry)
    return reply
  }
}

extension FaultInjectingTransport.Fault {
  nonisolated var logged: JSON {
    switch self {
    case .offline: "offline"
    case .refused(let status): JSON(status)
    }
  }

  nonisolated func reply<Body: Sendable>() -> Reply<Body> {
    switch self {
    case .offline: .unreachable
    case .refused(let status): .answered(.failed(HTTPFailure(status: status)))
    }
  }
}

// An open socket whose every message sent and frame received lands in the log.
nonisolated final class LoggedLiveConnection: LiveConnection {
  let inner: any LiveConnection
  let log: ProbeLog

  init(_ inner: any LiveConnection, log: ProbeLog) {
    self.inner = inner
    self.log = log
  }

  func send(_ request: LiveRequest) async throws {
    var entry = (try? request.json.asObject()) ?? [:]
    entry["kind"] = "live-send"
    log.record(entry)
    try await inner.send(request)
  }

  // A frame, the server's close (`live-closed`), or a socket that failed (`live-failed`).
  func receive() async throws -> LiveFrame? {
    do {
      let frame = try await inner.receive()
      log.record(frame.map(\.logged) ?? ["kind": "live-closed"])
      return frame
    } catch {
      log.record(["kind": "live-failed", "error": .string(String(describing: error))])
      throw error
    }
  }

  func close() {
    log.record(["kind": "live-close"])
    inner.close()
  }
}

// The device's network path, which the offline fault overrides.
nonisolated final class FaultConnectivity: Connectivity {
  let path = PathConnectivity()
  let forcedOffline = Atomic(false)
  let handlers = Mutex<[@Sendable (Bool) -> Void]>([])

  init() {
    path.onChange { [weak self] _ in self?.changed() }
  }

  var isOnline: Bool { path.isOnline && !forcedOffline.load(ordering: .relaxed) }

  func onChange(_ handler: @escaping @Sendable (Bool) -> Void) {
    handlers.withLock { $0.append(handler) }
  }

  func force(offline: Bool) {
    forcedOffline.store(offline, ordering: .relaxed)
    changed()
  }

  func changed() {
    let online = isOnline
    for handler in handlers.withLock({ $0 }) { handler(online) }
  }
}

// MARK: - The device clock

// The system clock with a skew added to its wall time, as a phone whose clock is set wrong: the monotonic clock and the
// boot are the system's, so a skew changed while the app runs, or between two launches, is a jump the engine can see.
nonisolated final class FaultClock: WallClock {
  let system = SystemClock()
  let skew: Atomic<Int64>

  init(skewMs: Int64) {
    skew = Atomic(skewMs)
  }

  var skewMs: Int64 { skew.load(ordering: .relaxed) }

  func setSkew(ms: Int64) {
    skew.store(ms, ordering: .relaxed)
  }

  func nowMs() -> Int64 {
    system.nowMs() + skewMs
  }

  func reading() -> ClockReading {
    let reading = system.reading()
    return ClockReading(wall: reading.wall + skewMs, mono: reading.mono, boot: reading.boot)
  }
}

// MARK: - Background time

// The system's background time, each lease begun, ended or expired landing in the log, so a report shows what ran inside
// it.
@MainActor
final class RecordedBackgroundTime: BackgroundTime {
  let system: any BackgroundTime
  let log: ProbeLog

  init(_ system: any BackgroundTime, log: ProbeLog) {
    self.system = system
    self.log = log
  }

  func begin(named name: String, expired: @escaping @MainActor @Sendable () -> Void) -> Int? {
    let log = log
    let identifier = system.begin(named: name) {
      log.record(["kind": "background-expired", "name": .string(name)])
      expired()
    }
    log.record(["kind": "background-begin", "name": .string(name), "granted": .bool(identifier != nil)])
    return identifier
  }

  func end(_ identifier: Int) {
    log.record(["kind": "background-end", "id": JSON(identifier)])
    system.end(identifier)
  }
}

// MARK: - The log

// What the probe saw, in the order it happened, each entry stamped with the real wall clock: every exchange with the
// server, live frame and lease of background time.
nonisolated final class ProbeLog: Sendable {
  let entries = Mutex<[JSON]>([])

  func record(_ entry: JSON.Object) {
    var entry = entry
    entry["at"] = JSON(Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)))
    let logged = JSON.object(entry)
    entries.withLock { $0.append(logged) }
  }

  var all: [JSON] { entries.withLock { $0 } }
}

// MARK: - How the log describes what the server said

extension Served {
  nonisolated var servedAsLogged: JSON {
    servedAs.map(JSON.string) ?? .null
  }
}

extension PushResult {
  nonisolated var logged: JSON {
    switch verdict {
    case .ok(let seq, _): ["n": JSON(n), "s": "ok", "seq": JSON(seq)]
    case .refused(let code): ["n": JSON(n), "s": "refused", "code": code.json]
    }
  }
}

extension PullPage {
  nonisolated var logged: JSON {
    switch body {
    case .rows(let page): ["scope": scope.json, "kind": "rows", "rows": JSON(Int64(page.rows.count)), "more": .bool(page.more)]
    case .reset: ["scope": scope.json, "kind": "reset"]
    case .gone: ["scope": scope.json, "kind": "gone"]
    case .notFound: ["scope": scope.json, "kind": "not-found"]
    }
  }
}

extension LiveFrame {
  nonisolated var logged: JSON.Object {
    switch self {
    case .change(let change):
      [
        "kind": "live-frame", "op": "change", "as": servedAsLogged, "scope": change.scope.json, "epoch": .string(change.epoch),
        "seq": JSON(change.seq), "ids": change.rows.map { .array($0.map(\.key.id.json)) } ?? .null,
      ]
    case .gone(let scope, _): ["kind": "live-frame", "op": "gone", "as": servedAsLogged, "scope": scope.json]
    case .notFound(let scope, _): ["kind": "live-frame", "op": "not-found", "as": servedAsLogged, "scope": scope.json]
    case .pong: ["kind": "live-frame", "op": "pong"]
    case .other(let op): ["kind": "live-frame", "op": .string(op)]
    }
  }
}
