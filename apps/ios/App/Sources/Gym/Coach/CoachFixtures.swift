import Foundation
import Synchronization
import GymDomain
import DomainKit
import SyncCore
import SyncEngine
import SyncIOS
import SyncStore
import UIKit
#if DEBUG
import struct SyncModelServer.ModelServer
#endif

// Simulator fixtures use the real engine actions and the authenticated REST boundary.
enum CoachFixture {
  nonisolated static var setup: Bool {
    #if DEBUG && targetEnvironment(simulator)
    ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture")
    #else
    false
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
      let config = URLSessionConfiguration.ephemeral
      config.protocolClasses = [CoachFixtureProtocol.self]; config.httpCookieStorage = nil
      return GymRESTClient(runtime: gym.runtime, telemetry: gym.telemetry, session: URLSession(configuration: config))
    }
    #endif
    return gym.rest
  }
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
      if !ProcessInfo.processInfo.arguments.contains("-restore-board") {
        try? FileManager.default.removeItem(at: CoachDraftStore().file(owner))
      }
      if ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture") { return true }
      _ = gym.run(SaveNoteCall(Note(id: ID("coach-fixture-note"), title: "How I want to be talked to", body: "Don’t cheerlead. Say the number and stop.")))
      _ = gym.run(SaveNoteCall(Note(id: ID("coach-fixture-goal"), title: "What I am training for", body: "A stronger squat.")))
      let board = CoachBoard.current
      if board != nil { _ = gym.run(CreateExercise(Exercise(id: ID("upright-row"), name: "Upright Row", pattern: "pull", equipment: "barbell", stepKg: 2.5))) }
      for case .exercise(let exercise, _, _, _) in board?.writes ?? [] { _ = gym.run(CreateExercise(exercise)) }
      let routines = board?.routines ?? [(id: "coach-fixture-routine", name: "Push A", entries: [CoachBoard.entry("back-squat", 1, 5, 80)])]
      for planned in routines {
        var routine = Draft(new: Routine(id: ID(RecordID(planned.id)), name: planned.name, entries: planned.entries))
        _ = gym.save(&routine)
      }
      await runtime.engine.flushOnLeave(); gym.refresh()
      _ = gym.run(ImportSession(id: ID("coach-fixture-session"), startedAt: Instant(ms: 1_790_423_000_000), finishedAt: Instant(ms: 1_790_424_000_000),
        sets: [ImportedSet(id: ID("coach-fixture-set"), exerciseId: ID("back-squat"), weightKg: 80, reps: 5, completedAt: Instant(ms: 1_790_423_500_000))],
        routineId: ID(RecordID(routines[0].id))))
      let removing = ProcessInfo.processInfo.arguments.contains("-coach-removal")
      let proposals = board?.proposals ?? [CoachBoard.Proposed(id: "coach-fixture-proposal", routine: "coach-fixture-routine", name: "Push A2",
        entries: [CoachBoard.entry("back-squat", 1, 3, 90), RoutineEntry(exerciseId: ID("bench-press"))], removing: removing)]
      for proposed in proposals {
        _ = gym.run(ProposeRoutine(id: ID(RecordID(proposed.id)), routineId: ID(RecordID(proposed.routine)), name: proposed.name, entries: proposed.entries,
          summary: removing ? "Push A has stopped moving your squat." : "Three triples at 90 keeps the weekly tonnage and gives you a top set to push.", removing: proposed.removing))
      }
      await runtime.engine.flushOnLeave(); gym.refresh()
      // The board's routine changes after Coach proposed, so its card is out of date.
      if let edit = board?.editedAfter, var routine = try gym.runner.open(ID<Routine>(RecordID(edit.id))) {
        routine.current.entries = edit.entries
        _ = gym.save(&routine)
        await runtime.engine.flushOnLeave(); gym.refresh()
      }
      // A newer proposal for Push A replaces this one, so its card and Review are out of date.
      if ProcessInfo.processInfo.arguments.contains("-coach-out-of-date") {
        _ = gym.run(ProposeRoutine(id: ID("coach-fixture-newer"), routineId: ID("coach-fixture-routine"), name: "Push A3",
          entries: [RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(reps: 2, weightKg: 95)])], summary: "Doubles at 95."))
        await runtime.engine.flushOnLeave(); gym.refresh()
      }
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

  // A draft program screenshot in the composer, as if just chosen from the photo picker (`-coach-draft-photo`).
  static func seedDraftPhoto(_ coach: CoachConversation) {
    #if DEBUG && targetEnvironment(simulator)
    guard ProcessInfo.processInfo.arguments.contains("-coach-draft-photo"), coach.allowed, coach.saved.photo == nil else { return }
    try? coach.addPhoto(CoachFixtureConversation.program())
    #endif
  }

  // The board's writes land as Coach's first words arrive, after the phone took what the log held as the question went.
  static let boardWritten = Mutex(false)
  static func applyBoardWrites(_ gym: GymModel) {
    #if DEBUG && targetEnvironment(simulator)
    guard let board = CoachBoard.current, !board.writes.isEmpty, !boardWritten.withLock({ let done = $0; $0 = true; return done }) else { return }
    for write in board.writes {
      switch write {
      case .exercise(let exercise, let name, let equipment, let loadCount): _ = gym.run(UpdateExercise(exercise.id, name: name, equipment: equipment, loadCount: loadCount))
      case .note(let title, let body): _ = gym.run(SaveNoteCall(Note(id: ID("board-note"), title: title, body: body)))
      }
    }
    #endif
  }

  static func applySetupResults(_ results: [CoachResult], gym: GymModel) {
    #if DEBUG && targetEnvironment(simulator)
    guard ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture") else { return }
    for result in results where result.kind == "routine-created" {
      let id = ID<Routine>(RecordID(result.routineId))
      guard !gym.routines.contains(where: { $0.id == id }) else { continue }
      var routine = Draft(new: Routine(id: id, name: result.routineName, entries: [
        RoutineEntry(exerciseId: ID("back-squat"), sets: Array(repeating: SetTarget(reps: 5), count: 3)),
        RoutineEntry(exerciseId: ID("bench-press"), sets: Array(repeating: SetTarget(reps: 5), count: 3)),
        RoutineEntry(exerciseId: ID("barbell-row"), sets: Array(repeating: SetTarget(reps: 5), count: 3))]))
      _ = gym.save(&routine)
    }
    #endif
  }

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
nonisolated final class CoachFixtureProtocol: URLProtocol, @unchecked Sendable {
  static let deletedThreads = Mutex<Set<String>>([])
  static let setupGenerations = Mutex<[String: Data]>([:])
  // The log's now, so an answer is stamped on the day the room reads as today; each answer a minute after the one before.
  static let now = Mutex<Int64>(0)
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
    let thread = body["thread"] as? String ?? "coach-fixture-thread"
    let requestId = body["requestId"] as? String ?? "coach-fixture-request"
    let said = CoachFixtureConversation(asked: body["question"] as? String)
    var generation: [String: Any] = ["id": "gen-" + requestId, "requestId": requestId, "question": body["question"] as? String ?? said.question,
      "status": "completed", "answer": said.answer, "at": Self.now.withLock { $0 += 60_000; return $0 }, "revision": 2, "attachments": said.attachments,
      "steps": said.steps, "results": said.results, "receipt": said.receipt]
    if ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture"), body["purpose"] as? String == "routine_setup" {
      generation["purpose"] = "routine_setup"; generation["steps"] = []; generation["results"] = []
      if (body["attachmentIds"] as? [String])?.isEmpty != false { generation["attachments"] = [] }
      generation["receipt"] = ["version": 1, "read": ["sets": 0, "sessions": 0, "weeks": 0], "steps": [], "proposals": [], "observations": []]
      generation["answer"] = "Here are three drafts. Review each routine and save the ones you want."
      generation["routineDrafts"] = ["A", "B", "C"].enumerated().map { index, suffix in
        ["operationId": "setup-operation-" + suffix, "routineId": "setup-routine-" + suffix, "name": "Full body " + suffix,
         "position": index, "state": "pending", "entries": ["back-squat", "bench-press", "barbell-row"].enumerated().map { position, exercise in
           ["position": position, "exerciseId": exercise, "sets": [["reps": 5, "weightKg": NSNull()]], "restSeconds": 120] as [String: Any]
         }] as [String: Any]
      }
    }

    let row: [String: Any] = ["id": "coach-fixture-thread", "title": said.question, "askedAt": 1_790_424_000_000,
      "outcome": said.outcome, "generation": generation, "turns": [], "nextCursor": NSNull()]
    var response: [String: Any] = [:], type = "application/json", data = Data(), status = 200
    if path.hasPrefix("/v1/ai/installations") || path == "/v1/gym/coach/onboarding" {
      let allowance: [String: Any] = ["code": "ok", "currency": "USD", "period": "lifetime", "tier": "anonymous", "configured": true,
        "limit": "0.050000000", "used": "0.001000000", "reserved": "0.000000000", "remaining": "0.049000000", "resetsAtMs": NSNull(), "budgetResetsAtMs": NSNull()]
      if path == "/v1/gym/coach/onboarding" {
        response = ["requestId": requestId, "resultId": "onb_" + String(repeating: "a", count: 64), "status": "completed", "expiresAtMs": 1_900_000_000_000 as Int64,
          "errorCode": NSNull(), "allowance": allowance, "message": "Here are your routine drafts. Review them before saving.",
          "routines": ["A", "B", "C"].map { suffix in
            ["name": "Full body " + suffix, "entries": ["back-squat", "bench-press", "barbell-row"].map { exercise in
              ["exerciseId": exercise, "sets": Array(repeating: ["reps": 5, "weightKg": NSNull()] as [String: Any], count: 3), "restSeconds": 120] as [String: Any]
            }] as [String: Any]
          }]
      } else {
        response = ["bound": path.hasSuffix("/bind"), "allowance": allowance]
        if path == "/v1/ai/installations" { response["credential"] = String(repeating: "a", count: 43) }
      }
    } else if path.hasSuffix("/confirm"), path.contains("/routines/") {
      let parts = path.split(separator: "/").map(String.init)
      let key = parts[5], operation = parts[7]
      if let stored = Self.setupGenerations.withLock({ $0[key] }),
         var snapshot = (try? JSONSerialization.jsonObject(with: stored)) as? [String: Any],
         var value = snapshot["generation"] as? [String: Any], var drafts = value["routineDrafts"] as? [[String: Any]],
         let index = drafts.firstIndex(where: { $0["operationId"] as? String == operation }) {
        drafts[index]["state"] = "saved"; value["routineDrafts"] = drafts
        value["revision"] = (value["revision"] as? Int ?? 2) + 1
        value["results"] = drafts.filter { $0["state"] as? String == "saved" }.map { draft in
          ["kind": "routine-created", "operationId": draft["operationId"]!, "routineId": draft["routineId"]!,
           "routineName": draft["name"]!, "movementCount": 3]
        }
        snapshot["generation"] = value
        Self.setupGenerations.withLock { $0[key] = try? JSONSerialization.data(withJSONObject: snapshot) }
        response = snapshot
      } else { status = 404; response = ["code": "not-found"] }
    } else if path == "/v1/gym/ask", ProcessInfo.processInfo.arguments.contains("-coach-unavailable") {
      status = 503; response = ["code": "ask-not-configured", "error": CoachCopy.absent]
    } else if path == "/v1/gym/ask" {
      _ = Self.deletedThreads.withLock { $0.remove("coach-fixture-thread") }
      var partial = generation; partial["status"] = "running"; partial["answer"] = ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture") ? "" : said.partial; partial["revision"] = 1
      if ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture") {
        Self.setupGenerations.withLock { $0[requestId] = try? JSONSerialization.data(withJSONObject: ["thread": thread, "generation": generation]) }
        partial["routineDrafts"] = []
      }
      let first = String(data: try! JSONSerialization.data(withJSONObject: ["thread": thread, "generation": partial]), encoding: .utf8)!
      let last = String(data: try! JSONSerialization.data(withJSONObject: ["thread": thread, "generation": generation]), encoding: .utf8)!
      data = Data("event: snapshot\ndata: \(first)\n\nevent: snapshot\ndata: \(last)\n\n".utf8); type = "text/event-stream"
      // A held answer streams its first snapshot and keeps the stream open, so Coach stays mid-answer.
      if said.held {
        let http = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("event: snapshot\ndata: \(first)\n\n".utf8)); return
      }
    } else if path == "/v1/gym/threads" {
      response = ["threads": Self.deletedThreads.withLock { $0.contains("coach-fixture-thread") } ? [] : [row], "nextCursor": NSNull()]
    } else if path.hasPrefix("/v1/gym/threads/"), request.httpMethod == "DELETE" {
      _ = Self.deletedThreads.withLock { $0.insert(request.url!.lastPathComponent) }
    } else if path.hasPrefix("/v1/gym/threads/"), Self.deletedThreads.withLock({ $0.contains(request.url!.lastPathComponent) }) {
      status = 404; response = ["code": "not-found"]
    }
    else if path == "/v1/oauth/grants" { response = ["grants": [["clientId": "fixture", "name": "Claude Desktop", "grantedMs": 1_790_424_000_000, "scope": "gym:read gym:write"]]] }
    else if path == "/v1/mcp-keys" { response = ["keys": [["id": "fixture-key", "name": "A static key", "createdMs": 1_790_424_000_000]]] }
    else if path.contains("/generations/") { var stopped = generation; stopped["status"] = "stopped"; stopped["revision"] = 3; response = ["thread": thread, "generation": stopped] }
    else if path.contains("/attachments/"), request.httpMethod == "GET" { data = said.photo(); type = "image/jpeg" }
    else if path.contains("/attachments/") { response = ["attachment": ["id": path.components(separatedBy: "/").last!, "mediaType": "image/jpeg", "width": 10, "height": 10, "bytes": request.httpBody?.count ?? 10]] }
    else { response = row }
    if data.isEmpty { data = try! JSONSerialization.data(withJSONObject: response) }
    let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!
    client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

