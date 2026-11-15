import Foundation
import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite @MainActor struct AiPolicyTests {
  @Test func anOldSeatsDelayedPassCannotAuthorizeTheNewSeat() async throws {
    let transport = DeferredAiTransport()
    let clock = PolicyClock()
    let diagnostics = PolicyDiagnostics()
    let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { seat in
      AiCredentials(session: seat.key, installation: "installation")
    })
    let profile = try Self.profile()
    let old = Task { try await client.allowance(profile: profile, seat: Seat(kind: .bound, key: "old")) }
    await transport.pending()
    client.seatWillChange()
    transport.answer(["pass": "old-pass", "expiresIn": 600000])
    await #expect(throws: HostFailure.self) { try await old.value }
    let fresh = Task { try await client.allowance(profile: profile, seat: Seat(kind: .bound, key: "new")) }
    await transport.pending()
    #expect(transport.requests.count == 2)
    #expect(transport.requests[1].path == "/v1/ai/passes")
    #expect(transport.requests[1].headers == ["Authorization": "Bearer new", "X-Windmill-Installation": "installation", "Content-Type": "application/json", "Accept": "application/json"])
    transport.answer(["pass": "new-pass", "expiresIn": 600000])
    await transport.pending()
    #expect(transport.requests[2].headers == ["Authorization": "Bearer new-pass", "Content-Type": "application/json"])
    transport.answer(["code": "ok"])
    #expect(try await fresh.value == ["code": "ok"])
    #expect(diagnostics.failures == [])
  }

  @Test func aPassRefreshUsesElapsedLocalTimeAndDropsOldAllowanceOnSeatChange() async throws {
    let transport = DeferredAiTransport()
    let clock = PolicyClock()
    clock.nowMs = 8_000_000_000
    let diagnostics = PolicyDiagnostics()
    let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials(session: "session") })
    let profile = try Self.profile()
    let seat = Seat(kind: .bound, key: "seat")
    for (elapsed, refresh) in [(Int64(0), true), (539_999, false), (2, true)] {
      clock.nowMs += elapsed
      let call = Task { try await client.allowance(profile: profile, seat: seat) }
      await transport.pending()
      if refresh {
        #expect(transport.requests.last?.path == "/v1/ai/passes")
        transport.answer(["pass": "pass", "expiresIn": 600000])
        await transport.pending()
      }
      #expect(transport.requests.last?.path == "/v1/allowance")
      transport.answer(["code": "ok"])
      #expect(try await call.value == ["code": "ok"])
    }
    #expect(transport.requests.map(\.path) == ["/v1/ai/passes", "/v1/allowance", "/v1/allowance", "/v1/ai/passes", "/v1/allowance"])
    client.seatWillChange()
    #expect(client.lastAllowance == nil)
  }

  @Test func aLateAllowanceCannotCrossTheSeatFence() async throws {
    let transport = DeferredAiTransport()
    let client = ServiceAiClient(transport: transport, clock: PolicyClock(), diagnostics: PolicyDiagnostics(), credentials: { _ in AiCredentials(session: "session") })
    let profile = try Self.profile()
    let call = Task { try await client.allowance(profile: profile, seat: Seat(kind: .bound, key: "seat")) }
    await transport.pending(); transport.answer(["pass": "pass", "expiresIn": 600000])
    await transport.pending(); client.seatWillChange(); transport.answer(["code": "subject_exhausted"])
    await #expect(throws: HostFailure.self) { try await call.value }
    #expect(client.lastAllowance == nil)
  }

  static func profile() throws -> Profile {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try Profile(JSON(parsing: Array(Data(contentsOf: root.appending(path: "packages/api-contract/agent/turns/text.json")))).field("profile"))
  }
}

@MainActor final class DeferredAiTransport: AiTransport {
  var requests: [AiRequest] = []
  var response: CheckedContinuation<AiResponse, Error>?
  var started: CheckedContinuation<Void, Never>?
  func send(_ request: AiRequest) async throws -> AiResponse {
    requests.append(request)
    return try await withCheckedThrowingContinuation { continuation in
      response = continuation; started?.resume(); started = nil
    }
  }
  func pending() async {
    if response != nil { return }
    await withCheckedContinuation { started = $0 }
  }
  func answer(_ value: JSON) {
    let continuation = response
    response = nil
    continuation?.resume(returning: AiResponse(status: 200, contentType: "application/json", bytes: AsyncThrowingStream { stream in
      stream.yield(value.jcs); stream.finish()
    }))
  }
}

@MainActor final class PolicyClock: AiClock {
  var nowMs: Int64 = 0
  func wait(ms: Int64) async throws { nowMs += ms }
}

@MainActor final class PolicyDiagnostics: AiDiagnostics {
  var failures: [String] = []
  func failure(operation: String, kind: String) { failures.append(operation) }
}
