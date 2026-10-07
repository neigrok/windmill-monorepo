import Foundation
import GymDomain
import DomainKit
import SyncCore
import SyncEngine
import SyncIOS
import SyncStore
import UIKit

// Simulator fixtures use the real engine actions and the authenticated REST boundary.
enum CoachFixture {
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
  static func prepare(_ gym: GymModel) async {
    #if DEBUG && targetEnvironment(simulator)
    guard ProcessInfo.processInfo.arguments.contains("-coach-fixture"), let runtime = gym.runtime, let server = runtime.auth.fake else { return }
    do {
      gym.refresh()
      if gym.account == nil {
        let identity = server.identity(email: "coach-fixture@example.com")
        _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
        gym.refresh()
      }
      guard let owner = gym.account, gym.coachAccountAvailable else { throw AppFailure(message: "Coach fixture account is unavailable.") }
      if !ProcessInfo.processInfo.arguments.contains("-restore-board") {
        try? FileManager.default.removeItem(at: CoachDraftStore().file(owner))
      }
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
        summary: removing ? "Remove this routine." : "Three triples at 90 keeps the weekly tonnage and gives you a top set to push.", removing: removing))
      await runtime.engine.flushOnLeave(); gym.refresh()
    } catch {
      let reason = failureReason(error)
      NSLog("Gym Coach fixture failed: %@", reason)
      gym.error = "Coach fixture could not be prepared (\(reason))."
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
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
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
    let generation: [String: Any] = ["id": "gen-" + requestId, "requestId": requestId,
      "question": body["question"] as? String ?? "Is Push A still doing anything?", "status": "completed",
      "answer": "## Your next block\n\nKeep the weekly work steady. **Three triples at 90** gives you a top set to push.",
      "at": 1_790_424_000_000, "revision": 2, "attachments": [["id": "coach-fixture-photo", "mediaType": "image/jpeg", "width": 80, "height": 80, "bytes": 500]], "steps": [["tool": "list_sessions"], ["tool": "list_notes"]],
      "results": [["kind": "routine-created", "operationId": "coach-fixture-result", "routineId": "coach-fixture-routine", "routineName": "Push A"]],
      "receipt": ["version": 1, "read": ["sets": 214, "weeks": 6, "sessions": 18], "steps": [["tool": "list_sessions"]], "proposals": ["coach-fixture-proposal"], "observations": [["sessionId": "coach-fixture-session", "startedAt": 1_790_423_000_000, "tool": "get_session", "coverage": "session", "setsRead": 1, "routine": "Push A workout", "workout": ["workingSetCount": 1, "tonnageKg": 400, "durationMs": 1_000_000]]]]]
    let row: [String: Any] = ["id": "coach-fixture-thread", "title": "Is Push A still doing anything?", "askedAt": 1_790_424_000_000,
      "outcome": ["kind": "proposed", "changes": 3, "routine": "Push A"], "generation": generation, "turns": [], "nextCursor": NSNull()]
    var response: [String: Any] = [:], type = "application/json", data = Data(), status = 200
    if path == "/v1/gym/ask", ProcessInfo.processInfo.arguments.contains("-coach-unavailable") {
      status = 503; response = ["code": "ask-not-configured", "error": CoachCopy.absent]
    } else if path == "/v1/gym/ask" {
      var partial = generation; partial["status"] = "running"; partial["answer"] = "Keep the weekly work steady."; partial["revision"] = 1
      let first = String(data: try! JSONSerialization.data(withJSONObject: ["thread": thread, "generation": partial]), encoding: .utf8)!
      let last = String(data: try! JSONSerialization.data(withJSONObject: ["thread": thread, "generation": generation]), encoding: .utf8)!
      data = Data("event: snapshot\ndata: \(first)\n\nevent: snapshot\ndata: \(last)\n\n".utf8); type = "text/event-stream"
    } else if path == "/v1/gym/threads" { response = ["threads": [row], "nextCursor": NSNull()] }
    else if path == "/v1/oauth/grants" { response = ["grants": [["clientId": "fixture", "name": "Claude Desktop", "grantedMs": 1_790_424_000_000, "scope": "gym:read gym:write"]]] }
    else if path == "/v1/mcp-keys" { response = ["keys": [["id": "fixture-key", "name": "A static key", "createdMs": 1_790_424_000_000]]] }
    else if path.contains("/generations/") { var stopped = generation; stopped["status"] = "stopped"; stopped["revision"] = 3; response = ["thread": thread, "generation": stopped] }
    else if path.contains("/attachments/"), request.httpMethod == "GET" {
      let format = UIGraphicsImageRendererFormat(); format.scale = 1
      data = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80), format: format).image { context in
        UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 80, height: 80))
      }.jpegData(compressionQuality: 0.9)!; type = "image/jpeg"
    }
    else if path.contains("/attachments/") { response = ["attachment": ["id": path.components(separatedBy: "/").last!, "mediaType": "image/jpeg", "width": 10, "height": 10, "bytes": request.httpBody?.count ?? 10]] }
    else { response = row }
    if data.isEmpty { data = try! JSONSerialization.data(withJSONObject: response) }
    let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!
    client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
#endif
