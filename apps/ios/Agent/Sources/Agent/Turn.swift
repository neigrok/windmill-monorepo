import SyncCore

public struct Recovery: Sendable {
  public let lease: HostLease
  public let mark: Mark
  public let text: String
  public init(lease: HostLease, mark: Mark, text: String) { self.lease = lease; self.mark = mark; self.text = text }
}

@MainActor public final class Turn {
  let host: any ToolHost
  let client: any AiClient
  let telemetry: any Telemetry
  let runtime: any TurnRuntime
  var active: TurnExecution?

  public init(host: any ToolHost, client: any AiClient, telemetry: any Telemetry, runtime: any TurnRuntime) {
    self.host = host; self.client = client; self.telemetry = telemetry; self.runtime = runtime
  }

  public func stop() { active?.stop() }

  public func seatWillChange() async {
    guard let execution = active else { client.seatWillChange(); return }
    await execution.seatWillChange()
    if active === execution { active = nil }
  }

  public func run(input: TurnInput, profile: Profile) async -> TurnEnd? {
    guard active == nil else { return nil }
    let execution = TurnExecution(host: host, client: client, telemetry: telemetry, runtime: runtime)
    active = execution
    defer { if active === execution { active = nil } }
    return await execution.run(input: input, profile: profile)
  }

  public func recover(input: TurnInput, profile: Profile) async -> TurnEnd? {
    guard active == nil else { return nil }
    let execution = TurnExecution(host: host, client: client, telemetry: telemetry, runtime: runtime)
    active = execution
    defer { if active === execution { active = nil } }
    return await execution.recover(input: input, profile: profile)
  }
}

@MainActor final class TurnExecution {
  let host: any ToolHost
  let client: any AiClient
  let telemetry: any Telemetry
  let runtime: any TurnRuntime
  var lease: HostLease?
  var input: TurnInput?
  var text = ""
  var stopRequested = false
  var seatChange = false
  var active = false
  var workLease = false
  var rounds = 0
  var abilityCalls = 0
  var refusals = 0
  var writes = 0
  var start: Int64 = 0
  var telemetryCodes: Set<String> = []
  var groupSuccesses: [String: Int] = [:]
  var identities: Set<String> = []
  var mutation: Task<Void, Never>?
  var finishTask: Task<TurnEnd?, Never>?

  public init(host: any ToolHost, client: any AiClient, telemetry: any Telemetry, runtime: any TurnRuntime) {
    self.host = host; self.client = client; self.telemetry = telemetry; self.runtime = runtime
  }

  public func stop() { stopRequested = true; client.stopAskingAgain() }

  public func seatWillChange() async {
    seatChange = true
    client.seatWillChange()
    await mutation?.value
    guard active else { return }
    _ = await finish(.interrupted)
    releaseWork()
  }

