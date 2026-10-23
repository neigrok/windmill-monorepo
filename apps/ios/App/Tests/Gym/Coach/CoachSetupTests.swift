import Foundation
import Testing
import UIKit
import DomainKit
import GymDomain
@testable import Windmill

extension CoachTests {
  @Test func pendingRoutineDraftRequiresExplicitConfirmationAndRetainsIdentityOnRetry() async throws {
    let (gym, rest, telemetry) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate()
    coach.edit("Create a routine")
    let request = CoachSaved.Request(thread: coach.saved.threadId, question: coach.saved.text, requestId: "draft-request", attachmentIds: [])
    var saved = coach.saved; saved.request = request
    #expect(coach.keep(saved, failure: "save"))
    var generation: [String: Any] = ["id": "draft-generation", "requestId": request.requestId, "question": request.question,
      "status": "completed", "revision": 1, "answer": "Review your draft.",
      "routineDrafts": [["operationId": "draft-operation", "routineId": "draft-routine", "name": "Upper", "position": 0,
        "entries": [["position": 1, "exerciseId": "bench-press", "sets": [["reps": 8, "weightKg": NSNull()]], "restSeconds": 120]], "state": "pending"]]]
    let response = try JSONDecoder().decode(CoachSnapshot.self, from: JSONSerialization.data(withJSONObject: ["thread": request.thread, "generation": generation]))
    try coach.accept(response, request: request)
    #expect(gym.routines.isEmpty && coach.activeGeneration?.results.isEmpty == true)
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty })
    let draft = try #require(coach.activeGeneration?.routineDrafts.first)
    let save = CoachDraftSave(requestId: request.requestId, operationId: draft.operationId)
    CoachTestProtocol.state.withLock { $0.reply = .failure(.networkConnectionLost) }
    #expect(await coach.saveRoutines(save) == .kept("Couldn’t save the routine. Try again."))
    #expect(coach.activeGeneration?.routineDrafts.first?.state == "pending" && gym.routines.isEmpty)
    generation["revision"] = 2
    var drafts = try #require(generation["routineDrafts"] as? [[String: Any]]); drafts[0]["state"] = "saved"; generation["routineDrafts"] = drafts
    generation["results"] = [["kind": "routine-created", "operationId": "draft-operation", "routineId": "draft-routine", "routineName": "Upper", "movementCount": 1]]
    let body = String(decoding: try JSONSerialization.data(withJSONObject: ["thread": request.thread, "generation": generation]), as: UTF8.self)
    CoachTestProtocol.state.withLock { $0.reply = .http(200, body) }
    #expect(await coach.saveRoutines(save) == .saved)
    #expect(coach.activeGeneration?.routineDrafts.first?.state == "saved" && coach.activeGeneration?.results.count == 1)
    let calls = CoachTestProtocol.state.withLock { $0.requests }
    #expect(calls.map(\.path) == Array(repeating: "/v1/gym/threads/" + request.thread + "/generations/draft-request/routines/draft-operation/confirm", count: 2))
    #expect(calls.map(\.body) == [Data("{}".utf8), Data("{}".utf8)])
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "gym_coach_routine_confirm" }.map { $0.properties["outcome"] ?? "" } } == ["started", "failed", "started", "saved"])
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
  }

  // Each refusal the confirmation door answers says what the draft can still do; only a 5xx or no answer is a failure.
  @Test(arguments: [404, 422, 400, 401, 409, 503])
  func confirmationAnswersSayWhatTheDraftCanStillDo(status: Int) async throws {
    let code = [404: "coach-draft-not-found", 422: "coach-draft-invalid", 409: "routine-save-in-progress", 503: "gym-engine-busy"][status] ?? "invalid"
    let (gym, rest, telemetry) = try await authed(.http(status, #"{"code":""# + code + #"","error":"A private server refusal"}"#)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate()
    let expected: CoachDraftSave.Outcome = switch status {
    case 404: .closed("This draft is no longer available.")
    case 400, 422: .closed("This draft can’t be saved. Ask Coach for a new one.")
    case 401: .kept("Sign in again to save this routine.")
    default: .kept("Couldn’t save the routine. Try again.")
    }
    #expect(await coach.saveRoutines(CoachDraftSave(requestId: "draft-request", operationId: "draft-operation")) == expected)
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "gym_coach_routine_confirm" }.map { $0.properties["outcome"] ?? "" } } == ["started", status < 500 ? "refused" : "failed"])
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "client_error" }.map(\.properties) } == (status < 500 ? [] : [["operation": "gym_rest", "failure_kind": "http"]]))
  }

  @Test func aDraftWithoutItsRequestOffersNoSave() async throws {
    let (gym, rest, telemetry) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate()
    let save = CoachDraftSave(requestId: nil, operationId: "draft-operation")
    #expect(!save.savable)
    #expect(await coach.saveRoutines(save) == .closed("This draft can’t be saved. Ask Coach for a new one."))
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty } && telemetry.entries.withLock { $0.filter { $0.name == "gym_coach_routine_confirm" }.isEmpty })
  }

  @Test func coachStreamOverridesTheProductionAuthTimeoutAndRemainsLiveBetweenHeartbeats() async throws {
    let (gym, original, _) = try await authed(.partial(": heartbeat\n\n"))
    let configuration = NativeAuth.nativeSession().configuration
    #expect(configuration.timeoutIntervalForRequest == 8 && configuration.timeoutIntervalForResource == 15)
    configuration.protocolClasses = [CoachTestProtocol.self]
    let rest = GymRESTClient(runtime: original.runtime, telemetry: gym.telemetry, session: URLSession(configuration: configuration))
    var activity = 0, ended = false
    let work = Task {
      defer { ended = true }
      _ = try await rest.coachRequest("/v1/gym/ask", activity: CoachStreamActivity { activity += 1 }) { _ in Issue.record("Heartbeat produced a snapshot") }
    }
    try await settle { activity == 2 }
    #expect(CoachTestProtocol.state.withLock { $0.active?.request.timeoutInterval } == 60)
    try await Task.sleep(for: .seconds(9))
    #expect(!ended && rest.tasks.count == 1)
    work.cancel(); _ = try? await work.value
    #expect(rest.tasks.isEmpty)
  }

  @Test func streamHeartbeatCountsAsActivityWithoutChangingTheAnswer() async throws {
    let (_, rest, _) = try await authed(.partial(": heartbeat\n\n"))
    var activity = 0
    let work = Task { try await rest.coachRequest("/v1/gym/ask", activity: CoachStreamActivity { activity += 1 }) { _ in Issue.record("Heartbeat produced a snapshot") } }
    try await settle { activity == 2 }
    #expect(rest.tasks.count == 1)
    work.cancel()
    _ = try? await work.value
    #expect(rest.tasks.isEmpty)
  }

  @Test func theGreetingOffersOnlyWhatCoachDoes() {
    let lines = { (signedIn: Bool) in CoachSetupView(signedIn: signedIn, choose: { _ in }).capabilities.map { "\($0.0) — \($0.1)" } }
    #expect(lines(true) == [
      "Build — a program from a screenshot or your own words.",
      "Goals — tell me your goals, and I will plan for them.",
      "Notes — I save important facts, like an old injury.",
      "Changes — ask me, and I suggest changes to your routines.",
    ])
    #expect(lines(false) == [
      "Build — a program from a screenshot or your own words.",
      "Goals — tell me your goals, and I will plan for them.",
      "Account — sign in, and I can also save notes and suggest changes to your routines.",
    ])
    #expect(CoachSetupView.choices.map { "coach-setup-\($0.choice.rawValue) \($0.title)" }
            == ["coach-setup-screenshot Add screenshot", "coach-setup-build_manually Build my own"])
  }

  @Test func setupNeedsResolvedHydratedEmptyAccountAndAnUnoccupiedRoom() {
    for mask in 0..<64 {
      let flags = (0..<6).map { mask & (1 << $0) != 0 }
      #expect(CoachSetupEligibility.shouldOffer(signedIn: flags[0], hydrated: flags[1], empty: flags[2], resolved: flags[3],
        occupied: flags[4], hasConversation: flags[5], choice: nil) == (mask == 15))
    }
    for choice in CoachSetupChoice.allCases {
      #expect(!CoachSetupEligibility.shouldOffer(signedIn: true, hydrated: true, empty: true, resolved: true,
        occupied: false, hasConversation: false, choice: choice))
    }
  }

  @Test func choicesOnlyMarkADurableAccountScopedSetupAndNeverWriteTheDraft() async throws {
    for choice in CoachSetupChoice.allCases {
      let (gym, rest, telemetry) = try await authed(.stalled), cache = store()
      defer { try? FileManager.default.removeItem(at: cache.directory) }
      let coach = CoachConversation(gym: gym, rest: rest, store: cache)
      await coach.activate()
      #expect(coach.beginSetup() && coach.chooseSetup(choice))
      #expect(coach.saved.text.isEmpty && coach.saved.setupChoice == choice)
      #expect(coach.saved.purpose == (choice.starter ? .routineSetup : .conversation))
      #expect(coach.saved.request == nil && !coach.asking && CoachTestProtocol.state.withLock { $0.requests.isEmpty })
      let restored = CoachConversation(gym: gym, rest: rest, store: cache)
      await restored.activate()
      #expect(restored.saved.text.isEmpty && restored.saved.setupChoice == choice && !restored.asking)
      #expect(restored.newChat() && restored.saved.setupChoice == choice)
      #expect(telemetry.entries.withLock { $0.filter { $0.name == "gym_setup_step" }.map(\.properties) } == [["screen": "coach", "action": choice.rawValue]])
      gym.account = "different-owner"; await restored.activate()
      #expect(restored.saved.text.isEmpty && restored.saved.setupChoice == nil)
    }
  }

  @Test func clarificationChipsFillAnEditableDraftWithoutSendingAndSurviveRelaunch() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); #expect(coach.beginSetup())
    let request = CoachSaved.Request(thread: coach.saved.threadId, question: "Get stronger", requestId: "goal-request", attachmentIds: [], purpose: .routineSetup)
    var saved = coach.saved; saved.request = request
    #expect(coach.keep(saved, failure: "save"))
    let body: [String: Any] = ["thread": request.thread, "generation": ["id": "goal-generation", "requestId": request.requestId,
      "question": request.question, "status": "completed", "purpose": "routine_setup", "revision": 1,
      "clarification": ["id": "goal-choices", "question": "Two things, so it fits your week.", "groups": [
        ["id": "days", "label": "How many days a week?", "multiple": false, "options": [["id": "three", "label": "3 days"], ["id": "daily", "label": "Every day"]]],
        ["id": "equipment", "label": "What is at home?", "multiple": true, "options": [["id": "dumbbells", "label": "Dumbbells"], ["id": "bands", "label": "Bands"]]]
      ]]]]
    try coach.accept(JSONDecoder().decode(CoachSnapshot.self, from: JSONSerialization.data(withJSONObject: body)), request: request)
    coach.edit("Private preference.")
    let clarification = try #require(coach.activeClarification)
    coach.select(clarification.groups[0].options[1], in: clarification.groups[0], clarification: clarification)
    coach.select(clarification.groups[1].options[0], in: clarification.groups[1], clarification: clarification)
    coach.select(clarification.groups[1].options[1], in: clarification.groups[1], clarification: clarification)
    #expect(coach.saved.text == "Private preference. Every day. Dumbbells, Bands.")
    #expect(!coach.asking && CoachTestProtocol.state.withLock { $0.requests.isEmpty })
    let restored = CoachConversation(gym: gym, rest: rest, store: cache)
    await restored.activate()
    #expect(restored.saved.choices?.groups == ["days": ["daily"], "equipment": ["dumbbells", "bands"]])
    #expect(restored.saved.text == coach.saved.text && restored.activeClarification == clarification)
    restored.edit("My own fully edited answer.")
    #expect(restored.saved.text == "My own fully edited answer." && restored.saved.choices == nil)
    #expect(!restored.asking)
  }

  @Test func setupPurposeIsImmutableAcrossLostResponseRetryAndOlderDraftsDecode() async throws {
    let legacy = Data(#"{"thread":"thread","question":"Question","requestId":"request","attachmentIds":[],"stream":true}"#.utf8)
    #expect(try JSONDecoder().decode(CoachSaved.Request.self, from: legacy).purpose == .conversation)
    let (gym, rest, _) = try await authed(.failure(.networkConnectionLost)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); #expect(coach.beginSetup()); coach.edit("A three day program."); coach.send()
    await coach.work?.value
    let request = try #require(coach.saved.request)
    #expect(request.purpose == .routineSetup)
    coach.saved.purpose = .conversation
    coach.retry(); await coach.work?.value
    let requests = try CoachTestProtocol.state.withLock { try $0.requests.map { try JSONDecoder().decode(CoachSaved.Request.self, from: #require($0.body)) } }
    #expect(requests == [request, request])
    #expect(try cache.read(gym.account!).request?.purpose == .routineSetup)
  }

  @Test(arguments: [false, true]) func allowanceRefusalKeepsPartialCreationsAndNeverAutomaticallyRetries(partial: Bool) async throws {
    let allowance: [String: Any] = ["code": "free_day_exhausted", "currency": "USD", "period": "calendar_month_utc", "tier": "logged_in",
      "configured": true, "limit": "0.25", "used": "0.01", "reserved": "0", "remaining": "0.24", "resetsAtMs": 1_793_491_200_000,
      "budgetResetsAtMs": 1_792_454_400_000]
    let (gym, rest, telemetry) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); #expect(coach.beginSetup()); coach.edit("Make three routines."); coach.send()
    try await settle { CoachTestProtocol.state.withLock { !$0.requests.isEmpty } }
    let request = try #require(coach.saved.request)
    var refusal: [String: Any] = ["code": "free_day_exhausted", "error": "A private server refusal", "allowance": allowance]
    if partial {
      refusal["generation"] = ["id": "partial-creation", "requestId": request.requestId, "question": request.question, "purpose": "routine_setup",
        "status": "failed", "revision": 2, "answer": "One routine is ready.", "allowanceRefusal": allowance,
        "results": [["kind": "routine-created", "operationId": "one-operation", "routineId": "one-routine", "routineName": "Private routine", "movementCount": 3]]]
    }
    let data = try JSONSerialization.data(withJSONObject: refusal)
    CoachTestProtocol.state.withLock { $0.active }?.respond(503, String(decoding: data, as: UTF8.self))
    await coach.work?.value
    #expect(coach.saved.text == request.question && !coach.retryable && !coach.asking)
    #expect(coach.saved.allowance?.code == "free_day_exhausted")
    #expect(coach.activeGeneration?.results.count == (partial ? 1 : nil))
    #expect(coach.error == "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.")
    let restored = CoachConversation(gym: gym, rest: rest, store: cache)
    await restored.activate()
    #expect(restored.saved.request == request && restored.saved.text == request.question && !restored.asking && !restored.retryable)
    #expect(CoachTestProtocol.state.withLock { $0.requests.count } == 1)
    CoachTestProtocol.state.withLock { $0.reply = .http(503, String(decoding: data, as: UTF8.self)) }
    restored.send(); await restored.work?.value
    let requests = try CoachTestProtocol.state.withLock { try $0.requests.map { try JSONDecoder().decode(CoachSaved.Request.self, from: #require($0.body)) } }
    #expect(requests == [request, request])
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
    #expect(!telemetry.entries.withLock { $0.flatMap { $0.properties.values } }.contains { $0.contains("private") || $0.contains("Private") })
  }

  @Test func receiptRefreshDistinguishesRemovedRoutineFromAnUnreachableLog() async throws {
    let (_, rest, _) = try await authed(.http(404, #"{"code":"not-found","error":"Routine not found"}"#))
    let runtime = try #require(rest.runtime)
    let gym = GymModel(runner: runtime.runner, runtime: runtime, rest: rest)
    #expect(await gym.routineExists(ID("missing")) == false)
    CoachTestProtocol.state.withLock { $0.reply = .failure(.notConnectedToInternet) }
    #expect(await gym.routineExists(ID("missing")) == nil)
    CoachTestProtocol.state.withLock { $0.reply = .http(200, #"{"id":"missing","name":"Private routine"}"#) }
    #expect(await gym.routineExists(ID("missing")) == true)
  }

  @Test func completedSetupWithCreatedRoutinesDoesNotRedirectBackToCoach() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); #expect(coach.beginSetup()); coach.edit("Make routines.")
    #expect(coach.setupNeedsAttention)
    let request = CoachSaved.Request(thread: coach.saved.threadId, question: coach.saved.text, requestId: "setup-request", attachmentIds: [], purpose: .routineSetup)
    var saved = coach.saved; saved.request = request
    #expect(coach.keep(saved, failure: "save"))
    let value: [String: Any] = ["thread": request.thread, "generation": ["id": "setup-generation", "requestId": request.requestId,
      "question": request.question, "purpose": "routine_setup", "status": "completed", "revision": 1,
      "results": [["kind": "routine-created", "operationId": "created", "routineId": "routine", "routineName": "Private routine", "movementCount": 3]]]]
    try coach.accept(JSONDecoder().decode(CoachSnapshot.self, from: JSONSerialization.data(withJSONObject: value)), request: request)
    let restored = CoachConversation(gym: gym, rest: rest, store: cache)
    await restored.activate()
    #expect(restored.hasConversation && restored.saved.purpose == .routineSetup && !restored.setupNeedsAttention)
    restored.edit("Change the last day.")
    #expect(restored.setupNeedsAttention)
  }

  @Test func historyAllowanceRefusalHasNoGenericRetryAndDoesNotLeakIntoAnotherConversation() async throws {
    let value: [String: Any] = ["id": "capped-thread", "generation": ["id": "capped-generation", "requestId": "capped-request", "question": "Private program",
      "status": "failed", "purpose": "routine_setup", "results": [["kind": "routine-created", "operationId": "done", "routineId": "routine", "routineName": "Private routine"]],
      "allowanceRefusal": ["code": "subject_exhausted", "currency": "USD", "period": "calendar_month_utc", "tier": "logged_in", "configured": true,
        "limit": "0.25", "used": "0.25", "reserved": "0", "remaining": "0", "resetsAtMs": 1_793_491_200_000]]]
    let data = try JSONSerialization.data(withJSONObject: value)
    let (gym, rest, _) = try await authed(.http(200, String(decoding: data, as: UTF8.self))), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); await coach.open("capped-thread")
    #expect(coach.saved.allowance?.code == "subject_exhausted" && !coach.retryable && !coach.asking)
    #expect(coach.error == "You have used all of your AI allowance." && coach.activeGeneration?.results.map(\.operationId) == ["done"])
    #expect(CoachTestProtocol.state.withLock { $0.requests.map(\.method) } == ["GET"])
    CoachTestProtocol.state.withLock { $0.reply = .http(200, #"{"id":"normal-thread","turns":[]}"#) }
    await coach.open("normal-thread")
    #expect(coach.saved.allowance == nil && coach.refusal == nil && coach.error == nil && !coach.retryable)
    let capped = try #require(value["generation"] as? [String: Any])
    let older: [String: Any] = ["id": "normal-thread", "turns": [["from": "coach", "text": "Private older reply", "position": 1,
      "status": "failed", "allowanceRefusal": try #require(capped["allowanceRefusal"])]]]
    let olderData = try JSONSerialization.data(withJSONObject: older)
    CoachTestProtocol.state.withLock { $0.reply = .http(200, String(decoding: olderData, as: UTF8.self)) }
    await coach.open("normal-thread", earlier: true)
    #expect(coach.visibleTurns.count == 1 && coach.visibleTurns.first?.allowanceRefusal?.code == "subject_exhausted")
    #expect(coach.saved.allowance == nil && coach.refusal == nil && coach.error == nil && !coach.retryable)
  }

  @Test func oldAndNewRoutineReceiptsDecodeWithoutInventingMovementCounts() throws {
    let results = try JSONDecoder().decode([CoachResult].self, from: Data(#"[{"kind":"routine-created","operationId":"a","routineId":"r1","routineName":"First"},{"kind":"routine-created","operationId":"b","routineId":"r2","routineName":"Second","movementCount":3}]"#.utf8))
    #expect(results.map(\.id) == ["a", "b"] && results.map(\.movementCount) == [nil, 3])
  }
}
