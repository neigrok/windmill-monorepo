import Foundation
import GRDB
import SyncAPI
import SyncCore
@testable import SyncEngine
import SyncReplica
import SyncTesting
@testable import SyncStore
import Synchronization
import Testing

struct TelemetryTests {
  struct Recorded: Sendable, Equatable {
    let name: String
    let kind: String?
    let properties: [String: String]
    let durationMs: Int64?
  }

  final class Recorder: Telemetry {
    let records = Mutex<[Recorded]>([])
    var events: [Recorded] { records.withLock { $0.filter { $0.kind == nil } } }
    var failures: [Recorded] { records.withLock { $0.filter { $0.kind != nil } } }
    func event(_ name: String, properties: [String: String], durationMs: Int64?) {
      records.withLock { $0.append(Recorded(name: name, kind: nil, properties: properties, durationMs: durationMs)) }
    }
    func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) {
      records.withLock { $0.append(Recorded(name: operation, kind: kind, properties: properties, durationMs: durationMs)) }
    }
  }

  final class BlockedSink: Telemetry {
    let recorder = Recorder()
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let first = Mutex(true)
    let afterRelease: @Sendable () -> Void

    init(afterRelease: @escaping @Sendable () -> Void = {}) { self.afterRelease = afterRelease }

    func event(_ name: String, properties: [String: String], durationMs: Int64?) {
      block()
      recorder.event(name, properties: properties, durationMs: durationMs)
    }

    func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) {
      block()
      recorder.failure(operation, kind: kind, properties: properties, durationMs: durationMs)
    }

    func block() {
      guard first.withLock({ first in defer { first = false }; return first }) else { return }
      entered.signal()
      release.wait()
      afterRelease()
    }
  }

  // Tests join the worker only after engine operations have returned, outside its writer and publisher locks.
  func drain(_ telemetry: any Telemetry) async {
    guard let telemetry = telemetry as? BoundedTelemetry else { return }
    await withCheckedContinuation { continuation in
      telemetry.worker.async { continuation.resume() }
    }
  }

  func wait(_ signal: DispatchSemaphore, seconds: Int) async -> Bool {
    await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        continuation.resume(returning: signal.wait(timeout: .now() + .seconds(seconds)) == .success)
      }
    }
  }

  @Test func aBlockedSinkDoesNotDelayWritersOrSubscriptionsOrInflateWriterMeasurements() async throws {
    let clock = Mutex<SimClock?>(nil)
    let sink = BlockedSink { clock.withLock { $0 }?.advance(ms: 10_000) }
    defer { sink.release.signal() }
    let rig = try Rig(telemetry: sink)
    clock.withLock { $0 = rig.clock }
    let writeFinished = DispatchSemaphore(value: 0)
    let written = Mutex<Result<Duration, any Error>?>(nil)
    DispatchQueue.global(qos: .userInitiated).async {
      defer { writeFinished.signal() }
      let result = Result {
        try rig.engine.core.timedWrite { _, _ in
          rig.clock.advance(ms: 6)
          return Written(value: (), events: [.pushMalformed], change: StoreChange())
        }.held
      }
      written.withLock { $0 = result }
    }
    #expect(await wait(sink.entered, seconds: 5))
    let writeCompleted = await wait(writeFinished, seconds: 2)
    #expect(writeCompleted)

    let operationsFinished = DispatchSemaphore(value: 0)
    let operations = Mutex<Result<SubscribeOutcome, any Error>?>(nil)
    DispatchQueue.global(qos: .userInitiated).async {
      defer { operationsFinished.signal() }
      let result = Result {
        let stream = rig.engine.events()
        let subscribed = try rig.engine.subscribe(.tree("b_00000001"))
        try rig.commit(Gesture(changes: [Rig.card("card0001", "private")], gestureId: "g1"))
        withExtendedLifetime(stream) {}
        return subscribed
      }
      operations.withLock { $0 = result }
    }
    let operationsCompleted = await wait(operationsFinished, seconds: 2)
    #expect(operationsCompleted)
    sink.release.signal()
    if !writeCompleted { #expect(await wait(writeFinished, seconds: 5)) }
    if !operationsCompleted { #expect(await wait(operationsFinished, seconds: 5)) }
    let measured = try #require(written.withLock { $0 }).get()
    let subscribed = try #require(operations.withLock { $0 }).get()
    #expect(subscribed == .subscribed)
    #expect(measured == .milliseconds(6))
    rig.engine.core.slices.withLock { $0.record(.chunk(Rig.scope), took: 64, held: measured) }
    #expect(rig.engine.slices.size(.chunk(Rig.scope)) == 128)
    await drain(rig.engine.core.telemetry)
    #expect(sink.recorder.failures == [Recorded(name: "sync_admission", kind: "malformed", properties: [:], durationMs: nil)])
  }

  @Test func aBlockedSinkKeepsOnlyTheBoundedFIFOAndDropsOverflowWithoutReportingIt() async {
    let sink = BlockedSink()
    defer { sink.release.signal() }
    let telemetry = BoundedTelemetry(sink)
    telemetry.failure("sync_admission", kind: "malformed")
    #expect(await wait(sink.entered, seconds: 5))
    for index in 0..<(BoundedTelemetry.capacity + 1_024) {
      telemetry.event("sync_pull_outcome", properties: ["outcome": "ok"], durationMs: Int64(index))
    }
    #expect(telemetry.state.withLock { $0.pending.count } == 128)
    sink.release.signal()
    await drain(telemetry)
    #expect(sink.recorder.failures == [Recorded(name: "sync_admission", kind: "malformed", properties: [:], durationMs: nil)])
    #expect(sink.recorder.events == (0..<128).map {
      Recorded(name: "sync_pull_outcome", kind: nil, properties: ["outcome": "ok"], durationMs: Int64($0))
    })
  }

  final class FailedRequest: URLProtocol, @unchecked Sendable {
    static let codes = Mutex<[String: URLError.Code]>([:])
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
      let code = Self.codes.withLock { $0[request.url!.host!]! }
      client?.urlProtocol(self, didFailWithError: URLError(code))
    }
    override func stopLoading() {}
    static func transport(_ code: URLError.Code, telemetry: any Telemetry) -> HTTPTransport {
      let host = "telemetry-url-error-\(abs(code.rawValue)).test"
      codes.withLock { $0[host] = code }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [FailedRequest.self]
      return HTTPTransport(baseURL: URL(string: "https://\(host)/")!, schema: 3, configuration: configuration, telemetry: telemetry)
    }
  }

  @Test func expectedHTTPFailuresAreMetricsWithoutIssuesOrSensitiveData() async throws {
    let recorder = Recorder()
    for status in [400, 401, 403, 404, 409, 422, 429] {
      let transport = TransportTests.Stub.transport("telemetry-status-\(status).test", telemetry: recorder) { _, _ in
        (status, #"{"error":"private journal and bearer token","email":"person@example.test"}"#)
      }
      _ = await transport.hello(token: SessionToken("secret-session"))
    }
    #expect(recorder.failures.isEmpty)
    #expect(recorder.events.count == 7)
    for event in recorder.events {
      #expect(event.name == "api_request_failed")
      #expect(event.properties["operation"] == "sync_hello")
      #expect(event.properties["method"] == "GET")
      #expect(event.properties["route"] == "/v1/sync")
      #expect(event.properties["failure_kind"] == "http")
      #expect(Set(event.properties.keys) == ["operation", "method", "route", "failure_kind", "status"])
      #expect(try #require(event.durationMs) >= 0)
    }
  }

  @Test func serverAndMalformedSuccessfulResponsesReportOnlyBoundedDiagnostics() async throws {
    let recorder = Recorder()
    let server = TransportTests.Stub.transport("telemetry-server.test", telemetry: recorder) { _, _ in (503, "secret response body") }
    let malformed = TransportTests.Stub.transport("telemetry-decode.test", telemetry: recorder) { _, _ in (200, "private journal") }
    _ = await server.hello(token: nil)
    _ = await malformed.hello(token: nil)
    #expect(recorder.events.count == 2)
    #expect(recorder.failures.map(\.kind) == ["http", "decode"])
    #expect(recorder.failures.map(\.name) == ["sync_hello", "sync_hello"])
    #expect(recorder.failures.map(\.properties) == recorder.events.map(\.properties))
    #expect(!String(describing: recorder.failures).contains("private journal"))
    #expect(!String(describing: recorder.failures).contains("secret response body"))
  }

  @Test func offlineRequestsAreMetricsWithoutIssues() async throws {
    let recorder = Recorder()
    let transport = TransportTests.Stub.transport("telemetry-offline.test", telemetry: recorder) { _, _ in nil }
    _ = await transport.hello(token: nil)
    #expect(recorder.events.count == 1)
    #expect(recorder.events.first?.properties["failure_kind"] == "offline")
    #expect(recorder.failures.isEmpty)
  }

  @Test func timeoutAndTLSAreReportableWhileCancellationIsQuiet() async throws {
    let recorder = Recorder()
    for code in [URLError.Code.timedOut, .secureConnectionFailed, .cancelled] {
      _ = await FailedRequest.transport(code, telemetry: recorder).hello(token: SessionToken("secret-session"))
    }
    #expect(recorder.events.map { $0.properties["failure_kind"] } == ["timeout", "tls"])
    #expect(recorder.failures.map(\.kind) == ["timeout", "tls"])
    #expect(recorder.failures.allSatisfy { $0.durationMs != nil })
  }

  @Test(.timeLimit(.minutes(1))) func engineAndTransportOwnOnlyOneReportWhenTheRequestDeadlineWins() async throws {
    let recorder = Recorder()
    let rig = try Rig(telemetry: recorder)
    rig.transport.willNotAnswerPush()
    async let exchanging = rig.engine.core.answered(operation: "sync_push") {
      let reply = await rig.transport.push(TransportTests.request, token: SessionToken("private-session"))
      // A late transport callback after the engine cancels it must not create a second metric or Issue.
      TransportDiagnostics.report(recorder, operation: "sync_push", method: "POST", kind: "transport", durationMs: 60_000)
      return reply
    }
    await rig.clock.asleep(until: Constants.requestTimeoutMs)
    rig.clock.advance(ms: Constants.requestTimeoutMs)
    let exchange = await exchanging
    await drain(rig.engine.core.telemetry)
    #expect(exchange.failureKind == "timeout")
    #expect(recorder.events.count == 1)
    #expect(recorder.failures.count == 1)
    #expect(recorder.failures.first?.kind == "timeout")
    #expect(recorder.failures.first?.durationMs == Constants.requestTimeoutMs)
  }

  @Test func syncPullAndPushOutcomesCarryDurationAndNoRecordContent() async throws {
    let recorder = Recorder()
    let rig = try Rig(account: "A", telemetry: recorder)
    let card = try Rig.cardRow("card0001", "private", seq: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([card], seq: 1)]))
    _ = await rig.engine.puller.step()
    try rig.commit(Gesture(changes: [Rig.card("card0002", "secret")], gestureId: "private-id"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.admitted(1, seq: 2)]))
    _ = await rig.engine.sender.step()
    await drain(rig.engine.core.telemetry)
    #expect(recorder.events.map(\.name) == ["sync_pull_outcome", "sync_push_outcome"])
    #expect(recorder.events.allSatisfy { $0.properties == ["outcome": "ok"] && $0.durationMs == 0 })
    #expect(recorder.failures.isEmpty)
  }

  @Test func digestMismatchReportsScopeKindWithoutDigestOrRecordIdentifiers() async throws {
    let recorder = Recorder()
    let rig = try Rig(account: "A", telemetry: recorder)
    let card = try Rig.cardRow("card0001", "private", seq: 1)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([card], seq: 1, digestOf: [])]))
    _ = await rig.engine.puller.step()
    await drain(rig.engine.core.telemetry)
    #expect(recorder.failures == [Recorded(name: "sync_digest", kind: "digest_mismatch", properties: ["scope_kind": "product"], durationMs: nil)])
  }

  @Test func aSuccessfulPullWhoseStoreTransactionFailsHasAFailedSyncOutcome() async throws {
    let recorder = Recorder()
    let rig = try Rig(account: "A", crashPoints: CrashPoints { point in
      if point == .beforeCommit(.pullPage) { throw StoreError.corrupt("private stored value") }
    }, telemetry: recorder)
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([], seq: 1)]))
    _ = await rig.engine.puller.step()
    await drain(rig.engine.core.telemetry)
    #expect(recorder.events == [Recorded(name: "sync_pull_outcome", kind: nil,
                                        properties: ["outcome": "failed", "failure_kind": "storage"], durationMs: 0)])
    #expect(recorder.failures == [Recorded(name: "storage_write", kind: "storage", properties: [:], durationMs: nil)])
  }

  @Test func unexpectedAdmissionReportsWithoutRefusalDetails() async throws {
    let recorder = Recorder()
    let rig = try Rig(account: "A", telemetry: recorder)
    try rig.commit(Gesture(changes: [Rig.card("card0001", "private")], gestureId: "secret-id"))
    rig.transport.willAnswerPush(200, Rig.ok(lastN: 1, [Rig.refused(1, "internal")]))
    _ = await rig.engine.sender.step()
    await drain(rig.engine.core.telemetry)
    #expect(recorder.failures == [Recorded(name: "sync_admission", kind: "unexpected_admission", properties: [:], durationMs: nil)])
  }

  @Test func corruptStoreReadEnqueuesAStaticDiagnosticAndPropagatesTheFailure() async throws {
    let recorder = Recorder()
    let armed = Mutex(false)
    let rig = try Rig(crashPoints: CrashPoints { point in
      if point == .read, armed.withLock({ $0 }) { throw StoreError.corrupt("private stored value") }
    }, telemetry: recorder)
    armed.withLock { $0 = true }
    #expect(throws: StoreError.corrupt("private stored value")) { try rig.engine.activeReplica() }
    await drain(rig.engine.core.telemetry)
    #expect(recorder.failures == [Recorded(name: "storage_read", kind: "storage", properties: [:], durationMs: nil)])
  }

  @Test func sqliteReadFailureReportsWithoutSQLOrBindings() async throws {
    let recorder = Recorder()
    let rig = try Rig(telemetry: recorder)
    try await rig.store.writer.write { db in try db.execute(sql: "DROP TABLE device") }
    #expect(throws: DatabaseError.self) { try rig.engine.activeReplica() }
    await drain(rig.engine.core.telemetry)
    #expect(recorder.failures == [Recorded(name: "storage_read", kind: "sqlite", properties: [:], durationMs: nil)])
  }

  @Test func corruptStoreWriteIsReportedOnceAndProductBodyFailuresStayProductFailures() async throws {
    let recorder = Recorder()
    let armed = Mutex(false)
    let rig = try Rig(crashPoints: CrashPoints { point in
      if point == .beforeCommit(.commit), armed.withLock({ $0 }) { throw StoreError.corrupt("private stored value") }
    }, telemetry: recorder)
    #expect(throws: RigError.self) {
      try rig.engine.commit(Rig.scope) { _ -> (Gesture?, ()) in throw RigError("private body") }
    }
    #expect(recorder.failures.isEmpty)
    armed.withLock { $0 = true }
    #expect(throws: CommitFailure.self) {
      try rig.commit(Gesture(changes: [Rig.card("card0001", "private")], gestureId: "secret-id"))
    }
    await drain(rig.engine.core.telemetry)
    #expect(recorder.failures == [Recorded(name: "storage_write", kind: "storage", properties: [:], durationMs: nil)])
  }

  @Test func doubtAtTheBackoffCeilingReportsOnceUntilARowsPageSettlesIt() async throws {
    let recorder = Recorder()
    let rig = try Rig(account: "A", telemetry: recorder)
    for _ in 0..<8 {
      rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "gone")]))
      _ = await rig.engine.puller.step()
      rig.clock.advance(ms: 31_000)
    }
    await drain(rig.engine.core.telemetry)
    #expect(recorder.failures == [Recorded(name: "sync_doubt", kind: "backoff_exhausted", properties: ["scope_kind": "product"], durationMs: nil)])
    rig.transport.willAnswerPull(200, Rig.pulled([Rig.rows([], seq: 1)]))
    _ = await rig.engine.puller.step()
    rig.clock.advance(ms: 31_000)
    for _ in 0..<8 {
      rig.transport.willAnswerPull(200, Rig.pulled([Rig.page(Rig.scope, "gone")]))
      _ = await rig.engine.puller.step()
      rig.clock.advance(ms: 31_000)
    }
    await drain(rig.engine.core.telemetry)
    #expect(recorder.failures.count == 2)
  }
}
