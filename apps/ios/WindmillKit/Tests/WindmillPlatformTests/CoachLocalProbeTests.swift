import Foundation
import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite @MainActor struct CoachLocalProbeTests {
  @Test func run() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let configPath = environment["WM_COACH_PROBE_CONFIG"], let outputPath = environment["WM_COACH_PROBE_OUT"] else { return }
    let config = try JSON(parsing: Array(Data(contentsOf: URL(fileURLWithPath: configPath))))
    let probe = try CoachLocalProbe(config: config, statePath: environment["WM_COACH_PROBE_STATE"])
    let end = await probe.run()
    let output: JSON = ["end": end.map(StoryHarness.json) ?? .null, "abilityCalls": JSON(probe.executions.count),
      "marks": .array(probe.marks), "requests": .array(probe.requests), "failures": .array(probe.failures.map(JSON.string))]
    try Data(output.jcs).write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputPath)
    #expect(end != nil)
  }
}

@MainActor final class CoachLocalProbe: ToolHost, TurnRuntime, Telemetry, AiDiagnostics, AiTransport {
  let config: JSON
  let profile: Profile
  let input: TurnInput
  let network: AiURLSessionTransport
  let clock = AiSystemClock()
  let statePath: String?
  var client: ServiceAiClient!
  var runner: Turn!
  var requests: [JSON] = []
  var marks: [JSON] = []
  var failures: [String] = []
  var executions: [String] = []
  var visibleText = ""
  var state = "running"
  var mark: Mark?
  var exists = false
  var callIndex = 0
  var recovery: JSON?
  var nowMs: Int64 { clock.nowMs }

  init(config: JSON, statePath: String?) throws {
    self.config = config; self.statePath = statePath
    profile = try Profile(config.field("profile"))
    let value = config.field("input")
    input = TurnInput(turnId: try value.field("turnId").string,
      seat: Seat(kind: Seat.Kind(rawValue: try value.field("seat").field("kind").string)!, key: try value.field("seat").field("key").string),
      question: try value.field("question").string, pictures: try StoryHarness.pictures(value.field("pictures")))
    network = try AiURLSessionTransport(origin: URL(string: try config.field("origin").string)!, allowLoopbackHTTP: true)
    if let statePath, FileManager.default.fileExists(atPath: statePath) {
      recovery = try JSON(parsing: Array(Data(contentsOf: URL(fileURLWithPath: statePath))))
    } else if config.field("recovery") != .null { recovery = config.field("recovery") }
    client = ServiceAiClient(transport: self, clock: clock, diagnostics: self, credentials: { _ in
      AiCredentials(session: try config.field("session").string, installation: try? config.field("installation").string)
    })
    runner = Turn(host: self, client: client, telemetry: self, runtime: self)
  }

  func run() async -> TurnEnd? {
    if recovery != nil { return await runner.recover(input: input, profile: profile) }
    return await runner.run(input: input, profile: profile)
  }
  func send(_ request: AiRequest) async throws -> AiResponse {
    if request.path != "/v1/ai/passes" { requests.append(["method": .string(request.method), "path": .string(request.path)]) }
    return try await network.send(request)
  }
  func callID() throws -> String {
    defer { callIndex += 1 }
    return try config.field("runtime").field("callIds").array[callIndex].string
  }
  func acquire() async throws {}
  func release() {}
  func failure(operation: String, kind: String) { failures.append(operation) }
  func ability(name: String, code: String?) {}
  func turn(state: TurnEnd.State, seat: Seat.Kind, code: String?, rounds: Int, abilityCalls: Int, refusals: Int, answerBytes: Int, durationMs: Int64) {}

  func open(_ input: TurnInput) async throws -> OpenTurn {
    exists = true
    mark = Mark(turnId: input.turnId, callId: nil, textBytesBeforeRound: 0)
    marks.append(StoryHarness.json(mark!)); try save()
    return OpenTurn(lease: HostLease(turnId: input.turnId, seat: input.seat, generation: 0), pictures: input.pictures)
  }
  func recover(_ input: TurnInput) async throws -> Recovery? {
    guard let recovery, recovery.field("state") == "running" else { return nil }
    let value = recovery.field("mark")
    guard value != .null else { return nil }
    mark = Mark(turnId: try value.field("turnId").string, callId: try? value.field("callId").string,
      textBytesBeforeRound: Int(try value.field("textBytesBeforeRound").integer))
    visibleText = try recovery.field("text").string
    executions = (try? recovery.field("executions").array.map { try $0.string }) ?? []
    exists = true
    return Recovery(lease: HostLease(turnId: input.turnId, seat: input.seat, generation: 0), mark: mark!, text: visibleText)
  }
  func text(_ text: String, lease: HostLease) async throws {
    try guardLease(lease)
    visibleText = text; try save()
    if config.field("scenario") == "stop" { runner.stop() }
  }
  func beginRound(_ mark: Mark, text: String, lease: HostLease) async throws {
    try guardLease(lease)
    self.mark = mark; visibleText = text; marks.append(StoryHarness.json(mark)); try save()
  }
  func end(_ end: TurnEnd, lease: HostLease) async throws {
    try guardLease(lease)
    state = end.state.rawValue; visibleText = end.text; mark = nil; marks.append(.null); try save()
  }
  func withdraw(lease: HostLease) async throws { try guardLease(lease); exists = false; mark = nil; marks.append(.null); try save() }
  func check(_ check: GateCheck, call: ToolCall, lease: HostLease) async throws -> String? { try guardLease(lease); return nil }
  func execute(_ call: ToolCall, callId: String, lease: HostLease) async throws -> ToolOutcome {
    try guardLease(lease)
    let identity = callId + ":" + call.id
    guard !executions.contains(identity) else { throw AiTransportFailure.invalidResponse }
    executions.append(identity); try save()
    return .success("1")
  }
  func guardLease(_ lease: HostLease) throws {
    guard lease.seat == input.seat, lease.generation == 0 else { throw HostFailure.staleSeat }
    guard exists else { throw HostFailure.recordGone }
  }
  func save() throws {
    guard let statePath else { return }
    let value: JSON = ["mark": mark.map(StoryHarness.json) ?? .null, "text": .string(visibleText), "state": .string(state),
      "executions": .array(executions.map(JSON.string))]
    try Data(value.jcs).write(to: URL(fileURLWithPath: statePath), options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: statePath)
  }
}
