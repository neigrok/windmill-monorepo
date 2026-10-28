import Foundation
import Synchronization
import GymDomain
import DomainKit
import SyncAPI
import SyncCore
import SyncEngine
import SyncIOS
import SyncSchema
import SyncStore
import UIKit
#if DEBUG
import struct SyncModelServer.ModelServer
#endif

// Simulator fixtures use the real engine, the real executor and a scripted Coach server over the turn wire.
enum CoachFixture {
  nonisolated static var setup: Bool {
    #if DEBUG && targetEnvironment(simulator)
    ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture")
    #else
    false
    #endif
  }
  // The setup fixture's drafts: three full-body days, or one with `-coach-one-draft`.
  nonisolated static var draftNames: [String] {
    #if DEBUG && targetEnvironment(simulator)
    ProcessInfo.processInfo.arguments.contains("-coach-one-draft") ? [""] : ["A", "B", "C"]
    #else
    []
    #endif
  }
  nonisolated static var offline: Bool {
    #if DEBUG && targetEnvironment(simulator)
    ProcessInfo.processInfo.arguments.contains("-coach-offline")
    #else
    false
    #endif
  }

  static func rest(_ gym: GymModel) -> GymRESTClient {
    #if DEBUG && targetEnvironment(simulator)
    if ProcessInfo.processInfo.arguments.contains("-coach-fixture") {
      return GymRESTClient(runtime: gym.runtime, telemetry: gym.telemetry, session: fixtureSession())
    }
    #endif
    return gym.rest
  }
  // The turn wire the room speaks: the scripted server under `-coach-fixture`, the configured one otherwise.
  static func turnWire(_ runtime: AppRuntime) -> CoachTurnWire? {
    #if DEBUG && targetEnvironment(simulator)
    if ProcessInfo.processInfo.arguments.contains("-coach-fixture") { return CoachTurnWire(baseURL: URL(string: "https://coach.fixture"), session: fixtureSession()) }
    #endif
    return nil
  }
  #if DEBUG && targetEnvironment(simulator)
  static func fixtureSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CoachFixtureProtocol.self]; config.httpCookieStorage = nil
    return URLSession(configuration: config)
  }
  #endif
  @discardableResult static func prepare(_ gym: GymModel, signIn: Bool = false) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard ProcessInfo.processInfo.arguments.contains("-coach-fixture"), let runtime = gym.runtime, let server = runtime.auth.fake else { return true }
    if gym.isAnonymous, runtime.settings.scenario?.hasPrefix("gym-e2e-anonymous") == true { return false }
    do {
      gym.refresh()
      if gym.account == nil {
        guard signIn else { return false }
        let identity = server.identity(email: "coach-fixture@example.com")
        _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
        gym.refresh()
      }
      guard let owner = gym.account, gym.coachAccountAvailable else { throw AppFailure(message: "Coach fixture account is unavailable.") }
      CoachFixtureProtocol.now.withLock { $0 = gym.dates.moment.now.ms }
      // An account the lifter signed into after a signed-out start keeps the conversation it adopted.
      if !runtime.settings.restoreBoard, runtime.settings.scenario?.hasPrefix("gym-e2e-anonymous") != true {
        try? FileManager.default.removeItem(at: CoachDraftStore().file(owner))
      }
      if ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture") {
        if ProcessInfo.processInfo.arguments.contains("-coach-archived-answer") { try seedSetupAnswer(owner: owner) }
        return true
      }
      _ = gym.run(SaveNoteCall(Note(id: ID("coach-fixture-note"), title: "How I want to be talked to", body: "Don’t cheerlead. Say the number and stop.")))
      _ = gym.run(SaveNoteCall(Note(id: ID("coach-fixture-goal"), title: "What I am training for", body: "A stronger squat.")))
      let board = CoachBoard.current
      for exercise in board == nil ? [] : CoachBoard.yours { _ = gym.run(CreateExercise(exercise)) }
      let routines = board?.routines ?? (ProcessInfo.processInfo.arguments.contains("-coach-created") ? []
        : [(id: "coach-fixture-routine", name: "Push A", entries: [CoachBoard.entry("back-squat", 1, 5, 80)])])
      for planned in routines {
        var routine = Draft(new: Routine(id: ID(RecordID(planned.id)), name: planned.name, entries: planned.entries))
        _ = gym.save(&routine)
      }
      await runtime.engine.flushOnLeave(); gym.refresh()
      if let first = routines.first {
        _ = gym.run(ImportSession(id: ID("coach-fixture-session"), startedAt: Instant(ms: 1_790_423_000_000), finishedAt: Instant(ms: 1_790_424_000_000),
          sets: [ImportedSet(id: ID("coach-fixture-set"), exerciseId: ID("back-squat"), weightKg: 80, reps: 5, completedAt: Instant(ms: 1_790_423_500_000))],
          routineId: ID(RecordID(first.id))))
      }
      if ProcessInfo.processInfo.arguments.contains("-coach-history") { try seedHistory(gym) }
      await runtime.engine.flushOnLeave(); gym.refresh()
      // An Apply then waits on the log past the card's 15-second wait.
      if ProcessInfo.processInfo.arguments.contains("-coach-decision-stall") {
        server.state.withLock { $0.server.refuse(next: 1_000, code: .clockSkew) }
      }
      // Every push then spends four seconds in flight and gets no answer.
      if ProcessInfo.processInfo.arguments.contains("-coach-decision-unreachable") {
        server.state.withLock { $0.pushesUnansweredAfter = 4 }
      }
    } catch {
      let reason = failureReason(error)
      NSLog("Gym Coach fixture failed: %@", reason)
      gym.error = "Coach fixture could not be prepared (\(reason))."
    }
    #endif
    return true
  }

  // A draft program screenshot in the composer, as if just chosen from the photo picker (`-coach-draft-photo`), or, signed
  // in, a draft a signed-out start left on this phone beside the account's own (`-coach-kept-draft`, 01.18).
  static func seedDraft(_ coach: CoachConversation) {
    #if DEBUG && targetEnvironment(simulator)
    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("-coach-draft-photo"), coach.allowed, coach.saved.photo == nil { try? coach.addPhoto(CoachFixtureConversation.program()) }
    if arguments.contains("-coach-kept-draft"), coach.allowed, !coach.anonymous, coach.saved.phoneDrafts == nil {
      var next = coach.saved; next.text = "Make it three days."
      next.phoneDrafts = [CoachPhoneDraft(text: "Push day twice a week, legs on Friday. I have dumbbells and a bench.", photo: nil, photoData: nil, setupChoice: .describe)]
      _ = coach.keep(next, failure: "Your draft couldn’t be saved. Try again.")
    }
    #endif
  }

  // Once the board's turn ended: its routine changes under the proposal (`routine-changed`), or a newer proposal
  // replaces it (`-coach-out-of-date`), so the card is out of date.
  static let boardSettled = Mutex(false)
  static func afterTurn(_ gym: GymModel) {
    #if DEBUG && targetEnvironment(simulator)
    guard ProcessInfo.processInfo.arguments.contains("-coach-fixture"), !boardSettled.withLock({ let done = $0; $0 = true; return done }) else { return }
    if let edit = CoachBoard.current?.editedAfter, var routine = try? gym.runner.open(ID<Routine>(RecordID(edit.id))) {
      routine.current.entries = edit.entries
      _ = gym.save(&routine)
    }
    if ProcessInfo.processInfo.arguments.contains("-coach-out-of-date") {
      _ = gym.run(ProposeRoutine(id: ID("coach-fixture-newer"), routineId: ID("coach-fixture-routine"), name: "Push A3",
        entries: [RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(reps: 2, weightKg: 95)])], summary: "Doubles at 95."))
    }
    if let runtime = gym.runtime { Task { await runtime.engine.flushOnLeave(); gym.refresh() } }
    #endif
  }

  #if DEBUG && targetEnvironment(simulator)
  // The setup fixture's archived signed-out answer: Coach drafted the lifter's program, three full-body days, and the room
  // offers Apply on them (01.7, 01.14, 01.15, 01.8, 01.9).
  static func seedSetupAnswer(owner: String) throws {
    let routines = draftNames.map { suffix in
      CoachOnboardingOut.Routine(name: ("Full body " + suffix).trimmingCharacters(in: .whitespaces),
        entries: ["back-squat", "bench-press", suffix == "B" ? "chin-up" : "barbell-row"].map { exercise in
          CoachOnboardingOut.Routine.Entry(exerciseId: exercise, sets: Array(repeating: .init(reps: exercise == "chin-up" ? 8 : 5, weightKg: nil), count: 3), restSeconds: 120)
        })
    }
    let allowance = AiAllowance(code: "ok", currency: "USD", period: "lifetime", tier: "anonymous", configured: true, limit: "0.050000000",
                                used: "0.001000000", reserved: "0.000000000", remaining: "0.049000000", resetsAtMs: nil, budgetResetsAtMs: nil)
    var response = CoachOnboardingOut(requestId: "setup-request", resultId: "setup-operation", status: "completed", expiresAtMs: 1_900_000_000_000,
                                      routines: routines, errorCode: nil, allowance: allowance)
    response.message = draftNames.count == 1 ? "Here is 1 new routine. Check it, then apply."
      : "Your screenshot has 3 full-body days. Here are 3 new routines. Check them, then apply."
    var saved = CoachSaved()
    saved.onboarding = [CoachOnboardingRecord(request: CoachOnboardingIn(requestId: "setup-request", mode: "conversation", text: "My program, 3 days a week"),
                                              response: response)]
    saved.acceptedFirstMessage = true
    try CoachDraftStore().write(saved, account: owner)
  }

  // Four conversations a few days apart (08.4): a proposal, a plain answer, another, and routines created.
  static func seedHistory(_ gym: GymModel) throws {
    let now = gym.dates.moment.now.ms, day: Int64 = 86_400_000
    let seeds: [(String, String, Int64, [AbilityCall])] = [
      ("history-push", "Is Push A still doing anything?", 0, []),
      ("history-pull-ups", "Pull-ups are bodyweight for me. I add a 10 kg belt.", 1, []),
      ("history-squats", "How heavy should I start squats?", 3, []),
      ("history-program", "My program, 3 days a week", 4, [AbilityCall(callId: "c1", name: "create_routine", input: nil, outcome: .ok,
                                                                        created: [RecordRef(type: Routine.type, id: "coach-fixture-routine")])]),
    ]
    for (id, title, days, calls) in seeds {
      _ = try gym.runner.run(SeedConversation(id: ID(RecordID(id)), title: title, at: Instant(ms: now - days * day), calls: calls))
    }
  }
  #endif

  static func failureReason(_ error: any Error) -> String {
    if let engine = error as? EngineError {
      switch engine {
      case .notSignedIn: return "not_signed_in"
      case .signedIn: return "signed_in"
      case .unauthenticated: return "unauthenticated"
      case .unreachable: return "unreachable"
      case .upgradeRequired: return "upgrade_required"
      case .decisionMissing: return "decision_missing"
      case .signInChanged: return "sign_in_changed"
      case .signInEnded: return "sign_in_ended"
      case .signOutChanged: return "sign_out_changed"
      case .signOutEnded: return "sign_out_ended"
      }
    }
    if let keychain = error as? KeychainError { return "keychain_\(keychain.status)" }
    if error is CancellationError { return "cancelled" }
    if error is AppFailure { return "app_failure" }
    return Store.failureKind(error) ?? "unexpected"
  }
}

