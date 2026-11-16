import Foundation
import Testing
import Agent
import SyncCore
@testable import WindmillPlatform

@Suite @MainActor struct TurnStoriesTests {
  @Test func everyCompleteStory() async throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let directory = root.appending(path: "packages/api-contract/agent/turns")
    let wire = try JSON(parsing: Array(Data(contentsOf: root.appending(path: "packages/api-contract/ai/wire/fixtures.json"))))
    let refusalStatus = try Dictionary(uniqueKeysWithValues: wire.field("refusals").array.map {
      (try $0.field("body").field("code").string, Int(try $0.field("status").integer))
    })
    let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }.sorted { $0.path < $1.path }
    #expect(files.count >= 60)
    for file in files {
      let story = try JSON(parsing: Array(Data(contentsOf: file)))
      let harness = try StoryHarness(story, refusalStatus: refusalStatus)
      let actual = try await harness.run()
      #expect(actual == story.field("expected"), "\(file.lastPathComponent)\nactual: \(actual.jcsText)\nexpected: \(story.field("expected").jcsText)")
    }
  }
}

extension JSON {
  func field(_ key: String) -> JSON { (try? asObject()[key]) ?? .null }
  var string: String { get throws { try asString() } }
  var integer: Int64 { get throws { try asInteger() } }
  var array: [JSON] { get throws { try asArray() } }
}

@MainActor final class StoryHarness: ToolHost, TurnRuntime, AiClock, Telemetry, AiDiagnostics, AiTransport {
  let story: JSON
  let refusalStatus: [String: Int]
  let profile: Profile
  let input: TurnInput
  var nowMs: Int64
  var callIndex = 0
  var passIndex = 0
  var pictureIndex = 0
  var exchangeIndex = 0
  var repeats = 0
  var generation: UInt64 = 0
  var exists = false
  var state = "running"
  var controlIndices: Set<Int> = []
  var requests: [JSON] = []
  var hostCalls: [JSON] = []
  var gateRefusals: [JSON] = []
  var marks: [JSON] = []
  var waits: [JSON] = []
  var events: [JSON] = []
  var toolCalls: [JSON] = []
  var executed: Set<String> = []
  var turn: Turn!
  var client: ServiceAiClient!
  var barrier: Task<Void, Never>?

  init(_ story: JSON, refusalStatus: [String: Int]) throws {
    self.story = story
    self.refusalStatus = refusalStatus
    profile = try Profile(story.field("profile"))
    let value = story.field("input")
    input = TurnInput(turnId: try value.field("turnId").string,
      seat: Seat(kind: Seat.Kind(rawValue: try value.field("seat").field("kind").string)!, key: try value.field("seat").field("key").string),
      question: try value.field("question").string, pictures: try Self.pictures(value.field("pictures")))
    nowMs = try story.field("runtime").field("nowMs").integer
    client = ServiceAiClient(transport: self, clock: self, diagnostics: self, credentials: { _ in AiCredentials(session: "session", installation: "installation") })
    turn = Turn(host: self, client: client, telemetry: self, runtime: self)
  }

  func run() async throws -> JSON {
    let end: TurnEnd?
    if story.field("host").field("recovery") != .null { end = await turn.recover(input: input, profile: profile) }
    else { end = await turn.run(input: input, profile: profile) }
    await barrier?.value
    return ["requests": .array(requests), "hostCalls": .array(hostCalls), "gateRefusals": .array(gateRefusals),
      "marks": .array(marks), "waitsMs": .array(waits), "telemetry": .array(events), "end": end.map(Self.json) ?? .null]
  }

  func control(_ checkpoint: String) async throws {
    for (index, control) in try story.field("controls").array.enumerated() where !controlIndices.contains(index) {
      guard try control.field("at").string == checkpoint else { continue }
      controlIndices.insert(index)
      switch try control.field("action").string {
      case "stop": turn.stop()
      case "seat":
        barrier = Task { @MainActor in await turn.seatWillChange(); generation += 1 }
        await Task.yield()
      case "delete": exists = false
      case "stale": state = "interrupted"
      default: throw AiTransportFailure.invalidResponse
      }
    }
  }

  func guardLease(_ lease: HostLease) throws {
    guard generation == lease.generation, lease.seat == input.seat else { throw HostFailure.staleSeat }
    guard exists else { throw HostFailure.recordGone }
  }

