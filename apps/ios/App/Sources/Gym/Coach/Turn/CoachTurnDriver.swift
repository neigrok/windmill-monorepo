import Foundation
import Observation
import DomainKit
import GymDomain
import SyncCore
import SyncEngine
import SyncIOS
import SyncSchema

// The turn driver (Coach §4): the phone side of one turn. It admits a question locally, records the turn on the replica,
// gathers the context reads, history and pictures, opens the stream, streams the answer's text onto the Coach message, runs
// each batch of ability calls through the replica executor and posts their results, ends the turn with its terminal state,
// and handles Stop, a dropped connection, the background and the turns a process death or a seat change left running.

// Why a send could not go, in the words the room already has for the nearest state.
nonisolated enum CoachTurnRefusal: Equatable, Sendable {
  case allowance(String)
  case rateLimited
  case updateRequired
  case absent
  case installation(String)
  case said(String)

  init(code: String, status: Int? = nil) {
    switch code {
    case _ where TurnRefusal.allowanceCodes.contains(code) && code != "invalid_installation": self = .allowance(code)
    case "coach-rate-limited": self = .rateLimited
    case "coach-update-required", "client-update-required": self = .updateRequired
    case "invalid_installation", "installation_bound", "device_bound": self = .installation(code)
    case _ where status == 404: self = .absent
    default: self = .said(code)
    }
  }

  var code: String {
    switch self {
    case .allowance(let code), .installation(let code), .said(let code): code
    case .rateLimited: "coach-rate-limited"
    case .updateRequired: "coach-update-required"
    case .absent: "absent"
    }
  }

  var message: String {
    switch self {
    case .allowance(let code): AiAllowance.sentence(code)
    case .rateLimited: CoachCopy.daily(waitMs: nil)
    case .updateRequired: AuthRefusal.updateRequired.message
    case .absent: CoachCopy.absent
    case .installation(let code): CoachCopy.refusal(code)
    case .said: CoachCopy.noAnswer
    }
  }

  // The composer stays closed on a cap the server refills and on a deployment without Coach; everything else asks again.
  var capped: Bool {
    switch self {
    case .allowance, .rateLimited, .absent: true
    case .updateRequired, .installation, .said: false
    }
  }
}

// What the turn counted for its `coach_turn` event; never a word of it.
nonisolated struct CoachTurnTally: Sendable {
  var calls = 0
  var refusals = 0
  var answerBytes = 0
}

nonisolated struct TurnInterrupted: Error {}

@Observable @MainActor final class CoachTurnDriver {
  struct Running: Equatable, Sendable {
    let turn: OpenTurn.Turn
    let seat: TurnSeat
    var turnId: String { turn.coach.description }
  }

  let runner: ActionRunner
  let runtime: AppRuntime
  let wire: CoachTurnWire
  let executor: AbilityExecutor
  let telemetry: any Telemetry
  let beat: Duration
  // The turn this phone is driving, while it runs.
  var running: Running?
  var stopping = false
  var reconnecting = false
  // How the last send ended when the server refused it, and what the band says.
  var refusal: CoachTurnRefusal?
  var error: String?
  @ObservationIgnored var work: Task<Void, Never>?
  @ObservationIgnored var lease: Task<Void, Never>?
  @ObservationIgnored var observation: Task<Void, Never>?
  @ObservationIgnored var textFlush: Task<Void, Never>?
  // The answer's text so far, committed in coalesced chunks.
  @ObservationIgnored var streamed = ""

  init(runner: ActionRunner, runtime: AppRuntime, wire: CoachTurnWire? = nil, telemetry: any Telemetry, beat: Duration = .seconds(1)) {
    self.runner = runner; self.runtime = runtime; self.telemetry = telemetry; self.beat = beat
    self.wire = wire ?? CoachTurnWire(baseURL: runtime.settings.baseURL)
    executor = AbilityExecutor(runner: runner, appBaseUrl: runtime.settings.baseURL?.absoluteString ?? "https://windmill.works")
  }

  var offline: Bool { CoachFixture.offline || !runtime.engine.status.online }

