import Foundation
import Observation
import Agent
import DomainKit
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncEngine
import WindmillPlatform

// Roadmap Coach in the iPhone's room (roadmap-ios.md §8; Roadmap · iOS section 11): the composer, a turn running on the
// Coach engine, the direct writes it makes with their receipts and Undo, the conversation the sheet shows, History, and what
// the AI service lets this phone ask. One composer is in the room at a time: at the foot of the Board, the Graph and a step's
// page, or at the sheet's foot while a conversation is open.
@Observable @MainActor final class RoadmapCoach: RoadmapTurnHost.Listener {
  // What the next question is about: the open roadmap, or one step of it, and where the composer was opened from.
  struct About: Equatable {
    let treeId: String
    let step: String?
    let stepLabel: String?
  }

  // Where a person opened Coach, as `roadmap_coach_opened` names it: the foot of the Board or the Graph, a step's page,
  // Ask Coach on a Board row, or the sheet.
  enum Entry: String {
    case foot, step, row, sheet
  }

  // What the AI service lets this phone ask, said in the band slot above the composer (11.19a to 11.21), each in the board's
  // words; the states no board draws in gym Coach's.
  enum Notice: Equatable {
    case offline
    case allowanceUsed(signedIn: Bool, renews: Instant?)
    case capacityUsed
    case busy
    case signIn
    case update
    case switchedOff
    case didNotAnswer

    // Engine §7's state of a refusal, from the code it came with.
    init(code: String?, allowance: JSON?, signedIn: Bool) {
      switch Access.forFailure(AiFailure(source: .text, code: code)) {
      case .allowanceUsed:
        let renews = allowance.flatMap { try? $0.member("resetsAt").asInteger() }.map(Instant.init(ms:))
        self = .allowanceUsed(signedIn: signedIn, renews: renews)
      case .capacityUsed: self = .capacityUsed
      case .busy: self = .busy
      case .signIn: self = .signIn
      case .update: self = .update
      case .switchedOff: self = .switchedOff
      case .offline: self = .offline
      case .didNotAnswer: self = .didNotAnswer
      }
    }

    var reason: String {
      switch self {
      case .offline: "offline"
      case .allowanceUsed: "allowanceUsed"
      case .capacityUsed: "capacityUsed"
      case .busy: "busy"
      case .signIn: "signIn"
      case .update: "update"
      case .switchedOff: "switchedOff"
      case .didNotAnswer: "didNotAnswer"
      }
    }
  }

  // The turn this phone runs: its records, what it is about, and the line the field shows in its place.
  struct Running: Equatable {
    let turn: RoadmapDomain.OpenTurn.Turn
    var line: String
  }

  // The engine and its ports, which the app builds once Coach is switched on.
  struct Engine {
    let turn: Turn
    let client: ServiceAiClient
    let host: RoadmapTurnHost
  }

  let runner: ActionRunner
  let engine: Engine
  let profile: CoachProfile
  let telemetry: any EventTelemetry
  // The seat a turn runs under now: the account signed in, or this phone's installation; and the installation's credential
  // taken, minted on first use, before a turn signed out asks.
  let seat: @MainActor () -> Agent.Seat?
  let installation: @MainActor () async throws -> Void
  let online: @MainActor () -> Bool
  let freshness: @MainActor () -> SyncFreshness
  weak var room: RoadmapModel?

  // The composer's words, where the person is writing them, and what they are about.
  var field = ""
  var focused = false
  var about: About?
  // The conversation the sheet shows, none for a new one before its first question, and whether the sheet stands.
  var thread: ID<CoachThread>?
  var sheet = false
  var running: Running?
  // The running answer's words as the engine hands them over, ahead of its record.
  var live: (message: ID<CoachMessage>, text: String)?
  var notice: Notice?
  // How many times the room has read its records since Coach opened: what a screen of Coach's draws again by, since it
  // reads the copy through the runner.
  var revision = 0
  // The question a turn took from the field, given back if the turn is withdrawn.
  @ObservationIgnored var asked: (question: String, about: About?)?
  // Each turn's tool host while a receipt of it may still be undone, and the writes whose Undo it still settles, in order.
  @ObservationIgnored var hosts: [ID<CoachMessage>: (tools: RoadmapToolHost, undoing: [CoachWrite])] = [:]
  @ObservationIgnored var sweep: Task<Void, Never>?

