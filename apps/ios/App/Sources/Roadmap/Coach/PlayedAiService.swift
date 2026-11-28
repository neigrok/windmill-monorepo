#if DEBUG && targetEnvironment(simulator)
import Foundation
import SyncCore
import WindmillPlatform

// The AI service a Debug launch plays inside the app (`-coach-play`), so Coach's flows and captures run a turn with no
// service and no provider (roadmap-coach.md: no test in CI calls either). It answers in the shapes of
// packages/api-contract/ai/wire/fixtures.json: a pass, the allowance the launch names (`-coach-allowance spent`, `capacity`
// or none), and each round's events, by the story the question names: "add a subtask: <words>" adds them to the step the
// conversation is about, or the roadmap's first, and says nothing; "I finished <step>" marks it done; "take your time"
// begins its words six seconds late and answers slowly enough to Stop; anything else answers in words that name the
// roadmap's first steps.
@MainActor final class PlayedAiService: AiTransport {
  enum Allowance: String {
    case ok, spent, capacity
  }

  let allowance: Allowance
  let pace: Duration

  init(allowance: Allowance, pace: Duration = .milliseconds(40)) {
    self.allowance = allowance; self.pace = pace
  }

  // The service a launch asks for, none where it plays no service.
  static func asked(_ arguments: [String] = ProcessInfo.processInfo.arguments) -> PlayedAiService? {
    guard arguments.contains("-coach-play") else { return nil }
    let named = arguments.firstIndex(of: "-coach-allowance").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
    return PlayedAiService(allowance: named.flatMap(Allowance.init(rawValue:)) ?? .ok)
  }

  func send(_ request: AiRequest) async throws -> AiResponse {
    switch (request.method, request.path) {
    case ("POST", "/v1/ai/passes"): return Self.json(200, ["pass": "played", "expiresIn": 600_000])
    case ("GET", "/v1/allowance"): return Self.json(200, allowanceJSON)
    case ("PUT", let path) where path.hasPrefix("/v1/calls/"):
      let callId = String(path.dropFirst("/v1/calls/".count).prefix(22))
      if allowance != .ok { return Self.json(429, ["code": .string(refusal), "allowance": allowanceJSON]) }
      return stream(callId, try JSON(parsing: request.body ?? []))
    case ("GET", let path) where path.hasPrefix("/v1/calls/"):
      return events(callId: String(path.dropFirst("/v1/calls/".count).prefix(22)), deltas: [], ending: .completed, after: 0)
    default: return Self.json(404, ["error": "not found", "code": "not-found"])
    }
  }

  var refusal: String { allowance == .spent ? "subject_exhausted" : "free_day_exhausted" }

  // The allowance as the service answers it: one that renews on 1 December, spent or not, or a free pool spent for today.
  var allowanceJSON: JSON {
    let code = switch allowance {
    case .ok: "ok"
    case .spent: "subject_exhausted"
    case .capacity: "free_day_exhausted"
    }
    return ["tier": "free", "period": "calendar_month_utc", "limit": "0.5", "used": allowance == .spent ? "0.5" : "0.01", "reserved": "0",
            "remaining": allowance == .spent ? "0" : "0.49", "resetsAt": 1_796_083_200_000, "budgetResetsAt": allowance == .capacity ? 1_795_651_200_000 : .null,
            "code": .string(code), "capabilities": ["text": ["large": "medium", "medium": "medium", "small": "small"], "transcription": false]]
  }

  enum Ending {
    case completed
    case tool(name: String, input: JSON)
  }

