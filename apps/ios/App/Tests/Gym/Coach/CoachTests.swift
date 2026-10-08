import Foundation
import Observation
import Testing
import UIKit
import SwiftUI
import Synchronization
import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import SyncSchema
import SyncEngine
import enum SyncEngine.Reply
import SyncModelServer
@testable import Windmill

@Suite(.serialized) @MainActor struct CoachTests {
  @Test func dynamicPaletteResolvesOnAccessibilityBackgroundThread() async {
    let colours = [CoachPalette.canvas, CoachPalette.surface, CoachPalette.onAccent, CoachPalette.accent].map { UIColor($0) }
    let result = await Task.detached { @Sendable in
      let onMain = ({ @Sendable in Thread.isMainThread })()
      let values = colours.map { colour -> UInt32? in
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard colour.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)).getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha == 1 else { return nil }
        return UInt32((red * 255).rounded()) << 16 | UInt32((green * 255).rounded()) << 8 | UInt32((blue * 255).rounded())
      }
      return (onMain, values)
    }.value
    #expect(!result.0)
    #expect(result.1 == [0x0b1111, 0x161c1d, 0x0b1111, 0x5fcdb4])
  }

  func fixture() -> (Harness, GymModel) {
    let h = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: "coach-owner",
                    rules: ComposedServerRules.windmill(registry: SyncSchema.registry), commandResultWrites: AppRuntime.commandResultWrites)
    let gym = GymModel(runner: h.runner); gym.account = "coach-owner"
    return (h, gym)
  }
  func snapshot(request: String = "request-123", thread: String = "thread-123", revision: Int = 1,
                status: String = "running", answer: String = "Partial") throws -> CoachSnapshot {
    let value: [String: Any] = ["thread": thread, "generation": ["id": "generation-123", "requestId": request,
      "question": "Private question", "status": status, "revision": revision, "answer": answer,
      "results": [["kind": "routine-created", "operationId": "operation-123", "routineId": "routine-123", "routineName": "Private routine"]]]]
    return try JSONDecoder().decode(CoachSnapshot.self, from: JSONSerialization.data(withJSONObject: value))
  }
  func store() -> CoachDraftStore { CoachDraftStore(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)) }
  func authed(_ reply: CoachTestProtocol.Reply) async throws -> (GymModel, GymRESTClient, TelemetryRecorder) {
    let telemetry = TelemetryRecorder(), transport = JournalModelTransport()
    let runtime = try GymModelTests().runtime(telemetry: telemetry, transport: transport)
    let identity = transport.identity(email: "coach-test@example.com")
    _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry)
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CoachTestProtocol.self]
    CoachTestProtocol.state.withLock { $0 = .init(reply: reply) }
    return (gym, GymRESTClient(runtime: runtime, telemetry: telemetry, session: URLSession(configuration: config)), telemetry)
  }

  func snapshotEvent(status: String, revision: Int, answer: String) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: ["thread": "thread-123", "generation": ["id": "generation-123",
      "requestId": "request-123", "question": "private question", "status": status, "revision": revision, "answer": answer]])
    return "event: snapshot\ndata: " + String(decoding: data, as: UTF8.self) + "\n\n"
  }

  @Test func largeSnapshotsValidateCredentialsPerEvent() async throws {
    let answer = String(repeating: "private answer ", count: 2_048)
    let stream = try snapshotEvent(status: "running", revision: 1, answer: answer) + snapshotEvent(status: "completed", revision: 2, answer: answer)
    let (_, original, telemetry) = try await authed(.http(200, stream, "text/event-stream"))
    let base = try #require(original.runtime), tokens = CoachCountingTokenStore(base.tokens)
    let runtime = AppRuntime(settings: base.settings, store: base.store, engine: base.engine, auth: base.auth,
      runner: base.runner, tokens: tokens, revocations: base.revocations, telemetry: telemetry)
    let rest = GymRESTClient(runtime: runtime, telemetry: telemetry, session: original.session)
    var received: [CoachSnapshot] = []
    let data = try await rest.coachRequest("/v1/gym/ask") { received.append($0) }
    #expect(data.isEmpty && received.map(\.generation.revision) == [1, 2])
    #expect(received.map(\.generation.answer) == [answer, answer])
    #expect(received.map(\.generation.terminal) == [false, true])
    #expect(tokens.reads.withLock { $0 } <= 8)
    #expect(CoachTestProtocol.state.withLock { $0.requests.count } == 1 && rest.tasks.isEmpty)
    #expect(telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_rest" }.isEmpty })
  }

  @Test(arguments: ["token", "account", "cancel", "blocked"], [false, true])
  func invalidatedStreamRejectsLaterEventsAndCompletion(change: String, afterTerminal: Bool) async throws {
    let stream = try (afterTerminal ? "" : snapshotEvent(status: "running", revision: 1, answer: "private partial")) +
      snapshotEvent(status: "completed", revision: 2, answer: "private final")
    let (_, rest, telemetry) = try await authed(.http(200, stream, "text/event-stream"))
    let runtime = try #require(rest.runtime), owner = try #require(try runtime.account())
    var received: [CoachSnapshot] = []
    do {
      _ = try await rest.coachRequest("/v1/gym/ask") { value in
        received.append(value)
        switch change {
        case "token": try runtime.tokens.save(SessionToken("changed-private-token"), for: owner)
        case "account":
          _ = try runtime.store.signOut(choice: .keep, counted: nil, identities: Identities(random: SystemRandom()))
          #expect(try runtime.account() == nil)
        case "cancel": rest.cancel()
        default: rest.blocked = true
        }
      }
      Issue.record("Expected invalidated stream cancellation")
    } catch { #expect(error is CancellationError || (error as? URLError)?.code == .cancelled) }
    #expect(received.map(\.generation.revision) == [afterTerminal ? 2 : 1])
    #expect(received.map(\.generation.answer) == [afterTerminal ? "private final" : "private partial"])
    #expect(rest.tasks.isEmpty)
    #expect(telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_rest" }.isEmpty })
  }

  @Test func truncatedTerminalEventKeepsOnlyTheCompleteSnapshot() async throws {
    let stream = try snapshotEvent(status: "running", revision: 1, answer: "private partial") +
      snapshotEvent(status: "completed", revision: 2, answer: "private final").dropLast()
    let (_, rest, telemetry) = try await authed(.http(200, stream, "text/event-stream"))
    var received: [CoachSnapshot] = []
    do {
      _ = try await rest.coachRequest("/v1/gym/ask") { received.append($0) }
      Issue.record("Expected truncated stream failure")
    } catch { #expect((error as? URLError)?.code == .networkConnectionLost) }
    #expect(received.map(\.generation.revision) == [1] && received.map(\.generation.answer) == ["private partial"])
    #expect(rest.tasks.isEmpty)
    let entries = telemetry.entries.withLock { $0.filter { $0.properties["operation"] == "gym_rest" } }
    #expect(entries.map(\.name) == ["api_request_failed"])
    #expect(entries.first?.properties == ["operation": "gym_rest", "route": "/v1/gym", "method": "GET", "failure_kind": "offline"])
    #expect(!entries.flatMap { $0.properties.values }.contains { $0.contains("private") })
  }

  func settle(_ condition: () -> Bool) async throws {
    for _ in 0..<200 { if condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
    Issue.record("Asynchronous Coach work did not settle")
  }
  func expectProposal(_ actual: Proposal?, equals expected: Proposal) throws {
    let actual = try #require(actual)
    #expect(actual.id == expected.id && actual.fields == expected.fields)
    #expect(actual.state == expected.state && actual.settledAt == expected.settledAt)
    #expect(actual.supersededBy == expected.supersededBy && actual.baseRevision == expected.baseRevision)
    #expect(actual.baseName == expected.baseName && actual.changeCount == expected.changeCount && actual.threadId == expected.threadId)
  }
  @Test func transportTimeoutOfflineAndHTTPRefusalReportWithoutContent() async throws {
    for reply in [CoachTestProtocol.Reply.failure(.timedOut), .failure(.notConnectedToInternet), .http(429, #"{"code":"ask-image-busy","error":"private server refusal"}"#)] {
      let (_, rest, telemetry) = try await authed(reply)
      do { _ = try await rest.coachRequest("/v1/oauth/grants"); Issue.record("Expected transport failure") }
      catch { if let failure = error as? GymRESTFailure { #expect(failure.message == "private server refusal") } }
      let entries = telemetry.entries.withLock { $0 }
      #expect(entries.filter { $0.name == "api_request_failed" }.count == 1)
      #expect(!entries.flatMap { $0.properties.values }.contains { $0.contains("private") })
      #expect(rest.tasks.isEmpty)
    }
  }
  @Test func changedEngineAccountCannotSendAnotherOwnersDraft() async throws {
    let (_, rest, _) = try await authed(.http(200, "{}"))
    do {
      _ = try await rest.coachRequest("/v1/gym/ask", method: "POST", body: Data("Private question".utf8), expectedAccount: "different-account")
      Issue.record("Expected account cancellation")
    } catch { #expect(error is CancellationError) }
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty } && rest.tasks.isEmpty)
  }
  @Test func cancellingStalledStreamReleasesRequestAndKeepsDraft() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); coach.edit("A private draft"); coach.send()
    try await settle { CoachTestProtocol.state.withLock { !$0.requests.isEmpty } }
    let request = try #require(coach.saved.request)
    coach.work?.cancel(); try await settle { !coach.asking }
    #expect(coach.error == CoachCopy.interrupted && coach.retryable && rest.tasks.isEmpty)
    #expect(try cache.read(gym.account!).request == request)
    gym.account = "other-account"; await coach.activate()
    #expect(coach.saved.request == nil && coach.saved.text.isEmpty)
  }
  @Test func interruptedStreamRetriesTheSameDurablePayload() async throws {
    let (gym, rest, _) = try await authed(.failure(.networkConnectionLost)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); coach.edit("Private question"); coach.send()
    await coach.work?.value; #expect(!coach.asking)
    let request = try #require(coach.saved.request)
    let first = try #require(CoachTestProtocol.state.withLock { $0.requests.first?.body })
    let terminal = try JSONSerialization.data(withJSONObject: ["thread": request.thread, "generation": ["id": "generation-123", "requestId": request.requestId, "question": request.question, "revision": 3, "status": "completed", "answer": "Final"]])
    CoachTestProtocol.state.withLock { $0.reply = .http(200, "event: snapshot\ndata: " + String(decoding: terminal, as: UTF8.self) + "\n\n", "text/event-stream") }
    coach.retry(); await coach.work?.value; #expect(!coach.asking)
    #expect(coach.activeGeneration?.answer == "Final" && coach.saved.text.isEmpty)
    let bodies = CoachTestProtocol.state.withLock { $0.requests.compactMap(\.body) }
    #expect(bodies.count == 2)
    for body in bodies { #expect(try JSONDecoder().decode(CoachSaved.Request.self, from: body) == JSONDecoder().decode(CoachSaved.Request.self, from: first)) }
    #expect(coach.saved.request == request)
  }
  @Test(arguments: ["unchanged", "text", "photo", "removed-photo"])
  func sendAfterLostResponseReusesRequestOnlyForUnchangedInput(change: String) async throws {
    let (gym, rest, _) = try await authed(.failure(.networkConnectionLost)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); coach.edit("  Private question  ")
    let photo = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in }.pngData()!
    if change == "removed-photo" { try coach.addPhoto(photo) }
    coach.send()
    let firstWork = try #require(coach.work)
    await firstWork.value
    #expect(!coach.asking)
    let first = try #require(coach.saved.request)
    if change == "text" { coach.edit("Another question") }
    if change == "photo" { try coach.addPhoto(photo) }
    if change == "removed-photo" { coach.removePhoto() }
    coach.send()
    let secondWork = try #require(coach.work)
    await secondWork.value
    #expect(!coach.asking)
    let second = try #require(coach.saved.request)
    #expect((second.requestId == first.requestId) == (change == "unchanged"))
    #expect(second.thread == first.thread)
    #expect(second.question == (change == "text" ? "Another question" : "Private question"))
    #expect(second.attachmentIds == (coach.saved.photo.map { [$0.id] } ?? []))
    #expect(try cache.read(gym.account!).request == second)
  }

  @Test(arguments: [false, true])
  func delayedStopCannotReplaceOrCancelNewerWork(retrySameRequest: Bool) async throws {
    let (gym, rest, _) = try await authed(.failure(.networkConnectionLost)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); coach.edit("First question"); coach.send(); await coach.work?.value; #expect(!coach.asking)
    let first = try #require(coach.saved.request)
    CoachTestProtocol.state.withLock { $0.reply = .stalled }
    coach.stopResponse()
    let stopPath = "/v1/gym/threads/\(first.thread)/generations/\(first.requestId)/stop"
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath[stopPath] != nil } }
    let stoppedCall = try #require(CoachTestProtocol.state.withLock { $0.activeByPath[stopPath] })
    let stopWork = try #require(coach.stopWork)
    if retrySameRequest { coach.retry() } else { coach.edit("Second question"); coach.send() }
    try await settle { CoachTestProtocol.state.withLock { $0.requests.count >= 3 && $0.activeByPath["/v1/gym/ask"] != nil } }
    let second = try #require(coach.saved.request)
    let activeWork = try #require(coach.work)
    defer { activeWork.cancel() }
    let terminal = try JSONSerialization.data(withJSONObject: ["thread": first.thread, "generation": ["id": "old-generation", "requestId": first.requestId, "question": first.question, "status": "stopped", "revision": 10]])
    stoppedCall.respond(200, String(decoding: terminal, as: UTF8.self))
    await stopWork.value
    #expect(!coach.stopping)
    #expect(coach.saved.request == second && coach.saved.text == second.question)
    #expect(coach.activeGeneration == nil && coach.error == nil)
    #expect(coach.asking && coach.work != nil && !activeWork.isCancelled)
    #expect(try cache.read(gym.account!).request == second)
    activeWork.cancel(); try await settle { !coach.asking }
  }

  @Test(arguments: ["new-chat", "draft", "send", "photo", "remove-photo"])
  func delayedConversationReadCannotOverwriteNewerInput(change: String) async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); coach.edit("Current draft")
    let photo = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in }.pngData()!
    if change == "remove-photo" { try coach.addPhoto(photo) }
    let opening = Task { await coach.open("historic-thread") }
    let path = "/v1/gym/threads/historic-thread"
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath[path] != nil } }
    let call = try #require(CoachTestProtocol.state.withLock { $0.activeByPath[path] })
    if change == "new-chat" { #expect(coach.newChat(seed: "Fresh draft")) }
    if change == "draft" { coach.edit("Changed draft") }
    if change == "send" { coach.send() }
    if change == "photo" { try coach.addPhoto(photo) }
    if change == "remove-photo" { coach.removePhoto() }
    let expected = coach.saved
    call.respond(200, #"{"id":"historic-thread","turns":[{"position":1,"from":"lifter","text":"Old conversation"}]}"#)
    await opening.value
    #expect(coach.saved.threadId == expected.threadId && coach.saved.text == expected.text)
    #expect(coach.saved.request == expected.request && coach.saved.photo == expected.photo && coach.saved.photoData == expected.photoData)
    #expect(coach.saved.thread == expected.thread && coach.error == nil && !coach.reading)
    let durable = try cache.read(gym.account!)
    #expect(durable.threadId == expected.threadId && durable.text == expected.text && durable.request == expected.request)
    if change == "send" { #expect(coach.asking); coach.work?.cancel(); try await settle { !coach.asking } }
  }

  @Test(arguments: [200, 404])
  func deletingActiveConversationClearsItsCacheButKeepsDraftAcrossRelaunch(status: Int) async throws {
    let (gym, rest, _) = try await authed(.http(status, status == 404 ? #"{"error":"Gone"}"# : "{}")), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate()
    let request = CoachSaved.Request(thread: "thread-123", question: "Private question", requestId: "request-123", attachmentIds: [])
    var saved = coach.saved; saved.threadId = request.thread; saved.request = request
    saved.thread = try JSONDecoder().decode(CoachThread.self, from: Data(#"{"id":"thread-123","turns":[{"position":1,"from":"coach","text":"Deleted answer"}]}"#.utf8))
    saved.generation = try snapshot(status: "completed", answer: "Deleted answer").generation
    saved.exchanges = [try snapshot(status: "failed").generation]
    saved.text = "Unrelated unsent draft"
    saved.photo = CoachAttachment(id: "draft-photo", mediaType: "image/png", width: 1, height: 1, bytes: 1); saved.photoData = Data([1])
    #expect(coach.keep(saved, failure: "failure"))
    let history = CoachHistory(gym: gym, rest: rest)
    _ = CoachHistoryScreen(gym: gym, coach: coach, history: history)
    let row = try #require(saved.thread)
    history.rows = [row]; history.remove(row)
    let deleting = try #require(history.held.first?.task)
    await deleting.value
    #expect(history.held.isEmpty && rest.tasks.isEmpty)
    #expect(history.rows.isEmpty && history.error == nil)
    #expect(coach.saved.threadId != row.id && coach.saved.thread == nil && coach.saved.request == nil && coach.saved.generation == nil && coach.saved.exchanges.isEmpty)
    #expect(coach.saved.text == saved.text && coach.saved.photo == saved.photo && coach.saved.photoData == saved.photoData)
    let relaunched = CoachConversation(gym: gym, rest: rest, store: cache); await relaunched.activate()
    #expect(relaunched.saved.threadId != row.id && relaunched.saved.thread == nil && relaunched.saved.request == nil && relaunched.saved.generation == nil && relaunched.saved.exchanges.isEmpty)
    #expect(relaunched.saved.text == saved.text && relaunched.saved.photo == saved.photo && relaunched.saved.photoData == saved.photoData)
    #expect(CoachTestProtocol.state.withLock { $0.requests.map(\.method) } == ["DELETE"])
  }

  @Test(arguments: [200, 404], [false, true])
  func acknowledgedHistoryDeleteClearsCapturedCacheDuringTransitionWithoutChangingAnotherOwner(status: Int, changedOwner: Bool) async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let account = try #require(gym.account)
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate()
    let row = try JSONDecoder().decode(CoachThread.self, from: Data(#"{"id":"thread-123","turns":[{"position":1,"from":"coach","text":"Deleted answer"}]}"#.utf8))
    var original = coach.saved; original.threadId = row.id; original.thread = row
    original.request = CoachSaved.Request(thread: row.id, question: "Private question", requestId: "request-123", attachmentIds: [])
    original.generation = try snapshot(status: "completed").generation; original.exchanges = [try snapshot(status: "failed").generation]
    original.text = "Old account unsent draft"
    original.photo = CoachAttachment(id: "old-photo", mediaType: "image/png", width: 1, height: 1, bytes: 1); original.photoData = Data([1])
    #expect(coach.keep(original, failure: "failure"))
    let history = CoachHistory(gym: gym, rest: rest)
    _ = CoachHistoryScreen(gym: gym, coach: coach, history: history)
    history.rows = [row]; history.remove(row)
    let deleting = try #require(history.held.first?.task)
    try await Task.sleep(for: .seconds(9.1))
    let path = "/v1/gym/threads/thread-123"
    try await settle { CoachTestProtocol.state.withLock { $0.activeByPath[path] != nil } }
    let call = try #require(CoachTestProtocol.state.withLock { $0.activeByPath[path] })
    if changedOwner {
      gym.account = "next-coach-owner"; await coach.activate(); coach.edit("Another owner’s unsent draft")
      coach.error = "Another owner’s message"; coach.refusal = .fresh("Another owner’s refusal")
    } else { coach.edit("Latest old account unsent draft") }
    let latest = coach.saved, latestError = coach.error, latestRefusal = coach.refusal
    gym.accountTransition = true
    call.respond(status, status == 404 ? #"{"error":"Gone"}"# : "{}")
    await deleting.value
    #expect(history.error == nil && rest.tasks.isEmpty)
    let oldCache = try cache.read(account)
    #expect(oldCache.threadId != row.id && oldCache.thread == nil && oldCache.request == nil && oldCache.generation == nil && oldCache.exchanges.isEmpty)
    #expect(oldCache.text == (changedOwner ? original.text : latest.text) && oldCache.photo == original.photo && oldCache.photoData == original.photoData)
    if changedOwner {
      #expect(coach.saved.threadId == latest.threadId && coach.saved.text == latest.text && coach.saved.request == latest.request && coach.saved.thread == latest.thread)
      #expect(coach.error == latestError && coach.refusal == latestRefusal && coach.owner == "next-coach-owner")
      let newCache = try cache.read("next-coach-owner")
      #expect(newCache.threadId == latest.threadId && newCache.text == latest.text)
    } else {
      #expect(coach.saved.threadId == oldCache.threadId && coach.saved.text == latest.text && coach.saved.thread == nil && coach.saved.request == nil)
    }
    gym.accountTransition = false; gym.account = account
    let relaunched = CoachConversation(gym: gym, rest: rest, store: cache); await relaunched.activate()
    #expect(relaunched.saved.threadId == oldCache.threadId && relaunched.saved.thread == nil && relaunched.saved.request == nil && relaunched.saved.generation == nil)
    #expect(relaunched.saved.text == oldCache.text && relaunched.saved.photo == oldCache.photo && relaunched.saved.photoData == oldCache.photoData)
  }

  @Test func interruptedSnapshotSurvivesRestartAndContinuesSameRequest() async throws {
    let (gym, rest, _) = try await authed(.failure(.networkConnectionLost)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let first = CoachConversation(gym: gym, rest: rest, store: cache)
    await first.activate(); first.edit("Private question"); first.send(); await first.work?.value; #expect(!first.asking)
    let request = try #require(first.saved.request)
    func event(_ status: String, _ revision: Int, _ answer: String) throws -> String {
      let data = try JSONSerialization.data(withJSONObject: ["thread": request.thread, "generation": ["id": "generation-123", "requestId": request.requestId, "question": request.question, "status": status, "revision": revision, "answer": answer]])
      return "event: snapshot\r\ndata: " + String(decoding: data, as: UTF8.self) + "\r\n\r\n"
    }
    CoachTestProtocol.state.withLock { $0.reply = .http(200, try! event("running", 1, "Partial"), "text/event-stream") }
    first.retry(); await first.work?.value; #expect(!first.asking)
    #expect(first.activeGeneration?.answer == "Partial" && first.retryable)
    CoachTestProtocol.state.withLock { $0.reply = .http(200, try! event("completed", 2, "Recovered"), "text/event-stream") }
    let restarted = CoachConversation(gym: gym, rest: rest, store: cache); await restarted.activate()
    await restarted.work?.value; #expect(!restarted.asking)
    #expect(restarted.activeGeneration?.answer == "Recovered" && restarted.saved.request == request)
    let calls = CoachTestProtocol.state.withLock { $0.requests.compactMap(\.body) }
    #expect(calls.count == 3)
    for call in calls { #expect(try JSONDecoder().decode(CoachSaved.Request.self, from: call) == request) }
  }
  @Test func acceptedJSONSnapshotPollsSameRequestUntilTerminal() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate(); coach.edit("Private question"); coach.send()
    try await settle { CoachTestProtocol.state.withLock { $0.active != nil } }
    let request = try #require(coach.saved.request)
    let partial = try JSONSerialization.data(withJSONObject: ["thread": request.thread, "generation": ["id": "generation-123", "requestId": request.requestId, "question": request.question, "status": "running", "revision": 1, "answer": "Partial"]])
    CoachTestProtocol.state.withLock { $0.active }?.respond(202, String(decoding: partial, as: UTF8.self))
    try await settle { coach.activeGeneration?.answer == "Partial" }
    #expect(coach.asking && !coach.saved.text.isEmpty)
    let terminal = try JSONSerialization.data(withJSONObject: ["thread": request.thread, "generation": ["id": "generation-123", "requestId": request.requestId, "question": request.question, "status": "completed", "revision": 2, "answer": "Final"]])
    try await settle { CoachTestProtocol.state.withLock { $0.requests.count == 2 && $0.active != nil } }
    let poll = try #require(CoachTestProtocol.state.withLock { $0.requests.count == 2 ? $0.active : nil })
    poll.respond(200, String(decoding: terminal, as: UTF8.self))
    await coach.work?.value; #expect(!coach.asking)
    #expect(coach.activeGeneration?.answer == "Final" && coach.saved.text.isEmpty)
    #expect(CoachTestProtocol.state.withLock { $0.requests.count } == 2)
  }
  @Test func uploadCancellationRetainsNormalizedPhotoAndOnlyUsesBinaryDoor() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate()
    let data = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { _ in }.pngData()!
    try coach.addPhoto(data); coach.send()
    try await settle { coach.uploading && CoachTestProtocol.state.withLock { !$0.requests.isEmpty } }
    coach.stopResponse(); try await settle { !coach.asking }
    #expect(coach.saved.photo != nil && coach.saved.photoData != nil && coach.retryable)
    #expect(coach.error == "Upload cancelled. Retry to send this photo.")
    let call = try #require(CoachTestProtocol.state.withLock { $0.requests.first })
    #expect(call.method == "PUT" && call.mediaType == "image/png" && call.body == coach.saved.photoData)
    #expect(call.authorization?.hasPrefix("Bearer ") == true && !call.path.contains("ask"))
  }
  @Test func stopFailureDoesNotErasePartialTextOrCommittedResults() async throws {
    let (gym, rest, _) = try await authed(.failure(.notConnectedToInternet)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache)
    await coach.activate()
    let request = CoachSaved.Request(thread: "thread-123", question: "Private question", requestId: "request-123", attachmentIds: [])
    var next = coach.saved; next.threadId = request.thread; next.request = request; _ = coach.keep(next, failure: "failure")
    try coach.accept(snapshot(answer: "Durable partial"), request: request)
    coach.stopResponse(); await coach.stopWork?.value; #expect(!coach.stopping)
    #expect(coach.error == "The stop request didn’t reach Coach. Try again.")
    #expect(coach.activeGeneration?.answer == "Durable partial" && coach.activeGeneration?.results.count == 1)
    let call = try #require(CoachTestProtocol.state.withLock { $0.requests.first })
    #expect(call.path.hasSuffix("/generations/request-123/stop") && call.method == "POST" && call.body == nil)
  }
  @Test func historyDeleteUndoAndBackgroundNeverSendWithheldDelete() async throws {
    let (gym, rest, _) = try await authed(.http(200, #"{"threads":[{"id":"thread-123","title":"Private","askedAt":1000}]}"#))
    let history = CoachHistory(gym: gym, rest: rest); await history.load()
    let row = try #require(history.rows.first)
    history.remove(row); #expect(history.rows.isEmpty && history.held.count == 1)
    history.undo(row.id); #expect(history.rows.map(\.id) == [row.id] && history.held.isEmpty)
    history.remove(row); history.abandon()
    #expect(history.rows.map(\.id) == [row.id] && history.held.isEmpty)
    #expect(CoachTestProtocol.state.withLock { $0.requests.map(\.method) } == ["GET"])
  }
  @Test func failedHistoryDeleteRestoresRowAndPreservesServerRefusal() async throws {
    let (gym, rest, _) = try await authed(.http(409, #"{"error":"Another generation is still running"}"#))
    let history = CoachHistory(gym: gym, rest: rest)
    let row = try JSONDecoder().decode(CoachThread.self, from: Data(#"{"id":"thread-123","title":"Private","askedAt":1000}"#.utf8))
    history.rows = [row]; history.remove(row)
    let deleting = try #require(history.held.first?.task)
    await deleting.value
    #expect(history.error == "Another generation is still running" && history.rows.map(\.id) == [row.id])
    #expect(history.held.isEmpty)
  }
  @Test func capsAndAbsentDeploymentSurviveNewChatButFreshRefusalDoesNot() async throws {
    let (_, gym) = fixture(), coach = CoachConversation(gym: gym, store: store())
    defer { try? FileManager.default.removeItem(at: coach.store.directory) }
    await coach.activate()
    for refusal in [CoachRefusal.daily("Daily"), .ceiling("Ceiling"), .absent] {
      coach.refusal = refusal; coach.error = refusal.message; coach.newChat()
      #expect(!coach.canCompose && coach.refusal == refusal && coach.error == refusal.message)
    }
    coach.refusal = .fresh("Full"); coach.newChat()
    #expect(coach.canCompose && coach.refusal == nil && coach.error == nil)
  }
  @Test func connectionsRequireBothSuccessfulReadsAndAccountOwner() async throws {
    let (gym, rest, _) = try await authed(.failure(.notConnectedToInternet))
    let connections = CoachConnections(gym: gym, rest: rest); await connections.load()
    #expect(connections.failed && connections.rows == nil && !connections.reading)
    gym.isAnonymous = true; gym.account = nil; await connections.load()
    #expect(connections.rows == nil)
  }

  @Test func connectedLogRejectsPartialReadAndKeepsBothAuthenticatedDoors() async throws {
    let (gym, rest, _) = try await authed(.http(200, #"{"keys":[]}"#))
    CoachTestProtocol.state.withLock { $0.replies["/v1/oauth/grants"] = .http(503, #"{"error":"Read unavailable"}"#) }
    let connections = CoachConnections(gym: gym, rest: rest); await connections.load()
    #expect(connections.failed && connections.rows == nil && !connections.reading)
    let calls = CoachTestProtocol.state.withLock { $0.requests }
    #expect(Set(calls.map(\.path)) == ["/v1/oauth/grants", "/v1/mcp-keys"])
    #expect(calls.allSatisfy { $0.method == "GET" && $0.authorization?.hasPrefix("Bearer ") == true && $0.body == nil })
  }

  @Test func writtenProgramHandoffKeepsFreshDurableDraftWithoutSending() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate()
    coach.edit("Prior draft"); let priorThread = coach.saved.threadId
    let handoff = CoachHandoff(question: "Help me turn my written program into a routine.")
    #expect(coach.begin(handoff))
    #expect(coach.saved.threadId != priorThread && coach.saved.text == handoff.question && coach.saved.request == nil)
    #expect(try cache.read(gym.account!).text == handoff.question)
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty })
  }

  @Test func shareWorkoutHandoffSendsFreshConversationAndPreservesFailureDraft() async throws {
    let (gym, rest, _) = try await authed(.failure(.notConnectedToInternet)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate()
    let priorThread = coach.saved.threadId
    #expect(coach.begin(CoachHandoff(question: "Check my last session.", send: true)))
    await coach.work?.value; #expect(!coach.asking)
    let request = try #require(coach.saved.request)
    #expect(request.thread != priorThread && request.question == "Check my last session." && request.attachmentIds.isEmpty)
    let call = try #require(CoachTestProtocol.state.withLock { $0.requests.first })
    #expect(call.path == "/v1/gym/ask" && call.method == "POST" && call.authorization?.hasPrefix("Bearer ") == true)
    #expect(try JSONDecoder().decode(CoachSaved.Request.self, from: #require(call.body)) == request)
    #expect(coach.retryable && coach.saved.text == request.question)
  }

  @Test func failedHandoffSaveNeverSendsPreviousDraft() async throws {
    let (gym, rest, _) = try await authed(.stalled), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate(); coach.edit("Prior draft")
    try FileManager.default.removeItem(at: cache.directory); try Data("blocked".utf8).write(to: cache.directory)
    #expect(!coach.begin(CoachHandoff(question: "Check my last session.", send: true)))
    #expect(coach.saved.text == "Prior draft" && coach.saved.request == nil && !coach.asking)
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty })
  }

  @Test(arguments: [false, true])
  func unavailableDeploymentHidesComposerAndPreservesAccountDraft(sse: Bool) async throws {
    let body = #"{"status":503,"code":"ask-not-configured","error":"Ask is not configured"}"#
    let reply = sse ? CoachTestProtocol.Reply.http(200, "event: error\ndata: " + body + "\n\n", "text/event-stream") : .http(503, body)
    let (gym, rest, telemetry) = try await authed(reply), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate()
    coach.edit("Training question"); coach.send(); await coach.work?.value; #expect(!coach.asking)
    #expect(coach.refusal == .absent && coach.error == CoachCopy.absent && !coach.canCompose)
    #expect(gym.coachUnavailable && !coach.retryable)
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "client_error" }.isEmpty })
    #expect(coach.saved.text == "Training question" && coach.saved.request != nil)
    #expect(coach.available && gym.coachAccountAvailable)
    let reopened = CoachConversation(gym: gym, rest: rest, store: cache); await reopened.activate()
    #expect(reopened.refusal == .absent && !reopened.canCompose && !reopened.asking)
    #expect(CoachTestProtocol.state.withLock { $0.requests.count } == 1)
  }

  @Test func openConversationRejectsWrongThreadAndRetainsCurrentDraft() async throws {
    let (gym, rest, _) = try await authed(.http(200, #"{"id":"foreign-thread","turns":[{"position":1,"from":"lifter","text":"Foreign content"}]}"#)), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    let coach = CoachConversation(gym: gym, rest: rest, store: cache); await coach.activate(); coach.edit("Current draft")
    let original = coach.saved.threadId
    await coach.open("requested-thread")
    #expect(coach.saved.threadId == original && coach.saved.text == "Current draft" && coach.saved.thread == nil)
    #expect(coach.error == "That conversation couldn’t be opened. Try again.")
  }

  @Test func textAndPhotoAdmissionUsesUTF8Bound() {
    #expect(!CoachCopy.sendable("  ", photo: false))
    #expect(CoachCopy.sendable("", photo: true))
    #expect(CoachCopy.sendable(String(repeating: "é", count: 500), photo: false))
    #expect(!CoachCopy.sendable(String(repeating: "é", count: 501), photo: true))
  }
  @Test func accountOnlyNeverSendsAndAccountChangeHidesContent() async throws {
    let (_, gym) = fixture(), cache = store(), coach = CoachConversation(gym: gym, store: cache)
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    await coach.activate(); coach.edit("Private draft")
    #expect(coach.allowed && coach.saved.text == "Private draft")
    gym.account = "other-account"; #expect(!coach.allowed && !coach.canCompose)
    await coach.activate(); #expect(coach.saved.text.isEmpty)
    gym.isAnonymous = true; gym.account = nil; await coach.activate()
    #expect(!coach.allowed && !coach.canCompose && coach.saved.text == "" && coach.saved.request == nil)
    coach.send(); #expect(!coach.asking && gym.rest.tasks.isEmpty)
    gym.isAnonymous = false; gym.account = "coach-owner"; await coach.activate()
    #expect(coach.saved.text == "Private draft")
  }
  @Test func durableSnapshotsReplaceTextIgnoreOlderAndKeepActions() async throws {
    let (_, gym) = fixture(), cache = store(), coach = CoachConversation(gym: gym, store: cache)
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    await coach.activate()
    let request = CoachSaved.Request(thread: "thread-123", question: "Private question", requestId: "request-123", attachmentIds: [])
    var saved = coach.saved; saved.threadId = request.thread; saved.request = request; saved.text = request.question
    #expect(coach.keep(saved, failure: "failure"))
    try coach.accept(snapshot(revision: 2, answer: "New partial"), request: request)
    try coach.accept(snapshot(revision: 1, answer: "Old partial"), request: request)
    #expect(coach.activeGeneration?.answer == "New partial")
    try coach.accept(snapshot(revision: 3, status: "stopped", answer: "Final partial"), request: request)
    #expect(coach.saved.text.isEmpty && coach.error == CoachCopy.stopped && !coach.retryable)
    let reopened = try cache.read("coach-owner")
    #expect(reopened.request == request && reopened.generation?.answer == "Final partial")
    #expect(reopened.generation?.results.map(\.operationId) == ["operation-123"])
    #expect(try cache.read("other-account").request == nil)
    #expect(cache.file("coach-owner").lastPathComponent != "coach-owner.json")
  }
  @Test func wrongThreadOrRequestSnapshotCannotReplaceDraft() async throws {
    let (_, gym) = fixture(), coach = CoachConversation(gym: gym, store: store())
    defer { try? FileManager.default.removeItem(at: coach.store.directory) }
    await coach.activate(); coach.edit("Draft")
    let request = CoachSaved.Request(thread: "thread-123", question: "Private question", requestId: "request-123", attachmentIds: [])
    #expect(throws: URLError.self) { try coach.accept(snapshot(thread: "foreign-thread"), request: request) }
    #expect(throws: URLError.self) { try coach.accept(snapshot(request: "foreign-request"), request: request) }
    #expect(coach.saved.text == "Draft" && coach.activeGeneration == nil)
  }
  @Test func corruptDraftBlocksSendAndWriteFailurePreservesDraft() async throws {
    let (_, gym) = fixture(), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
    try Data("corrupt".utf8).write(to: cache.file("coach-owner"))
    let coach = CoachConversation(gym: gym, store: cache); await coach.activate()
    #expect(!coach.draftReadable && !coach.canCompose && coach.error == "Your draft couldn’t be read. Try again.")
    try FileManager.default.removeItem(at: cache.file("coach-owner")); coach.reloadDraft()
    #expect(coach.draftReadable && coach.canCompose)
    try FileManager.default.removeItem(at: cache.directory)
    try Data("blocked directory".utf8).write(to: cache.directory)
    coach.edit("Unsaved draft"); coach.send()
    #expect(coach.saved.text == "Unsaved draft" && !coach.asking && coach.error == "Your message couldn’t be saved. Try again.")
  }
  @Test func refusalsSeparateCeilingsBusyFreshAbsentAndOffline() {
    #expect(CoachRefusal(status: 429, code: "ask-daily-limit", message: nil) == .daily("The next question frees up in a couple of hours."))
    let ceiling = CoachRefusal(status: 429, code: "ask-out-of-budget", message: nil)
    #expect(ceiling.message.contains("30 days") && !ceiling.message.contains("couple of hours"))
    #expect(CoachRefusal(status: 409, code: "ask-generation-active", message: "Server says wait") == .retry("Server says wait"))
    for code in ["ask-thread-full", "ask-thread-taken"] {
      #expect(CoachRefusal(status: 409, code: code, message: nil) == .fresh("This conversation is unavailable. Start a new one."))
    }
    #expect(CoachRefusal(status: 503, code: "ask-not-configured", message: "Ask is not configured") == .absent)
    #expect(CoachRefusal(status: nil, code: nil, message: "offline") == .retry(CoachCopy.noAnswer))
    #expect(CoachRefusal(status: 422, code: nil, message: "Server text") == .said("Server text"))
    #expect(CoachRefusal(status: 502, code: nil, message: "Server failure") == .retry("Server failure"))
    #expect(CoachRefusal(status: 503, code: nil, message: "Server restart") == .retry("Server restart"))
  }
  @Test func sseHandlesHeartbeatsMultilineAndAuthoritativeSnapshots() throws {
    var parser = CoachSSE()
    #expect(parser.consume(": heartbeat") == nil)
    #expect(parser.consume("") == nil)
    _ = parser.consume("event: snapshot"); _ = parser.consume("id: generation:2")
    _ = parser.consume("data: {\"thread\":\"thread-123\",")
    _ = parser.consume("data: \"generation\":{\"id\":\"gen\",\"requestId\":\"request-123\",\"question\":\"\",\"status\":\"completed\"}}")
    let consumed = parser.consume("")
    let (event, data) = try #require(consumed)
    #expect(event == "snapshot")
    let decoded = try JSONDecoder().decode(CoachSnapshot.self, from: data)
    #expect(decoded.generation.terminal && decoded.generation.answer.isEmpty)
  }
  @Test func pagesMergeByPositionAndDeduplicate() throws {
    let latest = #"{"id":"t","turns":[{"position":3,"from":"lifter","text":"new"},{"position":4,"from":"coach","text":"answer"}],"nextCursor":"older/+"}"#
    let older = #"{"id":"t","turns":[{"position":1,"from":"lifter","text":"old"},{"position":2,"from":"coach","text":"answer"},{"position":3,"from":"lifter","text":"new"}]}"#
    var thread = try JSONDecoder().decode(CoachThread.self, from: Data(latest.utf8))
    thread.prepend(try JSONDecoder().decode(CoachThread.self, from: Data(older.utf8)))
    #expect(thread.turns.map(\.position) == [1, 2, 3, 4] && thread.nextCursor == nil)
    #expect(CoachCopy.escaped("older/+") == "older%2F%2B")
  }
  @Test func receiptOnlyShowsKnownToolsAndValidatedVersionOneSources() throws {
    let json = #"{"version":1,"read":{"sets":214,"sessions":18,"weeks":6},"steps":[{"tool":"secret_internal_tool"},{"tool":"save_note","failed":true}],"observations":[{"sessionId":"s","startedAt":1000,"tool":"get_session","coverage":"session","setsRead":3,"workout":{"workingSetCount":3,"tonnageKg":400}},{"sessionId":"invalid","startedAt":1000,"tool":"get_session","coverage":"session","setsRead":1,"workout":{"workingSetCount":-1,"tonnageKg":1}}]}"#
    let receipt = try JSONDecoder().decode(CoachReceipt.self, from: Data(json.utf8))
    #expect(receipt.read.line == "read 214 sets · 6 weeks · 18 sessions")
    #expect(receipt.workouts.map(\.id) == ["s"])
    #expect(receipt.steps.compactMap(\.phrase) == ["could not confirm a note save"])
    let future = try JSONDecoder().decode(CoachReceipt.self, from: Data(json.replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8))
    #expect(future.workouts.isEmpty && CoachRead().line == "read nothing from your log")
  }
  @Test func photoPreparationNormalizesSizeAndRejectsUnsupportedData() throws {
    let format = UIGraphicsImageRendererFormat(); format.scale = 1
    let data = try #require(UIGraphicsImageRenderer(size: CGSize(width: 4500, height: 100), format: format).image { context in
      UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 4500, height: 100))
    }.pngData())
    let (attachment, bytes) = try CoachPhotoPreparation.prepare(data)
    #expect(attachment.width <= 4096 && attachment.height <= 4096 && attachment.mediaType == "image/png")
    #expect(bytes.count == attachment.bytes && bytes.count <= 5 * 1024 * 1024 && UIImage(data: bytes) != nil)
    #expect(throws: AppFailure.self) { try CoachPhotoPreparation.prepare(Data("not an image".utf8)) }
  }
  @Test func notesCreateEditReorderCeilingDeleteUndoAndUnitsUseEngine() throws {
    let (h, gym) = fixture()
    var first = Draft(new: Note(id: ID("first"), title: "First", body: "Original"), placed: .bottom)
    var second = Draft(new: Note(id: ID("second"), title: "Second"), placed: .bottom)
    #expect({ if case .saved = gym.save(&first) { return true }; return false }())
    _ = gym.save(&second)
    first.current.body = "Edited"; _ = gym.save(&first)
    #expect(gym.notes.map(\.body) == ["Edited", ""])
    #expect(gym.coachMoveNote(gym.notes[1], to: 0) && gym.notes.map(\.id) == [second.id, first.id])
    for n in 2..<10 { gym.run(SaveNoteCall(Note(id: gym.runner.mint(Note.self), title: "Note \(n)"))) }
    #expect(gym.notes.count == 10)
    #expect(gym.run(SaveNoteCall(Note(id: ID("overflow"), title: "Overflow")))?.refusal != nil)
    let gesture = try #require(gym.run(DeleteNote(first.id))?.receipt?.gestureId)
    #expect(!gym.notes.contains { $0.id == first.id })
    #expect(gym.undo(gesture) && gym.notes.count == 10)
    first.current.title = String(repeating: "x", count: 61); #expect({ if case .refused = gym.save(&first) { return true }; return false }())
    first.current.title = "First"; first.current.body = String(repeating: "é", count: 251)
    #expect({ if case .refused = gym.save(&first) { return true }; return false }())
    gym.coachSaveUnits("lb"); h.sync(); gym.refresh()
    #expect(gym.preferences.units == "lb")
    gym.coachSaveUnits("kg"); #expect(gym.preferences.units == "kg")
  }
  @Test func proposalDecisionsBlockWorkoutAndWaitForAtomicEngineReceipt() throws {
    let (h, gym) = fixture()
    gym.run(CreateExercise(Exercise(id: ID("custom-squat"), name: "Squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))
    gym.run(CreateExercise(Exercise(id: ID("custom-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routine = Draft(new: Routine(id: ID("routine-one"), name: "Before", entries: [RoutineEntry(exerciseId: ID("custom-squat"))]))
    _ = gym.save(&routine); h.sync(); gym.refresh()
    let proposed = try h.runner.run(ProposeRoutine(id: ID("proposal-one"), routineId: routine.id, name: "After", entries: [RoutineEntry(exerciseId: ID("custom-bench"))], summary: "Change"))
    #expect(proposed.receipt != nil)
    h.sync(); gym.refresh()
    let proposal = try #require(gym.proposals.first)
    gym.run(StartSession(id: ID("session-one")))
    #expect(!gym.coachDecideProposal(proposal, apply: true) && gym.error == "Finish this session")
    h.sync(); gym.refresh()
    gym.run(FinishSession(id: ID("session-one")))
    h.sync(); gym.refresh()
    #expect(gym.openSession == nil)
    #expect(gym.coachDecideProposal(proposal, apply: true))
    h.sync(); gym.refresh()
    #expect(gym.proposals.first?.state == "applied" && gym.routines.first?.name == "After")
    #expect(!ProposalReviewSheet(gym: gym, proposalId: proposal.id.record.string!).superseded)
    #expect(gym.routines.first?.entries.map(\.exerciseId) == [ID<Exercise>("custom-bench")])
    #expect(!gym.coachDecideProposal(proposal, apply: false))
  }
  @Test(arguments: [false, true])
  func removalReceiptObserversCanReadTheEngine(settled: Bool) throws {
    let (h, gym) = fixture(), runner = h.runner
    #expect(gym.run(CreateExercise(Exercise(id: ID("removal-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    var routine = Draft(new: Routine(id: ID("removal-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("removal-bench"))]))
    #expect(saved(gym.save(&routine)))
    h.sync(); gym.refresh()
    #expect(gym.run(ProposeRoutine(id: ID("removal-proposal"), routineId: routine.id, name: "", entries: [], summary: "Remove", removing: true))?.receipt != nil)
    h.sync(); gym.refresh()
    let proposal = try #require(gym.proposals.first)
    #expect(try runner.run(ApplyProposalKeepingReceipt(proposal.id)).receipt != nil)
    if settled { h.sync() }
    let expected = try runner.read(Gym.scope) { try $0.device(RoutineRemovalReceipt.key) }
    let observed = Mutex<[JSON?]>([])
    withObservationTracking { _ = gym.coachRemovalReceipts } onChange: {
      do {
        let receipt = try runner.read(Gym.scope) { try $0.device(RoutineRemovalReceipt.key) }
        observed.withLock { $0.append(receipt) }
      } catch { Issue.record(error) }
    }
    gym.refresh()
    #expect(observed.withLock { $0 } == [expected])
    #expect(gym.coachRemovalReceipts.map(\.outcome) == [settled ? .applied : .pending])
    #expect(gym.proposals.map(\.state) == [settled ? "applied" : "pending"])
  }
  @Test(arguments: [false, true])
  func removalReceiptWaitsForDeliveryAndAcknowledgesOnlyWhenShown(refused: Bool) async throws {
    let transport = RemovalDeliveryTransport(), telemetry = TelemetryRecorder(), fault = GymStoreFault()
    let runtime = try GymModelTests().runtime(failing: fault, telemetry: telemetry, transport: transport, drivesLoops: true)
    let owner = transport.model.identity(email: "removal-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime.engine.start()
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry)
    defer { gym.stop() }
    let exercise = ID<Exercise>("bench-press")
    var draft = Draft(new: Routine(id: ID("removal-routine"), name: "Push A",
      entries: [RoutineEntry(exerciseId: exercise, sets: [SetTarget(reps: 5, weightKg: 60)])]))
    #expect({ if case .saved = gym.save(&draft) { return true }; return false }())
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.routines.first?.revision != nil }
    let routine = try #require(gym.routines.first)
    let start = Instant(ms: 1_790_423_000_000), end = Instant(ms: 1_790_424_000_000)
    let sets = [ImportedSet(id: ID("removal-warmup"), exerciseId: exercise, weightKg: 20, reps: 8, completedAt: start, kind: "warmup"),
                ImportedSet(id: ID("removal-working"), exerciseId: exercise, weightKg: 60, reps: 5, completedAt: end)]
    #expect(gym.run(ImportSession(id: ID("removal-session"), startedAt: start, finishedAt: end, sets: sets, routineId: routine.id))?.receipt != nil)
    #expect(gym.run(ProposeRoutine(id: ID("removal-proposal"), routineId: routine.id, name: "", entries: [], summary: "Remove this routine.", removing: true))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.baseRevision != nil }
    let proposal = try #require(gym.proposals.first), logged = gym.sets
    let review = ProposalReviewSheet(gym: gym, proposalId: proposal.id.description)
    #expect(review.applyLabel == "Remove Push A" && proposal.state == "pending" && proposal.settledAt == nil)
    await transport.delivery.hold()
    defer { Task { await transport.delivery.release() } }
    if refused { transport.model.state.withLock { $0.server.refuse(code: .invalid) } }
    #expect(gym.coachDecideProposal(proposal, apply: true))
    #expect(gym.routines.isEmpty && gym.sets == logged)
    try expectProposal(review.proposal, equals: proposal)
    #expect(gym.proposals.count == 1 && review.pending && !review.decidable)
    #expect(try runtime.runner.read(Gym.scope) { try $0.confirmed(Proposal.self, proposal.id).map { try Proposal(Fields($0)).state } } == "pending")
    fault.point.withLock { $0 = .beforeCommit(.results) }
    await transport.delivery.release()
    try await settle { runtime.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
    gym.refresh()
    #expect(gym.coachRemovalReceipts.first?.outcome == .pending && review.pending)
    #expect(try runtime.runner.read(Gym.scope) { try $0.commands().count } == 1)
    fault.point.withLock { $0 = nil }
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return !review.pending && (refused ? !gym.notices.isEmpty : review.proposal?.state == "applied") }
    let answer = try #require(review.proposal)
    #expect(gym.sets == logged && gym.sessions.map(\.id) == [ID<Session>("removal-session")])
    #expect(gym.sessions.first?.plan == SessionPlan(routine))
    if refused {
      try expectProposal(answer, equals: proposal)
      #expect(gym.routines == [routine] && review.decidable)
      #expect(answer.settledAt == nil && !gym.notices.isEmpty)
    } else {
      #expect(answer.state == "applied" && answer.intent == "remove" && answer.settledAt == nil)
      #expect(answer.summary == proposal.summary && answer.changes == proposal.changes && answer.baseName == routine.name)
      #expect(gym.routines.isEmpty && gym.waitingRoutineProposals.isEmpty && !review.decidable)
      #expect(try runtime.runner.read(Gym.scope) { try $0.confirmed(Proposal.self, proposal.id) } == nil)
      gym.refresh()
      try expectProposal(gym.proposals.first, equals: answer)
      #expect(gym.proposals.count == 1)
      let cold = GymModel(runner: runtime.runner, runtime: runtime)
      #expect(cold.proposals.first?.state == "applied" && cold.sets == logged && cold.routines.isEmpty)
      #expect(cold.coachRemovalReceipts.count == 1)
    }
    let window = UIWindow(frame: UIScreen.main.bounds)
    let host = RemovalReceiptHost(rootView: review.environment(\.scenePhase, .background))
    window.rootViewController = host; window.makeKeyAndVisible()
    defer { window.isHidden = true }
    try await settle { host.appeared }
    #expect(try runtime.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).count } == 1)
    fault.point.withLock { $0 = .beforeCommit(.commit) }
    host.rootView = review.environment(\.scenePhase, .active)
    try await settle { telemetry.entries.withLock { $0.contains { $0.name == "client_error" && $0.properties["operation"] == "gym_action" } } }
    #expect(try runtime.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).count } == 1)
    fault.point.withLock { $0 = nil }
    window.rootViewController = nil
    window.rootViewController = RemovalReceiptHost(rootView: review.environment(\.scenePhase, .active))
    try await settle { (try? runtime.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).isEmpty }) == true }
    #expect(review.proposal?.state == (refused ? "pending" : "applied"))
    let shownCold = GymModel(runner: runtime.runner, runtime: runtime)
    #expect(shownCold.proposals.count == (refused ? 1 : 0) && shownCold.coachRemovalReceipts.isEmpty)
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "gym_proposal_outcome" }.map { $0.properties["outcome"] } } == [refused ? "failed" : "decided"])
  }
  @Test(arguments: [false, true], [false, true])
  func removalReceiptSurvivesAStoreRelaunch(resolvedBeforeRelaunch: Bool, refused: Bool) async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let service = "works.windmill.test-removal." + UUID().uuidString
    let transport = WorkoutFaultTransport()
    let settings = AppSettings(arguments: ["app", "-server", "https://gym.invalid"])
    let owner = transport.model.identity(email: "durable-removal@example.com")
    var runtime: AppRuntime? = try AppRuntime(settings: settings, directory: directory, service: service, syncTransport: transport)
    #expect(try await runtime!.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime!.engine.start()
    var warm: GymModel? = GymModel(runner: runtime!.runner, runtime: runtime!)
    var draft = Draft(new: Routine(id: ID("durable-routine"), name: "Retained plan", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect(saved(warm!.save(&draft)))
    await runtime!.engine.flushOnLeave(); runtime!.engine.foreground()
    try await settle { warm!.refresh(); return warm!.routines.first?.revision != nil }
    #expect(warm!.run(ProposeRoutine(id: ID("durable-proposal"), routineId: draft.id, name: "", entries: [], summary: "Remove", removing: true))?.receipt != nil)
    await runtime!.engine.flushOnLeave(); runtime!.engine.foreground()
    try await settle { warm!.refresh(); return warm!.proposals.first?.baseRevision != nil }
    let proposal = try #require(warm!.proposals.first)
    transport.failure.withLock { $0 = 503 }
    #expect(warm!.coachDecideProposal(proposal, apply: true))
    try await settle { runtime!.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
    await runtime!.engine.flushOnLeave()
    if refused { transport.model.state.withLock { $0.server.refuse(code: .invalid) } }
    if resolvedBeforeRelaunch {
      transport.failure.withLock { $0 = nil }
      await runtime!.engine.flushOnLeave(); runtime!.engine.foreground()
      try await settle { warm!.refresh(); return warm!.coachRemovalReceipts.first?.outcome == (refused ? .refused : .applied) && (try? runtime!.runner.read(Gym.scope) { try $0.commands().isEmpty }) == true }
      #expect(warm!.proposals.first?.state == (refused ? "pending" : "applied"))
    }
    let closed = { [weak oldRuntime = runtime, weak oldEngine = runtime!.engine, weak oldStore = runtime!.store] in
      oldRuntime == nil && oldEngine == nil && oldStore == nil
    }
    warm!.stop(); warm = nil; runtime = nil
    try await settle { closed() }
    try #require(closed())
    let closedReopened: () -> Bool
    do {
      let reopened = try AppRuntime(settings: settings, directory: directory, service: service, syncTransport: transport)
      await reopened.engine.start()
      let gym = GymModel(runner: reopened.runner, runtime: reopened)
      gym.start()
      closedReopened = { [weak gym, weak runtime = reopened, weak engine = reopened.engine, weak store = reopened.store] in
        gym == nil && runtime == nil && engine == nil && store == nil
      }
      defer { gym.stop(); try? reopened.tokens.delete(for: owner.account) }
      let review = ProposalReviewSheet(gym: gym, proposalId: proposal.id.description)
      if !resolvedBeforeRelaunch {
        #expect(review.proposal?.state == "pending" && review.pending)
        #expect(gym.coachDecideProposal(proposal, apply: true))
        #expect(try reopened.runner.read(Gym.scope) { try $0.commands().count } == 1)
        transport.failure.withLock { $0 = nil }
        await reopened.engine.flushOnLeave(); reopened.engine.foreground()
      }
      try await settle { gym.refresh(); return gym.coachRemovalReceipts.first?.outcome == (refused ? .refused : .applied) && (try? reopened.runner.read(Gym.scope) { try $0.commands().isEmpty }) == true }
      #expect(gym.routines.count == (refused ? 1 : 0))
      #expect(review.proposal?.state == (refused ? "pending" : "applied") && !review.pending)
      #expect(gym.coachRemovalReceipts.first?.outcome == (refused ? .refused : .applied))
      #expect(review.proposal?.summary == proposal.summary && review.proposal?.baseName == proposal.baseName)
    }
    try await settle { closedReopened() }
    try #require(closedReopened())
    try FileManager.default.removeItem(at: directory)
  }
  @Test func failedRemovalDeliveryWaitsForReceiptAndAccountSwitchClearsIt() async throws {
    let transport = WorkoutFaultTransport(), runtime = try WorkoutStateTests.faultRuntime(transport, drivesLoops: true)
    let owner = transport.model.identity(email: "removal-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime.engine.start()
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    defer { gym.stop() }
    var routine = Draft(new: Routine(id: ID("removal-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect({ if case .saved = gym.save(&routine) { return true }; return false }())
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.routines.first?.revision != nil }
    #expect(gym.run(ProposeRoutine(id: ID("removal-proposal"), routineId: routine.id, name: "", entries: [], summary: "Remove this routine.", removing: true))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.baseRevision != nil }
    let pending = try #require(gym.proposals.first)
    let review = ProposalReviewSheet(gym: gym, proposalId: pending.id.description)
    transport.failure.withLock { $0 = 503 }
    #expect(gym.coachDecideProposal(pending, apply: true))
    try await settle { runtime.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
    gym.refresh()
    try expectProposal(review.proposal, equals: pending)
    #expect(gym.proposals.count == 1 && review.pending && !review.decidable)
    #expect(review.proposal?.settledAt == nil && gym.routines.isEmpty)

    transport.failure.withLock { $0 = nil }
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.state == "applied" && !review.pending }
    #expect(gym.proposals.first?.state == "applied" && gym.proposals.first?.settledAt == nil && !review.decidable)
    _ = try await runtime.engine.signOut().finish(.keep)
    gym.refresh()
    #expect(gym.proposals.isEmpty && gym.account == nil)
    let other = transport.model.identity(email: "removal-other@example.com")
    #expect(try await runtime.engine.signIn(account: other.account, token: other.token).isComplete)
    gym.refresh()
    #expect(gym.proposals.isEmpty && gym.account == other.account && review.proposal == nil)
    _ = try await runtime.engine.signOut().finish(.keep)
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    gym.refresh()
    #expect(gym.proposals.first?.state == "applied" && gym.account == owner.account && gym.routines.isEmpty)
    #expect(gym.coachRemovalReceipts.count == 1)
  }
  @Test(arguments: [false, true])
  func routineDeletionDoesNotInventARemovalReceipt(dismissed: Bool) throws {
    let (h, gym) = fixture()
    #expect(gym.run(CreateExercise(Exercise(id: ID("removal-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))?.receipt != nil)
    var routine = Draft(new: Routine(id: ID("removal-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("removal-bench"))]))
    #expect({ if case .saved = gym.save(&routine) { return true }; return false }())
    h.sync(); gym.refresh()
    #expect(gym.run(ProposeRoutine(id: ID("removal-proposal"), routineId: routine.id, name: "", entries: [], summary: "Remove this routine.", removing: true))?.receipt != nil)
    h.sync(); gym.refresh()
    let pending = try #require(gym.proposals.first)
    if dismissed {
      #expect(gym.coachDecideProposal(pending, apply: false))
      try expectProposal(gym.proposals.first, equals: pending)
      #expect(gym.proposals.count == 1 && gym.coachProposalAwaitingReceipt(pending.id))
      h.sync(); gym.refresh()
      #expect(gym.proposals.first?.state == "dismissed")
    }
    #expect(gym.run(DeleteRoutine(routine.id))?.receipt != nil)
    h.leave(); h.sync(); gym.refresh()
    #expect(gym.routines.isEmpty && gym.proposals.isEmpty)
  }
  @Test func connectedCredentialsFilterScopesAndUseCreationDates() throws {
    let grants = Data(#"{"grants":[{"clientId":"a","name":" Claude ","grantedMs":1000,"scope":"gym:delete gym:read"},{"clientId":"b","name":"Roadmap","grantedMs":2000,"scope":"roadmap:read"},{"clientId":"c","grantedMs":3000,"scope":""}]}"#.utf8)
    let keys = Data(#"{"keys":[{"id":"k","createdMs":4000,"name":""}]}"#.utf8)
    let rows = try CoachConnection.decode(grants: grants, keys: keys)
    #expect(rows.map(\.name) == ["Claude", "A connected tool", "A static key"])
    #expect(rows.map(\.levels) == ["read · delete", "whole account", "whole account"])
    #expect(rows.map(\.created) == [1000, 3000, 4000])
    #expect(rows.last?.meta.hasPrefix("API key · whole account · since ") == true)
    #expect(throws: DecodingError.self) { try CoachConnection.decode(grants: grants, keys: Data("{}".utf8)) }
  }
}

nonisolated final class CoachCountingTokenStore: TokenStore {
  let base: any TokenStore
  let reads = Mutex(0)
  init(_ base: any TokenStore) { self.base = base }
  func token(for account: String) -> SessionToken? {
    reads.withLock { $0 += 1 }
    return base.token(for: account)
  }
  func save(_ token: SessionToken, for account: String) throws { try base.save(token, for: account) }
  func delete(for account: String) throws { try base.delete(for: account) }
  func accounts() -> [String] { base.accounts() }
}

nonisolated final class CoachTestProtocol: URLProtocol, @unchecked Sendable {
  enum Reply: Sendable { case http(Int, String, String = "application/json"), failure(URLError.Code), stalled }
  struct Request: Sendable { let path: String; let method: String; let authorization: String?; let mediaType: String?; let body: Data? }
  struct State: Sendable { var reply: Reply; var replies: [String: Reply] = [:]; var requests: [Request] = []; var active: CoachTestProtocol?; var activeByPath: [String: CoachTestProtocol] = [:] }
  static let state = Mutex(State(reply: .stalled))
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var body = request.httpBody
    if let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }; var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count)) }; body = data
    }
    let reply = Self.state.withLock { state in
      state.requests.append(Request(path: request.url!.path, method: request.httpMethod!, authorization: request.value(forHTTPHeaderField: "Authorization"), mediaType: request.value(forHTTPHeaderField: "Content-Type"), body: body))
      state.active = self; state.activeByPath[request.url!.path] = self; return state.replies[request.url!.path] ?? state.reply
    }
    switch reply {
    case .http(let status, let body, let type): respond(status, body, type: type)
    case .failure(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
    case .stalled: break
    }
  }
  func respond(_ status: Int, _ body: String, type: String = "application/json") {
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8)); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() { Self.state.withLock { if $0.active === self { $0.active = nil }; if $0.activeByPath[request.url!.path] === self { $0.activeByPath[request.url!.path] = nil } } }
}

nonisolated final class RemovalDeliveryTransport: SyncTransport {
  let model = JournalModelTransport()
  let delivery = RemovalDeliveryGate()
  func hello(token: SessionToken?) async -> Reply<HelloResponse> { await model.hello(token: token) }
  func push(_ request: PushRequest, token: SessionToken) async -> Reply<PushResponse> {
    await delivery.wait()
    return await model.push(request, token: token)
  }
  func pull(_ request: PullRequest, token: SessionToken?) async -> Reply<PullResponse> { await model.pull(request, token: token) }
  func openLive(token: SessionToken) async -> Reply<any LiveConnection> { await model.openLive(token: token) }
}

actor RemovalDeliveryGate {
  var held = false
  var waiting: [CheckedContinuation<Void, Never>] = []
  func hold() { held = true }
  func wait() async {
    guard held else { return }
    await withCheckedContinuation { waiting.append($0) }
  }
  func release() {
    held = false
    let resumed = waiting; waiting = []
    for continuation in resumed { continuation.resume() }
  }
}

@MainActor final class RemovalReceiptHost<Content: View>: UIHostingController<Content> {
  var appeared = false
  override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); appeared = true }
}