  public func run(input: TurnInput, profile: Profile) async -> TurnEnd? {
    guard !active else { return nil }
    reset(input, profile: profile)
    defer { active = false; releaseWork() }
    do {
      try await mutate { [self] in try await runtime.acquire(); workLease = true }
      try checkSeat()
      let open = try await mutate { [self] in
        let open = try await host.open(input)
        lease = open.lease
        return open
      }
      try checkSeat()
      if stopRequested { return await finish(.stopped) }
      try await client.upload(open.pictures, profile: profile, seat: input.seat)
      try checkSeat()
      var messages = [try profile.firstMessage(input: input, open: open)]
      for _ in 0..<profile.modelCalls {
        try checkSeat()
        if stopRequested { return await finish(.stopped) }
        let callId = try runtime.callID()
        let mark = Mark(turnId: input.turnId, callId: callId, textBytesBeforeRound: text.utf8.count)
        try await mutate { [self] in try await host.beginRound(mark, text: text, lease: open.lease) }
        try checkSeat()
        if stopRequested { return await finish(.stopped) }
        rounds += 1
        var terminal: AiEvent?
        try await client.call(id: callId, request: profile.request(messages: messages), profile: profile,
          seat: input.seat, pictures: open.pictures) { [self] event in
          try checkSeat()
          if event.name == "text" {
            text += try event.data.asObject().member("delta").asString()
            try await mutate { [self] in try await host.text(text, lease: open.lease) }
          }
          if event.name == "ended" || event.name == "failed" { terminal = event }
        }
        try checkSeat()
        guard let terminal else { throw AiFailure(source: .wire, code: "invalid-answer", admission: .admitted) }
        let answer = try terminal.data.asObject()
        if terminal.name == "failed" { return await finish(.failed, code: try answer.member("code").asString()) }
        let stop = try answer.member("stop").asString()
        switch stop {
        case "completed": return await finish(.completed)
        case "truncated": return await finish(.completed, truncated: true)
        case "declined": return await finish(.declined)
        case "tool_calls":
          if stopRequested { return await finish(.stopped) }
          let message = try answer.member("message")
          let calls = try Self.calls(message)
          guard !calls.isEmpty, Set(calls.map(\.id)).count == calls.count else {
            client.invalidAnswer()
            throw AiFailure(source: .wire, code: "invalid-answer", admission: .admitted)
          }
          messages.append(message)
          var results: [JSON] = []
          for call in calls {
            try checkSeat()
            if stopRequested { return await finish(.stopped) }
            let identity = callId + ":" + call.id
            guard identities.insert(identity).inserted else {
              client.invalidAnswer()
              throw AiFailure(source: .wire, code: "invalid-answer", admission: .admitted)
            }
            let refusal = try await gate(call, profile: profile, lease: open.lease)
            try checkSeat()
            let outcome: ToolOutcome
            if let refusal {
              refusals += 1
              outcome = .refusal(refusal)
            } else {
              abilityCalls += 1
              if profile.tools.first(where: { $0.name == call.name })?.countsAsWrite == true { writes += 1 }
              outcome = try await mutate { [self] in try await host.execute(call, callId: callId, lease: open.lease) }
              if case .success = outcome {
                for group in profile.groups where group.tools.contains(call.name) { groupSuccesses[group.name, default: 0] += 1 }
              }
            }
            let content: String
            let code: String?
            switch outcome {
            case .success(let value): content = value; code = nil
            case .refusal(let value): content = profile.refusal(value); code = value
            }
            telemetry.ability(name: profile.tools.contains(where: { $0.name == call.name }) ? call.name : "unoffered", code: bounded(code))
            results.append(.object(.init(uniqueKeysWithValues: [("id", .string(call.id)), ("content", .string(content)), ("isError", .bool(code != nil))])))
          }
          messages.append(.object(.init(uniqueKeysWithValues: [("role", .string("tool")), ("results", .array(results))])))
        default: throw AiFailure(source: .wire, code: "invalid-answer", admission: .admitted)
        }
      }
      if stopRequested { return await finish(.stopped) }
      return await finish(.failed, code: "model-call-limit")
    } catch HostFailure.recordGone {
      return await finish(.interrupted, gone: true)
    } catch HostFailure.staleSeat {
      return await finish(.interrupted)
    } catch let failure as AiFailure {
      if seatChange { return await finish(.interrupted) }
      if failure.code == "stopped" { return await finish(.stopped) }
      return await finish(.failed, code: failure.code, withdraw: rounds <= 1 && failure.admission == .none)
    } catch {
      client.invalidAnswer()
      return await finish(.failed, code: "invalid-answer")
    }
  }

  public func recover(input: TurnInput, profile: Profile) async -> TurnEnd? {
    guard !active else { return nil }
    reset(input, profile: profile)
    defer { active = false; releaseWork() }
    do {
      try await mutate { [self] in try await runtime.acquire(); workLease = true }
      let recovery = try await mutate { [self] in
        let recovery = try await host.recover(input)
        lease = recovery?.lease
        return recovery
      }
      guard let recovery else { return nil }
      text = recovery.text
      try checkSeat()
      guard let callId = recovery.mark.callId else { return await finish(.interrupted) }
      let prefixBytes = Array(text.utf8.prefix(recovery.mark.textBytesBeforeRound))
      let prefix = String(decoding: prefixBytes, as: UTF8.self)
      guard Array(prefix.utf8) == prefixBytes, recovery.mark.textBytesBeforeRound <= text.utf8.count else {
        client.invalidAnswer()
        return await finish(.interrupted)
      }
      var roundText = ""
      var terminal: AiEvent?
      try await client.recover(id: callId, profile: profile, seat: input.seat) { [self] event in
        try checkSeat()
        if event.name == "text" {
          roundText += try event.data.asObject().member("delta").asString()
          text = prefix + roundText
          try await mutate { [self] in try await host.text(text, lease: recovery.lease) }
        }
        if event.name == "ended" || event.name == "failed" { terminal = event }
      }
      try checkSeat()
      guard let terminal else { return await finish(.interrupted) }
      let answer = try terminal.data.asObject()
      if terminal.name == "failed" { return await finish(.failed, code: try answer.member("code").asString()) }
      switch try answer.member("stop").asString() {
      case "completed": return await finish(.completed)
      case "truncated": return await finish(.completed, truncated: true)
      case "declined": return await finish(.declined)
      default: return await finish(.interrupted)
      }
    } catch HostFailure.recordGone { return await finish(.interrupted, gone: true) }
    catch { return await finish(.interrupted) }
  }