#if DEBUG && targetEnvironment(simulator)
// A completed conversation seeded whole: one question and its answer, stamped on the day given.
struct SeedConversation: Action {
  let id: ID<CoachThread>
  let title: String
  let at: Instant
  let calls: [AbilityCall]
  var answer = "Here is what I found."

  var scope: ScopeRef { Gym.scope }

  func load(_ read: Reader) throws -> (replica: String, moment: Moment) { (read.replica, read.moment) }

  func decide(_ loaded: (replica: String, moment: Moment), ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    var plan = Plan()
    plan.create(try Valid(CoachThread(id: id, title: title), at: loaded.moment))
    plan.create(try Valid(CoachMessage(id: ids.mint(CoachMessage.self), threadId: id, role: .lifter, text: title, at: at), at: loaded.moment))
    plan.create(try Valid(CoachMessage(id: ids.mint(CoachMessage.self), threadId: id, role: .coach, replica: loaded.replica, text: answer,
                                       state: .completed, receipt: AbilityCall.receipt(of: calls), calls: calls, at: Instant(ms: at.ms + 60_000)), at: loaded.moment))
    return .write(plan)
  }
}

// The scripted Coach server (Coach §6) under `-coach-fixture`: an installation for the signed-out seat, and for each question
// a turn stream whose batch of ability calls the phone runs for real, answered with the rest of the answer once the phone
// posts the batch's results.
nonisolated final class CoachFixtureProtocol: URLProtocol, @unchecked Sendable {
  static let asked = Mutex(0)
  // The log's now, so an answer is stamped on the day the room reads as today.
  static let now = Mutex<Int64>(0)
  // The open stream waiting for the phone's results or its Stop, and the frames it still owes.
  nonisolated final class Held: @unchecked Sendable {
    let stream: CoachFixtureProtocol
    let frames: [String]
    init(_ stream: CoachFixtureProtocol, frames: [String]) { self.stream = stream; self.frames = frames }
  }
  static let held = Mutex<Held?>(nil)
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
    if CoachFixture.offline {
      client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return
    }
    var body: [String: Any] = [:]
    if let data = request.httpBody { body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
    if body.isEmpty, let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count))
      }
      body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
    let arguments = ProcessInfo.processInfo.arguments
    if path.hasPrefix("/v1/ai/installations") {
      let allowance: [String: Any] = ["code": "ok", "currency": "USD", "period": "lifetime", "tier": "anonymous", "configured": true,
        "limit": "0.050000000", "used": "0.001000000", "reserved": "0.000000000", "remaining": "0.049000000", "resetsAtMs": NSNull(), "budgetResetsAtMs": NSNull()]
      var response: [String: Any] = ["bound": path.hasSuffix("/bind"), "allowance": allowance]
      if path == "/v1/ai/installations" { response["credential"] = String(repeating: "a", count: 43) }
      respond(200, response); return
    }
    if path == "/v1/oauth/grants" { respond(200, ["grants": [["clientId": "fixture", "name": "Claude Desktop", "grantedMs": 1_790_424_000_000, "scope": "gym:read gym:write"]]]); return }
    if path == "/v1/mcp-keys" { respond(200, ["keys": [["id": "fixture-key", "name": "A static key", "createdMs": 1_790_424_000_000]]]); return }
    if path == "/v1/gym/coach/turns" {
      // A deployment without Coach mounts no turn route; a spent allowance or the day's cap refuses every question after the first.
      if arguments.contains("-coach-unavailable") { respond(404, [:], type: "text/html"); return }
      let asked = Self.asked.withLock { $0 += 1; return $0 }
      if arguments.contains("-coach-allowance-spent"), asked > 1 { respond(429, ["error": "allowance", "code": "subject_exhausted"]); return }
      if arguments.contains("-coach-daily-cap"), asked > 1 { respond(429, ["error": "later", "code": "coach-rate-limited"]); return }
      let said = CoachFixtureConversation(asked: body["question"] as? String)
      let http = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!
      client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
      let answer = Self.frame("text", ["delta": said.answer]) + Self.frame("done", ["state": "completed"])
      if said.held {
        if !said.partial.isEmpty { client?.urlProtocol(self, didLoad: Data(Self.frame("text", ["delta": said.partial]).utf8)) }
        let held = Held(self, frames: [Self.frame("done", ["state": "stopped"])])
        Self.held.withLock { $0 = held }
        return
      }
      guard !said.calls.isEmpty else { client?.urlProtocol(self, didLoad: Data(answer.utf8)); client?.urlProtocolDidFinishLoading(self); return }
      let calls = said.calls.enumerated().map { index, call in ["callId": "toolu_\(index + 1)", "name": call.0, "input": call.1] as [String: Any] }
      let held = Held(self, frames: [answer])
      Self.held.withLock { $0 = held }
      client?.urlProtocol(self, didLoad: Data(Self.frame("calls", ["batch": 1, "calls": calls]).utf8))
      return
    }
    if path.hasPrefix("/v1/gym/coach/turns/"), path.hasSuffix("/results") {
      let owed = Self.held.withLock { held in defer { held = nil }; return held }
      if let owed { for frame in owed.frames { owed.stream.client?.urlProtocol(owed.stream, didLoad: Data(frame.utf8)) }; owed.stream.client?.urlProtocolDidFinishLoading(owed.stream) }
      respond(200, ["batch": body["batch"] ?? 1]); return
    }
    if path.hasPrefix("/v1/gym/coach/turns/"), path.hasSuffix("/stop") {
      let owed = Self.held.withLock { held in defer { held = nil }; return held }
      if let owed { owed.stream.client?.urlProtocol(owed.stream, didLoad: Data(Self.frame("done", ["state": "stopped"]).utf8)); owed.stream.client?.urlProtocolDidFinishLoading(owed.stream) }
      respond(202, ["state": "stopped"]); return
    }
    respond(404, ["error": "no such turn", "code": "coach-turn-unknown"])
  }
  func respond(_ status: Int, _ response: [String: Any], type: String = "application/json") {
    let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!
    client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: response)); client?.urlProtocolDidFinishLoading(self)
  }
  static func frame(_ event: String, _ data: [String: Any]) -> String {
    "event: \(event)\ndata: " + String(decoding: try! JSONSerialization.data(withJSONObject: data), as: UTF8.self) + "\n\n"
  }
  override func stopLoading() { Self.held.withLock { if $0?.stream === self { $0 = nil } } }
}

