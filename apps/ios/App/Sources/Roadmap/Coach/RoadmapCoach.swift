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
  // What a conversation is about: one roadmap, one step of it, or every roadmap of the person's (no roadmap); and whether
  // Coach may write there, which it does in a roadmap of the person's own alone. The sheet's subtitle, the context, the
  // profile's tools and the tool host's scope all read this one value.
  struct About: Equatable {
    let treeId: String?
    let step: String?
    let stepLabel: String?
    let writes: Bool
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

  // Each turn's tool host while a write of it may still be undone: the writes the band offers the Undo of, and those whose
  // Undo the engine still settles. A host closes once neither holds a write and its turn has ended.
  struct Host {
    let tools: RoadmapToolHost
    var offered: [CoachWrite] = []
    var undoing: [CoachWrite] = []
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
  // The seat a turn runs under now: the account signed in, or this phone's installation, which throws where the phone
  // cannot read its account; and the installation's credential taken, minted on first use, before a turn signed out asks.
  let seat: @MainActor () throws -> Agent.Seat
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
  @ObservationIgnored var hosts: [ID<CoachMessage>: Host] = [:]
  @ObservationIgnored var sweep: Task<Void, Never>?
  // While a turn this replica marked is read back, or the seat changes, Coach holds: a question waits in the field and
  // nothing is written. A seat change may be announced more than once before it finishes.
  @ObservationIgnored var recovering = false
  @ObservationIgnored var seatChanges = 0
  // The kinds of failure a settling Undo's read has reported, once each while the room lives.
  @ObservationIgnored var followFailures: Set<String> = []

  init(runner: ActionRunner, engine: Engine, profile: CoachProfile, telemetry: any EventTelemetry, seat: @escaping @MainActor () throws -> Agent.Seat,
       installation: @escaping @MainActor () async throws -> Void, online: @escaping @MainActor () -> Bool,
       freshness: @escaping @MainActor () -> SyncFreshness) {
    self.runner = runner; self.engine = engine; self.profile = profile; self.telemetry = telemetry; self.seat = seat
    self.installation = installation; self.online = online; self.freshness = freshness
    engine.host.listener = self
  }

  // MARK: - Opening

  // A person opens the composer, from the foot, a step's page or a Board row's Ask Coach of the room they are in, a roadmap
  // gone into among them: about the roadmap that room shows, or one of its steps. A conversation goes on while it is about
  // what the composer now asks of, and keeps what it is about; another starts anew.
  func open(in shown: RoadmapModel, about step: (id: String, label: String)? = nil, from entry: Entry) {
    guard let treeId = shown.shown?.id.description else { return }
    if let thread, let held = about(of: thread), held.treeId == treeId, step == nil || held.step == step?.id {
      about = held
    } else {
      thread = nil
      about = About(treeId: treeId, step: step?.id, stepLabel: step?.label, writes: shown.owns)
    }
    focused = true
    telemetry.event("roadmap_coach_opened", properties: ["entry": entry.rawValue])
    Task { await readAllowance() }
  }

  // New Chat (11.6b): the thread empties, and the composer is focused with its suggestions.
  func newChat() {
    thread = nil
    focused = true
  }

  // History opens a conversation: the sheet shows it, and the next question continues it, about what its record says.
  func show(_ thread: ID<CoachThread>) {
    guard let held = about(of: thread) else { return }
    self.thread = thread
    about = held
    sheet = true
  }

  // What a conversation is about, as its record holds it: its roadmap and step, and whether that roadmap is the person's own.
  func about(of thread: ID<CoachThread>) -> About? {
    guard let record = (try? runner.read(CoachThread.scope) { try $0.repository(CoachThread.self).find(thread, in: .drawn) }) ?? nil else { return nil }
    guard let treeId = record.treeId else { return About(treeId: nil, step: nil, stepLabel: nil, writes: false) }
    let label = record.stepId.flatMap { room?.label(of: $0, in: treeId) }
    return About(treeId: treeId, step: record.stepId, stepLabel: label, writes: room?.account.trees.contains { $0.id == treeId } == true)
  }

  // Engine §7: before a question is sent, the allowance says whether one could be asked.
  func readAllowance() async {
    guard let seat = try? seat(), notice == nil || notice == .offline else { return }
    guard let profile = try? profile.profile(seat: seat.kind, about: about?.treeId, writes: about?.writes == true) else { return }
    guard let allowance = try? await engine.client.allowance(profile: profile, seat: seat), let code = try? allowance.member("code").asString() else { return }
    notice = code == "ok" ? nil : Notice(code: code, allowance: allowance, signedIn: seat.kind == .bound)
  }

  // MARK: - Asking

  // Send (11.2): the question leaves the field and a turn opens its records and runs. With no connection, a seat the phone
  // cannot read or take, or while Coach holds, the question stays in the field and nothing is written; the band slot says why
  // where there are words for it (11.21).
  func send(_ words: String? = nil) async {
    let question = words ?? field
    guard running == nil, !holds, !TextSpec.isBlank(question), question.utf8.count <= RoadmapLimits.questionBytes else { return }
    guard online() else { return refuse(.offline) }
    let seat: Agent.Seat
    do { seat = try self.seat() } catch {
      telemetry.failure("roadmap-coach-turn", kind: "storage")
      return
    }
    if seat.kind == .anon {
      do { try await installation() } catch { return refuse(online() ? .signIn : .offline) }
    }
    guard running == nil, !holds, let about = thread.flatMap(about(of:)) ?? about else { return }
    let profile: Profile
    do { profile = try self.profile.profile(seat: seat.kind, about: about.treeId, writes: about.writes) } catch {
      telemetry.failure("roadmap-coach-turn", kind: "unexpected")
      return
    }
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
    let tools = RoadmapToolHost(runner: runner, about: about.treeId) { [weak self] receipt, undo in self?.told(receipt, undo, of: turn.coach) }
    hosts[turn.coach] = Host(tools: tools)
    engine.host.next = RoadmapTurnHost.Opened(turn: turn, about: about.treeId, step: about.step, seat: seat, tools: tools)
    asked = (question, self.about)
    field = ""
    notice = nil
    thread = turn.thread
    self.about = about
    running = Running(turn: turn, line: Self.line(of: nil))
    guard let end = await engine.turn.run(input: TurnInput(turnId: turn.coach.description, seat: seat, question: question), profile: profile) else {
      // Another execution took the engine after the records opened: they are withdrawn, and the question is back.
      engine.host.next = nil
      do { _ = try runner.runAct(WithdrawTurn(turn: turn)) } catch { telemetry.failure("roadmap-coach-turn", kind: "storage") }
      return finished(turn, end: nil)
    }
    finished(turn, end: end)
  }

  // Coach holds while a turn this replica marked is read back, or the seat changes.
  var holds: Bool { recovering || seatChanges > 0 }

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
      let refused = Notice(code: end.code, allowance: engine.client.lastAllowance, signedIn: (try? seat())?.kind == .bound)
      notice = refused
      if withdrawn { telemetry.event("roadmap_coach_ask_refused", properties: ["reason": refused.reason]) }
    }
    closeIfSettled(turn.coach)
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
    hosts[write.message]?.offered.append(write)
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
  // An Undo asked again of a write it is taking back asks nothing; one whose host has closed brought nothing back. An Undo
  // that throws reports under the room's own write failure (§13).
  func undo(_ write: CoachWrite) {
    guard let host = hosts[write.message] else {
      room?.show(.init(unrestored: .coachWrote(write.facts)))
      return
    }
    guard let offered = host.offered.firstIndex(of: write) else { return }
    hosts[write.message]?.offered.remove(at: offered)
    hosts[write.message]?.undoing.append(write)
    do { try host.tools.undo(write.receipt) } catch {
      room?.report(error, write: "coachUndo")
    }
  }

  // The band of a receipt ended: the engine keeps nothing more of its act.
  func forget(_ write: CoachWrite) {
    guard let host = hosts[write.message], let offered = host.offered.firstIndex(of: write) else { return }
    hosts[write.message]?.offered.remove(at: offered)
    do { try host.tools.forget(write.receipt) } catch { room?.report(error, write: "coachUndo") }
    closeIfSettled(write.message)
  }

  // The tool host of a turn told what an Undo of one of its writes came to: the band says so, and an Undo that took the write
  // back is the receipt's fate, so it reads Undone on every device.
  func told(_ receipt: WriteReceipt, _ undo: WriteReceipt.Undo, of message: ID<CoachMessage>) {
    telemetry.event("roadmap_coach_write_undone", properties: ["ability": receipt.ability, "outcome": undo.rawValue])
    guard let index = hosts[message]?.undoing.firstIndex(where: { $0.receipt == receipt }), let write = hosts[message]?.undoing.remove(at: index) else {
      return
    }
    defer { closeIfSettled(message) }
    guard undo == .undone else {
      room?.show(.init(unrestored: .coachWrote(write.facts)))
      return
    }
    do { _ = try runner.runAct(RecordWriteFate(write.message, receipt: write.index, fate: .undone)) } catch {
      room?.report(error, write: "coachUndo")
    }
    room?.show(.init(told: .coachUndone))
  }

  // The copy changed: each Undo the engine has settled since it was asked is told. A read that throws reports once for each
  // kind of failure while the room lives, not on every read.
  func follow() {
    for host in hosts.values where !host.undoing.isEmpty {
      do { try host.tools.follow() } catch {
        guard followFailures.insert((error as? CommitFailure)?.kind == .storeFailure ? "storage" : "unexpected").inserted else { continue }
        room?.report(error, write: "coachUndo")
      }
    }
  }

  // A turn's host closes once its turn has ended and it holds no write the band offers or the engine still settles.
  func closeIfSettled(_ message: ID<CoachMessage>) {
    guard let host = hosts[message], host.offered.isEmpty, host.undoing.isEmpty, running?.turn.coach != message else { return }
    close(message)
  }

  func close(_ message: ID<CoachMessage>) {
    guard let host = hosts.removeValue(forKey: message) else { return }
    try? host.tools.close()
  }

  // MARK: - Reading the records

  // The conversation the sheet shows, as the phone's copy holds it.
  var conversation: Conversation? {
    guard let thread else { return nil }
    return try? runner.read(CoachThread.scope) { try Conversation.read($0, thread: thread) }
  }

  // The moment by the phone's clock, which History's day words read.
  func now() -> Instant? {
    try? runner.moment().now
  }

  // History (11.7): every conversation, the open roadmap's first.
  func history() -> CoachHistory? {
    try? runner.read(CoachThread.scope) { try CoachHistory.read($0, current: room?.shown?.id.description) }
  }

  // History's swipe: the conversation and its proposals, held as any roadmap delete is, with the room's band and its Undo
  // for the hold.
  func delete(_ thread: ID<CoachThread>) {
    guard running?.turn.thread != thread else { return }
    let title = (try? runner.read(CoachThread.scope) { try $0.repository(CoachThread.self).find(thread, in: .drawn) })??.title
    do {
      if case .committed(_, let receipt) = try runner.runAct(DeleteConversation(thread)) {
        room?.show(.init(.deletedConversation(title ?? ""), of: receipt, act: .conversation))
      }
    } catch { room?.report(error, write: "coachDelete") }
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
    guard !recovering, let seat = try? seat(), let profile = try? profile.profile(seat: seat.kind, about: nil, writes: false) else { return }
    recovering = true
    defer { recovering = false }
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

  // Engine §5, the seat changes: a running turn ends interrupted, its pass dropped, before the seat is replaced, and Coach
  // holds until the change has finished.
  func seatWillChange() async {
    seatChanges += 1
    await engine.turn.seatWillChange()
    engine.host.seatDidChange()
    for message in Array(hosts.keys) { close(message) }
    notice = nil
  }

  func seatChangeFinished() {
    seatChanges = max(0, seatChanges - 1)
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

  func seatChangeFinished() async {
    coach?.seatChangeFinished()
  }
}

extension RoadmapCoach {
  // Coach as the app composes it on the room's runner: the engine's turn over roadmap's host, the AI client on the server's
  // origin, or the service a Debug launch plays, under the account signed in or this phone's installation.
  static func make(runtime: AppRuntime, telemetry: any EventTelemetry) throws -> RoadmapCoach {
    let profile = try CoachProfile()
    let seat = { @MainActor () throws -> Agent.Seat in
      guard let account = try runtime.account() else { return Agent.Seat(kind: .anon, key: "installation") }
      return Agent.Seat(kind: .bound, key: account)
    }
    let host = RoadmapTurnHost(runner: runtime.roadmapRunner, profile: profile, seat: seat)
    let ports = CoachTelemetry(telemetry: telemetry) { [weak host] in host?.lastEnd?.truncated ?? false }
    #if DEBUG && targetEnvironment(simulator)
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
