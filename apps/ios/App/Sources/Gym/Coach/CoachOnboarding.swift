import Foundation
import DomainKit
import GymDomain
import SyncCore
import SyncSchema

nonisolated struct CoachOnboardingIn: Codable, Equatable, Sendable {
  struct Image: Codable, Equatable, Sendable { let mimeType: String; let data: String }
  let requestId: String
  let mode: String
  var goal: String?
  var daysPerWeek: Int?
  var equipment: String?
  var program: String?
  var image: Image?
  var note: String?
  struct Context: Codable, Equatable, Sendable { let role: String; let text: String }
  var text: String?
  var context: [Context]?
  var question: String { text ?? goal ?? program ?? note ?? "Turn this program into routines." }
}

nonisolated struct CoachOnboardingOut: Codable, Equatable, Sendable {
  struct Routine: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Sendable {
      struct Set: Codable, Equatable, Sendable { let reps: Int?; let weightKg: Double? }
      let exerciseId: String
      let sets: [Set]
      let restSeconds: Int?
    }
    let name: String
    let entries: [Entry]
    var domain: CoachRoutine {
      CoachRoutine(name: name, entries: entries.map { entry in
        RoutineEntry(exerciseId: ID(RecordID(entry.exerciseId)), sets: entry.sets.isEmpty ? nil : entry.sets.map { SetTarget(reps: $0.reps, weightKg: $0.weightKg) }, restSeconds: entry.restSeconds)
      })
    }
  }
  let requestId: String
  let resultId: String
  let status: String
  let expiresAtMs: Int64
  let routines: [Routine]
  let errorCode: String?
  let allowance: AiAllowance
  var message: String?
}

nonisolated struct CoachOnboardingRecord: Codable, Equatable, Identifiable {
  let request: CoachOnboardingIn
  var photo: CoachAttachment?
  var response: CoachOnboardingOut?
  var results: [CoachResult] = []
  var stopped = false
  var refusalCode: String?
  var id: String { request.requestId }
  var finished: Bool { refusalCode != nil || !results.isEmpty || response?.status == "completed" || response?.status == "failed" || response?.status == "expired" }
}

extension CoachConversation {
  var anonymous: Bool { gym.isAnonymous }
  var seat: String? {
    guard !gym.accountTransition, !gym.authPaused else { return nil }
    if !gym.isAnonymous { return gym.account }
    return try? gym.runner.read(Gym.scope) { "anonymous:" + $0.replica }
  }
  var anonymousRequest: CoachOnboardingRecord? { saved.onboarding?.last }
  var anonymousRetryable: Bool { anonymousRequest.map { !$0.finished && !asking } ?? false }
  var textLimit: Int { anonymous ? 4000 : 8000 }


