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
    transport.answer(try Self.allowance())
    #expect(try await fresh.value == Self.allowance())
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
      transport.answer(try Self.allowance())
      #expect(try await call.value == Self.allowance())
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

  @Test func offlinePassAndPictureRequestsStayQuietAndMapToOffline() async throws {
    let profile = try Self.profile()
    for picture in [false, true] {
      let diagnostics = PolicyDiagnostics()
      let transport = OfflineAiTransport(picture: picture)
      let client = ServiceAiClient(transport: transport, clock: PolicyClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      do {
        if picture { try await client.upload([Picture(pictureId: String(repeating: "P", count: 22), mediaType: "image/png", bytes: [137, 80, 78, 71])], profile: profile, seat: Seat(kind: .anon, key: "seat")) }
        else { _ = try await client.allowance(profile: profile, seat: Seat(kind: .anon, key: "seat")) }
        Issue.record("Offline request succeeded")
      } catch let error as AiFailure {
        #expect(error.source == .transport)
        #expect(error.code == nil)
        #expect(Access.forFailure(error) == .offline)
      }
      #expect(diagnostics.failures == [])
    }
  }

  @Test func aLostPassBodyIsOfflineAndAnOldSeatsMalformedBodyIsFenced() async throws {
    let profile = try Self.profile()
    let diagnostics = PolicyDiagnostics()
    let lost = AiResponse(status: 200, contentType: "application/json", bytes: AsyncThrowingStream { $0.finish(throwing: AiTransportFailure.offline) })
    let client = ServiceAiClient(transport: ValidationTransport([lost]), clock: PolicyClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    do { _ = try await client.allowance(profile: profile, seat: Seat(kind: .anon, key: "seat")); Issue.record("Lost pass succeeded") }
    catch let error as AiFailure { #expect(error.source == .transport); #expect(error.code == nil) }
    #expect(diagnostics.failures == [])
    let body = AsyncThrowingStream<[UInt8], Error>.makeStream()
    let transport = ValidationTransport([AiResponse(status: 200, contentType: "application/json", bytes: body.stream)])
    let staleClient = ServiceAiClient(transport: transport, clock: PolicyClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    let pending = Task { try await staleClient.allowance(profile: profile, seat: Seat(kind: .anon, key: "old")) }
    while transport.requests.isEmpty { await Task.yield() }
    staleClient.seatWillChange()
    body.continuation.yield(Array("invalid JSON".utf8)); body.continuation.finish()
    await #expect(throws: HostFailure.self) { try await pending.value }
    #expect(diagnostics.failures == [])
  }

  @Test func aPassIsFetchedForEachNamedUseAndACoachProfileNamesOne() async throws {
    let transport = ValidationTransport([ValidationTransport.json(["pass": "talk", "expiresIn": 600000]), ValidationTransport.json(try Self.allowance()),
                                         ValidationTransport.json(try Self.allowance()),
                                         ValidationTransport.json(["pass": "coach", "expiresIn": 600000]), ValidationTransport.json(try Self.allowance())])
    let client = ServiceAiClient(transport: transport, clock: PolicyClock(), diagnostics: PolicyDiagnostics(),
                                 credentials: { seat in AiCredentials(session: seat.key, installation: "installation") })
    let talk = AiUse(name: "journal.talk", version: 1, label: "talk")
    let seat = Seat(kind: .bound, key: "session")
    let profile = try Self.profile()
    #expect(try await client.allowance(for: talk, seat: seat) == Self.allowance())
    #expect(try await client.allowance(for: talk, seat: seat) == Self.allowance())
    #expect(try await client.allowance(profile: profile, seat: seat) == Self.allowance())
    #expect(transport.requests.map(\.path) == ["/v1/ai/passes", "/v1/allowance", "/v1/allowance", "/v1/ai/passes", "/v1/allowance"])
    #expect(transport.requests.map(\.headers) == [
      ["Authorization": "Bearer session", "X-Windmill-Installation": "installation", "Content-Type": "application/json", "Accept": "application/json"],
      ["Authorization": "Bearer talk", "Content-Type": "application/json"],
      ["Authorization": "Bearer talk", "Content-Type": "application/json"],
      ["Authorization": "Bearer session", "X-Windmill-Installation": "installation", "Content-Type": "application/json", "Accept": "application/json"],
      ["Authorization": "Bearer coach", "Content-Type": "application/json"],
    ])
    #expect(transport.requests[0].body.map { String(decoding: $0, as: UTF8.self) } == #"{"client":"ios","use":"journal.talk","version":1}"#)
    #expect(try transport.requests[3].body.map { try JSON(parsing: $0) } == ["client": "ios", "use": .string(profile.name), "version": .number(.init(profile.version))])
    #expect(profile.use == AiUse(name: profile.name, version: profile.version, label: profile.label))
  }

  static func allowance() throws -> JSON {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try JSON(parsing: Array(Data(contentsOf: root.appending(path: "packages/api-contract/ai/wire/fixtures.json")))).field("allowance")
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

@MainActor final class OfflineAiTransport: AiTransport {
  let picture: Bool
  init(picture: Bool) { self.picture = picture }
  func send(_ request: AiRequest) async throws -> AiResponse {
    if picture && request.path == "/v1/ai/passes" { return ValidationTransport.pass() }
    throw AiTransportFailure.offline
  }
}
