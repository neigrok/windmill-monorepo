import Foundation

nonisolated enum EventValue: Codable, Sendable, Equatable {
  case label(String)
  case number(Int64)
  init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer()
    if let number = try? value.decode(Int64.self) { self = .number(number) }
    else { self = .label(try value.decode(String.self)) }
  }
  func encode(to encoder: any Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self { case .label(let label): try value.encode(label); case .number(let number): try value.encode(number) }
  }
}

actor EventQueue {
  struct Item: Codable, Sendable, Equatable {
    let id: String
    let name: String
    let clientMs: Int64
    let props: [String: EventValue]
    let account: String?
  }
  struct State: Codable, Sendable {
    var sessionKey = UUID().uuidString
    var events: [Item] = []
  }
  struct Batch: Encodable {
    struct Event: Encodable {
      let id: String; let name: String; let clientMs: Int64; let props: [String: EventValue]
    }
    let sessionKey: String
    let platform = "ios"
    let events: [Event]
  }
  struct Acknowledgement: Decodable { let accepted: Int }
  typealias Delivery = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
  typealias Load = @Sendable (URL) throws -> Data?
  typealias Save = @Sendable (Data, URL) throws -> Void
  static let maximumBytes = 1_048_576
  typealias Report = @Sendable (String, String, [String: String], Int64?) -> Void
  let file: URL
  let baseURL: URL
  let metadata: TelemetryMetadata
  let credentials: @Sendable () -> AppTelemetry.Identity
  let deliver: Delivery
  let report: Report
  var state = State()
  var restoration: Task<State, Never>?
  let save: Save
  var dirty = false
  var storageBackoff: TimeInterval = 0
  let retryInterval: TimeInterval
  let now: @Sendable () -> Date
  var retryAt = Date.distantPast
  var sending = false
  var failed = false
  var overflow = false
  var storageFailed = false

  init(file: URL, baseURL: URL, metadata: TelemetryMetadata,
       credentials: @escaping @Sendable () -> AppTelemetry.Identity,
       report: @escaping Report, deliver: Delivery? = nil, retryInterval: TimeInterval = 30,
       load: @escaping Load = { try EventQueue.read($0) }, save: @escaping Save = EventQueue.write,
       now: @escaping @Sendable () -> Date = { Date() }) {
    self.retryInterval = retryInterval; self.now = now
    self.file = file; self.baseURL = baseURL; self.metadata = metadata
    self.credentials = credentials; self.report = report; self.save = save
    if let deliver { self.deliver = deliver }
    else {
      let config = URLSessionConfiguration.ephemeral
      config.httpCookieStorage = nil; config.urlCache = nil; config.httpShouldSetCookies = false
      config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 60
      let session = URLSession(configuration: config)
      self.deliver = { request in
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, response)
      }
    }
    // Neither opening the file nor decoding it can run on the caller's startup executor.
    restoration = Task.detached(priority: .utility) {
      do {
        guard let data = try load(file) else { return State() }
        var restored = try JSONDecoder().decode(State.self, from: data)
        guard restored.events.count <= 500, UUID(uuidString: restored.sessionKey) != nil,
              restored.events.allSatisfy({ UUID(uuidString: $0.id) != nil && TelemetryPrivacy.events.contains($0.name) }) else { throw CocoaError(.fileReadCorruptFile) }
        restored.events = restored.events.map {
          Item(id: $0.id, name: $0.name, clientMs: $0.clientMs,
               props: TelemetryPrivacy.persistedProperties($0.props, fallback: metadata), account: $0.account)
        }
        return restored
      } catch {
        report("telemetry_storage", "storage", [:], nil)
        return State()
      }
    }
  }

  static func read(_ file: URL, readBytes: (FileHandle, Int) throws -> Data? = { try $0.read(upToCount: $1) }) throws -> Data? {
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    guard try handle.seekToEnd() <= maximumBytes else { throw CocoaError(.fileReadTooLarge) }
    try handle.seek(toOffset: 0)
    // Also bound the read if the file grows after the size check.
    let data = try readBytes(handle, maximumBytes + 1) ?? Data()
    guard data.count <= maximumBytes else { throw CocoaError(.fileReadTooLarge) }
    return data
  }

  static func write(_ data: Data, to file: URL) throws {
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    var directory = file.deletingLastPathComponent()
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  func restore() async {
    guard let pending = restoration else { return }
    let restored = await pending.value
    // Other callers can await the same worker while this actor is suspended.
    if restoration != nil { state = restored; restoration = nil }
  }

  func record(_ name: String, properties: [String: EventValue], account: String?) async {
    guard TelemetryPrivacy.events.contains(name) else { return }
    await restore()
    guard state.events.count < 500 else {
      if !overflow { overflow = true; report("telemetry_overflow", "overflow", [:], nil) }
      await flush()
      return
    }
    state.events.append(Item(id: UUID().uuidString, name: name, clientMs: Int64(Date().timeIntervalSince1970 * 1_000),
                             props: TelemetryPrivacy.persistedProperties(properties, fallback: metadata), account: account))
    dirty = true
    if !storageFailed || now() >= retryAt { guard persist() else { return } }
    await flush()
  }

  @discardableResult func persist() -> Bool {
    do {
      try save(JSONEncoder().encode(state), file)
      dirty = false; storageFailed = false; storageBackoff = 0
      return true
    } catch {
      if !storageFailed { storageFailed = true; report("telemetry_storage", "storage", [:], nil) }
      storageBackoff = min(retryInterval, storageBackoff == 0 ? 1 : storageBackoff * 2)
      retryAt = now().addingTimeInterval(storageBackoff)
      return false
    }
  }

  func flush() async {
    await restore()
    guard !sending, now() >= retryAt else { return }
    sending = true
    defer { sending = false }
    while true {
      // Recovery is required before delivery, even when all 500 slots are occupied.
      if dirty && !persist() { return }
      let identity = credentials()
      guard let first = state.events.first(where: { $0.account == nil || ($0.account == identity.account && identity.token != nil) }) else { return }
      let items = Array(state.events.filter { $0.account == first.account }.prefix(50))
      let ids = Set(items.map(\.id))
      let batch = Batch(sessionKey: state.sessionKey, events: items.map { Batch.Event(id: $0.id, name: $0.name, clientMs: $0.clientMs, props: $0.props) })
      var request = URLRequest(url: baseURL.appending(path: "v1/events"))
      request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      if first.account != nil, let token = identity.token { request.setValue("Bearer " + token.value, forHTTPHeaderField: "Authorization") }
      let start = ContinuousClock.now
      var kind = "transport"
      var status: Int?
      do {
        kind = "encode"; request.httpBody = try JSONEncoder().encode(batch)
        kind = "transport"
        let (data, response) = try await deliver(request)
        status = response.statusCode
        guard response.statusCode == 202 else { kind = "http"; throw URLError(.badServerResponse) }
        kind = "decode"
        let accepted = try JSONDecoder().decode(Acknowledgement.self, from: data).accepted
        guard (0...items.count).contains(accepted) else { throw URLError(.cannotParseResponse) }
        if accepted != items.count { report("telemetry_rejected", "rejected", ["method": "POST", "route": "/v1/events"], nil) }
        state.events.removeAll { ids.contains($0.id) }
        dirty = true
        if !persist() { return }
        failed = false; overflow = false; retryAt = .distantPast
      } catch {
        retryAt = now().addingTimeInterval(retryInterval)
        if error is CancellationError { return }
        if let error = error as? URLError {
          if error.code == .cancelled { return }
          if [.notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost].contains(error.code) { return }
          if error.code == .timedOut { kind = "timeout" }
        }
        if let status, [400, 401, 403, 404, 409, 422, 429].contains(status) { return }
        if !failed {
          failed = true
          let elapsed = start.duration(to: .now).components
          let ms = elapsed.seconds * 1_000 + elapsed.attoseconds / 1_000_000_000_000_000
          var props = ["method": "POST", "route": "/v1/events"]
          if let status { props["status"] = String(status) }
          report("telemetry_delivery", kind, props, ms)
        }
        return
      }
    }
  }
}