  // Coach §4.5: at engine start a running Coach message the device row names ended with the process, and every change of
  // the active replica ends the turn that ran under the replica it replaced.
  func start() {
    guard observation == nil else { return }
    interruptAbandonedTurn()
    let events = runtime.engine.events()
    observation = Task { [weak self] in
      for await event in events {
        guard let self, !Task.isCancelled else { return }
        if case .activeReplicaChanged(let previous, _) = event { self.seatChanged(from: previous) }
      }
    }
  }

  func stop() {
    observation?.cancel(); observation = nil
  }

  func interruptAbandonedTurn() {
    guard running == nil else { return }
    do {
      guard let named = try runner.read(Gym.scope, { try $0.device(EndTurn.runningTurnKey) }), case .string(let id) = named else { return }
      let message = try runner.read(Gym.scope) { try $0.repository(CoachMessage.self).find(ID(RecordID(id)), in: .drawn) }
      guard let message, message.state == .running else { return }
      _ = try runner.run(EndTurn(message.id, state: .interrupted))
    } catch { report("storage", error) }
  }

  // The active replica changed under the turn: its stream ended with its identity, and this is the one write of an
  // `interrupted` the replica that opened it does not make itself.
  func seatChanged(from previous: String) {
    guard let running else { return }
    let message = try? runner.read(Gym.scope) { try $0.repository(CoachMessage.self).find(running.turn.coach, in: .drawn) }
    work?.cancel(); work = nil; textFlush?.cancel(); textFlush = nil
    self.running = nil; stopping = false; reconnecting = false
    guard message?.replica == previous, message?.state == .running else { return }
    do { _ = try runner.run(EndTurn(running.turn.coach, state: .interrupted)) } catch { report("storage", error) }
  }

  // MARK: - Open

  // Coach §4.1: admitted locally, recorded, and sent; the turn it opened, or nil with the band's reason, the draft kept.
  func send(_ question: String, picture: CoachPictureRow?, thread: ID<CoachThread>?, anonymous: Bool,
            withdrawn: @escaping @MainActor (OpenTurn.Turn) -> Void) async -> OpenTurn.Turn? {
    guard running == nil else { error = "Coach is answering another message. Try again when it finishes."; return nil }
    if offline { error = CoachCopy.offline; outcome("offline"); return nil }
    guard question.utf8.count <= CoachRules.maxQuestionBytes else { error = "Keep your message within \(CoachRules.maxQuestionBytes) bytes."; return nil }
    let seat: TurnSeat
    do { seat = try await self.seat(anonymous: anonymous) } catch {
      self.error = refusalMessage(for: error)
      outcome("refused")
      return nil
    }
    guard running == nil else { error = "Coach is answering another message. Try again when it finishes."; return nil }
    do {
      let admission = try runner.read(Gym.scope) { read in (open: try TrainingLog(read).open != nil, pulled: try read.firstPullComplete()) }
      if admission.open { error = "Finish your workout first."; return nil }
      if !admission.pulled { error = CoachCopy.noAnswer; outcome("refused"); return nil }
      if let picture, try runner.run(KeepPicture(picture: picture)).refusal != nil { error = "Your message couldn’t be saved. Try again."; return nil }
      let pictures = picture.map { [Picture(id: $0.id, mediaType: "image/jpeg", localOnly: true)] } ?? []
      let outcome = try runner.run(OpenTurn(thread: thread, question: question, pictures: pictures))
      guard let turn = outcome.value else { error = "Your message couldn’t be saved. Try again."; return nil }
      let running = Running(turn: turn, seat: seat)
      self.running = running; refusal = nil; error = nil; stopping = false; reconnecting = false
      telemetry.event("gym_ask_started", properties: ["screen": "coach"])
      work = Task { [weak self] in await self?.drive(running, question: question, picture: picture, withdrawn: withdrawn) }
      lease = runtime.background.run(named: "windmill.coach.turn") { [work] in await work?.value }
      return turn
    } catch {
      self.error = "Your message couldn’t be saved. Try again."
      report("storage", error)
      return nil
    }
  }

