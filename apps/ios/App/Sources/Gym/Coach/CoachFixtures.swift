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
      if !ProcessInfo.processInfo.arguments.contains("-restore-board") {
        try? FileManager.default.removeItem(at: CoachDraftStore().file(owner))
      }
      if ProcessInfo.processInfo.arguments.contains("-coach-setup-fixture") { return true }
      _ = gym.run(SaveNoteCall(Note(id: ID("coach-fixture-note"), title: "How I want to be talked to", body: "Don’t cheerlead. Say the number and stop.")))
      _ = gym.run(SaveNoteCall(Note(id: ID("coach-fixture-goal"), title: "What I am training for", body: "A stronger squat.")))
      var routine = Draft(new: Routine(id: ID("coach-fixture-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(reps: 5, weightKg: 80)])]))
      _ = gym.save(&routine)
      await runtime.engine.flushOnLeave(); gym.refresh()
      _ = gym.run(ImportSession(id: ID("coach-fixture-session"), startedAt: Instant(ms: 1_790_423_000_000), finishedAt: Instant(ms: 1_790_424_000_000),
        sets: [ImportedSet(id: ID("coach-fixture-set"), exerciseId: ID("back-squat"), weightKg: 80, reps: 5, completedAt: Instant(ms: 1_790_423_500_000))], routineId: routine.id))
      let removing = ProcessInfo.processInfo.arguments.contains("-coach-removal")
      _ = gym.run(ProposeRoutine(id: ID("coach-fixture-proposal"), routineId: routine.id, name: "Push A2",
        entries: [RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(reps: 3, weightKg: 90)]), RoutineEntry(exerciseId: ID("bench-press"))],
        summary: removing ? "Push A has stopped moving your squat." : "Three triples at 90 keeps the weekly tonnage and gives you a top set to push.", removing: removing))
      await runtime.engine.flushOnLeave(); gym.refresh()
      // A newer proposal for Push A replaces this one, so its card and Review are out of date.
      if ProcessInfo.processInfo.arguments.contains("-coach-out-of-date") {
        _ = gym.run(ProposeRoutine(id: ID("coach-fixture-newer"), routineId: routine.id, name: "Push A3",
          entries: [RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(reps: 2, weightKg: 95)])], summary: "Doubles at 95."))
        await runtime.engine.flushOnLeave(); gym.refresh()
      }
      // A removal Apply then waits on the log past the review's 15-second wait.
      if ProcessInfo.processInfo.arguments.contains("-coach-removal-stall") {
        server.state.withLock { $0.server.refuse(next: 1_000, code: .clockSkew) }
      }
    } catch {
      let reason = failureReason(error)
      NSLog("Gym Coach fixture failed: %@", reason)
      gym.error = "Coach fixture could not be prepared (\(reason))."
    }
    #endif
    return true
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
    let said = CoachFixtureConversation()
    var generation: [String: Any] = ["id": "gen-" + requestId, "requestId": requestId, "question": body["question"] as? String ?? said.question,
      "status": "completed", "answer": said.answer, "at": 1_790_424_000_000, "revision": 2, "attachments": said.attachments,
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
    else if path.contains("/attachments/"), request.httpMethod == "GET" { data = CoachFixtureConversation.photo(); type = "image/jpeg" }
    else if path.contains("/attachments/") { response = ["attachment": ["id": path.components(separatedBy: "/").last!, "mediaType": "image/jpeg", "width": 10, "height": 10, "bytes": request.httpBody?.count ?? 10]] }
    else { response = row }
    if data.isEmpty { data = try! JSONSerialization.data(withJSONObject: response) }
    let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!
    client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

// One conversation per fixture state: a change to Push A, its removal read from totals (`-coach-removal`), a routine and a note (`-coach-created`).
nonisolated struct CoachFixtureConversation {
  let question: String
  let partial: String
  let answer: String
  var attachments: [[String: Any]] = []
  var steps: [[String: Any]]
  var results: [[String: Any]] = []
  let receipt: [String: Any]
  let outcome: [String: Any]

  init(arguments: [String] = ProcessInfo.processInfo.arguments) {
    let workout: [String: Any] = ["workingSetCount": 1, "tonnageKg": 400, "durationMs": 1_000_000]
    let read: [String: Any] = ["sets": 1, "sessions": 1, "weeks": 1]
    let observations: [[String: Any]] = [
      ["sessionId": "coach-fixture-session", "startedAt": 1_790_423_000_000, "finishedAt": 1_790_424_000_000, "tool": "list_sessions",
       "coverage": "summary", "setsRead": 0, "routine": "Push A", "workout": workout],
      ["sessionId": "coach-fixture-session", "startedAt": 1_790_423_000_000, "finishedAt": 1_790_424_000_000, "tool": "get_session",
       "coverage": "session", "setsRead": 1, "routine": "Push A", "workout": workout]]
    steps = [["tool": "list_notes"], ["tool": "list_sessions"], ["tool": "get_session"]]
    if arguments.contains("-coach-created") {
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
#endif