  func open(_ input: TurnInput) async throws -> OpenTurn {
    let lease = HostLease(turnId: input.turnId, seat: input.seat, generation: generation)
    try await control("open:beforeCommit")
    guard lease.generation == generation else { throw HostFailure.staleSeat }
    exists = true
    hostCalls.append(["op": "open", "input": story.field("input")])
    marks.append(Self.json(Mark(turnId: input.turnId, callId: nil, textBytesBeforeRound: 0)))
    return OpenTurn(lease: lease, history: try story.field("host").field("open").field("history").string,
      context: try story.field("host").field("open").field("context").array.map { try $0.string }, pictures: try Self.pictures(story.field("host").field("open").field("pictures")))
  }

  func recover(_ input: TurnInput) async throws -> Recovery? {
    let value = story.field("host").field("recovery")
    guard value != .null, try value.field("state").string == "running" else { return nil }
    exists = true
    hostCalls.append(["op": "recover", "turnId": .string(input.turnId)])
    return Recovery(lease: HostLease(turnId: input.turnId, seat: input.seat, generation: generation),
      mark: Mark(turnId: input.turnId, callId: try value.field("mark").field("callId") == .null ? nil : value.field("mark").field("callId").string,
        textBytesBeforeRound: Int(try value.field("mark").field("textBytesBeforeRound").integer)), text: try value.field("text").string)
  }

  func text(_ text: String, lease: HostLease) async throws {
    try await control("text:beforeCommit")
    try guardLease(lease)
    hostCalls.append(["op": "text", "text": .string(text)])
  }
  func beginRound(_ mark: Mark, text: String, lease: HostLease) async throws {
    try await control("beginRound:beforeCommit")
    try guardLease(lease)
    hostCalls.append(["op": "beginRound", "text": .string(text), "mark": Self.json(mark)])
    marks.append(Self.json(mark))
  }
  func end(_ end: TurnEnd, lease: HostLease) async throws {
    try guardLease(lease)
    hostCalls.append(["op": "end", "end": Self.json(end)])
    marks.append(.null)
  }
  func withdraw(lease: HostLease) async throws {
    try guardLease(lease)
    hostCalls.append(["op": "withdraw"]); marks.append(.null); exists = false
  }
  func check(_ check: GateCheck, call: ToolCall, lease: HostLease) async throws -> String? {
    hostCalls.append(["op": "check", "rule": .string(check.rawValue), "call": Self.json(call)])
    try await control("check:\(call.id):\(check.rawValue)")
    try guardLease(lease)
    let code = story.field("host").field("checks").field(call.id).field(check.rawValue)
    return try code == .null ? nil : code.string
  }
  func execute(_ call: ToolCall, callId: String, lease: HostLease) async throws -> ToolOutcome {
    try await control("execute:\(call.id):beforeCommit")
    try guardLease(lease)
    executed.insert(call.id)
    hostCalls.append(["op": "execute", "callId": .string(callId), "call": Self.json(call)])
    let outcome = story.field("host").field("executions").field(call.id)
    if outcome == .null { return .success(try String(call.input.field("value").integer)) }
    if try outcome.field("ok").asBool() { return .success(try outcome.field("content").string) }
    return .refusal(try outcome.field("code").string)
  }

  func callID() throws -> String { defer { callIndex += 1 }; return try story.field("runtime").field("callIds").array[callIndex].string }
  func acquire() async throws {}
  func release() {}
  func wait(ms: Int64) async throws {
    let index = waits.count
    waits.append(JSON(ms))
    try await control("wait:\(index)")
    try Task.checkCancellation()
    nowMs += ms
  }
  func hostFailure() { failure(operation: "agent-host", kind: "host") }
  func ability(name: String, code: String?) {
    if !toolCalls.isEmpty {
      let call = toolCalls.removeFirst()
      if let code, let id = try? call.field("id").string, !executed.contains(id) { gateRefusals.append(["id": .string(id), "code": .string(code)]) }
    }
    events.append(["kind": "ability", "name": .string(name), "outcome": code == nil ? "ok" : "refused", "code": code.map(JSON.string) ?? .null])
  }
  func turn(state: TurnEnd.State, seat: Seat.Kind, code: String?, rounds: Int, abilityCalls: Int, refusals: Int, answerBytes: Int, durationMs: Int64) {
    events.append(["kind": "turn", "state": .string(state.rawValue), "seat": .string(seat.rawValue), "code": code.map(JSON.string) ?? .null,
      "rounds": JSON(rounds), "abilityCalls": JSON(abilityCalls), "refusals": JSON(refusals), "answerBytes": JSON(answerBytes), "durationMs": JSON(durationMs)])
  }
  func failure(operation: String, kind: String) { events.append(["kind": "failure", "operation": .string(operation)]) }