// One conversation per fixture state: a change to Push A, its removal read from totals (`-coach-removal`), a routine and a note
// (`-coach-created`), a Markdown answer (`-coach-markdown`), and Coach held mid-answer (`-coach-streaming`) or before its
// first word (`-coach-thinking`). `calls` are the ability calls the server's batch asks the phone to run, by name and input.
nonisolated struct CoachFixtureConversation {
  let question: String
  let partial: String
  let answer: String
  var held = false
  var calls: [(String, [String: Any])] = []

  init(arguments: [String] = ProcessInfo.processInfo.arguments, asked: String? = nil) {
    let session: (String, [String: Any]) = ("get_session", ["sessionId": "coach-fixture-session"])
    if let board = CoachBoard.current {
      let turn = board.turns.first { $0.question == asked } ?? board.turns[0]
      question = turn.question; partial = turn.answer; answer = turn.answer
      calls = turn.calls(board)
    } else if arguments.contains("-coach-markdown") || arguments.contains("-coach-streaming") || arguments.contains("-coach-thinking") {
      held = !arguments.contains("-coach-markdown")
      question = arguments.contains("-coach-thinking") ? "My program, 3 days a week" : "What should Thursday look like?"
      partial = arguments.contains("-coach-thinking") ? "" : "Thursday is still a Push day. Keep the same total work, and change the last set to a heavier…"
      answer = "## Thursday · Push A\n\nKeep the same total work each week. Do 3 sets of 3 at 90 kg for a heavier top set.\n\n"
        + "- Bench Press — 3 × 3 at 90\n- Incline Press — 3 × 10 at 24\n- Triceps Pushdown — 3 × 12\n\n"
        + "| Movement | Last | Next |\n|---|---|---|\n| Bench Press | 5 × 5 · 82.5 | 3 × 3 · 90 |\n| Incline Press | 3 × 10 · 22 | 3 × 10 · 24 |\n| Pushdown | 3 × 12 · 30 | 3 × 12 · 30 |"
      calls = held ? [] : [session]
    } else if arguments.contains("-coach-created") {
      question = "Build me a routine."; partial = "Push A is in your routines."
      answer = "Push A is in your routines: back squat, one set of five at 80."
      calls = [("create_routine", ["id": "coach-fixture-routine", "name": "Push A", "position": 0, "entries": CoachBoard.json([CoachBoard.entry("back-squat", 1, 5, 80)])]),
               ("save_note", ["id": "board-note", "title": "Shoulder", "body": "Left shoulder hurts on wide-grip bench. Use a close grip."])]
    } else if arguments.contains("-coach-removal") {
      question = "Remove Push A."; partial = "Push A has not moved your squat in six weeks."
      answer = "Push A has not moved your squat in six weeks. Removing it leaves every set you logged where it is."
      calls = [("get_stats", [:]), ("propose_routine_removal", ["id": "coach-fixture-proposal", "routineId": "coach-fixture-routine", "summary": "Push A has stopped moving your squat."])]
    } else {
      question = "Is Push A still doing anything?"; partial = "Keep the weekly work steady."
      answer = "## Your next block\n\nKeep the weekly work steady. **Three triples at 90** gives you a top set to push."
      calls = [session, ("propose_routine_change", ["id": "coach-fixture-proposal", "routineId": "coach-fixture-routine", "name": "Push A2",
        "entries": CoachBoard.json([CoachBoard.entry("back-squat", 1, 3, 90), RoutineEntry(exerciseId: ID("bench-press"))]),
        "summary": "Three triples at 90 keeps the weekly tonnage and gives you a top set to push."])]
    }
  }

  // A phone screenshot of a three-day program, as a lifter shares one to build from.
  static func program() -> Data {
    let format = UIGraphicsImageRendererFormat(); format.scale = 1
    let size = CGSize(width: 360, height: 480)
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
      UIColor.white.setFill(); UIRectFill(CGRect(origin: .zero, size: size))
      var y: CGFloat = 24
      let lines: [(String, CGFloat, UIFont.Weight)] = [("Full body, 3× a week", 30, .bold), ("", 12, .regular), ("A", 24, .semibold), ("Squat 3×5", 22, .regular),
        ("Bench 3×5", 22, .regular), ("Row 3×5", 22, .regular), ("", 12, .regular), ("B", 24, .semibold), ("Deadlift 1×5", 22, .regular),
        ("Overhead press 3×5", 22, .regular), ("Chin-ups 3×8", 22, .regular), ("", 12, .regular), ("C", 24, .semibold), ("Front squat 3×5", 22, .regular)]
      for (text, size, weight) in lines {
        (text as NSString).draw(at: CGPoint(x: 24, y: y), withAttributes: [.font: UIFont.systemFont(ofSize: size, weight: weight), .foregroundColor: UIColor.black])
        y += size * 1.3
      }
    }.jpegData(compressionQuality: 0.9)!
  }
}