  // The seat the turn runs under: the account's session token, or the installation credential (§8.2), minted on first use
  // and never replaced once invalid.
  func seat(anonymous: Bool) async throws -> TurnSeat {
    guard anonymous else {
      guard let account = try runtime.account(), let token = runtime.tokens.token(for: account) else { throw AppFailure(message: CoachCopy.signedOut) }
      return .bound(token: token.value)
    }
    return .anon(credential: try await runtime.installation.credential())
  }

  func refusalMessage(for error: any Error) -> String {
    if GymRESTClient.needsConnection(error) { return CoachCopy.offline }
    if let failure = error as? AppFailure { return failure.message }
    if let failure = error as? AiRequestFailure {
      let code = (try? JSONDecoder().decode(InstallationFailure.self, from: failure.body))?.code ?? "unavailable"
      return CoachTurnRefusal(code: code, status: failure.status).message
    }
    return CoachCopy.refusal("unavailable")
  }

  // MARK: - The turn

  func drive(_ running: Running, question: String, picture: CoachPictureRow?, withdrawn: @escaping @MainActor (OpenTurn.Turn) -> Void) async {
    let started = ContinuousClock.now
    var tally = CoachTurnTally()
    streamed = ""
    do {
      let open = try prepare(running, question: question, picture: picture, tally: &tally)
      var stream = try wire.open(open, seat: running.seat)
      var opened = false, reconnects = 0
      while true {
        do {
          for try await event in stream {
            opened = true; reconnecting = false
            switch event {
            case .text(let delta):
              streamed += delta
              scheduleTextCommit(running)
            case .snapshot(let snapshot, let state, let batch):
              streamed = snapshot
              try commitText(running)
              if state.isTerminal { end(running, state: state, truncated: false, code: nil, tally: tally, started: started); return }
              if let batch { try await answer(batch, running, tally: &tally) }
            case .calls(let batch):
              try commitText(running)
              try await answer(batch, running, tally: &tally)
            case .done(let state, let truncated):
              end(running, state: state, truncated: truncated, code: nil, tally: tally, started: started); return
            case .error(let code) where code == TurnRefusal.streamReplaced:
              throw TurnWireFault.streamReplaced
            case .error(let code):
              end(running, state: .failed, truncated: false, code: code, tally: tally, started: started); return
            }
          }
          throw TurnWireFault.endedWithoutTerminal
        } catch let refusal as TurnRefusal where !opened && reconnects == 0 {
          withdraw(running, refusal: refusal, started: started); withdrawn(running.turn); return
        } catch let refusal as TurnRefusal {
          if refusal.status >= 500 { report("http", refusal) }
          throw TurnInterrupted()
        } catch is TurnInterrupted {
          throw TurnInterrupted()
        } catch is CancellationError {
          throw CancellationError()
        } catch {
          // Coach §4.5: a dropped stream, or one another stream of this turn replaced, resumes after 1, 2, 4 and 8 beats; a
          // fifth loss ends the turn interrupted.
          let dropped = [.endedWithoutTerminal, .streamReplaced].contains(error as? TurnWireFault) || !(error is TurnWireFault)
          guard reconnects < 4, dropped else { report(dropped ? "transport" : "decode", error); throw TurnInterrupted() }
          reconnects += 1
          reconnecting = true
          try await Task.sleep(for: beat * (1 << (reconnects - 1)))
          guard self.running == running else { throw CancellationError() }
          stream = try wire.resume(running.turnId, seat: running.seat)
        }
      }
    } catch is CancellationError {
      return
    } catch {
      guard self.running == running else { return }
      end(running, state: .interrupted, truncated: false, code: nil, tally: tally, started: started)
    }
  }