  func send(_ request: AiRequest) async throws -> AiResponse {
    if request.path == "/v1/ai/passes" {
      let passes = try story.field("service").field("passes").array
      let value = passes[min(passIndex, passes.count - 1)]
      passIndex += 1
      let status = Int((try? value.field("status").integer) ?? 200)
      let body: JSON = status == 200 ? value : ["code": value.field("code"), "error": "Pass refused"]
      return response(status: status, type: "application/json", chunks: [body.jcs])
    }
    let body = try request.body.map { request.path.hasPrefix("/v1/pictures/") ? JSON.array($0.map { JSON($0) }) : try JSON(parsing: $0) } ?? .null
    requests.append(["method": .string(request.method), "path": .string(request.path), "body": body])
    if request.path.hasPrefix("/v1/pictures/") {
      let pictures = try story.field("service").field("pictures").array
      let status = pictureIndex < pictures.count ? Int(try pictures[pictureIndex].integer) : 204
      pictureIndex += 1
      return response(status: status, type: "", chunks: [])
    }
    let exchanges = try story.field("service").field("exchanges").array
    guard exchangeIndex < exchanges.count else { throw AiTransportFailure.invalidResponse }
    let index = exchangeIndex
    let exchange = exchanges[index]
    repeats += 1
    if repeats >= Int(try exchange.field("repeat").integer) { exchangeIndex += 1; repeats = 0 }
    if exchange.field("refusal") != .null {
      return response(status: refusalStatus[try exchange.field("refusal").field("code").string] ?? 500, type: "application/json", chunks: [exchange.field("refusal").jcs])
    }
    let events = try exchange.field("events").array
    let stream = AsyncThrowingStream<[UInt8], Error>(unfolding: { @MainActor [self, cursor = StoryCursor()] in
      guard cursor.index < events.count else { return nil }
      let event = events[cursor.index]
      cursor.index += 1
      if event.field("event") == "ended", event.field("data").field("stop") == "tool_calls" {
        toolCalls = try event.field("data").field("message").field("parts").array.compactMap { part in
          part.field("toolCall") == .null ? nil : part.field("toolCall")
        }
      }
      try await control("event:\(index):\(try event.field("id").integer)")
      return Array("id: \(try event.field("id").integer)\nevent: \(try event.field("event").string)\ndata: \(event.field("data").jcsText)\n\n".utf8)
    })
    return AiResponse(status: 200, contentType: "text/event-stream", bytes: stream)
  }

  func response(status: Int, type: String, chunks: [[UInt8]]) -> AiResponse {
    AiResponse(status: status, contentType: type, bytes: AsyncThrowingStream { continuation in
      for chunk in chunks { continuation.yield(chunk) }
      continuation.finish()
    })
  }

  static func pictures(_ value: JSON) throws -> [Picture] {
    try value.array.map { Picture(pictureId: try $0.field("pictureId").string, mediaType: try $0.field("mediaType").string,
      bytes: try $0.field("bytes").array.map { UInt8(try $0.integer) }) }
  }
  static func json(_ call: ToolCall) -> JSON { ["id": .string(call.id), "name": .string(call.name), "input": call.input] }
  static func json(_ mark: Mark) -> JSON { ["turnId": .string(mark.turnId), "callId": mark.callId.map(JSON.string) ?? .null, "textBytesBeforeRound": JSON(mark.textBytesBeforeRound)] }
  static func json(_ end: TurnEnd) -> JSON { ["state": .string(end.state.rawValue), "text": .string(end.text), "truncated": .bool(end.truncated), "code": end.code.map(JSON.string) ?? .null] }
}

@MainActor final class StoryCursor { var index = 0 }
