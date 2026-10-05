import Foundation
import Sentry
import Testing
import SyncEngine
import SyncTesting
import DomainKit
import DomainKitTesting
import JournalDomain
import SyncModelServer
import SyncSchema
import Synchronization
@testable import Windmill

nonisolated final class TelemetryDelivery: Sendable {
  struct State { var requests: [URLRequest] = []; var statuses: [Int] = []; var accepted: Int? }
  let state = Mutex(State())
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as! [String: Any]
    let count = (body["events"] as! [Any]).count
    let (status, accepted) = state.withLock { state -> (Int, Int) in
      state.requests.append(request)
      return (state.statuses.isEmpty ? 202 : state.statuses.removeFirst(), state.accepted ?? count)
    }
    return (Data("{\"accepted\":\(accepted)}".utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
  }
}

nonisolated final class TelemetryRecorder: Telemetry {
  struct Entry: Sendable { let name: String; let properties: [String: String] }
  let entries = Mutex<[Entry]>([])
  func event(_ name: String, properties: [String: String], durationMs: Int64?) { entries.withLock { $0.append(Entry(name: name, properties: properties)) } }
  func failure(_ operation: String, kind: String, properties: [String: String], durationMs: Int64?) { event("client_error", properties: ["operation": operation, "failure_kind": kind], durationMs: durationMs) }
}

nonisolated final class TelemetryBuffer<Value: Sendable>: Sendable {
  let state: Mutex<Value>
  init(_ value: Value) { state = Mutex(value) }
  func withLock<Result>(_ body: (inout sending Value) throws -> sending Result) rethrows -> sending Result { try state.withLock(body) }
}

@Suite(.serialized) @MainActor struct TelemetryTests {
  let info: [String: Any] = ["WMSentryDSN": "https://ios@example.invalid/42", "WMDebugTelemetry": "YES",
                             "CFBundleShortVersionString": "0.2.0", "CFBundleVersion": "71", "WMSourceRevision": "abc123", "WMTelemetryEnvironment": "test"]
  func directory() -> URL { URL.temporaryDirectory.appending(path: UUID().uuidString) }
  func queue(file: URL, delivery: TelemetryDelivery, identity: TelemetryBuffer<AppTelemetry.Identity>? = nil,
             failures: TelemetryBuffer<[String]>? = nil) -> EventQueue {
    EventQueue(file: file, baseURL: URL(string: "https://first-party.invalid")!, metadata: TelemetryMetadata(info: info),
               credentials: { identity?.withLock { $0 } ?? AppTelemetry.Identity() },
               report: { operation, _, _, _ in failures?.withLock { $0.append(operation) } }, deliver: delivery.send, retryInterval: 0)
  }

  @Test func debugIsOptInAndMetadataMatchesReleaseConvention() {
    #expect(CrashReports.options(info: [:], debug: true) == nil)
    var disabled = info; disabled["WMDebugTelemetry"] = "NO"
    #expect(CrashReports.options(info: disabled, debug: true) == nil)
    #expect(CrashReports.options(info: disabled, debug: false)?.releaseName == "ios-0.2.0-abc123")
    #expect(CrashReports.options(info: info, debug: true)?.dist == "71")
  }

  @Test func propertyFilterExcludesAllContentAndRetainsNumericLatency() throws {
    let filtered = TelemetryPrivacy.properties(["email": "private-marker", "text": "private-marker", "mood": "8", "energy": "2",
                                                "operation": "private-marker", "screen": "code", "status": "502", "failure_kind": "http"], durationMs: 123)
    #expect(filtered == ["screen": .label("code"), "status": .label("502"), "failure_kind": .label("http"), "duration_ms": .number(123)])
    let bytes = try JSONEncoder().encode(filtered)
    #expect(!String(decoding: bytes, as: UTF8.self).contains("private-marker"))
  }

  @Test func writingChoicesRetainOnlyBoundedLabels() {
    for action in ["write", "done_writing"] {
      #expect(TelemetryPrivacy.properties(["screen": "journal", "action": action, "text": "private-marker", "mood": "8"]) ==
              ["screen": .label("journal"), "action": .label(action)])
    }
    #expect(TelemetryPrivacy.properties(["action": "private-marker"]).isEmpty)
  }

  @Test func sdkScrubsPrivateFieldsBeforeDelivery() async throws {
    let options = try #require(CrashReports.options(info: info, debug: true))
    let delivered = TelemetryBuffer<String?>(nil)
    options.beforeSend = { event in
      let scrubbed = CrashReports.scrub(event)!
      delivered.withLock { $0 = String(decoding: (try? JSONSerialization.data(withJSONObject: scrubbed.serialize())) ?? Data(), as: UTF8.self) }
      return nil
    }
    SentrySDK.start(options: options)
    defer { SentrySDK.close() }
    let event = Event(level: .error)
    event.message = SentryMessage(formatted: "private-marker"); event.user = User(userId: "private-marker")
    event.request = SentryRequest(); event.request?.url = "https://private-marker.invalid"
    event.extra = ["text": "private-marker"]; event.breadcrumbs = [Breadcrumb(level: .info, category: "private-marker")]
    event.tags = ["operation": "auth_request_code", "failure_kind": "http", "email": "private-marker"]
    event.context = ["custom": ["text": "private-marker"], "app": ["device_app_hash": "private-marker", "view_names": ["private-marker"]], "telemetry": ["duration_ms": 123, "text": "private-marker"]]
    let exception = Exception(value: "private-marker", type: "BoundaryFailure")
    exception.mechanism = Mechanism(type: "handled"); exception.mechanism?.handled = true
    exception.mechanism?.data = ["text": "private-marker"]; exception.mechanism?.desc = "private-marker"
    event.exceptions = [exception]
    SentrySDK.capture(event: event)
    for _ in 0..<100 { if delivered.withLock({ $0 != nil }) { break }; try await Task.sleep(for: .milliseconds(50)) }
    let json = try #require(delivered.withLock { $0 })
    #expect(!json.contains("private-marker"))
    #expect(json.contains("duration_ms") && json.contains("123") && json.contains("BoundaryFailure"))
    #expect(json.contains("ios-0.2.0-abc123"))
  }

  @Test func retryAndRelaunchKeepEventIdsAndPersistNoCredentials() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    delivery.state.withLock { $0.statuses = [503] }
    let first = queue(file: file, delivery: delivery)
    await first.record("journal_line_saved", properties: ["day_kind": .label("today")], account: nil)
    let before = try JSONDecoder().decode(EventQueue.State.self, from: Data(contentsOf: file))
    #expect(before.events.count == 1)
    let restored = queue(file: file, delivery: delivery)
    await restored.flush()
    let requests = delivery.state.withLock { $0.requests }
    let bodies = try requests.map { try JSONSerialization.jsonObject(with: $0.httpBody!) as! [String: Any] }
    #expect(bodies.count == 2)
    #expect((bodies[0]["events"] as! [[String: Any]])[0]["id"] as? String == before.events[0].id)
    #expect((bodies[1]["events"] as! [[String: Any]])[0]["id"] as? String == before.events[0].id)
    #expect(bodies[0]["sessionKey"] as? String == bodies[1]["sessionKey"] as? String)
    #expect(await restored.state.events.isEmpty)
    #expect(!String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("Bearer"))
  }

  @Test func persistedQueueIsFilteredAgainBeforeDelivery() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    var state = EventQueue.State()
    state.events = [EventQueue.Item(id: UUID().uuidString, name: "journal_line_saved", clientMs: 1,
                                  props: ["text": .label("private-marker"), "mood": .number(8), "energy": .number(2), "day_kind": .label("today")], account: nil)]
    try JSONEncoder().encode(state).write(to: file)
    let events = queue(file: file, delivery: delivery); await events.flush()
    let body = try #require(delivery.state.withLock { $0.requests.first?.httpBody })
    let json = String(decoding: body, as: UTF8.self)
    #expect(!json.contains("private-marker") && !json.contains("mood") && !json.contains("energy"))
    #expect(json.contains("day_kind") && json.contains("ios-0.2.0-abc123"))
  }

  @Test func batchesNeverExceedFifty() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    var state = EventQueue.State()
    state.events = (0..<123).map { _ in EventQueue.Item(id: UUID().uuidString, name: "app_started", clientMs: 1, props: [:], account: nil) }
    try JSONEncoder().encode(state).write(to: file)
    let events = queue(file: file, delivery: delivery); await events.flush()
    let counts = try delivery.state.withLock { try $0.requests.map { ((try JSONSerialization.jsonObject(with: $0.httpBody!) as! [String: Any])["events"] as! [Any]).count } }
    #expect(counts == [50, 50, 23])
  }

  @Test func anonymousAndAccountShelvesUseOnlyTheirOwnCredentials() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery()
    let identity = TelemetryBuffer(AppTelemetry.Identity())
    let events = queue(file: file, delivery: delivery, identity: identity)
    await events.record("app_started", properties: [:], account: "account-a")
    await events.record("app_started", properties: [:], account: "account-b")
    await events.record("app_started", properties: [:], account: nil)
    #expect(await events.state.events.count == 2)
    identity.withLock { $0 = AppTelemetry.Identity(account: "account-a", token: SessionToken("token-a")) }
    await events.flush()
    #expect(await events.state.events.map(\.account) == ["account-b"])
    identity.withLock { $0 = AppTelemetry.Identity(account: "account-b", token: SessionToken("token-b")) }
    await events.flush()
    #expect(delivery.state.withLock { $0.requests.map { $0.value(forHTTPHeaderField: "Authorization") } } == [nil, "Bearer token-a", "Bearer token-b"])
    #expect(!String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("token-"))
  }

  @Test func partialAcceptanceDropsSubmittedBatchWithoutRecursion() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let delivery = TelemetryDelivery(), failures = TelemetryBuffer<[String]>([])
    delivery.state.withLock { $0.accepted = 0 }
    let events = queue(file: dir.appending(path: "events.json"), delivery: delivery, failures: failures)
    await events.record("app_started", properties: [:], account: nil)
    #expect(await events.state.events.isEmpty)
    #expect(failures.withLock { $0 } == ["telemetry_rejected"])
  }

  @Test func invalidAcknowledgementRetriesAndReportsOncePerFailureStreak() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let delivery = TelemetryDelivery(), failures = TelemetryBuffer<[String]>([])
    delivery.state.withLock { $0.accepted = 99 }
    let events = queue(file: dir.appending(path: "events.json"), delivery: delivery, failures: failures)
    await events.record("app_started", properties: [:], account: nil)
    await events.flush()
    #expect(await events.state.events.count == 1)
    #expect(failures.withLock { $0 } == ["telemetry_delivery"])
    delivery.state.withLock { $0.accepted = nil }
    await events.flush()
    #expect(await events.state.events.isEmpty)
    delivery.state.withLock { $0.accepted = 99 }
    await events.record("app_started", properties: [:], account: nil)
    #expect(failures.withLock { $0 } == ["telemetry_delivery", "telemetry_delivery"])
  }

  @Test func fullQueueRejectsNewEventsWithoutEvictingAnotherAccount() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "events.json"), delivery = TelemetryDelivery(), failures = TelemetryBuffer<[String]>([])
    var state = EventQueue.State()
    state.events = (0..<500).map { _ in EventQueue.Item(id: UUID().uuidString, name: "app_started", clientMs: 1, props: [:], account: "dormant-account") }
    try JSONEncoder().encode(state).write(to: file)
    let events = queue(file: file, delivery: delivery, failures: failures)
    await events.record("app_started", properties: [:], account: nil)
    await events.record("app_started", properties: [:], account: nil)
    #expect(await events.state.events.map(\.id) == state.events.map(\.id))
    #expect(await events.state.events.map(\.account) == state.events.map(\.account))
    #expect(failures.withLock { $0 } == ["telemetry_overflow"])
    #expect(delivery.state.withLock { $0.requests.isEmpty })
  }

  @Test func restorationDoesNotBlockStartupAndPreservesEventsDuringLoad() async throws {
    let entered = TelemetryBuffer(false), release = DispatchSemaphore(value: 0)
    let delivery = TelemetryDelivery(), dir = directory()
    defer { release.signal(); try? FileManager.default.removeItem(at: dir) }
    var stored = EventQueue.State()
    stored.events = [EventQueue.Item(id: UUID().uuidString, name: "app_started", clientMs: 1, props: [:], account: nil)]
    let bytes = try JSONEncoder().encode(stored)
    let start = ContinuousClock.now
    let events = EventQueue(file: dir.appending(path: "events.json"), baseURL: URL(string: "https://first-party.invalid")!,
                            metadata: TelemetryMetadata(info: info), credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in },
                            deliver: delivery.send, load: { _ in
      entered.withLock { $0 = true }
      _ = release.wait(timeout: .now() + 5)
      return bytes
    })
    #expect(start.duration(to: .now) < .seconds(1))
    let recording = Task { await events.record("app_foregrounded", properties: [:], account: nil) }
    for _ in 0..<100 { if entered.withLock({ $0 }) { break }; try await Task.sleep(for: .milliseconds(10)) }
    #expect(entered.withLock { $0 })
    #expect(delivery.state.withLock { $0.requests.isEmpty })
    release.signal()
    await recording.value
    let request = try #require(delivery.state.withLock { $0.requests.first })
    let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
    let submitted = body["events"] as! [[String: Any]]
    #expect(submitted.map { $0["name"] as! String } == ["app_started", "app_foregrounded"])
    #expect(submitted.first?["id"] as? String == stored.events.first?.id)
  }

  @Test func restorationBoundsBytesBeforeReadingAndIfFileGrows() throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appending(path: "events.json")
    #expect(FileManager.default.createFile(atPath: file.path, contents: Data()))
    let handle = try FileHandle(forWritingTo: file)
    try handle.truncate(atOffset: UInt64(EventQueue.maximumBytes + 1)); try handle.close()
    var reads = 0
    #expect(throws: CocoaError.self) { try EventQueue.read(file) { _, _ in reads += 1; return Data() } }
    #expect(reads == 0)
    try Data().write(to: file)
    #expect(throws: CocoaError.self) {
      try EventQueue.read(file) { _, limit in
        #expect(limit == EventQueue.maximumBytes + 1)
        return Data(count: limit)
      }
    }
  }

  @Test func fullDirtyQueueRetriesStorageBeforeDeliveryAndRecovers() async throws {
    let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
    let delivery = TelemetryDelivery(), failures = TelemetryBuffer<[String]>([]), attempts = TelemetryBuffer(0)
    var stored = EventQueue.State()
    stored.events = (0..<499).map { _ in EventQueue.Item(id: UUID().uuidString, name: "app_started", clientMs: 1, props: [:], account: nil) }
    let bytes = try JSONEncoder().encode(stored)
    let events = EventQueue(file: dir.appending(path: "events.json"), baseURL: URL(string: "https://first-party.invalid")!,
                            metadata: TelemetryMetadata(info: info), credentials: { AppTelemetry.Identity() },
                            report: { operation, _, _, _ in failures.withLock { $0.append(operation) } }, deliver: delivery.send,
                            retryInterval: 0, load: { _ in bytes }, save: { data, file in
      let count = attempts.withLock { $0 += 1; return $0 }
      if count <= 2 { throw CocoaError(.fileWriteOutOfSpace) }
      try EventQueue.write(data, to: file)
    })
    await events.record("app_foregrounded", properties: [:], account: nil)
    let ids = await events.state.events.map(\.id)
    #expect(ids.count == 500 && delivery.state.withLock { $0.requests.isEmpty })
    await events.record("app_backgrounded", properties: [:], account: nil) // Capacity must still permit a storage retry.
    #expect(await events.state.events.map(\.id) == ids)
    #expect(delivery.state.withLock { $0.requests.isEmpty })
    await events.flush() // The same scheduled flush path recovers without relaunch or another event.
    #expect(await events.state.events.isEmpty)
    let requests = delivery.state.withLock { $0.requests }
    #expect(requests.count == 10)
    let sent = try requests.flatMap { request in
      ((try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any])["events"] as! [[String: Any]]).map { $0["id"] as! String }
    }
    #expect(sent == ids)
    #expect(failures.withLock { $0 } == ["telemetry_storage", "telemetry_overflow"])
  }

  @Test func storageRetriesBackOffAndStayBounded() async throws {
    let dir = directory(), attempts = TelemetryBuffer(0), clock = TelemetryBuffer(Date())
    let events = EventQueue(file: dir.appending(path: "events.json"), baseURL: URL(string: "https://first-party.invalid")!,
                            metadata: TelemetryMetadata(info: info), credentials: { AppTelemetry.Identity() }, report: { _, _, _, _ in },
                            load: { _ in nil }, save: { _, _ in attempts.withLock { $0 += 1 }; throw CocoaError(.fileWriteOutOfSpace) },
                            now: { clock.withLock { $0 } })
    await events.record("app_started", properties: [:], account: nil)
    await events.record("app_foregrounded", properties: [:], account: nil)
    #expect(attempts.withLock { $0 } == 1)
    for delay in [1.0, 2, 4, 8, 16, 30, 30] {
      let before = attempts.withLock { $0 }
      clock.withLock { $0 = $0.addingTimeInterval(delay - 0.125) }
      await events.flush()
      #expect(attempts.withLock { $0 } == before)
      clock.withLock { $0 = $0.addingTimeInterval(0.125) }
      await events.flush()
      #expect(attempts.withLock { $0 } == before + 1)
    }
    #expect(await events.state.events.count == 2)
  }

  @Test func firstRunReportsChoicesAndSaveWithoutTextOrScaleValues() throws {
    let harness = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry),
                          commandResultWrites: JournalWriting.resultWrites, pendingDeviceWork: JournalWriting.pendingWork)
    let recorder = TelemetryRecorder()
    let model = try JournalModel(runner: harness.runner, preferences: UserDefaults(suiteName: UUID().uuidString)!, telemetry: recorder)
    model.openJournal(); model.type("private-marker"); #expect(model.save()); model.done(); model.setScale("mood", 8); model.setScale("energy", 2); model.keep(); model.closeKeep()
    let entries = recorder.entries.withLock { $0 }
    #expect(entries.filter { $0.name == "journal_line_saved" }.count == 1)
    #expect(entries.contains { $0.name == "scale_invitation_shown" })
    #expect(entries.filter { $0.name == "scale_invitation_answered" }.map(\.properties) == [["action": "answered"]])
    #expect(entries.contains { $0.properties == ["screen": "journal", "action": "keep"] })
    #expect(entries.allSatisfy { !$0.properties.values.contains("private-marker") && $0.properties["mood"] == nil && $0.properties["energy"] == nil })
    model.saveTask?.cancel()
  }
}