  func releaseWork() {
    guard workLease else { return }
    workLease = false
    runtime.release()
  }

  func reset(_ input: TurnInput, profile: Profile) {
    self.input = input; active = true; lease = nil; text = ""; stopRequested = false; seatChange = false
    rounds = 0; abilityCalls = 0; refusals = 0; writes = 0; groupSuccesses = [:]; identities = []
    telemetryCodes = AiFailure.codes.union((try? profile.value.asObject().member("refusals").asObject().keys) ?? [])
    start = runtime.nowMs; mutation = nil; finishTask = nil
  }

  func gate(_ call: ToolCall, profile: Profile, lease: HostLease) async throws -> String? {
    guard let tool = profile.tools.first(where: { $0.name == call.name }) else { return "not-offered" }
    for rule in [GateCheck.seat, .shape] {
      if let code = try await host.check(rule, call: call, lease: lease) { return code }
      try checkSeat()
    }
    for group in profile.groups where group.tools.contains(call.name) {
      if groupSuccesses[group.name, default: 0] >= group.maxSuccesses { return group.code }
    }
    if abilityCalls >= profile.abilityCalls || tool.countsAsWrite && writes >= profile.writes { return "coach-turn-volume" }
    if let code = try await host.check(.product, call: call, lease: lease) { return code }
    try checkSeat()
    return stopRequested ? "stopped" : nil
  }

  func mutate<T: Sendable>(_ body: @escaping @MainActor () async throws -> T) async throws -> T {
    let previous = mutation
    let task = Task { @MainActor in await previous?.value; return try await body() }
    mutation = Task { _ = try? await task.value }
    return try await task.value
  }

  func bounded(_ code: String?) -> String? { code.map { telemetryCodes.contains($0) ? $0 : "unknown" } }

  func checkSeat() throws { if seatChange { throw HostFailure.staleSeat } }

  func finish(_ state: TurnEnd.State, code: String? = nil, truncated: Bool = false,
              withdraw: Bool = false, gone: Bool = false) async -> TurnEnd? {
    if let finishTask { return await finishTask.value }
    let end = TurnEnd(state: state, text: text, truncated: truncated, code: code)
    let task = Task { @MainActor [self] () -> TurnEnd? in
      await mutation?.value
      var removed = gone
      if let lease, !gone {
        do {
          if withdraw { try await host.withdraw(lease: lease) }
          else { try await host.end(end, lease: lease) }
        } catch HostFailure.recordGone { removed = true }
        catch HostFailure.staleSeat { removed = true }
        catch { client.invalidAnswer() }
      }
      if let input {
        telemetry.turn(state: end.state, seat: input.seat.kind, code: bounded(code), rounds: rounds,
          abilityCalls: abilityCalls, refusals: refusals, answerBytes: end.text.utf8.count, durationMs: max(0, runtime.nowMs - start))
      }
      return removed ? nil : end
    }
    finishTask = task
    return await task.value
  }

  static func calls(_ message: JSON) throws -> [ToolCall] {
    try message.asObject().member("parts").asArray().compactMap { part in
      guard let call = try part.asObject()["toolCall"] else { return nil }
      let object = try call.asObject()
      return ToolCall(id: try object.member("id").asString(), name: try object.member("name").asString(), input: try object.member("input"))
    }
  }
}