  init(runner: ActionRunner, engine: Engine, profile: CoachProfile, telemetry: any EventTelemetry, seat: @escaping @MainActor () -> Agent.Seat?,
       installation: @escaping @MainActor () async throws -> Void, online: @escaping @MainActor () -> Bool,
       freshness: @escaping @MainActor () -> SyncFreshness) {
    self.runner = runner; self.engine = engine; self.profile = profile; self.telemetry = telemetry; self.seat = seat
    self.installation = installation; self.online = online; self.freshness = freshness
    engine.host.listener = self
  }

  // MARK: - Opening

  // A person opens the composer, from the foot, a step's page or a Board row's Ask Coach: about the open roadmap, or one of
  // its steps.
  func open(about step: (id: String, label: String)? = nil, from entry: Entry) {
    guard let treeId = room?.shown?.id.description else { return }
    about = About(treeId: treeId, step: step?.id, stepLabel: step?.label)
    // A conversation goes on while it is about what the composer now asks of; another starts anew.
    if let shown = conversation?.thread, shown.treeId != treeId || (step != nil && shown.stepId != step?.id) { thread = nil }
    focused = true
    telemetry.event("roadmap_coach_opened", properties: ["entry": entry.rawValue])
    Task { await readAllowance() }
  }

  // New Chat (11.6b): the thread empties, and the composer is focused with its suggestions.
  func newChat() {
    thread = nil
    focused = true
  }

  // History opens a conversation: the sheet shows it, and the next question continues it.
  func show(_ thread: ID<CoachThread>) {
    self.thread = thread
    sheet = true
  }

  // Engine §7: before a question is sent, the allowance says whether one could be asked.
  func readAllowance() async {
    guard let seat = seat(), notice == nil || notice == .offline else { return }
    guard let profile = try? profile.profile(seat: seat.kind, about: about?.treeId) else { return }
    guard let allowance = try? await engine.client.allowance(profile: profile, seat: seat), let code = try? allowance.member("code").asString() else { return }
    notice = code == "ok" ? nil : Notice(code: code, allowance: allowance, signedIn: seat.kind == .bound)
  }

  // MARK: - Asking

  // Send (11.2): the question leaves the field and a turn opens its records and runs. With no connection, or a seat the
  // phone cannot take, the question stays in the field and the band slot says why (11.21).
  func send(_ words: String? = nil) async {
    let question = words ?? field
    guard running == nil, !TextSpec.isBlank(question), question.utf8.count <= RoadmapLimits.questionBytes else { return }
    guard online() else { return refuse(.offline) }
    let signedIn = seat()?.kind == .bound
    if !signedIn {
      do { try await installation() } catch { return refuse(online() ? .signIn : .offline) }
    }
    guard let seat = seat(), let treeId = about?.treeId ?? room?.shown?.id.description else { return }
    let about = about ?? About(treeId: treeId, step: nil, stepLabel: nil)
    let open: RoadmapDomain.OpenTurn = thread.map { RoadmapDomain.OpenTurn(thread: $0, question: question) }
      ?? RoadmapDomain.OpenTurn(about: .init(treeId: about.treeId, stepId: about.step), question: question)
    let turn: RoadmapDomain.OpenTurn.Turn
    do {
      switch try runner.runAct(open) {
      case .committed(let opened, _), .unchanged(let opened): turn = opened
      case .refused: thread = nil; return
      }
    } catch {
      telemetry.failure("roadmap-coach-turn", kind: "storage")
      return
    }
    let tools = RoadmapToolHost(runner: runner, about: about.treeId) { [weak self] ability, undo in self?.told(ability, undo) }
    hosts[turn.coach] = (tools, [])
    engine.host.next = RoadmapTurnHost.Opened(turn: turn, about: about.treeId, step: about.step, seat: seat, tools: tools)
    asked = (question, self.about)
    field = ""
    notice = nil
    thread = turn.thread
    running = Running(turn: turn, line: Self.line(of: nil))
    let profile: Profile
    do { profile = try self.profile.profile(seat: seat.kind, about: about.treeId) } catch {
      telemetry.failure("roadmap-coach-turn", kind: "unexpected")
      return finished(turn, end: nil)
    }
    let end = await engine.turn.run(input: TurnInput(turnId: turn.coach.description, seat: seat, question: question), profile: profile)
    finished(turn, end: end)
  }