  func sendOnboarding() {
    guard allowed, !asking, draftReadable, let owner else { return }
    if offline { error = CoachCopy.offline; gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": "offline"]); return }
    if anonymousRetryable { resumeOnboarding(); return }
    let text = saved.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.utf8.count <= textLimit else { error = "Keep your message within \(textLimit) bytes."; return }
    guard !text.isEmpty || saved.photo != nil else { return }
    var context: [CoachOnboardingIn.Context] = []
    for record in saved.onboarding ?? [] where record.response?.status == "completed" {
      if !record.request.question.isEmpty { context.append(.init(role: "user", text: record.request.question)) }
      if let message = record.response?.message, !message.isEmpty { context.append(.init(role: "assistant", text: message)) }
    }
    while context.count > 12 || context.reduce(0, { $0 + $1.text.utf8.count }) > 16000 { context.removeFirst() }
    let image = saved.photo.flatMap { photo in saved.photoData.map { CoachOnboardingIn.Image(mimeType: photo.mediaType, data: $0.base64EncodedString()) } }
    let request = CoachOnboardingIn(requestId: UUID().uuidString.lowercased(), mode: "conversation", image: image, text: text, context: context)
    var next = saved
    next.onboarding = (next.onboarding ?? []) + [CoachOnboardingRecord(request: request, photo: saved.photo)]
    next.allowance = nil
    guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { return }
    launchOnboarding(owner: owner)
  }

  func resumeOnboarding() {
    guard allowed, !asking, let owner, var record = anonymousRequest, !record.finished else { return }
    record.stopped = false
    var next = saved; if let index = next.onboarding?.indices.last { next.onboarding?[index] = record }
    guard keep(next, failure: "Your message couldn’t be saved. Try again.") else { return }
    launchOnboarding(owner: owner)
  }

  func launchOnboarding(owner: String) {
    guard let record = anonymousRequest, !record.finished, let installation = gym.runtime?.installation else { return }
    workGeneration += 1; let generation = workGeneration
    asking = true; refusal = nil; error = nil
    let started = ProcessInfo.processInfo.systemUptime
    gym.telemetry.event("gym_ask_started", properties: ["screen": "coach"])
    work = Task { [weak self] in
      guard let self else { return }
      defer { if self.owner == owner, self.workGeneration == generation { self.asking = false; self.work = nil } }
      do {
        let credential = try await installation.credential()
        guard self.owner == owner, self.allowed, self.workGeneration == generation else { throw CancellationError() }
        let data: Data
        if anonymous {
          data = try await installation.request("/v1/gym/coach/onboarding", method: "POST", body: try JSONEncoder().encode(record.request), credential: credential)
        } else {
          data = try await installation.request("/v1/gym/coach/onboarding/" + record.id, credential: credential)
        }
        var response = try JSONDecoder().decode(CoachOnboardingOut.self, from: data)
        while true {
          try Task.checkCancellation()
          guard self.owner == owner, self.allowed, self.workGeneration == generation,
                self.anonymousRequest?.id == record.id else { throw CancellationError() }
          guard response.requestId == record.id, ["pending", "completed", "failed", "expired"].contains(response.status) else { throw URLError(.badServerResponse) }
          var updated = record; updated.response = response
          var next = saved; if let index = next.onboarding?.indices.last { next.onboarding?[index] = updated }
          if response.status == "completed" { next.acceptedFirstMessage = true }
          if response.status == "completed", next.text.trimmingCharacters(in: .whitespacesAndNewlines) == record.request.question,
             next.photo == record.photo {
            next.text = ""; next.photo = nil; next.photoData = nil; next.choices = nil; next.setupChoice = nil
          }
          guard keep(next, failure: "Coach’s response couldn’t be saved. Check it again.") else { throw AppFailure(message: "Coach’s response couldn’t be saved. Check it again.") }
          if response.status == "completed" { break }
          if response.status != "pending" { showOnboardingRefusal(response.errorCode ?? "expired", allowance: response.allowance); break }
          try await Task.sleep(for: .seconds(1))
          let data = try await installation.request("/v1/gym/coach/onboarding/" + record.id, credential: credential)
          response = try JSONDecoder().decode(CoachOnboardingOut.self, from: data)
        }
        gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": response.status == "completed" ? "answered" : AiAllowance.refusalCodes.contains(response.errorCode ?? "") ? "capped" : "refused"], durationMs: Int64((ProcessInfo.processInfo.systemUptime - started) * 1000))
      } catch {
        guard self.owner == owner, self.allowed, self.workGeneration == generation else { return }
        if error is CancellationError || (error as? URLError)?.code == .cancelled {
          self.error = "Stopped waiting. Coach may still finish. Check the same response when you’re ready."
          return
        }
        if let failure = error as? AiRequestFailure, let body = try? JSONDecoder().decode(InstallationFailure.self, from: failure.body) {
          if failure.status == 400 || ["request_limit", "installation_rate_limited", "anonymous_ai_unavailable"].contains(body.code ?? "") {
            var next = saved
            if let index = next.onboarding?.indices.last, next.onboarding?[index].id == record.id { next.onboarding?[index].refusalCode = body.code ?? "invalid_input" }
            _ = keep(next, failure: "Your message couldn’t be saved. Try again.")
          }
          showOnboardingRefusal(body.code ?? "unavailable", allowance: body.allowance)
        } else if GymRESTClient.needsConnection(error) { self.error = CoachCopy.offline }
        else if let failure = error as? AppFailure { self.error = failure.message }
        else { self.error = "Coach’s response couldn’t be read. Check it again."; gym.report("gym_rest", error) }
        gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": "failed"])
      }
    }
  }

  func importOnboarding(_ record: CoachOnboardingRecord, owner: String, generation: Int) throws {
    guard self.owner == owner, allowed, workGeneration == generation, let response = record.response,
          response.status == "completed" else { throw CancellationError() }
    let result: Outcome<[ID<Routine>], GymRefusal>
    do {
      let replica = try gym.runner.read(Gym.scope) { $0.replica }
      result = try gym.runner.run(ImportCoachRoutines(replica: replica, requestId: record.id,
        resultId: response.resultId, routines: response.routines.map(\.domain)))
    } catch {
      gym.report("gym_action", error)
      gym.telemetry.event("gym_action", properties: ["screen": "coach", "outcome": "failed"])
      throw AppFailure(message: "Your routines couldn’t be saved. The response is kept on this phone; try again.")
    }
    let ids: [ID<Routine>]
    switch result {
    case .committed(let created, _), .unchanged(let created): ids = created
    case .refused: throw AppFailure(message: "These routines couldn’t be saved. Your response is kept; try again.")
    }
    guard ids.count == response.routines.count else { throw URLError(.badServerResponse) }
    var completed = record
    completed.results = zip(ids, response.routines).enumerated().map { index, item in
      CoachResult(kind: "routine-created", operationId: response.resultId + "-" + String(index), routineId: item.0.description,
        routineName: item.1.name, movementCount: item.1.entries.count)
    }
    var next = saved; if let index = next.onboarding?.firstIndex(where: { $0.id == record.id }) { next.onboarding?[index] = completed }
    guard keep(next, failure: "Your routines are saved. Check the response to restore their links.") else { throw AppFailure(message: "Your routines are saved. Check the response to restore their links.") }
    gym.refresh()
    gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "routines_saved"])
  }

  func stopOnboarding() {
    workGeneration += 1; work?.cancel(); work = nil; asking = false
    var next = saved
    if let index = next.onboarding?.indices.last { next.onboarding?[index].stopped = true }
    _ = keep(next, failure: "Your message couldn’t be saved. Try again.")
    error = "Stopped waiting. Coach may still finish. Check the same response when you’re ready."
    gym.telemetry.event("gym_ask_outcome", properties: ["screen": "coach", "outcome": "cancelled"])
  }

  func showOnboardingRefusal(_ code: String, allowance: AiAllowance?) {
    if let allowance, AiAllowance.refusalCodes.contains(code) {
      refusal = .allowance(allowance); error = allowance.message
      return
    }
    error = Self.onboardingRefusalMessage(code)
    refusal = .said(error!)
  }

  static func onboardingRefusalMessage(_ code: String) -> String {
    switch code {
    case "invalid_installation": return "This phone’s AI access couldn’t be verified. Your draft is kept. Sign in to continue."
    case "installation_bound", "device_bound": return "This phone’s AI access belongs to an account. Sign in to use Coach."
    case "installation_rate_limited", "onboarding_rate_limited", "request_limit": return "Too many requests from this connection. Your draft is kept; try again later."
    case "insufficient_details": return "Coach needs a clearer program. Add the movements and sets, or a clearer photo."
    case "expired", "result_expired": return "This response has expired. Your draft is still on this phone."
    case "anonymous_ai_unavailable", "unconfigured": return "Coach setup is unavailable right now. Your draft is kept."
    case "unsupported_equipment": return "Choose Full gym, Dumbbells, Barbell or Bodyweight."
    case "invalid_input", "invalid_image": return "Check your program details or choose a different photo, then send again."
    case "model_refused": return "Coach couldn’t help with that request. Edit your program details and try again."
    case "output_truncated", "invalid_result": return "Coach couldn’t make complete routines. Your draft is kept."
    default: return "Coach couldn’t finish these routines. Your draft is kept."
    }
  }
}
