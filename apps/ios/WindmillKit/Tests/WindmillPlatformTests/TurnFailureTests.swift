import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite @MainActor struct TurnFailureTests {
  @Test func unexpectedHostFailuresReportOnlyTheStaticHostOperation() async throws {
    let profile = try AiPolicyTests.profile()
    let input = TurnInput(turnId: "turn", seat: Seat(kind: .bound, key: "seat"), question: "private question")
    for operation in ["acquire", "open", "recover", "callID", "beginRound", "text", "check", "execute", "end"] {
      let host = FaultHost(operation: operation, error: StorageFault.disk)
      let client = HostTestClient()
      client.tools = ["check", "execute"].contains(operation)
      let turn = Turn(host: host, client: client, telemetry: host, runtime: host)
      let end = operation == "recover" ? await turn.recover(input: input, profile: profile) : await turn.run(input: input, profile: profile)
      let state: TurnEnd.State = operation == "recover" ? .interrupted : operation == "end" ? .completed : .failed
      let text = ["text", "check", "execute", "end"].contains(operation) ? "Answer" : ""
      #expect(end == TurnEnd(state: state, text: text, code: state == .failed ? "invalid-answer" : nil))
      #expect(host.failures == ["agent-host"])
      #expect(client.defects == 0)
      #expect(host.releases == (operation == "acquire" ? 0 : 1))
    }
  }

  @Test func corruptRecoveryOffsetsReportHostFailureBeforeReadingAnAnswer() async throws {
    let profile = try AiPolicyTests.profile()
    let input = TurnInput(turnId: "turn", seat: Seat(kind: .bound, key: "seat"), question: "")
    for offset in [-1, 1, 3] {
      let host = FaultHost(operation: "none", error: StorageFault.disk)
      host.recoveryOffset = offset
      let client = HostTestClient()
      let turn = Turn(host: host, client: client, telemetry: host, runtime: host)
      #expect(await turn.recover(input: input, profile: profile) == TurnEnd(state: .interrupted, text: "é"))
      #expect(host.failures == ["agent-host"])
      #expect(client.recoveries == 0)
      #expect(client.defects == 0)
    }
  }

  @Test func expectedRecordAndSeatRefusalsRemainQuiet() async throws {
    let profile = try AiPolicyTests.profile()
    let input = TurnInput(turnId: "turn", seat: Seat(kind: .bound, key: "seat"), question: "private question")
    for error in [HostFailure.recordGone, .staleSeat] {
      for operation in ["open", "recover", "text", "end"] {
        let host = FaultHost(operation: operation, error: error)
        let client = HostTestClient()
        let turn = Turn(host: host, client: client, telemetry: host, runtime: host)
        _ = operation == "recover" ? await turn.recover(input: input, profile: profile) : await turn.run(input: input, profile: profile)
        #expect(host.failures == [])
        #expect(client.defects == 0)
      }
    }
  }
}

private enum StorageFault: Error { case disk }

@MainActor final class FaultHost: ToolHost, TurnRuntime, Telemetry {
  let operation: String
  let error: any Error
  var failures: [String] = []
  var releases = 0
  var recoveryOffset: Int?
  var nowMs: Int64 { 0 }
  init(operation: String, error: any Error) { self.operation = operation; self.error = error }
  func fail(_ operation: String) throws { if self.operation == operation { throw error } }
  func acquire() async throws { try fail("acquire") }
  func release() { releases += 1 }
  func callID() throws -> String { try fail("callID"); return String(repeating: "A", count: 22) }
  func open(_ input: TurnInput) async throws -> OpenTurn {
    try fail("open")
    return OpenTurn(lease: HostLease(turnId: input.turnId, seat: input.seat, generation: 0))
  }
  func recover(_ input: TurnInput) async throws -> Recovery? {
    try fail("recover")
    guard let recoveryOffset else { return nil }
    return Recovery(lease: HostLease(turnId: input.turnId, seat: input.seat, generation: 0),
      mark: Mark(turnId: input.turnId, callId: String(repeating: "A", count: 22), textBytesBeforeRound: recoveryOffset), text: "é")
  }
  func text(_ text: String, lease: HostLease) async throws { try fail("text") }
  func beginRound(_ mark: Mark, text: String, lease: HostLease) async throws { try fail("beginRound") }
  func end(_ end: TurnEnd, lease: HostLease) async throws { try fail("end") }
  func withdraw(lease: HostLease) async throws { try fail("withdraw") }
  func check(_ check: GateCheck, call: ToolCall, lease: HostLease) async throws -> String? { try fail("check"); return nil }
  func execute(_ call: ToolCall, callId: String, lease: HostLease) async throws -> ToolOutcome { try fail("execute"); return .success("") }
  func hostFailure() { failures.append("agent-host") }
  func ability(name: String, code: String?) {}
  func turn(state: TurnEnd.State, seat: Seat.Kind, code: String?, rounds: Int, abilityCalls: Int, refusals: Int, answerBytes: Int, durationMs: Int64) {}
}

@MainActor final class HostTestClient: AiClient {
  var defects = 0
  var tools = false
  var recoveries = 0
  func call(id: String, request: JSON, profile: Profile, seat: Seat, pictures: [Picture], receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    try await receive(AiEvent(id: 1, name: "text", data: ["delta": "Answer"]))
    if tools {
      try await receive(AiEvent(id: 2, name: "ended", data: ["stop": "tool_calls", "message": ["role": "assistant", "parts": [["toolCall": ["id": "tool", "name": "read", "input": ["value": 1]]]], "carry": ""], "charged": "0", "allowance": .null]))
      return
    }
    try await receive(AiEvent(id: 2, name: "ended", data: ["stop": "completed", "message": ["role": "assistant", "parts": [["text": "Answer"]], "carry": ""], "charged": "0", "allowance": .null]))
  }
  func recover(id: String, profile: Profile, seat: Seat, receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws { recoveries += 1 }
  func allowance(profile: Profile, seat: Seat) async throws -> JSON { .null }
  func upload(_ pictures: [Picture], profile: Profile, seat: Seat) async throws {}
  func stopAskingAgain() {}
  func seatWillChange() {}
  func invalidAnswer() { defects += 1 }
}