  // A turn ended: given back to the field where it never began, its refusal said where a cap or a door stopped it, its sheet
  // left as it was, and its tool host kept while a receipt of it may still be undone.
  func finished(_ turn: RoadmapDomain.OpenTurn.Turn, end: TurnEnd?) {
    running = nil
    if live?.message == turn.coach { live = nil }
    let withdrawn = (try? runner.read(CoachMessage.scope) { try $0.repository(CoachMessage.self).find(turn.coach, in: .drawn) }) == nil
    if withdrawn, let asked {
      field = asked.question
      about = asked.about
      if (try? runner.read(CoachThread.scope) { try $0.repository(CoachThread.self).find(turn.thread, in: .drawn) }) == nil { thread = nil }
    }
    asked = nil
    if let end, end.state == .failed || withdrawn {
      let refused = Notice(code: end.code, allowance: engine.client.lastAllowance, signedIn: seat()?.kind == .bound)
      notice = refused
      if withdrawn { telemetry.event("roadmap_coach_ask_refused", properties: ["reason": refused.reason]) }
    }
    if hosts[turn.coach]?.undoing.isEmpty != false, receipts(of: turn.coach).isEmpty { close(turn.coach) }
  }

  func refuse(_ notice: Notice) {
    self.notice = notice
    telemetry.event("roadmap_coach_ask_refused", properties: ["reason": notice.reason])
  }

  // Stop (11.2): the turn ends stopped before its next round or call.
  func stop() {
    guard running != nil else { return }
    engine.turn.stop()
    telemetry.event("roadmap_coach_stopped")
  }

  // MARK: - What the turn tells

  func answering(_ message: ID<CoachMessage>, text: String) {
    live = (message, text)
    if !text.isEmpty, !sheet { sheet = true }
  }

  // A direct write landed: the band is its receipt, with Undo for six seconds (11.3); a completion is said in the Board's
  // own words (11.18).
  func wrote(_ write: CoachWrite) {
    running?.line = Self.line(of: write.receipt.ability)
    room?.offer(write)
  }

  // The step line the field shows while a turn runs: the catalog's phrase of what it does now, never the model's words.
  static func line(of ability: String?) -> String {
    switch ability {
    case "get_nodes": String(localized: "Reading some steps…")
    case "find_nodes": String(localized: "Searching your roadmap…")
    case "get_progress": String(localized: "Reading your progress…")
    case "get_diagnostics": String(localized: "Checking your roadmap…")
    case "list_trees": String(localized: "Reading your roadmaps…")
    case "set_progress": String(localized: "Marking a step…")
    case "update_node": String(localized: "Changing a step…")
    case "create_node": String(localized: "Adding a step…")
    case "connect": String(localized: "Linking two steps…")
    default: String(localized: "Reading your roadmap…")
    }
  }

  // MARK: - Receipts and their Undo

