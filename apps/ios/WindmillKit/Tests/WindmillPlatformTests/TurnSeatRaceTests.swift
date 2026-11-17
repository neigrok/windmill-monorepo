import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite @MainActor struct TurnSeatRaceTests {
  @Test func oldCleanupCannotReleaseANewTurnsWorkLeaseOrActiveSlot() async throws {
    let host = SeatRaceHost()
    let client = SeatRaceClient()
    client.pauseSecond = true
    let turn = Turn(host: host, client: client, telemetry: host, runtime: host)
    let profile = try AiPolicyTests.profile()
    let old = Task { await turn.run(input: TurnInput(turnId: "old", seat: Seat(kind: .bound, key: "old"), question: ""), profile: profile) }
    await client.started()
    await turn.seatWillChange()
    host.seat = "new"
    let next = Task { await turn.run(input: TurnInput(turnId: "new", seat: Seat(kind: .bound, key: "new"), question: ""), profile: profile) }
    await client.secondStarted()
    client.releaseOld()
    #expect(await old.value == TurnEnd(state: .interrupted, text: ""))
    #expect(host.acquisitions == 2)
    #expect(host.releases == 1)
    let extra = await turn.run(input: TurnInput(turnId: "extra", seat: Seat(kind: .bound, key: "new"), question: ""), profile: profile)
    #expect(extra == nil)
    client.releaseSecond()
    #expect(await next.value == TurnEnd(state: .completed, text: "New"))
    #expect(host.releases == 2)
    #expect(host.failures == 0)
  }

  @Test func newSeatRunsBeforeOldProviderDrains() async throws {
    let host = SeatRaceHost()
    let client = SeatRaceClient()
    let turn = Turn(host: host, client: client, telemetry: host, runtime: host)
    let profile = try AiPolicyTests.profile()
    let old = Task { await turn.run(input: TurnInput(turnId: "old", seat: Seat(kind: .bound, key: "old"), question: ""), profile: profile) }
    await client.started()
    await turn.seatWillChange()
    host.seat = "new"
    let next = await turn.run(input: TurnInput(turnId: "new", seat: Seat(kind: .bound, key: "new"), question: ""), profile: profile)
    #expect(next == TurnEnd(state: .completed, text: "New"))
    client.releaseOld()
    #expect(await old.value == TurnEnd(state: .interrupted, text: ""))
    #expect(host.ends == ["old": TurnEnd(state: .interrupted, text: ""), "new": TurnEnd(state: .completed, text: "New")])
    #expect(host.acquisitions == 2)
    #expect(host.releases == 2)
    #expect(host.failures == 0)
  }
}

@MainActor final class SeatRaceClient: AiClient {
  var calls = 0
  var pauseSecond = false
  var secondPause: CheckedContinuation<Void, Never>?
  var secondSignal: CheckedContinuation<Void, Never>?
  var pause: CheckedContinuation<Void, Never>?
  var signal: CheckedContinuation<Void, Never>?
  func started() async { if pause != nil { return }; await withCheckedContinuation { signal = $0 } }
  func secondStarted() async { if secondPause != nil { return }; await withCheckedContinuation { secondSignal = $0 } }
  func releaseSecond() { secondPause?.resume(); secondPause = nil }
  func releaseOld() { pause?.resume(); pause = nil }
  func call(id: String, request: JSON, profile: Profile, seat: Seat, pictures: [Picture], receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {
    calls += 1
    let ordinal = calls
    if ordinal == 2 && pauseSecond { await withCheckedContinuation { secondPause = $0; secondSignal?.resume(); secondSignal = nil } }
    if ordinal == 1 { await withCheckedContinuation { pause = $0; signal?.resume(); signal = nil } }
    try await receive(AiEvent(id: 1, name: "text", data: ["delta": seat.key == "old" ? "Old" : "New"]))
    try await receive(AiEvent(id: 2, name: "ended", data: ["stop": "completed", "message": ["role": "assistant", "parts": []]]))
  }
  func recover(id: String, profile: Profile, seat: Seat, receive: @escaping @MainActor (AiEvent) async throws -> Void) async throws {}
  func allowance(profile: Profile, seat: Seat) async throws -> JSON { .null }
  func upload(_ pictures: [Picture], profile: Profile, seat: Seat) async throws {}
  func stopAskingAgain() {}
  func seatWillChange() {}
  func invalidAnswer() {}
}

@MainActor final class SeatRaceHost: ToolHost, TurnRuntime, Telemetry {
  var seat = "old"
  var ends: [String: TurnEnd] = [:]
  var acquisitions = 0
  var releases = 0
  var failures = 0
  var nowMs: Int64 { 0 }
  func callID() throws -> String { String(repeating: acquisitions == 1 ? "A" : "B", count: 22) }
  func acquire() async throws { acquisitions += 1 }
  func release() { releases += 1 }
  func open(_ input: TurnInput) async throws -> OpenTurn { OpenTurn(lease: HostLease(turnId: input.turnId, seat: input.seat, generation: 0)) }
  func recover(_ input: TurnInput) async throws -> Recovery? { nil }
  func text(_ text: String, lease: HostLease) async throws { try checkLease(lease) }
  func beginRound(_ mark: Mark, text: String, lease: HostLease) async throws { try checkLease(lease) }
  func end(_ end: TurnEnd, lease: HostLease) async throws { try checkLease(lease); ends[lease.turnId] = end }
  func withdraw(lease: HostLease) async throws { try checkLease(lease) }
  func check(_ check: GateCheck, call: ToolCall, lease: HostLease) async throws -> String? { try checkLease(lease); return nil }
  func execute(_ call: ToolCall, callId: String, lease: HostLease) async throws -> ToolOutcome { try checkLease(lease); return .success("") }
  func checkLease(_ lease: HostLease) throws { if lease.seat.key != seat { failures += 1; throw HostFailure.staleSeat } }
  func hostFailure() { failures += 1 }
  func ability(name: String, code: String?) {}
  func turn(state: TurnEnd.State, seat: Seat.Kind, code: String?, rounds: Int, abilityCalls: Int, refusals: Int, answerBytes: Int, durationMs: Int64) {}
}
