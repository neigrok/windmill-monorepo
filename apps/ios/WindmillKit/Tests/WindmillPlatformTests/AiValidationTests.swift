import Foundation
import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite @MainActor struct AiValidationTests {
  @Test func malformedEventsNeverReachTheCaller() async throws {
    let id = String(repeating: "A", count: 22)
    let samples: [(String, JSON)] = [
      ("started", ["callId": .string(id), "served": "small", "maxTokens": 1]),
      ("text", ["delta": "Answer"]),
      ("toolCall", ["id": "tool", "name": "read", "input": [:]]),
      ("ended", ["stop": "completed", "message": ["role": "assistant", "parts": [], "carry": ""], "charged": "0", "allowance": .null]),
      ("failed", ["code": "provider_failed", "charged": .null, "allowance": .null]),
    ]
    var invalid: [(String, JSON)] = []
    for (name, value) in samples {
      for key in try value.asObject().keys { invalid.append((name, try value.changed([key], to: nil))) }
      invalid.append((name, try value.changed(["extra"], to: true)))
    }
    invalid += [
      ("started", try samples[0].1.changed(["callId"], to: .string(String(repeating: "B", count: 22)))),
      ("started", try samples[0].1.changed(["served"], to: "unknown")),
      ("started", try samples[0].1.changed(["maxTokens"], to: 0)),
      ("started", try samples[0].1.changed(["maxTokens"], to: true)),
      ("text", ["delta": 1]),
      ("toolCall", ["id": "", "name": "read", "input": [:]]),
      ("toolCall", ["id": "tool", "name": "read.bad", "input": [:]]),
      ("toolCall", ["id": "tool", "name": "read", "input": []]),
      ("ended", try samples[3].1.changed(["message", "carry"], to: nil)),
      ("ended", try samples[3].1.changed(["message", "parts"], to: [["unknown": "text"]])),
      ("ended", try samples[3].1.changed(["message", "parts"], to: [["text": "text", "image": [:]]])),
      ("ended", try samples[3].1.changed(["message", "parts"], to: [["image": ["picture": "short"]]])),
      ("ended", try samples[3].1.changed(["message", "parts"], to: [["image": ["mediaType": "image/png", "data": "AA=="]]])),
      ("ended", try samples[3].1.changed(["allowance"], to: ["code": "ok"])),
      ("failed", try samples[4].1.changed(["code"], to: "paused")),
      ("unknown", [:]),
    ]
    for amount: JSON in [-100, "-1", "01", "1.", "0.0000000001", true] {
      invalid.append(("ended", try samples[3].1.changed(["charged"], to: amount)))
    }
    let profile = try AiPolicyTests.profile()
    for (name, value) in invalid {
      let transport = ValidationTransport([ValidationTransport.pass(), ValidationTransport.event(name, value)])
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: transport, clock: PolicyClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      var events: [String] = []
      do {
        try await client.call(id: id, request: [:], profile: profile, seat: Seat(kind: .anon, key: "seat"), pictures: []) { events.append($0.name) }
        Issue.record("Accepted malformed \(name)")
      } catch let error as AiFailure {
        #expect(error.code == "invalid-answer")
        #expect(error.source == .wire)
        #expect(error.admission == .possible)
      }
      #expect(events == [])
      #expect(diagnostics.failures == ["ai-call"])
      #expect(transport.requests.count == 2)
      #expect(client.lastAllowance == nil)
    }
  }

  @Test func malformedSuccessfulAllowanceAndPassBodiesAreDefects() async throws {
    let good = try AiPolicyTests.allowance()
    var badAllowances: [JSON] = []
    for key in try good.asObject().keys { badAllowances.append(try good.changed([key], to: nil)) }
    for (path, value): ([String], JSON) in [
      (["extra"], true), (["limit"], "-1"), (["resetsAt"], -1),
      (["budgetResetsAt"], "today"), (["tier"], "unknown"), (["period"], "week"), (["code"], "provider_failed"),
      (["capabilities", "text", "large"], "huge"), (["capabilities", "transcription"], "yes"),
    ] { badAllowances.append(try good.changed(path, to: value)) }
    let badPasses: [JSON] = [["pass": "token"], ["pass": "", "expiresIn": 600000], ["pass": "token", "expiresIn": "600000"],
      ["pass": "token", "expiresIn": 0], ["pass": "token", "expiresIn": 600001], ["pass": "token", "expiresIn": 600000, "extra": true]]
    var cases: [([AiResponse], String)] = badAllowances.map { ([ValidationTransport.pass(), ValidationTransport.json($0)], "ai-call") }
    cases += badPasses.map { ([ValidationTransport.json($0)], "ai-pass") }
    let profile = try AiPolicyTests.profile()
    for (responses, operation) in cases {
      let transport = ValidationTransport(responses)
      let diagnostics = PolicyDiagnostics()
      let client = ServiceAiClient(transport: transport, clock: PolicyClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      do {
        _ = try await client.allowance(profile: profile, seat: Seat(kind: .anon, key: "seat"))
        Issue.record("Accepted malformed \(operation) body")
      } catch let error as AiFailure { #expect(error.code == "invalid-answer") }
      #expect(diagnostics.failures == [operation])
      #expect(client.lastAllowance == nil)
    }
  }

  @Test func passDoorRefusalsKeepTheirBoundedMeaning() async throws {
    let profile = try AiPolicyTests.profile()
    for (code, status) in [("rate_limited", 429), ("unavailable", 503), ("device_bound", 409)] {
      let diagnostics = PolicyDiagnostics()
      let transport = ValidationTransport([ValidationTransport.json(["error": "Refused", "code": .string(code)], status: status)])
      let client = ServiceAiClient(transport: transport, clock: PolicyClock(), diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      do { _ = try await client.allowance(profile: profile, seat: Seat(kind: .anon, key: "seat")); Issue.record("Refusal succeeded") }
      catch let error as AiFailure { #expect(error.code == code); #expect(error.source == .pass) }
      #expect(diagnostics.failures == [])
      #expect(transport.requests.map(\.path) == ["/v1/ai/passes"])
    }
  }

  @Test func aDeadlineDuringPassAcquisitionDoesNotClaimAdmission() async throws {
    let clock = DeadlineClock()
    let diagnostics = PolicyDiagnostics()
    let stream = AsyncThrowingStream<[UInt8], Error>.makeStream()
    let transport = ValidationTransport([AiResponse(status: 200, contentType: "application/json", bytes: stream.stream)])
    let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    let profile = try AiPolicyTests.profile()
    let call = Task {
      try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile, seat: Seat(kind: .anon, key: "seat"), pictures: []) { _ in Issue.record("Undispatched event") }
    }
    while transport.requests.isEmpty { await Task.yield() }
    clock.expire()
    do { try await call.value; Issue.record("Pass exceeded deadline") }
    catch let error as AiFailure { #expect(error.code == "answer-timeout"); #expect(error.admission == .none) }
    #expect(transport.requests.map(\.method) == ["POST"])
    #expect(diagnostics.failures == [])
    stream.continuation.finish()
  }

  @Test func theWholeRoundDeadlineCancelsASuspendedRead() async throws {
    for started in [false, true] {
      let clock = DeadlineClock()
      let diagnostics = PolicyDiagnostics()
      let stream = AsyncThrowingStream<[UInt8], Error>.makeStream()
      let id = String(repeating: "A", count: 22)
      if started { stream.continuation.yield(ValidationTransport.eventBytes("started", ["callId": .string(id), "served": "small", "maxTokens": 1])) }
      let transport = ValidationTransport([ValidationTransport.pass(), AiResponse(status: 200, contentType: "text/event-stream", bytes: stream.stream)])
      let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
      let profile = try AiPolicyTests.profile()
      let delivered = AsyncStream<Void>.makeStream()
      let call = Task {
        try await client.call(id: id, request: [:], profile: profile, seat: Seat(kind: .anon, key: "seat"), pictures: []) { _ in delivered.continuation.yield(()) }
      }
      if started { for await _ in delivered.stream { break } }
      else { while transport.requests.count < 2 { await Task.yield() } }
      clock.expire()
      do { try await call.value; Issue.record("Read exceeded the round deadline") }
      catch let error as AiFailure {
        #expect(error.code == "answer-timeout")
        #expect(error.admission == (started ? .admitted : .possible))
      }
      #expect(clock.deadlines == [1_200_000])
      #expect(transport.requests.map(\.method) == ["POST", "PUT"])
      #expect(diagnostics.failures == [])
      stream.continuation.finish()
      delivered.continuation.finish()
    }
  }

  @Test func preparationTimeDoesNotShortenTheTextRecoveryDeadline() async throws {
    let clock = DeadlineClock()
    let diagnostics = PolicyDiagnostics()
    let pass = AsyncThrowingStream<[UInt8], Error>.makeStream()
    let answer = AsyncThrowingStream<[UInt8], Error>.makeStream()
    let transport = ValidationTransport([
      AiResponse(status: 200, contentType: "application/json", bytes: pass.stream),
      AiResponse(status: 200, contentType: "text/event-stream", bytes: answer.stream),
    ])
    let client = ServiceAiClient(transport: transport, clock: clock, diagnostics: diagnostics, credentials: { _ in AiCredentials() })
    let profile = try AiPolicyTests.profile()
    let call = Task {
      try await client.call(id: String(repeating: "A", count: 22), request: [:], profile: profile,
        seat: Seat(kind: .anon, key: "seat"), pictures: []) { _ in Issue.record("Unexpected event") }
    }
    while transport.requests.isEmpty || clock.deadlines.isEmpty { await Task.yield() }
    clock.nowMs = 60_000
    pass.continuation.yield(JSON.object(["pass": "token", "expiresIn": 600000]).jcs)
    pass.continuation.finish()
    while transport.requests.count < 2 { await Task.yield() }
    clock.expire()
    while clock.deadlines.count < 2 { await Task.yield() }
    #expect(clock.deadlines == [1_200_000, 1_260_000])
    clock.expire()
    do { try await call.value; Issue.record("Text deadline did not expire") }
    catch let error as AiFailure { #expect(error.code == "answer-timeout"); #expect(error.admission == .possible) }
    #expect(clock.nowMs == 1_260_000)
    #expect(diagnostics.failures == [])
    answer.continuation.finish()
  }
}

extension JSON {
  func changed(_ path: [String], to value: JSON?) throws -> JSON {
    var object = try asObject()
    let key = path[0]
    object[key] = path.count == 1 ? value : try object.member(key).changed(Array(path.dropFirst()), to: value)
    return .object(object)
  }
}

@MainActor final class ValidationTransport: AiTransport {
  var responses: [AiResponse]
  var requests: [AiRequest] = []
  init(_ responses: [AiResponse]) { self.responses = responses }
  func send(_ request: AiRequest) async throws -> AiResponse {
    requests.append(request)
    guard !responses.isEmpty else { throw AiTransportFailure.invalidResponse }
    return responses.removeFirst()
  }
  static func pass() -> AiResponse { json(["pass": "token", "expiresIn": 600000]) }
  static func json(_ value: JSON, status: Int = 200) -> AiResponse {
    AiResponse(status: status, contentType: "application/json", bytes: AsyncThrowingStream { $0.yield(value.jcs); $0.finish() })
  }
  static func eventBytes(_ name: String, _ value: JSON) -> [UInt8] { Array("id: 1\nevent: \(name)\ndata: \(value.jcsText)\n\n".utf8) }
  static func event(_ name: String, _ value: JSON) -> AiResponse {
    AiResponse(status: 200, contentType: "text/event-stream", bytes: AsyncThrowingStream { $0.yield(eventBytes(name, value)); $0.finish() })
  }
}

@MainActor final class DeadlineClock: AiClock {
  var nowMs: Int64 = 0
  var deadlines: [Int64] = []
  let expiry = AsyncStream<Void>.makeStream()
  func wait(ms: Int64) async throws { nowMs += ms }
  func waitUntil(_ deadline: Int64) async throws {
    deadlines.append(deadline)
    for await _ in expiry.stream { break }
    try Task.checkCancellation()
    nowMs = deadline
  }
  func expire() { expiry.continuation.yield(()) }
}