// A Figma board's conversation (`-coach-board 08.17`): the routines it starts from, what Coach proposes for them, and
// what it says to each question; a board may then change a routine under its proposal.
nonisolated struct CoachBoard {
  struct Proposed { let id: String; let routine: String; let name: String; let entries: [RoutineEntry]; var removing = false }
  struct Turn {
    let question: String
    let answer: String
    var proposals: [String] = []
    var creates: [(id: String, name: String, entries: [RoutineEntry])] = []
    var note: (String, String)?
    // Signed out, a note Coach wants to save needs the account: the phone refuses it, and the answer offers Sign in.
    var needsAccount = false

    // The batch the server asks of the phone for this turn: the proposals it writes, the routines it creates, the note.
    func calls(_ board: CoachBoard) -> [(String, [String: Any])] {
      var calls: [(String, [String: Any])] = []
      for id in proposals {
        guard let proposed = board.proposals.first(where: { $0.id == id }) else { continue }
        if proposed.removing { calls.append(("propose_routine_removal", ["id": proposed.id, "routineId": proposed.routine, "summary": "You have not done it in 8 weeks."])) }
        else { calls.append(("propose_routine_change", ["id": proposed.id, "routineId": proposed.routine, "name": proposed.name, "entries": CoachBoard.json(proposed.entries), "summary": ""])) }
      }
      for (index, routine) in creates.enumerated() {
        calls.append(("create_routine", ["id": routine.id, "name": routine.name, "position": index, "entries": CoachBoard.json(routine.entries)]))
      }
      if let note { calls.append(("save_note", ["id": "board-note", "title": note.0, "body": note.1])) }
      if needsAccount { calls.append(("save_note", ["id": "board-account-note", "title": "Push A", "body": "Make Push A harder."])) }
      return calls
    }
  }
  var routines: [(id: String, name: String, entries: [RoutineEntry])]
  var proposals: [Proposed]
  var turns: [Turn]
  var editedAfter: (id: String, entries: [RoutineEntry])?

  static var current: CoachBoard? {
    let arguments = ProcessInfo.processInfo.arguments
    guard let at = arguments.firstIndex(of: "-coach-board"), at + 1 < arguments.count else { return nil }
    return all[arguments[at + 1]]
  }
  static func entry(_ exercise: String, _ sets: Int, _ reps: Int?, _ kg: Double? = nil, rest: Int? = nil) -> RoutineEntry {
    RoutineEntry(exerciseId: ID(RecordID(exercise)), sets: Array(repeating: SetTarget(reps: reps, weightKg: kg), count: sets), restSeconds: rest)
  }
  static func ladder(_ exercise: String, _ sets: [(Int?, Double?)]) -> RoutineEntry {
    RoutineEntry(exerciseId: ID(RecordID(exercise)), sets: sets.map { SetTarget(reps: $0.0, weightKg: $0.1) })
  }
  // Routine entries as a call's input lists them.
  static func json(_ entries: [RoutineEntry]) -> [[String: Any]] {
    entries.map { entry in
      var line: [String: Any] = ["exerciseId": entry.exerciseId.description]
      if let sets = entry.sets { line["sets"] = sets.map { set in var target: [String: Any] = [:]; if let reps = set.reps { target["reps"] = reps }; if let kg = set.weightKg { target["weightKg"] = kg }; return target } }
      if let rest = entry.restSeconds { line["restSeconds"] = rest }
      return line
    }
  }
  static func one(_ question: String, _ answer: String, routine: (String, [RoutineEntry]), proposed: (String, [RoutineEntry]), removing: Bool = false) -> CoachBoard {
    CoachBoard(routines: [(id: "board-routine", name: routine.0, entries: routine.1)],
               proposals: [Proposed(id: "board-proposal", routine: "board-routine", name: proposed.0, entries: proposed.1, removing: removing)],
               turns: [Turn(question: question, answer: answer, proposals: ["board-proposal"])])
  }

  // The movements every board's lifter made: their routines carry them beside the seeded ones.
  static let yours = [Exercise(id: ID("upright-row"), name: "Upright Row", pattern: "pull", equipment: "barbell", stepKg: 2.5),
                      Exercise(id: ID("landmine-squat"), name: "Landmine Squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)]
  static let bench = entry("bench-press", 5, 5, 82.5), heavier = entry("bench-press", 3, 3, 90)
  static let pushA = [bench, entry("cable-fly", 3, 12, 15), entry("triceps-pushdown", 3, 12, 30), entry("overhead-press", 3, 8, 40)]
  static let pushB = [bench, entry("incline-bench-press", 3, 10, 50), entry("overhead-press", 3, 8, 40), entry("triceps-pushdown", 3, 12, 30), entry("lateral-raise", 3, 15, 8)]
  static let pullA = [entry("chin-up", 3, nil), entry("barbell-row", 3, 8, 60), entry("face-pull", 3, 15, 12.5), entry("lateral-raise", 3, 15, 8), entry("rear-delt-fly", 3, 15, 8)]
  static let change = one("Is Push A still doing anything?", "Your Bench Press has not gone up in 3 weeks.\n\nYou did 5 × 5 at 82.5 kg nine times and finished every rep. Try 3 sets of 3 at 90 kg for a heavier top set.",
    routine: ("Push A", pushA), proposed: ("Push A", [heavier, pushA[3], entry("incline-dumbbell-press", 3, 10, 24), entry("triceps-pushdown", 3, 10, 30)]))
  // The three full-body days a signed-out first question creates, and the swap the signed-in next question proposes for day B.
  static let fullBody: [(id: String, name: String, entries: [RoutineEntry])] = ["A", "B", "C"].map { suffix in
    (id: "setup-routine-" + suffix, name: "Full body " + suffix,
     entries: ["back-squat", "bench-press", suffix == "B" ? "chin-up" : "barbell-row"].map { entry($0, 3, $0 == "chin-up" ? 8 : 5, rest: 120) })
  }

  static let squatsAnswer = "Choose a weight you can lift 8 times with good form. Do 5 reps. The app remembers it for next time."
  static let all: [String: CoachBoard] = [
    "after-sign-in": CoachBoard(routines: [], proposals: [
        Proposed(id: "board-proposal", routine: "setup-routine-B", name: "Full body B",
                 entries: [fullBody[1].entries[0], fullBody[1].entries[1], entry("lat-pulldown", 3, 8, 45, rest: 120)])],
      turns: [Turn(question: "Build a short full body routine for three days each week", answer: "Here are three full-body days. They are in Routines now.", creates: fullBody),
              Turn(question: "Build me a three day full body program", answer: "Here are three full-body days. They are in Routines now.", creates: fullBody),
              Turn(question: "Swap chin-ups for pulldowns", answer: "Here is a change for Full body B.", proposals: ["board-proposal"])]),
    "squats": CoachBoard(routines: [(id: "board-routine", name: "Push A", entries: pushB)], proposals: [],
      turns: [Turn(question: "How heavy should I start squats?", answer: squatsAnswer)]),
    "needs-account": CoachBoard(routines: [], proposals: [],
      turns: [Turn(question: "Make Push A harder", answer: "I need your account to change a routine. Sign in, then ask again.", needsAccount: true)]),
    "stalled": CoachBoard(routines: [(id: "board-routine", name: "Push A", entries: pushB)], proposals: [],
      turns: [Turn(question: "Bench has stalled for three weeks. Is Push A still doing anything?",
                   answer: "Your Bench Press has not gone up in 3 weeks. You did 5 × 5 at 82.5 kg nine times.")]),
    "note": CoachBoard(routines: [(id: "board-routine", name: "Push A", entries: pushB)], proposals: [],
      turns: [Turn(question: "My left shoulder hurts on wide-grip bench.", answer: "I saved this as a note. I will use it when I plan.",
                   note: ("Shoulder", "Left shoulder hurts on wide-grip bench. Use a close grip."))]),
    "change": change,
    "summary": CoachBoard(
      routines: change.routines + [(id: "board-lower", name: "Lower A", entries: [entry("back-squat", 1, 5, 80), entry("romanian-deadlift", 3, 8, 82.5),
                                                                                   entry("landmine-squat", 3, 10, 140), entry("standing-calf-raise", 3, 12, 45)])],
      proposals: change.proposals, turns: change.turns),
    "routine-changed": { var board = change; board.editedAfter = (id: "board-routine", entries: [entry("bench-press", 5, 5, 85)] + pushA.dropFirst()); return board }(),
    "bench": one("Is Push A still doing anything?", "Try 3 sets of 3 at 90 kg for a heavier top set.",
      routine: ("Push A", pushB), proposed: ("Push A", [heavier] + pushB.dropFirst())),
    "two": CoachBoard(
      routines: [(id: "board-routine", name: "Push A", entries: pushA), (id: "board-pull", name: "Pull A", entries: pullA)],
      proposals: [Proposed(id: "board-proposal", routine: "board-routine", name: "Push A", entries: [heavier, pushA[3], entry("incline-dumbbell-press", 3, 10, 24), entry("triceps-pushdown", 3, 10, 30)]),
                  Proposed(id: "board-pull-proposal", routine: "board-pull", name: "Pull A", entries: [pullA[1], pullA[0]] + pullA.dropFirst(2))],
      turns: [Turn(question: "Is Push A still doing anything?", answer: "You did 5 × 5 at 82.5 kg nine times and finished every rep. Try 3 sets of 3 at 90 kg for a heavier top set.", proposals: ["board-proposal"]),
              Turn(question: "And Pull A?", answer: "Do Barbell Row first, when you are fresh.", proposals: ["board-pull-proposal"])]),
    "rename": one("Can Push A have a better name?", "Here is a better name for Push A.",
      routine: ("Push A", pushB), proposed: ("Push Day", pushB)),
    "remove": one("Should I keep Arms?", "You have not done Arms in 8 weeks. You can remove it.",
      routine: ("Arms", [entry("triceps-pushdown", 3, 12, 30), entry("lateral-raise", 3, 15, 8), entry("cable-fly", 3, 12, 15), entry("overhead-triceps-extension", 3, 12, 14)]),
      proposed: ("Arms", []), removing: true),
    "add": one("My shoulders feel tight.", "Add Face Pull to Pull A for your shoulders.",
      routine: ("Pull A", [pullA[0], pullA[1], pullA[3], pullA[4]]), proposed: ("Pull A", [pullA[0], pullA[1], pullA[3], pullA[4], entry("face-pull", 3, 15, 12.5)])),
    "drop": one("Upright Row hurts my shoulder.", "Remove Upright Row. It hurts your shoulder.",
      routine: ("Push A", [bench, entry("upright-row", 3, 12, 30)] + pushB.dropFirst(2)), proposed: ("Push A", [bench] + pushB.dropFirst(2))),
    "swap": one("I can’t do chin-ups yet.", "Use Lat Pulldown instead of Chin-up until you can do 5 chin-ups.",
      routine: ("Pull A", Array(pullA.prefix(4))), proposed: ("Pull A", [entry("lat-pulldown", 3, 10, 45)] + pullA[1..<4])),
    "move": one("What should I do first?", "Do Overhead Press first, when you are fresh.",
      routine: ("Push A", [bench, pushB[1], pushB[2], pushB[3], pushB[4]]), proposed: ("Push A", [pushB[2], bench, pushB[1], pushB[3], pushB[4]])),
    "targets": one("Give me more work.", "Here is more work for Push A.",
      routine: ("Push A", [entry("bench-press", 3, 8, 80), entry("push-up", 3, 15), entry("dip", 3, 10, 10), pushB[2], pushB[3]]),
      proposed: ("Push A", [entry("bench-press", 4, 6, 85), entry("push-up", 3, nil), entry("dip", 3, 10), pushB[2], pushB[3]])),
    "vary": one("Make the last set heavier.", "Make the last set heavier.",
      routine: ("Push A", [entry("bench-press", 3, 5, 80)] + pushB.dropFirst()), proposed: ("Push A", [ladder("bench-press", [(5, 80), (5, 80), (3, 90)])] + pushB.dropFirst())),
    "ramp": one("Warm up to your top set.", "Warm up to your top set, then add one heavy set.",
      routine: ("Legs", [entry("back-squat", 3, 5, 100), entry("leg-press", 3, 10, 140), entry("lying-leg-curl", 3, 12, 40), entry("standing-calf-raise", 3, 15, 60)]),
      proposed: ("Legs", [ladder("back-squat", [(5, 80), (5, 90), (5, 100), (3, 105)]), entry("leg-press", 3, 10, 140), entry("lying-leg-curl", 3, 12, 40), entry("standing-calf-raise", 3, 15, 60)])),
    "rest": one("Dips have no target.", "Here is a target for Dips and more rest.",
      routine: ("Push A", [RoutineEntry(exerciseId: ID("dip"), restSeconds: 90)] + pushB.dropFirst()),
      proposed: ("Push A", [entry("dip", 3, 10, rest: 120)] + pushB.dropFirst())),
    "long": one("Rebuild Push A for strength", "Here is a new plan for Push A. It has 9 changes.",
      routine: ("Push A", [bench, entry("incline-bench-press", 3, 10, 24), entry("overhead-press", 3, 8, 40), entry("lateral-raise", 3, 12), entry("triceps-pushdown", 3, 12, 30, rest: 60), entry("cable-fly", 3, 12, 15)]),
      proposed: ("Push Day", [entry("overhead-press", 3, 8, 40), heavier, ladder("incline-bench-press", [(10, 24), (10, 24), (8, 26)]), entry("lateral-raise", 3, 15),
                              entry("triceps-pushdown", 3, 12, 30, rest: 90), entry("dip", 3, nil), entry("face-pull", 3, 15, 12.5)])),
  ]
}
#endif