  // A round as the story plays it: its words, or the one direct write it calls and then the words after it.
  func stream(_ callId: String, _ body: JSON) -> AiResponse {
    let messages = (try? body.member("messages").asArray()) ?? []
    let answered = messages.contains { (try? $0.member("role").asString()) == "tool" }
    let parts = (try? messages.first?.member("parts").asArray()) ?? []
    let texts = parts.compactMap { try? $0.member("text").asString() }
    let question = texts.last ?? ""
    let context = texts.compactMap { text -> JSON? in
      guard let newline = text.firstIndex(of: "\n") else { return nil }
      return try? JSON(parsing: Array(text[text.index(after: newline)...].utf8))
    }.first
    let treeId = (try? context?.member("tree").member("id").asString()) ?? ""
    let steps = (try? context?.member("steps").asArray()) ?? []
    let step = { (label: String?) -> String in
      if let label, let found = steps.first(where: { (try? $0.member("label").asString())?.lowercased() == label.lowercased() }) {
        return (try? found.member("id").asString()) ?? ""
      }
      if let started = try? context?.member("step").member("id").asString() { return started }
      return (try? steps.first?.member("id").asString()) ?? ""
    }
    let lowered = question.lowercased()
    if !answered, let range = lowered.range(of: "add a subtask:") {
      let words = question[range.upperBound...].trimmingCharacters(in: .whitespaces)
      let subtask = words.prefix(1).uppercased() + words.dropFirst()
      return events(callId: callId, deltas: [], ending: .tool(name: "update_node", input: ["treeId": .string(treeId), "nodeId": .string(step(nil)),
                                                                                             "subtasks": [.string(subtask)]]), after: 0)
    }
    if !answered, lowered.hasPrefix("i finished ") {
      let label = String(question.dropFirst("i finished ".count)).trimmingCharacters(in: .punctuationCharacters)
      return events(callId: callId, deltas: [], ending: .tool(name: "set_progress", input: ["treeId": .string(treeId), "nodeId": .string(step(label)),
                                                                                             "status": "complete"]), after: 0)
    }
    if answered { return events(callId: callId, deltas: [], ending: .completed, after: 0) }
    let open = steps.filter { (try? $0.member("state").asString()) == "available" }.compactMap { try? $0.member("label").asString() }
    let words = open.count > 1 ? "\(open[0]). It’s open now, and \(open[1]) can wait." : "\(open.first ?? "Start at the top"). It’s open now."
    let slow = lowered.contains("take your time")
    let pieces = words.split(separator: " ").map(String.init)
    let deltas = slow ? Array(repeating: "Still reading your roadmap. ", count: 60)
      : pieces.enumerated().map { $0.offset == pieces.count - 1 ? $0.element : $0.element + " " }
    return events(callId: callId, deltas: deltas, ending: .completed, after: slow ? 250 : 0, lead: slow ? 6_000 : 0)
  }

  // A round's events, each `pauseMs` after the one before, and the first words `leadMs` after the round began.
  func events(callId: String, deltas: [String], ending: Ending, after pauseMs: Int, lead leadMs: Int = 0) -> AiResponse {
    var played: [(String, JSON)] = [("started", ["callId": .string(callId), "served": "medium", "maxTokens": 2_000])]
    played += deltas.map { ("text", ["delta": .string($0)]) }
    let text = deltas.joined()
    let message: JSON
    let stop: String
    switch ending {
    case .completed:
      message = ["role": "assistant", "parts": text.isEmpty ? [] : [["text": .string(text)]], "carry": "wm-carry.v1.played"]
      stop = "completed"
    case .tool(let name, let input):
      let call: JSON = ["id": "played-1", "name": .string(name), "input": input]
      played.append(("toolCall", call))
      message = ["role": "assistant", "parts": [["toolCall": call]], "carry": "wm-carry.v1.played"]
      stop = "tool_calls"
    }
    played.append(("ended", ["stop": .string(stop), "message": message, "charged": "0.001", "allowance": allowanceJSON]))
    let pace = pauseMs > 0 ? Duration.milliseconds(pauseMs) : self.pace
    let bytes = AsyncThrowingStream<[UInt8], Error> { continuation in
      let task = Task {
        for (index, (name, data)) in played.enumerated() {
          if index == 1 && leadMs > 0 { try? await Task.sleep(for: .milliseconds(leadMs)) }
          if index > 0 { try? await Task.sleep(for: pace) }
          continuation.yield(Array("id: \(index + 1)\nevent: \(name)\ndata: \(data.jcsText)\n\n".utf8))
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
    return AiResponse(status: 200, contentType: "text/event-stream", bytes: bytes)
  }

  static func json(_ status: Int, _ value: JSON) -> AiResponse {
    AiResponse(status: status, contentType: "application/json", bytes: AsyncThrowingStream { continuation in
      continuation.yield(value.jcs)
      continuation.finish()
    })
  }
}
#endif