  // Coach §4.1 steps 3 to 5: the four context reads, recorded on the Coach message and within their byte bound together,
  // the newest completed turns and the model copies of the current and previous pictures.
  func prepare(_ running: Running, question: String, picture: CoachPictureRow?, tally: inout CoachTurnTally) throws -> TurnOpenRequest {
    var context: [TurnOpenRequest.ContextRead] = []
    var bytes = 0
    for name in CoachTurnBounds.contextReads {
      let request = AbilityRequest(callId: "context-" + name, name: name, input: [:])
      guard case .result(let jcs, _) = try run(request, running, tally: &tally), bytes + jcs.count <= CoachTurnBounds.contextReadBytes else { continue }
      bytes += jcs.count
      context.append(TurnOpenRequest.ContextRead(name: name, input: [:], result: try JSON(parsing: jcs)))
    }
    let messages = try runner.read(Gym.scope) { try $0.repository(CoachMessage.self).children(of: running.turn.thread, via: "threadId", in: .drawn) }
    let rows = try runner.read(Gym.scope) { read in
      try messages.contextPictures(sending: running.turn.lifter).compactMap { picture in
        CoachPictureRow(id: picture.id, json: try read.device(CoachPictureRow.key(picture.id)))
      }
    }
    return TurnOpenRequest(turnId: running.turnId, question: question,
                           pictures: rows.map { TurnOpenRequest.Picture(id: $0.id, mediaType: "image/jpeg", data: $0.model) },
                           history: messages.history(before: running.turn.coach), context: context)
  }

  // Coach §4.3: every call of the batch, in order, through the replica executor, then the batch's results in one request,
  // asked again after a lost answer, since the same body answers 204.
  func answer(_ batch: TurnBatch, _ running: Running, tally: inout CoachTurnTally) async throws {
    var results: [TurnResult] = []
    for call in batch.calls {
      switch try run(call, running, tally: &tally) {
      case .result(let jcs, _) where jcs.count > CoachTurnBounds.toolResultBytes:
        tally.refusals += 1
        results.append(TurnResult(callId: call.callId, outcome: .refused(TurnResult.tooLarge)))
      case .result(let jcs, _):
        results.append(TurnResult(callId: call.callId, outcome: .ok(try JSON(parsing: jcs))))
      case .refused(let code):
        tally.refusals += 1
        results.append(TurnResult(callId: call.callId, outcome: .refused(code.rawValue)))
      }
    }
    var attempts = 0
    while true {
      do {
        _ = try await wire.answer(running.turnId, batch: batch.batch, results: results, seat: running.seat)
        return
      } catch let refusal as TurnRefusal {
        if refusal.status >= 500 { report("http", refusal) }
        throw TurnInterrupted()
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        guard attempts < 3 else { report("transport", error); throw TurnInterrupted() }
        attempts += 1
        try await Task.sleep(for: beat * (1 << (attempts - 1)))
        guard self.running == running else { throw CancellationError() }
      }
    }
  }

  // One call on the replica: its result or refusal, recorded on the Coach message by the executor; a refusal of the
  // message itself (gone, ended, full) ends the turn.
  func run(_ call: AbilityRequest, _ running: Running, tally: inout CoachTurnTally) throws -> AbilityOutcome {
    let outcome: Outcome<AbilityOutcome, GymRefusal>
    do { outcome = try executor.run(call, on: running.turn.coach, seat: running.seat.seat) } catch { report("storage", error); throw TurnInterrupted() }
    guard let answered = outcome.value else { throw TurnInterrupted() }
    tally.calls += 1
    let said = switch answered {
    case .result: "ok"
    case .refused(let code): code.rawValue
    }
    telemetry.event("coach_ability", properties: ["name": call.name, "outcome": said])
    return answered
  }

  // The answer's text lands on the Coach message in coalesced chunks, never a commit per token.
  func scheduleTextCommit(_ running: Running) {
    guard textFlush == nil else { return }
    textFlush = Task { [weak self] in
      try? await Task.sleep(for: CoachTurnBounds.textCoalescing)
      guard let self, !Task.isCancelled else { return }
      textFlush = nil
      guard self.running == running else { return }
      try? commitText(running)
    }
  }

  func commitText(_ running: Running) throws {
    textFlush?.cancel(); textFlush = nil
    do { _ = try runner.run(StreamTurnText(message: running.turn.coach, text: streamed)) } catch { report("storage", error); throw TurnInterrupted() }
  }

  // MARK: - End