  // The band's Undo of a receipt: the tool host takes the write back, and what it came to is told as the engine settles it.
  // An Undo that throws reports under the room's own write failure (§13).
  func undo(_ write: CoachWrite) {
    guard let host = hosts[write.message] else {
      room?.show(.init(unrestored: .coachWrote(write.facts)))
      return
    }
    hosts[write.message]?.undoing.append(write)
    do { try host.tools.undo(write.receipt) } catch {
      room?.report(error, write: "coachUndo")
    }
  }

  // The band of a receipt ended: the engine keeps nothing more of its act.
  func forget(_ write: CoachWrite) {
    guard let host = hosts[write.message] else { return }
    do { try host.tools.forget(write.receipt) } catch { room?.report(error, write: "coachUndo") }
    if host.undoing.isEmpty, running?.turn.coach != write.message { close(write.message) }
  }

  // The tool host told what an Undo came to: the band says so, and an Undo that took the write back is the receipt's fate,
  // so it reads Undone on every device.
  func told(_ ability: String, _ undo: WriteReceipt.Undo) {
    telemetry.event("roadmap_coach_write_undone", properties: ["ability": ability, "outcome": undo.rawValue])
    guard let message = hosts.first(where: { !$0.value.undoing.isEmpty && $0.value.undoing[0].receipt.ability == ability })?.key,
          let write = hosts[message]?.undoing.removeFirst() else { return }
    guard undo == .undone else {
      room?.show(.init(unrestored: .coachWrote(write.facts)))
      return
    }
    do { _ = try runner.runAct(RecordWriteFate(write.message, receipt: write.index, fate: .undone)) } catch {
      room?.report(error, write: "coachUndo")
    }
    room?.show(.init(told: .coachUndone))
  }

  // The copy changed: each Undo the engine has settled since it was asked is told.
  func follow() {
    for host in hosts.values where !host.undoing.isEmpty {
      do { try host.tools.follow() } catch { room?.report(error, write: "coachUndo") }
    }
  }

  func close(_ message: ID<CoachMessage>) {
    guard let host = hosts.removeValue(forKey: message) else { return }
    try? host.tools.close()
  }

  func receipts(of message: ID<CoachMessage>) -> [CoachReceipt] {
    (try? runner.read(CoachMessage.scope) { try $0.repository(CoachMessage.self).find(message, in: .drawn) })??.receipts ?? []
  }

  // MARK: - Reading the records

  // The conversation the sheet shows, as the phone's copy holds it.
  var conversation: Conversation? {
    guard let thread else { return nil }
    return try? runner.read(CoachThread.scope) { try Conversation.read($0, thread: thread) }
  }

  // History (11.7): every conversation, the open roadmap's first.
  func history() -> CoachHistory? {
    try? runner.read(CoachThread.scope) { try CoachHistory.read($0, current: room?.shown?.id.description) }
  }

  // History's swipe: the conversation and its proposals, held as any roadmap delete is.
  func delete(_ thread: ID<CoachThread>) {
    guard running?.turn.thread != thread else { return }
    do { _ = try runner.runAct(DeleteConversation(thread)) } catch { room?.report(error, write: "coachDelete") }
    if self.thread == thread { self.thread = nil }
  }

  // MARK: - The process and the seat

  // Engine §5: as the room starts, each turn this replica marks is read back, and a turn nobody ends is ended once its
  // record has stood thirty minutes by the server's clock.
  func start() {
    guard sweep == nil else { return }
    sweep = Task { [weak self] in
      await self?.recover()
      while !Task.isCancelled {
        self?.endStale()
        try? await Task.sleep(for: .seconds(60))
      }
    }
  }

  func recover() async {
    guard let seat = seat(), let profile = try? profile.profile(seat: seat.kind, about: nil) else { return }
    let marks: [RunningMark]
    switch try? runner.runAct(RecoverMark()) {
    case .committed(let held, _)?, .unchanged(let held)?: marks = held
    default: return
    }
    for mark in marks where running == nil {
      _ = await engine.turn.recover(input: TurnInput(turnId: mark.message.description, seat: seat, question: ""), profile: profile)
    }
  }

