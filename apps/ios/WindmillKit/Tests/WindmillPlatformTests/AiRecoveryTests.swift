import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite @MainActor struct AiRecoveryTests {
  @Test func unvalidatedHTTPFailuresRetryTheIdenticalTextRequestQuietly() async throws {
    let responses = [
      AiResponse(status: 502, contentType: "text/html", bytes: AsyncThrowingStream { $0.yield(Array("<html>Bad gateway</html>".utf8)); $0.finish() }),
      ValidationTransport.json(["code": "paused"], status: 503),
      ValidationTransport.json(["code": "unknown", "allowance": .null], status: 503),
      ValidationTransport.json(["code": "paused", "allowance": .null], status: 400),
      AiResponse(status: 503, contentType: "application/json", bytes: AsyncThrowingStream { $0.finish(throwing: AiTransportFailure.offline) }),
    ]
    let profile = try AiPolicyTests.profile()
    for response in responses {
      let transport = ValidationTransport([ValidationTransport.pass(), response, Self.completed()])
      let diagnostics = PolicyDiagnostics()
      let clock = PolicyClock()
      let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      var events: [String] = []
      do { try await client.call(id: String(repeating: "A", count: 22), request: ["private": "question"], profile: profile, seat: Seat(kind: .anon, key: "seat"), pictures: []) { events.append($0.name) } }
      catch { Issue.record("Unvalidated HTTP failure ended the call") }
      #expect(events == ["ended"])
      #expect(transport.requests.map(\.method) == ["POST", "PUT", "PUT"])
      #expect(transport.requests.last?.body == transport.requests[1].body)
      #expect(clock.nowMs == 1_000)
      #expect(diagnostics.failures == [])
    }
  }

  @Test func refreshTransportLossAfterDispatchKeepsAskingWithAdmission() async throws {
    let profile = try AiPolicyTests.profile()
    for refreshSucceeds in [false, true] {
      let clock = PolicyClock()
      let diagnostics = PolicyDiagnostics()
      let transport = RecoveryTransport([
        .success(ValidationTransport.pass()),
        .failure(.offline),
        .failure(.offline),
        .success(ValidationTransport.json(["code": "rate_limited", "error": "Refused"], status: 429)),
        .success(ValidationTransport.json(["code": "unavailable", "error": "Refused"], status: 503)),
        refreshSucceeds ? .success(ValidationTransport.pass()) : .failure(.offline),
        refreshSucceeds ? .success(Self.completed()) : .failure(.offline),
      ])
      transport.beforeResponse = { count in if count == 2 { clock.nowMs = 540_001 } }
      let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      var events: [String] = []
      do {
        try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile, seat: Seat(kind: .anon, key: "seat"), pictures: []) { events.append($0.name) }
        #expect(refreshSucceeds)
      } catch let failure as AiFailure {
        #expect(!refreshSucceeds)
        #expect(failure.code == "answer-timeout")
        #expect(failure.admission == .possible)
      }
      #expect(events == (refreshSucceeds ? ["ended"] : []))
      #expect(clock.nowMs == (refreshSucceeds ? 555_001 : 1_200_000))
      #expect(transport.requests.filter { $0.method == "PUT" }.count == (refreshSucceeds ? 2 : 1))
    }
  }

  @Test func resentPUTKeepsTheThirtySecondTransientWindow() async throws {
    let profile = try AiPolicyTests.profile()
    for code in ["paused", "concurrency_exhausted", "provider_unavailable"] {
      let diagnostics = PolicyDiagnostics()
      let clock = PolicyClock()
      let transport = RecoveryTransport([.success(ValidationTransport.pass()), .failure(.offline)] + (0..<8).map { _ in
        .success(ValidationTransport.json(["code": .string(code), "allowance": .null], status: AiWire.refusalStatus[code]!))
      })
      let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      do {
        try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile, seat: Seat(kind: .anon, key: "seat"), pictures: []) { _ in Issue.record("Refused event") }
        Issue.record("Transient refusal succeeded")
      } catch let failure as AiFailure {
        #expect(failure.code == code)
        #expect(failure.admission == .possible)
      }
      #expect(clock.nowMs == 30_000)
      #expect(transport.requests.map(\.method) == ["POST", "PUT", "PUT", "PUT", "PUT", "PUT", "PUT"])
      #expect(diagnostics.failures == [])
    }
  }

  @Test func unknownRecoveryIsQuietButALiveUnknownIsADefect() async throws {
    let profile = try AiPolicyTests.profile()
    for recover in [false, true] {
      let diagnostics = PolicyDiagnostics()
      let transport = ValidationTransport([ValidationTransport.pass(), ValidationTransport.json(["code": "call_unknown", "allowance": .null], status: 404)])
      let client = ServiceAiClient(transport: transport, clock: PolicyClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      do {
        if recover { try await client.recover(id: String(repeating: "A", count: 22), profile: profile, seat: Seat(kind: .anon, key: "seat")) { _ in } }
        else { try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile, seat: Seat(kind: .anon, key: "seat"), pictures: []) { _ in } }
        Issue.record("Unknown call succeeded")
      } catch let failure as AiFailure { #expect(failure.code == "call_unknown") }
      #expect(diagnostics.failures == (recover ? [] : ["ai-call"]))
    }
  }

  @Test func offlineBeforeTextDispatchStopsButACachedPassMakesDispatchUncertain() async throws {
    let profile = try AiPolicyTests.profile()
    for cached in [false, true] {
      let diagnostics = PolicyDiagnostics()
      let clock = PolicyClock()
      let transport = RecoveryTransport([.failure(.offline), .success(Self.completed())])
      let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      let seat = Seat(kind: .anon, key: "seat")
      if cached { client.pass = .init(token: "cached", expiresAt: 600_000, seat: seat, use: profile.name, version: profile.version) }
      var events: [String] = []
      do {
        try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile, seat: seat, pictures: []) { events.append($0.name) }
        #expect(cached)
      } catch let failure as AiFailure { #expect(!cached); #expect(failure.code == nil); #expect(failure.admission == .none) }
      #expect(events == (cached ? ["ended"] : []))
      #expect(transport.requests.map(\.method) == (cached ? ["PUT", "PUT"] : ["POST"]))
      #expect(clock.nowMs == (cached ? 1_000 : 0))
      #expect(diagnostics.failures == [])
    }
  }

  @Test func aPassProxyFailureIsQuietAndRetriesOnlyAfterTextDispatch() async throws {
    let profile = try AiPolicyTests.profile()
    for dispatched in [false, true] {
      let clock = PolicyClock()
      let diagnostics = PolicyDiagnostics()
      let proxy = AiResponse(status: 503, contentType: "text/html", bytes: AsyncThrowingStream { $0.yield(Array("unavailable".utf8)); $0.finish() })
      let prefix: [Result<AiResponse, AiTransportFailure>] = dispatched ? [.success(ValidationTransport.pass()), .failure(.offline)] : []
      let transport = RecoveryTransport(prefix + [.success(proxy), .success(ValidationTransport.pass()), .success(Self.completed())])
      if dispatched { transport.beforeResponse = { count in if count == 2 { clock.nowMs = 540_001 } } }
      let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      var events: [String] = []
      do {
        try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile, seat: Seat(kind: .anon, key: "seat"), pictures: []) { events.append($0.name) }
        #expect(dispatched)
      } catch let failure as AiFailure { #expect(!dispatched); #expect(failure.code == nil); #expect(failure.admission == .none) }
      #expect(events == (dispatched ? ["ended"] : []))
      #expect(transport.requests.map(\.method) == (dispatched ? ["POST", "PUT", "POST", "POST", "PUT"] : ["POST"]))
      #expect(diagnostics.failures == [])
    }
  }

  @Test func aPictureRepairLossKeepsOnlyTheAdmissionEvidenceAlreadyEstablished() async throws {
    let profile = try AiPolicyTests.profile()
    for lost in [false, true] {
      let clock = PolicyClock()
      let diagnostics = PolicyDiagnostics()
      let prefix: [Result<AiResponse, AiTransportFailure>] = [.success(ValidationTransport.pass())] + (lost ? [.failure(.offline)] : [])
      let transport = RecoveryTransport(prefix + [
        .success(ValidationTransport.json(["code": "picture_gone", "allowance": .null], status: 410)), .failure(.offline),
        .success(ValidationTransport.json(["code": "picture_gone", "allowance": .null], status: 410)),
        .success(AiResponse(status: 204, contentType: "", bytes: AsyncThrowingStream { $0.finish() })), .success(Self.completed()),
      ])
      let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      var events: [String] = []
      do {
        try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile,
          seat: Seat(kind: .anon, key: "seat"), pictures: [Picture(pictureId: String(repeating: "P", count: 22), mediaType: "image/png", bytes: [137, 80, 78, 71])]) { events.append($0.name) }
        #expect(lost)
      } catch let failure as AiFailure { #expect(!lost); #expect(failure.code == nil); #expect(failure.admission == .none) }
      #expect(events == (lost ? ["ended"] : []))
      #expect(transport.requests.count == (lost ? 7 : 3))
      #expect(clock.nowMs == (lost ? 3_000 : 0))
      #expect(diagnostics.failures == [])
    }
  }

  @Test func aSlowRefreshCannotDispatchBeyondTheOriginalDeadline() async throws {
    let clock = PolicyClock()
    let diagnostics = PolicyDiagnostics()
    let transport = RecoveryTransport([.success(ValidationTransport.pass()), .failure(.offline), .success(ValidationTransport.pass())])
    transport.beforeResponse = { count in
      if count == 2 { clock.nowMs = 540_001 }
      if count == 3 { clock.nowMs = 1_200_000 }
    }
    let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    let profile = try AiPolicyTests.profile()
    do {
      try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile,
        seat: Seat(kind: .anon, key: "seat"), pictures: []) { _ in Issue.record("Late event") }
      Issue.record("Late refresh succeeded")
    } catch let failure as AiFailure { #expect(failure.code == "answer-timeout"); #expect(failure.admission == .possible) }
    #expect(transport.requests.map(\.method) == ["POST", "PUT", "POST"])
    #expect(diagnostics.failures == [])
  }

  @Test func stopCancelsASuspendedPassRefreshWithoutWaitingForTheDeadline() async throws {
    let clock = PolicyClock()
    let diagnostics = PolicyDiagnostics()
    let pass = AsyncThrowingStream<[UInt8], Error>.makeStream()
    let transport = RecoveryTransport([.success(ValidationTransport.pass()), .failure(.offline),
      .success(AiResponse(status: 200, contentType: "application/json", bytes: pass.stream))])
    transport.beforeResponse = { count in if count == 2 { clock.nowMs = 540_001 } }
    let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    let profile = try AiPolicyTests.profile()
    var finished = false
    let call = Task { @MainActor in
      defer { finished = true }
      try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile,
        seat: Seat(kind: .anon, key: "seat"), pictures: []) { _ in }
    }
    while transport.requests.count < 3 { await Task.yield() }
    client.stopAskingAgain()
    try await Task.sleep(for: .milliseconds(50))
    #expect(finished)
    pass.continuation.finish(throwing: AiTransportFailure.offline)
    do { try await call.value; Issue.record("Stopped refresh succeeded") }
    catch let failure as AiFailure { #expect(failure.code == "stopped"); #expect(failure.admission == .possible) }
    #expect(transport.requests.map(\.method) == ["POST", "PUT", "POST"])
    #expect(diagnostics.failures == [])
  }

  @Test func refreshLossAfterBusyRetainsPossibleAdmissionAndRetries() async throws {
    let clock = PolicyClock()
    let diagnostics = PolicyDiagnostics()
    let transport = RecoveryTransport([
      .success(ValidationTransport.json(["pass": "token", "expiresIn": 60001])),
      .success(ValidationTransport.json(["code": "busy", "allowance": .null], status: 503)),
      .failure(.offline), .success(ValidationTransport.pass()), .success(Self.completed()),
    ])
    let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    let profile = try AiPolicyTests.profile()
    var events: [String] = []
    do {
      try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile,
        seat: Seat(kind: .anon, key: "seat"), pictures: []) { events.append($0.name) }
    } catch { Issue.record("Refresh loss ended a possibly admitted busy call") }
    #expect(events == ["ended"])
    #expect(clock.nowMs == 3_000)
    #expect(transport.requests.map(\.method) == ["POST", "PUT", "POST", "POST", "PUT"])
    #expect(diagnostics.failures == [])
  }

  @Test func aSlowRefreshCannotExtendTheTransientRefusalWindow() async throws {
    let clock = PolicyClock()
    let diagnostics = PolicyDiagnostics()
    let transport = RecoveryTransport([
      .success(ValidationTransport.json(["pass": "token", "expiresIn": 60001])),
      .success(ValidationTransport.json(["code": "paused", "allowance": .null], status: 503)),
      .success(ValidationTransport.pass()),
      .success(ValidationTransport.json(["code": "paused", "allowance": .null], status: 503)),
    ])
    transport.beforeResponse = { count in if count == 3 { clock.nowMs = 31_000 } }
    let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    let profile = try AiPolicyTests.profile()
    do {
      try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile,
        seat: Seat(kind: .anon, key: "seat"), pictures: []) { _ in Issue.record("Refused event") }
      Issue.record("Refused call succeeded")
    } catch let failure as AiFailure { #expect(failure.code == "paused"); #expect(failure.admission == .none) }
    #expect(transport.requests.map(\.method) == ["POST", "PUT", "POST"])
    #expect(diagnostics.failures == [])
  }

  static func completed() -> AiResponse {
    ValidationTransport.event("ended", ["stop": "completed", "message": ["role": "assistant", "parts": [], "carry": ""], "charged": "0", "allowance": .null])
  }
}

@MainActor final class RecoveryTransport: AiTransport {
  let responses: [Result<AiResponse, AiTransportFailure>]
  var requests: [AiRequest] = []
  var beforeResponse: ((Int) -> Void)?
  init(_ responses: [Result<AiResponse, AiTransportFailure>]) { self.responses = responses }
  func send(_ request: AiRequest) async throws -> AiResponse {
    requests.append(request)
    beforeResponse?(requests.count)
    return try responses[min(requests.count - 1, responses.count - 1)].get()
  }
}