// One conversation per fixture state: a change to Push A, its removal read from totals (`-coach-removal`), a routine and a note
// (`-coach-created`), a Markdown answer (`-coach-markdown`), and Coach held mid-answer (`-coach-streaming`) or before its
// first word under a program screenshot (`-coach-thinking`).
nonisolated struct CoachFixtureConversation {
  let question: String
  let partial: String
  let answer: String
  var held = false
  var screenshot = false
  var attachments: [[String: Any]] = []
  var steps: [[String: Any]]
  var results: [[String: Any]] = []
  let receipt: [String: Any]
  let outcome: [String: Any]

  init(arguments: [String] = ProcessInfo.processInfo.arguments, asked: String? = nil) {
    let workout: [String: Any] = ["workingSetCount": 1, "tonnageKg": 400, "durationMs": 1_000_000]
    let read: [String: Any] = ["sets": 1, "sessions": 1, "weeks": 1]
    let observations: [[String: Any]] = [
      ["sessionId": "coach-fixture-session", "startedAt": 1_790_423_000_000, "finishedAt": 1_790_424_000_000, "tool": "list_sessions",
       "coverage": "summary", "setsRead": 0, "routine": "Push A", "workout": workout],
      ["sessionId": "coach-fixture-session", "startedAt": 1_790_423_000_000, "finishedAt": 1_790_424_000_000, "tool": "get_session",
       "coverage": "session", "setsRead": 1, "routine": "Push A", "workout": workout]]
    steps = [["tool": "list_notes"], ["tool": "list_sessions"], ["tool": "get_session"]]
    if let board = CoachBoard.current {
      let turn = board.turns.first { $0.question == asked } ?? board.turns[0]
      question = turn.question; partial = turn.answer; answer = turn.answer
      let tools = turn.tools.isEmpty ? [board.proposals.contains(where: \.removing) ? "propose_routine_removal" : "propose_routine_change"] : turn.tools
      steps.append(contentsOf: tools.map { ["tool": $0] })
      receipt = ["version": 1, "read": read, "steps": steps, "proposals": turn.proposals, "observations": observations]
      outcome = ["kind": "proposed", "changes": 1, "routineId": board.routines[0].id, "routine": board.routines[0].name]
    } else if arguments.contains("-coach-markdown") || arguments.contains("-coach-streaming") || arguments.contains("-coach-thinking") {
      held = !arguments.contains("-coach-markdown"); screenshot = arguments.contains("-coach-thinking")
      question = screenshot ? "My program, 3 days a week" : "What should Thursday look like?"
      partial = screenshot ? "" : "Thursday is still a Push day. Keep the same total work, and change the last set to a heavier…"
      answer = "## Thursday · Push A\n\nKeep the same total work each week. Do 3 sets of 3 at 90 kg for a heavier top set.\n\n"
        + "- Bench Press — 3 × 3 at 90\n- Incline Press — 3 × 10 at 24\n- Triceps Pushdown — 3 × 12\n\n"
        + "| Movement | Last | Next |\n|---|---|---|\n| Bench Press | 5 × 5 · 82.5 | 3 × 3 · 90 |\n| Incline Press | 3 × 10 · 22 | 3 × 10 · 24 |\n| Pushdown | 3 × 12 · 30 | 3 × 12 · 30 |"
      if screenshot { attachments = [["id": "coach-fixture-photo", "mediaType": "image/jpeg", "width": 360, "height": 480, "bytes": 500]] }
      receipt = ["version": 1, "read": read, "steps": steps, "proposals": [], "observations": observations]
      outcome = ["kind": "answered", "changes": 0, "routineId": NSNull(), "routine": NSNull()]
    } else if arguments.contains("-coach-created") {
      question = "Build me a routine."; partial = "Push A is in your routines."
      answer = "Push A is in your routines: back squat, one set of five at 80."
      steps = [["tool": "list_notes"], ["tool": "list_exercises"], ["tool": "create_routine"], ["tool": "save_note"]]
      results = [["kind": "routine-created", "operationId": "coach-fixture-result", "routineId": "coach-fixture-routine", "routineName": "Push A"]]
      receipt = ["version": 1, "read": ["sets": 0, "sessions": 0, "weeks": 0], "steps": steps, "proposals": [], "observations": []]
      outcome = ["kind": "created", "changes": 1, "routineId": "coach-fixture-routine", "routine": "Push A"]
    } else if arguments.contains("-coach-removal") {
      question = "Remove Push A."; partial = "Push A has not moved your squat in six weeks."
      answer = "Push A has not moved your squat in six weeks. Removing it leaves every set you logged where it is."
      steps = [["tool": "list_notes"], ["tool": "get_stats"], ["tool": "propose_routine_removal"]]
      receipt = ["version": 1, "read": read, "steps": steps, "proposals": ["coach-fixture-proposal"], "observations": []]
      outcome = ["kind": "proposed", "changes": 1, "routineId": "coach-fixture-routine", "routine": "Push A"]
    } else {
      question = "Is Push A still doing anything?"; partial = "Keep the weekly work steady."
      answer = "## Your next block\n\nKeep the weekly work steady. **Three triples at 90** gives you a top set to push."
      attachments = [["id": "coach-fixture-photo", "mediaType": "image/jpeg", "width": 480, "height": 360, "bytes": 500]]
      steps.append(["tool": "propose_routine_change"])
      receipt = ["version": 1, "read": read, "steps": steps, "proposals": ["coach-fixture-proposal"], "observations": observations]
      outcome = ["kind": "proposed", "changes": 3, "routineId": "coach-fixture-routine", "routine": "Push A"]
    }
  }

  func photo() -> Data { screenshot ? Self.program() : Self.photo() }

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

  // The lifter's photo: a lit frame with the training symbol on it, so a capture shows how a picture sits, not a swatch.
  static func photo() -> Data {
    let format = UIGraphicsImageRendererFormat(); format.scale = 1
    let size = CGSize(width: 480, height: 360)
    return UIGraphicsImageRenderer(size: size, format: format).image { context in
      let colours = [UIColor(GymPalette.accent).cgColor, UIColor(GymPalette.done).cgColor, UIColor(GymPalette.record).cgColor]
      let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colours as CFArray, locations: [0, 0.6, 1])!
      context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
      let symbol = UIImage(systemName: "figure.strengthtraining.traditional", withConfiguration: UIImage.SymbolConfiguration(pointSize: 180))!
        .withTintColor(UIColor(GymPalette.card), renderingMode: .alwaysOriginal)
      symbol.draw(at: CGPoint(x: (size.width - symbol.size.width) / 2, y: (size.height - symbol.size.height) / 2))
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
    var tools: [String] = []
  }
  // What Coach writes on the log while it answers: a movement it corrects, or a note it saves.
  enum Write { case exercise(Exercise, name: String?, equipment: String?, loadCount: Int?), note(String, String) }
  var routines: [(id: String, name: String, entries: [RoutineEntry])]
  var proposals: [Proposed]
  var turns: [Turn]
  var editedAfter: (id: String, entries: [RoutineEntry])?
  var writes: [Write] = []

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
  static func one(_ question: String, _ answer: String, routine: (String, [RoutineEntry]), proposed: (String, [RoutineEntry]), removing: Bool = false) -> CoachBoard {
    CoachBoard(routines: [(id: "board-routine", name: routine.0, entries: routine.1)],
               proposals: [Proposed(id: "board-proposal", routine: "board-routine", name: proposed.0, entries: proposed.1, removing: removing)],
               turns: [Turn(question: question, answer: answer, proposals: ["board-proposal"])])
  }

  static let bench = entry("bench-press", 5, 5, 82.5), heavier = entry("bench-press", 3, 3, 90)
  static let pushA = [bench, entry("cable-fly", 3, 12, 15), entry("triceps-pushdown", 3, 12, 30), entry("overhead-press", 3, 8, 40)]
  static let pushB = [bench, entry("incline-bench-press", 3, 10, 50), entry("overhead-press", 3, 8, 40), entry("triceps-pushdown", 3, 12, 30), entry("lateral-raise", 3, 15, 8)]
  static let pullA = [entry("chin-up", 3, nil), entry("barbell-row", 3, 8, 60), entry("face-pull", 3, 15, 12.5), entry("lateral-raise", 3, 15, 8), entry("rear-delt-fly", 3, 15, 8)]
  static let change = one("Is Push A still doing anything?", "Your Bench Press has not gone up in 3 weeks.\n\nYou did 5 × 5 at 82.5 kg nine times and finished every rep. Try 3 sets of 3 at 90 kg for a heavier top set.",
    routine: ("Push A", pushA), proposed: ("Push A", [heavier, pushA[3], entry("incline-dumbbell-press", 3, 10, 24), entry("triceps-pushdown", 3, 10, 30)]))
  static func wrote(_ question: String, _ answer: String, tool: String, _ write: Write) -> CoachBoard {
    var board = CoachBoard(routines: [(id: "board-routine", name: "Push A", entries: pushB)], proposals: [],
                           turns: [Turn(question: question, answer: answer, tools: [tool])])
    if case .exercise(let exercise, _, _, _) = write { board.routines[0].entries.append(RoutineEntry(exerciseId: exercise.id, sets: [SetTarget(reps: 8)])) }
    board.writes = [write]
    return board
  }

  static let all: [String: CoachBoard] = [
    "load-basis": wrote("Pull-ups are bodyweight for me. I add a 10 kg belt.",
      "Done. Pull-up is now a bodyweight movement. Log the belt as 10 kg added. Volume counts only the added weight.", tool: "update_exercise",
      .exercise(Exercise(id: ID("board-pull-up"), name: "Pull-up", pattern: "pull", equipment: "machine", stepKg: 2.5), name: nil, equipment: "bodyweight", loadCount: nil)),
    "note": wrote("My left shoulder hurts on wide-grip bench.", "I saved this as a note. I will use it when I plan.", tool: "save_note",
      .note("Shoulder", "Left shoulder hurts on wide-grip bench. Use a close grip.")),
    "movement-details": wrote("Incline DB is really dumbbells, one in each hand.", "Done. Enter the weight of one dumbbell from now on.", tool: "update_exercise",
      .exercise(Exercise(id: ID("board-incline-db"), name: "Incline DB", pattern: "press", equipment: "barbell", stepKg: 2.5), name: "Incline Press", equipment: "dumbbell", loadCount: 2)),
    "change": change,
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

