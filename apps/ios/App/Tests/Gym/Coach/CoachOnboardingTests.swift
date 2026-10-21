import Foundation
import Testing
import UIKit
import DomainKit
import GymDomain
import SyncCore
import SyncSchema
import SyncEngine
@testable import Windmill

@MainActor final class InstallationMemoryStore: InstallationCredentialStore {
  var value: String?
  var unreadable = false
  var unwritable = false
  init(_ value: String? = nil) { self.value = value }
  func read() throws -> String? { if unreadable { throw KeychainInstallationError() }; return value }
  func write(_ credential: String) throws { if unwritable { throw KeychainInstallationError() }; value = credential }
}

extension CoachTests {
  func installationBody(credential: String? = nil) throws -> String {
    var body: [String: Any] = ["bound": false, "allowance": ["code": "ok", "currency": "USD", "period": "lifetime", "tier": "anonymous", "configured": true,
      "limit": "0.050000000", "used": "0.000000000", "reserved": "0.000000000", "remaining": "0.050000000", "resetsAtMs": NSNull(), "budgetResetsAtMs": NSNull()]]
    body["credential"] = credential
    return String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
  }
  func installation(store: InstallationMemoryStore) -> AiInstallation {
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CoachTestProtocol.self]
    return AiInstallation(baseURL: URL(string: "https://gym.invalid"), credentials: store, session: URLSession(configuration: config), telemetry: NoopTelemetry())
  }
  func anonymousCoach(fault: GymStoreFault = GymStoreFault()) async throws -> (CoachConversation, CoachDraftStore) {
    let body = try installationBody()
    CoachTestProtocol.state.withLock { $0 = .init(reply: .stalled, replies: ["/v1/ai/installations/current": .http(200, body)]) }
    let service = installation(store: InstallationMemoryStore(String(repeating: "a", count: 43)))
    let runtime = try GymModelTests().runtime(failing: fault, installation: service)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    let cache = store()
    let coach = CoachConversation(gym: gym, store: cache)
    await coach.activate()
    return (coach, cache)
  }
  func onboardingResponse(_ request: CoachOnboardingIn, status: String = "completed") throws -> String {
    let allowance = try #require((JSONSerialization.jsonObject(with: Data(installationBody().utf8)) as? [String: Any])?["allowance"])
    let body: [String: Any] = ["requestId": request.requestId, "resultId": "onb_" + String(repeating: "b", count: 64), "status": status,
      "expiresAtMs": 1_900_000_000_000 as Int64, "routines": status == "completed" ? [["name": "Upper", "entries": [["exerciseId": "bench-press", "sets": [["reps": 8, "weightKg": NSNull()]], "restSeconds": 120]]]] : [], "errorCode": NSNull(), "allowance": allowance]
    return String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
  }

  @Test(arguments: [false, true]) func installationIssueAndBindShareTheInFlightCredential(previousSignIn: Bool) async throws {
    let credentials = InstallationMemoryStore(), service = installation(store: credentials)
    CoachTestProtocol.state.withLock { $0 = .init(reply: .stalled) }
    if previousSignIn { try await service.bind(account: "account", token: SessionToken("previous-token")); #expect(service.resolvedAccount == "account") }
    let issue = Task { try await service.credential() }
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath["/v1/ai/installations"] != nil } }
    let bind = Task { try await service.bind(account: "account", token: SessionToken("account-token")) }
    await Task.yield()
    #expect(service.resolvedAccount == nil)
    #expect(CoachTestProtocol.state.withLock { $0.requests.map(\.path) } == ["/v1/ai/installations"])
    let secret = String(repeating: "a", count: 43)
    let issuer = try #require(CoachTestProtocol.state.withLock { $0.activeByPath["/v1/ai/installations"] })
    issuer.respond(201, try installationBody(credential: secret))
    #expect(try await issue.value == secret)
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath["/v1/ai/installations/bind"] != nil } }
    #expect(service.resolvedAccount == nil && credentials.value == secret)
    let binder = try #require(CoachTestProtocol.state.withLock { $0.activeByPath["/v1/ai/installations/bind"] })
    #expect(binder.request.value(forHTTPHeaderField: "X-Windmill-Installation") == secret)
    #expect(binder.request.value(forHTTPHeaderField: "Authorization") == "Bearer account-token")
    binder.respond(200, try installationBody().replacingOccurrences(of: "\"bound\":false", with: "\"bound\":true"))
    try await bind.value
    #expect(service.resolvedAccount == "account")
  }

  @Test func invalidOrUnreadableInstallationNeverCreatesAReplacementAndConflictKeepsAccountUsable() async throws {
    let credentials = InstallationMemoryStore(String(repeating: "a", count: 43)), service = installation(store: credentials)
    CoachTestProtocol.state.withLock { $0 = .init(reply: .http(401, "{\"code\":\"invalid_installation\"}")) }
    #expect(try await service.credential() == credentials.value)
    try await service.bind(account: "one", token: SessionToken("token"))
    #expect(service.resolvedAccount == "one")
    CoachTestProtocol.state.withLock { $0.reply = .http(401, "{\"code\":\"unauthenticated\"}") }
    await #expect(throws: AiRequestFailure.self) { try await service.bind(account: "unverified", token: SessionToken("bad-token")) }
    #expect(service.resolvedAccount == "one")
    credentials.unreadable = true
    await #expect(throws: AppFailure.self) { try await service.credential() }
    #expect(CoachTestProtocol.state.withLock { $0.requests.map(\.path) } == ["/v1/ai/installations/bind", "/v1/ai/installations/bind"])
    credentials.unreadable = false
    CoachTestProtocol.state.withLock { $0.reply = .http(409, "{\"code\":\"installation_bound\"}") }
    try await service.bind(account: "two", token: SessionToken("token-two"))
    #expect(service.resolvedAccount == "two" && credentials.value == String(repeating: "a", count: 43))
  }

  @Test func anonymousGoalCollectsChoicesWithoutSendingThenCommitsUsableRoutinesOnce() async throws {
    let (coach, cache) = try await anonymousCoach()
    defer { coach.work?.cancel(); try? FileManager.default.removeItem(at: cache.directory) }
    #expect(coach.allowed && coach.anonymous && coach.installationAllowance?.limit == "0.050000000")
    #expect(coach.chooseSetup(.goal)); coach.edit("Get stronger")
    coach.send()
    #expect(!coach.asking && coach.saved.onboarding == nil)
    let choices = try #require(coach.activeClarification)
    coach.select(choices.groups[0].options[2], in: choices.groups[0], clarification: choices)
    coach.select(choices.groups[1].options[0], in: choices.groups[1], clarification: choices)
    #expect(coach.saved.text == "Get stronger" && !coach.asking)
    coach.send()
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/coach/onboarding"] != nil } }
    let record = try #require(coach.anonymousRequest)
    #expect(record.request.mode == "goal" && record.request.daysPerWeek == 3 && record.request.equipment == "gym")
    let call = try #require(CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/coach/onboarding"] })
    #expect(call.request.value(forHTTPHeaderField: "Authorization") == nil)
    call.respond(200, try onboardingResponse(record.request))
    await coach.work?.value
    #expect(coach.anonymousRequest?.results.count == 1)
    let routine = try #require(coach.gym.routines.first)
    #expect(routine.name == "Upper" && routine.entries == [RoutineEntry(exerciseId: ID("bench-press"), sets: [SetTarget(reps: 8)], restSeconds: 120)])
    let restored = CoachConversation(gym: coach.gym, store: cache)
    await restored.activate()
    #expect(restored.saved.onboarding == coach.saved.onboarding && restored.gym.routines.count == 1)
    #expect(coach.saved.setupChoice == nil && coach.saved.text.isEmpty)
    var completed = try #require(coach.anonymousRequest); completed.results = []
    #expect(coach.chooseSetup(.goal)); coach.edit("Get stronger")
    let revised = try #require(coach.activeClarification)
    coach.select(revised.groups[0].options[3], in: revised.groups[0], clarification: revised)
    coach.select(revised.groups[1].options[0], in: revised.groups[1], clarification: revised)
    try coach.importOnboarding(completed, owner: #require(coach.owner), generation: coach.workGeneration)
    #expect(coach.saved.text == "Get stronger" && coach.saved.choices?.groups["days"] == ["4"])
    coach.gym.startWorkout(routineId: routine.id)
    #expect(coach.gym.openSession != nil && coach.gym.isAnonymous)
  }

  @Test func stoppedAnonymousRequestKeepsIdentityAndEditedDraftAndCannotImportIntoAnotherSeat() async throws {
    let (coach, cache) = try await anonymousCoach()
    defer { coach.work?.cancel(); try? FileManager.default.removeItem(at: cache.directory) }
    #expect(coach.chooseSetup(.describe)); coach.edit("Bench press 3 by 8")
    coach.send()
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/coach/onboarding"] != nil } }
    let record = try #require(coach.anonymousRequest), oldWork = coach.work
    coach.stopOnboarding(); await oldWork?.value
    coach.edit("New unsent program")
    #expect(coach.anonymousRequest?.stopped == true && coach.gym.routines.isEmpty)
    let restored = CoachConversation(gym: coach.gym, store: cache)
    await restored.activate()
    #expect(!restored.asking && restored.saved.text == "New unsent program" && restored.anonymousRequest?.id == record.id)
    restored.send()
    try await settle { CoachTestProtocol.state.withLock { $0.requests.filter { $0.path == "/v1/gym/coach/onboarding" }.count == 2 } }
    #expect(restored.anonymousRequest?.id == record.id)
    let call = try #require(CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/coach/onboarding"] })
    restored.gym.accountChanging = true
    call.respond(200, try onboardingResponse(record.request))
    await restored.work?.value
    #expect(restored.gym.routines.isEmpty && restored.saved.text == "New unsent program")
  }

  @Test func localSaveFailureKeepsCompletedResponseAndRetriesWithoutProviderDispatch() async throws {
    let fault = GymStoreFault()
    let (coach, cache) = try await anonymousCoach(fault: fault)
    defer { coach.work?.cancel(); try? FileManager.default.removeItem(at: cache.directory) }
    #expect(coach.chooseSetup(.describe)); coach.edit("Bench press 3 by 8"); coach.send()
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/coach/onboarding"] != nil } }
    let record = try #require(coach.anonymousRequest)
    fault.point.withLock { $0 = .beforeCommit(.commit) }
    let call = try #require(CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/coach/onboarding"] })
    call.respond(200, try onboardingResponse(record.request))
    await coach.work?.value
    #expect(coach.gym.routines.isEmpty && coach.anonymousRequest?.results == [])
    #expect(coach.anonymousRequest?.response?.status == "completed" && coach.saved.text == "Bench press 3 by 8")
    fault.point.withLock { $0 = nil }
    coach.retry(); await coach.work?.value
    #expect(coach.gym.routines.count == 1 && coach.anonymousRequest?.results.count == 1)
    #expect(CoachTestProtocol.state.withLock { $0.requests.filter { $0.path == "/v1/gym/coach/onboarding" }.count } == 1)
  }

  @Test func knownInputRefusalAllowsEditedSubmissionAndAdoptionKeepsAllLocalDrafts() async throws {
    let (coach, cache) = try await anonymousCoach()
    defer { coach.work?.cancel(); try? FileManager.default.removeItem(at: cache.directory) }
    CoachTestProtocol.state.withLock { $0.replies["/v1/gym/coach/onboarding"] = .http(400, "{\"code\":\"invalid_input\"}") }
    #expect(coach.chooseSetup(.describe)); coach.edit("Program one"); coach.send(); await coach.work?.value
    let first = try #require(coach.anonymousRequest?.id)
    #expect(coach.anonymousRequest?.refusalCode == "invalid_input" && !coach.anonymousRetryable)
    coach.edit("Program two"); coach.send(); await coach.work?.value
    #expect(coach.anonymousRequest?.id != first && coach.saved.text == "Program two")
    var account = CoachSaved(); account.text = "Existing account draft"
    try cache.write(account, account: "account")
    try cache.adopt(from: #require(coach.owner), account: "account", discard: false)
    let adopted = try cache.read("account")
    #expect(adopted.text == "Existing account draft" && adopted.phoneDrafts == [CoachPhoneDraft(text: "Program two", photo: nil, photoData: nil, setupChoice: .describe)])
    #expect(adopted.onboarding == coach.saved.onboarding)
    try cache.write(coach.saved, account: #require(coach.owner))
    try cache.adopt(from: #require(coach.owner), account: "account", discard: false)
    #expect(try cache.read("account").phoneDrafts == adopted.phoneDrafts)
  }
}

extension CoachTests {
  @Test func anonymousPhotoAndAccountAdoption() async throws {
    guard let sessionPath = ProcessInfo.processInfo.environment["WM_ANONYMOUS_COACH_SESSION"] else {
      let (coach, cache) = try await anonymousCoach()
      defer { coach.work?.cancel(); try? FileManager.default.removeItem(at: cache.directory) }
      #expect(coach.chooseSetup(.screenshot))
      try coach.addPhoto(#require(UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in UIColor.white.setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 20, height: 20)) }.pngData()))
      coach.send()
      try await settle { CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/coach/onboarding"] != nil } }
      let request = try #require(coach.anonymousRequest?.request)
      #expect(request.mode == "photo" && request.image != nil)
      let call = try #require(CoachTestProtocol.state.withLock { $0.activeByPath["/v1/gym/coach/onboarding"] })
      call.respond(200, try onboardingResponse(request)); await coach.work?.value
      #expect(coach.gym.routines.count == 1)
      try cache.adopt(from: #require(coach.owner), account: "photo-account", discard: false)
      #expect(try cache.read("photo-account").onboarding == coach.saved.onboarding)
      return
    }
    let server = try #require(ProcessInfo.processInfo.environment["WM_ANONYMOUS_COACH_SERVER"])
    let values = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sessionPath))) as? [String: String])
    let account = try #require(values["account"]), token = try #require(values["token"])
    let directory = FileManager.default.temporaryDirectory.appending(path: "anonymous-coach-" + UUID().uuidString)
    let service = ProcessInfo.processInfo.environment["WM_ANONYMOUS_COACH_KEYCHAIN"] ?? "works.windmill.anonymous-coach-test." + UUID().uuidString
    let runtime = try AppRuntime(settings: AppSettings(arguments: ["app", "-server", server]), directory: directory, service: service)
    let preferences = try #require(UserDefaults(suiteName: service))
    let model = try AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime)
    let coach = CoachConversation(gym: model.gym)
    await runtime.engine.start()
    await coach.activate()
    let owner = try #require(coach.owner)
    defer {
      coach.work?.cancel(); model.gym.stop(); preferences.removePersistentDomain(forName: service)
      try? FileManager.default.removeItem(at: directory)
      try? FileManager.default.removeItem(at: coach.store.file(owner))
      try? FileManager.default.removeItem(at: coach.store.file(account))
    }
    #expect(coach.chooseSetup(.goal)); coach.edit("Get stronger with a short full gym routine")
    let choices = try #require(coach.activeClarification)
    coach.select(choices.groups[0].options[2], in: choices.groups[0], clarification: choices)
    coach.select(choices.groups[1].options[0], in: choices.groups[1], clarification: choices)
    coach.send(); await coach.work?.value
    let goal = try #require(coach.anonymousRequest)
    #expect(!goal.results.isEmpty && model.gym.isAnonymous)
    let count = model.gym.routines.count
    #expect(coach.chooseSetup(.screenshot))
    let photo = UIGraphicsImageRenderer(size: CGSize(width: 480, height: 240)).image { context in
      UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 480, height: 240))
      ("Bench press 3 x 8\nSquat 3 x 5" as NSString).draw(at: CGPoint(x: 25, y: 25), withAttributes: [.font: UIFont.systemFont(ofSize: 30), .foregroundColor: UIColor.black])
    }
    try coach.addPhoto(#require(photo.pngData())); coach.send(); await coach.work?.value
    #expect(coach.anonymousRequest?.request.mode == "photo" && coach.anonymousRequest?.results.isEmpty == false)
    #expect(model.gym.routines.count > count)
    let routine = try #require(model.gym.routines.first)
    model.gym.startWorkout(routineId: routine.id)
    #expect(model.gym.openSession != nil && model.gym.account == nil)
    await model.gym.workout.finish()
    let expected = coach.saved.onboarding
    try await model.signIn(AuthIdentity(account: account, token: SessionToken(token), name: "Fixture"))
    for _ in 0..<4 where model.signInPending { await model.adopt(.add) }
    model.refresh()
    #expect(model.account == account && !model.signInPending)
    #expect(runtime.installation.resolvedAccount == account)
    #expect(try coach.store.read(account).onboarding == expected)
    #expect(!model.gym.routines.isEmpty)
    let credential = try await runtime.installation.credential()
    let current = try await runtime.installation.request("/v1/ai/installations/current", credential: credential)
    #expect(try JSONDecoder().decode(AiInstallation.State.self, from: current).bound)
  }
}