  func endStale() {
    let fresh = freshness()
    guard fresh.live, let serverNow = fresh.serverNow else { return }
    let runningIds = (try? runner.read(CoachMessage.scope) { read in
      try read.repository(CoachMessage.self).all(in: .drawn).filter { $0.isCoach && $0.state == .running }.map(\.id)
    }) ?? []
    for id in runningIds where id != running?.turn.coach {
      _ = try? runner.runAct(InterruptStaleTurn(id, serverNow: serverNow))
    }
  }

  // Engine §5, the seat changes: a running turn ends interrupted, its pass dropped, before the seat is replaced.
  func seatWillChange() async {
    await engine.turn.seatWillChange()
    engine.host.seatDidChange()
    for message in Array(hosts.keys) { close(message) }
    notice = nil
  }

  func stopSweeping() {
    sweep?.cancel()
    sweep = nil
  }
}

// The product binding the engine awaits before it changes the replica the room writes to (Coach D-10).
@MainActor final class RoadmapBinding: ProductBinding {
  nonisolated let product = "roadmap"
  weak var coach: RoadmapCoach?

  func seatWillChange() async throws {
    await coach?.seatWillChange()
  }
}

extension RoadmapCoach {
  // Coach as the app composes it on the room's runner: the engine's turn over roadmap's host, the AI client on the server's
  // origin, or the service a Debug launch plays, under the account signed in or this phone's installation.
  static func make(runtime: AppRuntime, telemetry: any EventTelemetry) throws -> RoadmapCoach {
    let profile = try CoachProfile()
    let seat = { @MainActor () -> Agent.Seat? in
      guard let account = try? runtime.account() else { return Agent.Seat(kind: .anon, key: "installation") }
      return Agent.Seat(kind: .bound, key: account)
    }
    let host = RoadmapTurnHost(runner: runtime.roadmapRunner, profile: profile, seat: seat)
    let ports = CoachTelemetry(telemetry: telemetry) { [weak host] in host?.lastEnd?.truncated ?? false }
    #if DEBUG
    let played: (any AiTransport)? = PlayedAiService.asked()
    #else
    let played: (any AiTransport)? = nil
    #endif
    let transport = try played ?? Self.network(runtime.settings.baseURL)
    let engine = runtime.engine
    let credentials = { @MainActor (seat: Agent.Seat) throws -> AiCredentials in
      let installation = try runtime.installation.credentials.read()
      guard seat.kind == .bound else { return AiCredentials(installation: installation) }
      return AiCredentials(session: runtime.tokens.token(for: seat.key)?.value, installation: installation)
    }
    let client = ServiceAiClient(transport: transport, clock: AiSystemClock(), diagnostics: ports, credentials: credentials,
                                 connection: { engine.status.online })
    let turn = Turn(host: host, client: client, telemetry: ports, runtime: CoachRuntime(clock: AiSystemClock(), lease: CoachBackgroundLease(), expired: {}))
    let coach = RoadmapCoach(runner: runtime.roadmapRunner, engine: Engine(turn: turn, client: client, host: host), profile: profile, telemetry: telemetry,
                             seat: seat, installation: { if played == nil { _ = try await runtime.installation.credential() } }, online: { engine.status.online },
                             freshness: { (try? engine.read(CoachThread.scope) { try $0.freshness() }) ?? SyncFreshness() })
    runtime.roadmapBinding.coach = coach
    return coach
  }

  // The server's origin, plain HTTP on this Mac's own address alone, as a local stack serves it.
  static func network(_ baseURL: URL?) throws -> any AiTransport {
    let origin = baseURL ?? URL(string: "https://windmill.works")!
    return try AiURLSessionTransport(origin: origin, allowLoopbackHTTP: ["127.0.0.1", "localhost"].contains(origin.host ?? ""))
  }
}
