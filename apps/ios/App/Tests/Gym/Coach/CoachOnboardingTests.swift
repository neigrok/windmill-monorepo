import Foundation
import Testing
import UIKit
import DomainKit
import GymDomain
import SyncCore
import SyncEngine
import SyncSchema
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
  func anonymousCoach() async throws -> (CoachConversation, CoachDraftStore) {
    CoachTestProtocol.state.withLock { $0 = .init(reply: .stalled) }
    let service = installation(store: InstallationMemoryStore(String(repeating: "a", count: 43)))
    let runtime = try GymModelTests().runtime(installation: service)
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    let cache = store()
    let coach = CoachConversation(gym: gym, store: cache)
    await coach.activate()
    return (coach, cache)
  }
  func onboardingRecord(_ id: String, response: String) throws -> CoachOnboardingRecord {
    var record = CoachOnboardingRecord(request: CoachOnboardingIn(requestId: id, mode: "conversation", text: "Make Push A harder"))
    record.response = try JSONDecoder().decode(CoachOnboardingOut.self, from: Data(response.utf8))
    return record
  }

  @Test func installationOnboardingCarriesTheGeneratedSchemaAndKeepsUpgradeRefusal() async throws {
    #expect(CoachCopy.refusal("client-update-required") == "Update Windmill to keep using Gym.")
    let service = installation(store: InstallationMemoryStore())
    for path in ["/v1/gym/coach/onboarding", "/v1/gym/coach/onboarding/fixture"] {
      CoachTestProtocol.state.withLock { $0 = .init(reply: .http(426, #"{"code":"client-update-required","error":"Update Windmill to keep using Gym."}"#)) }
      do { _ = try await service.request(path); Issue.record("Expected update refusal") }
      catch let failure as AiRequestFailure { #expect(failure.status == 426) }
      #expect(CoachTestProtocol.state.withLock { $0.requests.map(\.schema) } == [String(SyncSchema.version)])
    }
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

  // An archived signed-out answer that needed an account offers Sign in while signed out and newest; adopted into an
  // account, it offers nothing, and a spent signed-out allowance is said only while signed out.
  @Test func archivedSignedOutAnswersOfferSignInAndSayTheirAllowanceOnlyWhileSignedOut() async throws {
    let allowance = #""allowance":{"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"limit":"0.05","used":"0.01","reserved":"0","remaining":"0.04","resetsAtMs":null,"budgetResetsAtMs":null}"#
    let needs = try onboardingRecord("onb-2", response: #"{"requestId":"onb-2","resultId":"r2","status":"completed","expiresAtMs":1900000000000,"routines":[],"errorCode":null,"message":"Sign in, then ask again.","needsAccount":true,"#+allowance+"}")
    let earlier = try onboardingRecord("onb-1", response: #"{"requestId":"onb-1","resultId":"r1","status":"completed","expiresAtMs":1900000000000,"routines":[],"errorCode":null,"message":"Sign in first.","needsAccount":true,"#+allowance+"}")
    let spent = #"{"code":"subject_exhausted","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"limit":"0.05","used":"0.05","reserved":"0","remaining":"0","resetsAtMs":null,"budgetResetsAtMs":null}"#
    let refused = try onboardingRecord("onb-3", response: #"{"requestId":"onb-3","resultId":"r3","status":"failed","expiresAtMs":1900000000000,"routines":[],"errorCode":"subject_exhausted","allowance":"#+spent+"}")
    let (anonymous, anonymousCache) = try await anonymousCoach()
    defer { try? FileManager.default.removeItem(at: anonymousCache.directory) }
    var next = anonymous.saved; next.onboarding = [earlier, needs]; #expect(anonymous.keep(next, failure: "x"))
    #expect([anonymous.offersSignIn(earlier), anonymous.offersSignIn(needs)] == [false, true])
    let spentAllowance = try JSONDecoder().decode(AiAllowance.self, from: Data(spent.utf8))
    #expect(anonymous.spentAllowance(needs) == nil && anonymous.spentAllowance(refused) == spentAllowance)
    let (gym, _, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let account = CoachConversation(gym: gym, store: cache); await account.activate()
    var adopted = account.saved; adopted.onboarding = [earlier, needs, refused]; #expect(account.keep(adopted, failure: "x"))
    #expect([account.offersSignIn(earlier), account.offersSignIn(needs)] == [false, false] && account.spentAllowance(refused) == nil)
  }

  // Apply on an archived answer replays by its result: a retry returns the routines it made, and an answer an earlier
  // version imported under the single receipt links its routines without making them again.
  @Test func applyReplaysByResultAndKeepsAnswersImportedUnderTheEarlierReceipt() async throws {
    let allowance = #""allowance":{"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"limit":"0.05","used":"0.01","reserved":"0","remaining":"0.04","resetsAtMs":null,"budgetResetsAtMs":null}"#
    let routines = #""routines":[{"name":"Upper","entries":[{"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":null}],"restSeconds":90}]}]"#
    let fresh = try onboardingRecord("onb-1", response: #"{"requestId":"onb-1","resultId":"r1","status":"completed","expiresAtMs":1900000000000,"#+routines+#","errorCode":null,"#+allowance+"}")
    let earlier = try onboardingRecord("onb-2", response: #"{"requestId":"onb-2","resultId":"r2","status":"completed","expiresAtMs":1900000000000,"#+routines+#","errorCode":null,"#+allowance+"}")
    let (coach, cache) = try await anonymousCoach()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let receipt: JSON = ["onb-2": ["resultId": "r2", "routines": ["routine-earlier"]]]
    _ = try coach.gym.runner.run(WriteDeviceRow(key: ImportCoachRoutineBatch.earlierReceiptKey, value: receipt))
    var next = coach.saved; next.onboarding = [fresh, earlier]; #expect(coach.keep(next, failure: "x"))
    #expect(coach.saveRoutines("onb-1") == .saved)
    #expect(coach.saveRoutines("onb-2") == .saved)
    let drawn = try coach.gym.runner.read(Gym.scope) { try $0.repository(Routine.self).all(in: .stored) }
    #expect(drawn.map(\.name) == ["Upper"])
    let made = try #require(drawn.first?.id.description)
    let made1 = CoachResult(kind: "routine-created", operationId: "r1-0", routineId: made, routineName: "Upper", movementCount: 1)
    let linked = CoachResult(kind: "routine-created", operationId: "r2-0", routineId: "routine-earlier", routineName: "Upper", movementCount: 1)
    let results = coach.saved.onboarding?.map(\.results)
    #expect(results == [[made1], [linked]])
    let replayed = try #require(coach.saved.onboarding?.first)
    try coach.importOnboarding(replayed, owner: try #require(coach.owner))
    let after = try coach.gym.runner.read(Gym.scope) { try $0.repository(Routine.self).all(in: .stored) }
    #expect(after.map(\.id) == drawn.map(\.id))
    #expect(coach.saved.onboarding?.first?.results == [made1])
  }
}

struct WriteDeviceRow: Action {
  let key: String
  let value: JSON
  var scope: ScopeRef { Gym.scope }
  func load(_ read: Reader) throws {}
  func decide(_ loaded: Void, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    var plan = Plan()
    plan.device(key, value)
    return .write(plan)
  }
}