  // Coach §4.4: the terminal state, the text and the receipt its calls derive, in one transaction; then what the band and
  // the events say of it.
  func end(_ running: Running, state: MessageState, truncated: Bool, code: String?, tally: CoachTurnTally, started: ContinuousClock.Instant) {
    textFlush?.cancel(); textFlush = nil
    let text = streamed
    do { _ = try runner.run(EndTurn(running.turn.coach, state: state, text: text, truncated: truncated)) } catch { report("storage", error) }
    guard self.running == running else { return }
    self.running = nil; stopping = false; reconnecting = false; work = nil
    let refused = code.map { CoachTurnRefusal(code: $0) }
    refusal = refused
    error = refused?.message ?? (state == .interrupted ? CoachCopy.interrupted : state == .stopped ? CoachCopy.stopped : nil)
    var ended = ["screen": "coach", "outcome": Self.outcome(of: state)]
    if case .allowance? = refused { ended["outcome"] = "capped"; ended["cap"] = "allowance" }
    let duration = Int64(started.duration(to: .now).components.seconds * 1_000)
    telemetry.event("gym_ask_outcome", properties: ended, durationMs: duration)
    var turn = ["state": state.rawValue, "seat": running.seat.seat == .anon ? "anon" : "bound",
                "ability_calls": String(tally.calls), "refusals": String(tally.refusals), "answer_bytes": String(text.utf8.count)]
    if let code { turn["code"] = code }
    telemetry.event("coach_turn", properties: turn, durationMs: duration)
  }

  // A refusal before the stream started never reached Coach: the turn's records go and the question returns to the field.
  func withdraw(_ running: Running, refusal: TurnRefusal, started: ContinuousClock.Instant) {
    do { _ = try runner.run(WithdrawTurn(turn: running.turn)) } catch { report("storage", error) }
    guard self.running == running else { return }
    self.running = nil; stopping = false; reconnecting = false; work = nil
    let refused = CoachTurnRefusal(code: refusal.code, status: refusal.status)
    self.refusal = refused; error = refused.message
    var ended = ["screen": "coach", "outcome": "refused"]
    switch refused {
    case .allowance: ended["outcome"] = "capped"; ended["cap"] = "allowance"
    case .rateLimited: ended["outcome"] = "capped"; ended["cap"] = "daily"
    case .absent: ended["outcome"] = "absent"
    case .updateRequired, .installation, .said: if refusal.status >= 500 { ended["outcome"] = "failed"; report("http", refusal) }
    }
    telemetry.event("api_request_failed", properties: ["operation": "gym_coach_turn", "route": "/v1/gym", "method": "POST", "failure_kind": "http", "status": String(refusal.status)])
    telemetry.event("gym_ask_outcome", properties: ended, durationMs: Int64(started.duration(to: .now).components.seconds * 1_000))
  }

  static func outcome(of state: MessageState) -> String {
    switch state {
    case .completed: "answered"
    case .stopped: "cancelled"
    case .declined: "refused"
    case .failed, .interrupted, .running: "failed"
    }
  }

  // Coach §4.5 Stop: asked of the server, whose stream then ends the turn stopped; with no connection the turn stops on
  // this phone alone, as the band says.
  func requestStop() {
    guard let running, !stopping else { return }
    stopping = true
    Task { [weak self] in
      guard let self else { return }
      do {
        _ = try await wire.stop(running.turnId, seat: running.seat)
      } catch {
        guard self.running == running else { return }
        work?.cancel(); work = nil
        end(running, state: .stopped, truncated: false, code: nil, tally: CoachTurnTally(), started: .now)
        self.error = GymRESTClient.needsConnection(error) ? "Coach is stopped on this phone. Stopping it on the server needs a connection."
          : "The stop request didn’t reach Coach. Try again."
      }
    }
  }

  func outcome(_ outcome: String) {
    telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": outcome])
  }

  // A failure at the wire or the store, under one static name; never a word of the turn.
  func report(_ kind: String, _ error: any Error) {
    guard !(error is CancellationError), (error as? URLError)?.code != .cancelled, !GymRESTClient.needsConnection(error) else { return }
    var properties = ["operation": "gym_coach_turn", "failure_kind": kind]
    if let refusal = error as? TurnRefusal { properties["status"] = String(refusal.status) }
    telemetry.failure("gym_coach_turn", kind: kind, properties: properties)
  }
}
