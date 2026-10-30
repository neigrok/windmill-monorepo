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
import SyncAPI
import SyncSchema
import SyncEngine
import enum SyncEngine.Reply
import SyncModelServer
import SyncTesting
@testable import Windmill

@Suite(.serialized) @MainActor struct CoachTests {
  @Test func dynamicPaletteResolvesOnAccessibilityBackgroundThread() async {
    let colours = [GymPalette.canvas, GymPalette.card, GymPalette.onAccent, GymPalette.accent].map { UIColor($0) }
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
    #expect(result.1 == [0x0b1111, 0x161c1d, 0x1b1408, 0x5fcdb4])
  }

  func fixture() -> (Harness, GymModel) {
    let h = Harness(holdRemovals: false, registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: "coach-owner",
                    rules: ComposedServerRules.windmill(registry: SyncSchema.registry), commandResultWrites: AppRuntime.commandResultWrites)
    let gym = GymModel(runner: h.runner); gym.account = "coach-owner"
    return (h, gym)
  }
  func store() -> CoachDraftStore { CoachDraftStore(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)) }
  func authed(_ reply: CoachTestProtocol.Reply, timeout: TimeInterval = 60,
              connectivity: SwitchedConnectivity = SwitchedConnectivity()) async throws -> (GymModel, GymRESTClient, TelemetryRecorder) {
    let telemetry = TelemetryRecorder(), transport = JournalModelTransport()
    let runtime = try GymModelTests().runtime(telemetry: telemetry, transport: transport, connectivity: connectivity)
    let identity = transport.identity(email: "coach-test@example.com")
    _ = try await runtime.engine.signIn(account: identity.account, token: identity.token)
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry, waits: GymWaits(coachBeat: .milliseconds(5)))
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [CoachTestProtocol.self]
    config.timeoutIntervalForRequest = timeout
    CoachTestProtocol.state.withLock { $0 = .init(reply: reply) }
    return (gym, GymRESTClient(runtime: runtime, telemetry: telemetry, session: URLSession(configuration: config)), telemetry)
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

  @Test func retiredServerConversationRequestsNeverReachTransport() async throws {
    let (_, rest, _) = try await authed(.stalled)
    for path in ["/v1/gym/ask", "/v1/gym/threads/fixture/attachments/fixture"] {
      await #expect(throws: AppFailure.self) { _ = try await rest.coachRequest(path, method: "POST") }
    }
    #expect(CoachTestProtocol.state.withLock { $0.requests.isEmpty } && rest.tasks.isEmpty)
  }

  // What Coach read lists one step per call, in order, from its catalog phrase (08.36): a read that served workouts says
  // how many over which weeks and days, by identity, a write names what it made, and a refused call is no step at all;
  // the step line under a running answer is the same phrases in order (08.35).
  @Test func whatCoachReadListsOneStepPerCallInOrder() throws {
    let (h, gym) = fixture()
    #expect(gym.run(CreateExercise(Exercise(id: ID("source-other"), name: "Other", pattern: "press", equipment: "other", stepKg: 2.5)))?.receipt != nil)
    var served = ReadServed()
    for (index, daysAgo) in [2, 9].enumerated() {
      let id = ID<Session>(RecordID("source-" + String(index)))
      let start = Instant(ms: 1_790_423_900_000 - Int64(daysAgo) * 86_400_000)
      #expect(gym.run(ImportSession(id: id, startedAt: start, finishedAt: Instant(ms: start.ms + 100), sets: [
        ImportedSet(id: ID(RecordID("source-set-" + String(index))), exerciseId: ID("source-other"), weightKg: 80, reps: 2, completedAt: Instant(ms: start.ms + 1)),
      ]))?.receipt != nil)
      h.sync(); gym.refresh()
      served.saw(session: try #require(gym.sessions.first { $0.id == id }))
    }
    let calls = [
      AbilityCall(callId: "c1", name: "list_notes", input: nil, outcome: .ok),
      AbilityCall(callId: "c2", name: "list_sessions", input: nil, outcome: .ok, read: .ids(served)),
      AbilityCall(callId: "c3", name: "get_session", input: nil, outcome: .ok, read: .ids(.none)),
      AbilityCall(callId: "c4", name: "save_note", input: nil, outcome: .refused(.seatRequired)),
      AbilityCall(callId: "c5", name: "create_exercise", input: nil, outcome: .ok, created: [RecordRef(type: Exercise.type, id: "source-other")]),
    ]
    let reading = CoachReading(calls: calls, gym: gym)
    let days = [9, 2].map { gym.dates.draw(LocalDay(Instant(ms: 1_790_423_900_000 - Int64($0) * 86_400_000), in: gym.dates.moment.zone), .dateTime.month(.abbreviated).day()) }
    #expect(reading.steps == [
      CoachReading.Step(title: "Read your notes", detail: nil),
      CoachReading.Step(title: "Read 2 workouts", detail: "2 weeks · " + days[0] + " – " + days[1]),
      CoachReading.Step(title: "Read one workout", detail: nil),
      CoachReading.Step(title: "Created a movement", detail: "Other"),
    ])
    #expect(reading.line == "Read 2 workouts · 2 weeks")
    #expect(reading.stepLine == "read your notes · read your recent workouts · read one workout · created a movement")
    #expect(CoachReading(calls: [calls[0]], gym: gym).line == "Read nothing from your log")
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

  @Test func connectionsRequireBothSuccessfulReadsAndAccountOwner() async throws {
    let (gym, rest, _) = try await authed(.failure(.notConnectedToInternet))
    let connections = CoachConnections(gym: gym, rest: rest); await connections.load()
    #expect(connections.failed && connections.rows == nil && !connections.reading)
    gym.isAnonymous = true; gym.account = nil; await connections.load()
    #expect(connections.rows == nil)
  }

  // The failed read cancels the other, so whether the keys request goes out at all is the scheduler's call.
  @Test func connectedLogFailsWhenOnlyOneOfItsTwoReadsAnswers() async throws {
    let (gym, rest, _) = try await authed(.http(200, #"{"keys":[]}"#))
    CoachTestProtocol.state.withLock { $0.replies["/v1/oauth/grants"] = .http(503, #"{"error":"Read unavailable"}"#) }
    let connections = CoachConnections(gym: gym, rest: rest); await connections.load()
    #expect(connections.failed && connections.rows == nil && !connections.reading && !connections.connectionRequired)
  }

  @Test func connectedLogReadsGrantsAndKeysAsAuthenticatedGetsAndListsBoth() async throws {
    let (gym, rest, _) = try await authed(.http(200, #"{"keys":[{"id":"k","createdMs":1758888000000,"name":"Laptop"}]}"#))
    CoachTestProtocol.state.withLock { $0.replies["/v1/oauth/grants"] = .http(200, #"{"grants":[{"clientId":"a","name":"Claude","grantedMs":1790448120000,"scope":"gym:read"}]}"#) }
    let runtime = try #require(rest.runtime), owner = try #require(try runtime.account()), token = try #require(runtime.tokens.token(for: owner))
    let connections = CoachConnections(gym: gym, rest: rest); await connections.load()
    #expect(!connections.failed && !connections.reading && connections.owner == owner)
    #expect(connections.rows == [CoachConnection(id: "grant:a", name: "Claude", created: 1_790_448_120_000, levels: "read", key: false),
                                 CoachConnection(id: "key:k", name: "Laptop", created: 1_758_888_000_000, levels: "whole account", key: true)])
    let bearer = "Bearer " + token.value
    #expect(CoachTestProtocol.state.withLock { $0.requests }.sorted { $0.path < $1.path } == [
      .init(path: "/v1/mcp-keys", method: "GET", authorization: bearer, mediaType: nil, body: nil),
      .init(path: "/v1/oauth/grants", method: "GET", authorization: bearer, mediaType: nil, body: nil)])
  }

  // Each refusal offers the one door that exists (boards 08.38–08.45): sign-in where the phone's own AI access is spent or
  // belongs to an account, the lifter's own agent where Coach's shared capacity is paused, and nothing where no door helps.
  @Test func eachRefusalOffersTheOneDoorThatExists() {
    for code in ["device_bound", "installation_bound", "invalid_installation"] {
      #expect(CoachTurnRefusal(code: code) == .installation(code))
      #expect(CoachTurnRefusal(code: code).recovery(anonymous: true) == .signIn && CoachTurnRefusal(code: code).recovery(anonymous: false) == nil)
    }
    #expect(CoachTurnRefusal.allowance("subject_exhausted").recovery(anonymous: true) == .signIn)
    #expect(CoachTurnRefusal.allowance("subject_exhausted").recovery(anonymous: false) == nil, "Signed in, a spent allowance offers nothing while paid plans are closed")
    for code in ["free_day_exhausted", "concurrency_exhausted", "funding_required", "unconfigured"] {
      #expect(CoachTurnRefusal(code: code).recovery(anonymous: true) == nil && CoachTurnRefusal(code: code).recovery(anonymous: false) == nil)
    }
    #expect(CoachTurnRefusal(code: "free_month_exhausted", resetsAtMs: 1_793_491_200_000) == .freeMonthExhausted(resetsAtMs: 1_793_491_200_000))
    #expect([CoachTurnRefusal.freeMonthExhausted(resetsAtMs: nil), .rateLimited].map { $0.recovery(anonymous: false) } == [.ownAgent, .ownAgent])
    #expect([CoachTurnRefusal.offline, .logArriving, .updateRequired].map { $0.recovery(anonymous: true) } == [.tryAgain, nil, .update])
    #expect([CoachTurnRefusal(code: "subject_exhausted"), CoachTurnRefusal(code: "coach-rate-limited"), CoachTurnRefusal(code: "coach-update-required"),
             CoachTurnRefusal(code: "invalid_installation"), CoachTurnRefusal(code: "coach-busy", status: 503), CoachTurnRefusal(code: "", status: 404)]
      == [.allowance("subject_exhausted"), .rateLimited, .updateRequired, .installation("invalid_installation"), .said("coach-busy"), .absent])
    #expect([CoachTurnRefusal.allowance("subject_exhausted"), .freeMonthExhausted(resetsAtMs: nil), .rateLimited, .absent].map { $0.capped } == [true, true, true, true])
    #expect([CoachTurnRefusal.offline, .logArriving, .updateRequired, .installation("device_bound"), .said("coach-busy")].map { $0.capped }
      == [false, false, false, false, false])
    #expect([CoachTurnRefusal.offline, .logArriving, .installation("invalid_installation"), .installation("device_bound"), .updateRequired].map(\.sentence) == [
      "No connection. Your question is kept here.",
      "Your log is still arriving on this phone. Ask again in a moment.", "This phone can’t ask Coach signed out any more. Sign in to continue.",
      "This phone is linked to an account. Sign in to ask Coach.", "This version can’t ask Coach any more. Update Windmill to continue.",
    ])
  }

  // Each refusal says only what is true of it: the reset line where a reset brings Coach back, *used all* only when nothing
  // is left or held.
  @Test func anAllowanceSaysWhenCoachAnswersAgainOnlyWhereAResetBringsItBack() throws {
    let dates = GymDate(Moment(now: Instant(ms: 1_792_152_000_000), zone: FixedZone(offsetSeconds: 0)), locale: Locale(identifier: "en_US"))
    func said(_ code: String, remaining: String, reserved: String) throws -> [String?] {
      let allowance = try JSONDecoder().decode(AiAllowance.self, from: Data(#"{"code":"\#(code)","currency":"USD","period":"calendar_month_utc","tier":"logged_in","configured":true,"limit":"0.25","used":"0.2","reserved":"\#(reserved)","remaining":"\#(remaining)","resetsAtMs":1793491200000,"budgetResetsAtMs":1792540800000}"#.utf8))
      return [allowance.message, allowance.detail(dates)]
    }
    let reset = "You can use Coach again on Nov 1 at 12:00\u{202F}AM.", pool = "You can use Coach again on Oct 21 at 12:00\u{202F}AM."
    #expect(try said("subject_exhausted", remaining: "0.000000000", reserved: "0") == ["You have used all of your AI allowance.", reset])
    #expect(try said("subject_exhausted", remaining: "0", reserved: "0.05") == ["The rest of your AI allowance is held by a request still in progress.", nil])
    #expect(try said("subject_exhausted", remaining: "0.01", reserved: "0") == ["This request needs more AI capacity than your remaining allowance.", nil])
    #expect(try said("free_day_exhausted", remaining: "0.05", reserved: "0") == ["Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.", pool])
    #expect(try said("free_month_exhausted", remaining: "0.05", reserved: "0") == ["Coach’s shared free AI capacity is unavailable for this month. Signing in does not bypass this limit.", pool])
    #expect(try said("concurrency_exhausted", remaining: "0.04", reserved: "0.01") == ["Another AI request is still in progress. Try again when it finishes.", nil])
    #expect(try said("funding_required", remaining: "0", reserved: "0") == ["Your plan has no funded AI allowance for this period.", nil])
    #expect(try said("debt_outstanding", remaining: "0", reserved: "0") == ["Coach’s AI allowance is unavailable right now.", nil])
    #expect(try said("device_bound", remaining: "0.05", reserved: "0") == ["This phone’s AI access belongs to an account.", nil])
    let tokyo = GymDate(Moment(now: Instant(ms: 1_792_152_000_000), zone: FixedZone(offsetSeconds: 9 * 3_600)), locale: Locale(identifier: "en_US"))
    let spent = try JSONDecoder().decode(AiAllowance.self, from: Data(#"{"code":"subject_exhausted","currency":"USD","period":"calendar_month_utc","tier":"logged_in","configured":true,"limit":"0.25","used":"0.25","reserved":"0","remaining":"0","resetsAtMs":1793491200000}"#.utf8))
    #expect(spent.detail(tokyo) == "You can use Coach again on Nov 1 at 9:00\u{202F}AM.")
  }

  @Test func textAndPhotoAdmissionUsesUTF8Bound() {
    #expect(!CoachCopy.sendable("  ", photo: false))
    #expect(CoachCopy.sendable("", photo: true))
    #expect(CoachCopy.sendable(String(repeating: "é", count: 4000), photo: false))
    #expect(!CoachCopy.sendable(String(repeating: "é", count: 4001), photo: true))
  }
  @Test func corruptDraftBlocksSendAndWriteFailurePreservesDraft() async throws {
    let (_, gym) = fixture(), cache = store()
    defer { try? FileManager.default.removeItem(at: cache.directory) }
    try FileManager.default.createDirectory(at: cache.directory, withIntermediateDirectories: true)
    try Data("corrupt".utf8).write(to: cache.file("coach-owner"))
    let coach = CoachConversation(gym: gym, store: cache); await coach.activate()
    #expect(!coach.draftReadable && !coach.canCompose && coach.error == "Your draft couldn’t be read.")
    try FileManager.default.removeItem(at: cache.file("coach-owner")); coach.reloadDraft()
    #expect(coach.draftReadable && coach.canCompose)
    try FileManager.default.removeItem(at: cache.directory)
    try Data("blocked directory".utf8).write(to: cache.directory)
    coach.edit("Unsaved draft")
    #expect(coach.saved.text == "Unsaved draft" && !coach.asking && coach.error == "Your draft couldn’t be saved. Try again.")
  }
  @Test func theDaysCapSaysTheWaitToTheServersMomentRounded() {
    let waits: [Int64?] = [nil, -5_000, 59_999, 60_000, 89_999, 90_000, 539_999, 570_000, 2_400_000, 3_149_999, 3_150_000,
                           5_399_999, 5_400_000, 8_640_000]
    #expect(waits.map { CoachCopy.daily(waitMs: $0) } == [
      "You can ask again later.", "You can ask again in a minute.", "You can ask again in a minute.",
      "You can ask again in about 1 minute.", "You can ask again in about 1 minute.", "You can ask again in about 2 minutes.",
      "You can ask again in about 9 minutes.", "You can ask again in about 10 minutes.", "You can ask again in about 40 minutes.",
      "You can ask again in about 50 minutes.", "You can ask again in about 1 hour.", "You can ask again in about 1 hour.",
      "You can ask again in about 2 hours.", "You can ask again in about 2 hours.",
    ])
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
  @Test func notesCreateEditReorderCeilingAndDeleteUseEngine() throws {
    let (_, gym) = fixture()
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
    let receipt = try #require(gym.run(DeleteNote(first.id))?.receipt)
    #expect(!gym.notes.contains { $0.id == first.id })
    #expect(receipt.releaseAt == nil && gym.notes.count == 9)
    first.current.title = String(repeating: "x", count: 61); #expect({ if case .refused = gym.save(&first) { return true }; return false }())
    first.current.title = "First"; first.current.body = String(repeating: "é", count: 251)
    #expect({ if case .refused = gym.save(&first) { return true }; return false }())
  }
  // A routine proposal applies during a workout and changes the routine for next time; the running workout keeps the plan
  // it started from.
  @Test func aProposalAppliedMidWorkoutChangesTheRoutineAndNeverTheRunningWorkout() throws {
    let (h, gym) = fixture()
    gym.run(CreateExercise(Exercise(id: ID("custom-squat"), name: "Squat", pattern: "squat", equipment: "barbell", stepKg: 2.5)))
    gym.run(CreateExercise(Exercise(id: ID("custom-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routine = Draft(new: Routine(id: ID("routine-one"), name: "Before", entries: [RoutineEntry(exerciseId: ID("custom-squat"), sets: [SetTarget(reps: 5, weightKg: 100)])]))
    _ = gym.save(&routine); h.sync(); gym.refresh()
    let proposed = try h.runner.run(ProposeRoutine(id: ID("proposal-one"), routineId: routine.id, name: "After", entries: [RoutineEntry(exerciseId: ID("custom-bench"))], summary: "Change"))
    #expect(proposed.receipt != nil)
    h.sync(); gym.refresh()
    let proposal = try #require(gym.proposals.first)
    let card = ProposalCard(gym: gym, id: proposal.id.record.string!)
    #expect(card.eyebrow == "Changes to Before")
    #expect(gym.run(StartSession(id: ID("session-one"), routineId: routine.id))?.refusal == nil)
    h.sync(); gym.refresh()
    let started = try #require(gym.openSession), before = try #require(gym.routines.first)
    #expect(started.plan == SessionPlan(before) && before.entries.map(\.exerciseId) == [ID<Exercise>("custom-squat")])
    #expect(card.eyebrow == "Changes to Before · Next time")
    #expect(gym.coachDecideProposal(proposal, apply: true) && gym.error == nil)
    #expect(card.decision(stalled: false).title == "Applying…")
    h.sync(); gym.refresh()
    #expect(gym.proposals.first?.state == "applied" && gym.routines.first?.name == "After")
    #expect(gym.proposals.first.map(gym.coachProposalOutOfDate) == false)
    #expect(gym.routines.first?.entries.map(\.exerciseId) == [ID<Exercise>("custom-bench")])
    #expect(gym.openSession == started && gym.openSession?.plan == SessionPlan(before))
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
    let sets = [ImportedSet(id: ID("removal-first"), exerciseId: exercise, weightKg: 20, reps: 8, completedAt: start),
                ImportedSet(id: ID("removal-working"), exerciseId: exercise, weightKg: 60, reps: 5, completedAt: end)]
    #expect(gym.run(ImportSession(id: ID("removal-session"), startedAt: start, finishedAt: end, sets: sets, routineId: routine.id))?.receipt != nil)
    #expect(gym.run(ProposeRoutine(id: ID("removal-proposal"), routineId: routine.id, name: "", entries: [], summary: "Remove this routine.", removing: true))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.baseRevision != nil }
    let proposal = try #require(gym.proposals.first), logged = gym.sets
    let card = ProposalCard(gym: gym, id: proposal.id.description)
    #expect(card.decision(stalled: false).title == "Remove routine" && proposal.state == "pending" && proposal.settledAt == nil)
    await transport.delivery.hold()
    defer { Task { await transport.delivery.release() } }
    if refused { transport.model.state.withLock { $0.server.refuse(code: .invalid) } }
    #expect(gym.coachDecideProposal(proposal, apply: true))
    #expect(gym.routines.isEmpty && gym.sets == logged)
    try expectProposal(card.proposal, equals: proposal)
    #expect(gym.proposals.count == 1 && card.pending && !card.decidable && card.decision(stalled: false).title == "Removing…")
    #expect(try runtime.runner.read(Gym.scope) { try $0.confirmed(Proposal.self, proposal.id).map { try Proposal(Fields($0)).state } } == "pending")
    fault.point.withLock { $0 = .beforeCommit(.results) }
    await transport.delivery.release()
    try await settle { runtime.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
    gym.refresh()
    #expect(gym.coachRemovalReceipts.first?.outcome == .pending && card.pending)
    #expect(try runtime.runner.read(Gym.scope) { try $0.commands().count } == 1)
    fault.point.withLock { $0 = nil }
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return !card.pending && (refused ? !gym.notices.isEmpty : card.proposal?.state == "applied") }
    let answer = try #require(card.proposal)
    #expect(gym.sets == logged && gym.sessions.map(\.id) == [ID<Session>("removal-session")])
    #expect(gym.sessions.first?.plan == SessionPlan(routine))
    if refused {
      try expectProposal(answer, equals: proposal)
      #expect(gym.routines == [routine] && card.decidable)
      #expect(answer.settledAt == nil && !gym.notices.isEmpty)
      #expect(card.failure == "Not applied." && card.decision(stalled: false).title == "Try again")
    } else {
      #expect(answer.state == "applied" && answer.intent == "remove" && answer.settledAt == nil)
      #expect(answer.summary == proposal.summary && answer.changes == proposal.changes && answer.baseName == routine.name)
      #expect(gym.routines.isEmpty && gym.routineProposals.isEmpty && !card.decidable)
      #expect(try runtime.runner.read(Gym.scope) { try $0.confirmed(Proposal.self, proposal.id) } == nil)
      gym.refresh()
      try expectProposal(gym.proposals.first, equals: answer)
      #expect(gym.proposals.count == 1)
      let cold = GymModel(runner: runtime.runner, runtime: runtime)
      #expect(cold.proposals.first?.state == "applied" && cold.sets == logged && cold.routines.isEmpty)
      #expect(cold.coachRemovalReceipts.count == 1)
    }
    let window = UIWindow(frame: UIScreen.main.bounds)
    let host = RemovalReceiptHost(rootView: card.environment(\.scenePhase, .background))
    window.rootViewController = host; window.makeKeyAndVisible()
    defer { window.isHidden = true }
    try await settle { host.appeared }
    #expect(try runtime.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).count } == 1)
    fault.point.withLock { $0 = .beforeCommit(.commit) }
    host.rootView = card.environment(\.scenePhase, .active)
    try await settle { telemetry.entries.withLock { $0.contains { $0.name == "client_error" && $0.properties["operation"] == "gym_action" } } }
    #expect(try runtime.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).count } == 1)
    fault.point.withLock { $0 = nil }
    window.rootViewController = nil
    window.rootViewController = RemovalReceiptHost(rootView: card.environment(\.scenePhase, .active))
    try await settle { (try? runtime.runner.read(Gym.scope) { try RoutineRemovalReceipt.read($0).isEmpty }) == true }
    #expect(card.proposal?.state == (refused ? "pending" : "applied"))
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
      let card = ProposalCard(gym: gym, id: proposal.id.description)
      if !resolvedBeforeRelaunch {
        #expect(card.proposal?.state == "pending" && card.pending)
        #expect(gym.coachDecideProposal(proposal, apply: true))
        #expect(try reopened.runner.read(Gym.scope) { try $0.commands().count } == 1)
        transport.failure.withLock { $0 = nil }
        await reopened.engine.flushOnLeave(); reopened.engine.foreground()
      }
      try await settle {
        gym.refresh()
        return gym.coachRemovalReceipts.first?.outcome == (refused ? .refused : .applied) &&
          (try? reopened.runner.read(Gym.scope) { try $0.commands().isEmpty }) == true
      }
      #expect(gym.routines.count == (refused ? 1 : 0))
      #expect(card.proposal?.state == (refused ? "pending" : "applied") && !card.pending)
      #expect(gym.coachRemovalReceipts.first?.outcome == (refused ? .refused : .applied))
      #expect(card.proposal?.summary == proposal.summary && card.proposal?.baseName == proposal.baseName)
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
    let card = ProposalCard(gym: gym, id: pending.id.description)
    transport.failure.withLock { $0 = 503 }
    #expect(gym.coachDecideProposal(pending, apply: true))
    try await settle { runtime.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
    gym.refresh()
    try expectProposal(card.proposal, equals: pending)
    #expect(gym.proposals.count == 1 && card.pending && !card.decidable)
    #expect(card.proposal?.settledAt == nil && gym.routines.isEmpty)

    transport.failure.withLock { $0 = nil }
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.state == "applied" && !card.pending }
    #expect(gym.proposals.first?.state == "applied" && gym.proposals.first?.settledAt == nil && !card.decidable)
    _ = try await runtime.engine.signOut().finish(.keep)
    gym.refresh()
    #expect(gym.proposals.isEmpty && gym.account == nil)
    let other = transport.model.identity(email: "removal-other@example.com")
    #expect(try await runtime.engine.signIn(account: other.account, token: other.token).isComplete)
    gym.refresh()
    #expect(gym.proposals.isEmpty && gym.account == other.account && card.proposal == nil)
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
      #expect(ProposalCard(gym: gym, id: pending.id.description).stance == .rejected, "A rejection settles its card at once")
      h.sync(); gym.refresh()
      #expect(gym.proposals.first?.state == "dismissed")
    }
    #expect(gym.run(DeleteRoutine(routine.id))?.receipt != nil)
    h.leave(); h.sync(); gym.refresh()
    #expect(gym.routines.isEmpty && gym.proposals.isEmpty)
  }
  @Test func connectedCredentialsFilterScopesAndUseCreationDates() throws {
    let grants = Data(#"{"grants":[{"clientId":"a","name":" Claude ","grantedMs":1790448120000,"scope":"gym:delete gym:read"},{"clientId":"b","name":"Roadmap","grantedMs":1790448120000,"scope":"roadmap:read"},{"clientId":"c","grantedMs":1792152000000,"scope":""}]}"#.utf8)
    let keys = Data(#"{"keys":[{"id":"k","createdMs":1758888000000,"name":""}]}"#.utf8)
    let rows = try CoachConnection.decode(grants: grants, keys: keys)
    let dates = GymDate(Moment(now: Instant(ms: 1_792_152_000_000), zone: FixedZone(offsetSeconds: 0)), locale: Locale(identifier: "en_US"))
    #expect(rows.map(\.name) == ["Claude", "A connected tool", "A static key"])
    #expect(rows.map { $0.meta(dates) } == ["read · delete · since Sep 26", "whole account · since today", "API key · whole account · since Sep 26, 2025"])
    #expect(throws: DecodingError.self) { try CoachConnection.decode(grants: grants, keys: Data("{}".utf8)) }
  }
  // An out-of-date proposal has no Apply and no Reject: the card says once why nothing was applied — a newer one
  // took its place, the log set it aside when its routine changed there, or its routine moved here and the log has not
  // confirmed it yet. Each routine is its own case, in one store.
  @Test func anOutOfDateProposalSaysWhyWhereApplyStood() throws {
    let (h, gym) = fixture()
    for (id, name) in [("stale-bench", "Bench"), ("stale-squat", "Squat")] {
      gym.run(CreateExercise(Exercise(id: ID(RecordID(id)), name: name, pattern: "press", equipment: "barbell", stepKg: 2.5)))
    }
    let routines = ["current", "replaced", "outrun", "unsent", "applied", "dismissed"].map { name in
      Routine(id: ID(RecordID("stale-" + name)), name: "Push " + name, entries: [RoutineEntry(exerciseId: ID("stale-bench"))])
    }
    for routine in routines { var draft = Draft(new: routine); #expect(saved(gym.save(&draft))) }
    h.sync(); gym.refresh()
    let proposed = zip(routines + [routines[1]], ["current", "replaced", "outrun", "unsent", "applied", "dismissed", "replacement"]).map { routine, id in
      gym.run(ProposeRoutine(id: ID(RecordID("proposal-" + id)), routineId: routine.id, name: routine.name + " 2", entries: routine.entries, summary: "Rename"))?.receipt != nil
    }
    #expect(proposed == Array(repeating: true, count: 7))
    h.sync(); gym.refresh()
    var outrun = try #require(try h.runner.open(routines[2].id)); outrun.current.name = "Push outrun B"
    #expect(saved(gym.save(&outrun)))
    #expect(gym.coachDecideProposal(try #require(gym.proposals.first { $0.id == ID("proposal-applied") }), apply: true))
    #expect(gym.coachDecideProposal(try #require(gym.proposals.first { $0.id == ID("proposal-dismissed") }), apply: false))
    h.sync(); gym.refresh()
    var unsent = try #require(try h.runner.open(routines[3].id)); unsent.current.entries.append(RoutineEntry(exerciseId: ID("stale-squat")))
    #expect(saved(gym.save(&unsent)))
    gym.refresh()
    let ids = ["current", "replaced", "outrun", "unsent", "applied", "dismissed"]
    let proposals = try ids.map { id in try #require(gym.proposals.first { $0.id == ID(RecordID("proposal-" + id)) }) }
    let cards = ids.map { ProposalCard(gym: gym, id: "proposal-" + $0) }
    #expect(proposals.map(\.state) == ["pending", "superseded", "superseded", "pending", "applied", "dismissed"])
    #expect(proposals.map(gym.coachProposalOutOfDate) == [false, true, true, true, false, false])
    #expect(cards.map { $0.outOfDate ?? "-" } == ["-", "A newer suggestion replaced this one. Nothing was applied.",
      "Push outrun changed after this suggestion. Nothing was applied.", "Push unsent changed after this suggestion. Nothing was applied.", "-", "-"])
    #expect(cards.map(\.stance) == [.open, .outOfDate(.replaced), .outOfDate(.routineChanged), .outOfDate(.routineChanged), .applied, .rejected])
    #expect(cards.map(\.decidable) == [true, false, false, false, false, false])
    #expect(Set(gym.routineProposals.map(\.id)) == [ID("proposal-current"), ID("proposal-replacement")])
  }
  @Test func aProposalBecomesUnavailableWhenItsRoutineDeletionIsConfirmed() throws {
    let (h, gym) = fixture()
    for (id, name) in [("deleted-bench", "Bench"), ("deleted-squat", "Squat"), ("deleted-deadlift", "Deadlift")] {
      gym.run(CreateExercise(Exercise(id: ID(RecordID(id)), name: name, pattern: "press", equipment: "barbell", stepKg: 2.5)))
    }
    var routine = Draft(new: Routine(id: ID("deleted-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("deleted-bench"))]))
    #expect(saved(gym.save(&routine)))
    h.sync(); gym.refresh()
    #expect(try h.runner.run(ProposeRoutine(id: ID("deleted-proposal"), routineId: routine.id, name: "Push B", entries: [RoutineEntry(exerciseId: ID("deleted-squat"))], summary: "Change")).receipt != nil)
    h.sync(); gym.refresh()
    let proposal = try #require(gym.proposals.first)
    let card = ProposalCard(gym: gym, id: proposal.id.description)
    #expect(gym.routineProposals.map(\.id) == [proposal.id] && card.decidable)
    let deleted = try #require(gym.run(DeleteRoutine(routine.id))?.receipt)
    gym.refresh()
    #expect(gym.routines.isEmpty && gym.routineProposals.isEmpty && gym.coachProposalOutOfDate(proposal))
    #expect(!card.decidable)
    #expect(card.outOfDate == "Push A changed after this suggestion. Nothing was applied.")
    #expect(!gym.coachDecideProposal(proposal, apply: true) && gym.proposals.first?.state == "pending")
    #expect(deleted.releaseAt == nil)
    h.sync(); gym.refresh()
    #expect(gym.routineProposals.isEmpty)
    #expect(gym.proposals.isEmpty)
    #expect(card.proposal == nil)
    #expect(card.outOfDate == nil)
    #expect(!card.decidable)
  }
  // An edit the log has not confirmed moves the routine under a waiting proposal: it is out of date at once, Apply is not
  // offered, and the lifter's edit stands after the log answers.
  @Test func aProposalOverAnEditTheLogHasNotConfirmedIsOutOfDate() throws {
    let (h, gym) = fixture()
    for (id, name) in [("edited-bench", "Bench"), ("edited-squat", "Squat"), ("edited-deadlift", "Deadlift")] {
      gym.run(CreateExercise(Exercise(id: ID(RecordID(id)), name: name, pattern: "press", equipment: "barbell", stepKg: 2.5)))
    }
    var routine = Draft(new: Routine(id: ID("edited-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("edited-bench"))]))
    #expect(saved(gym.save(&routine)))
    h.sync(); gym.refresh()
    #expect(try h.runner.run(ProposeRoutine(id: ID("edited-proposal"), routineId: routine.id, name: "Push B", entries: [RoutineEntry(exerciseId: ID("edited-squat"))], summary: "Change")).receipt != nil)
    h.sync(); gym.refresh()
    let proposal = try #require(gym.proposals.first)
    var edit = try #require(try h.runner.open(routine.id)); edit.current.entries.append(RoutineEntry(exerciseId: ID("edited-deadlift")))
    #expect(saved(gym.save(&edit)))
    gym.refresh()
    let card = ProposalCard(gym: gym, id: proposal.id.description)
    #expect(gym.routines.first?.revision == proposal.baseRevision && gym.coachProposalOutOfDate(proposal))
    #expect(gym.routineProposals.isEmpty && !card.decidable)
    #expect(card.outOfDate == "Push A changed after this suggestion. Nothing was applied.")
    #expect(!gym.coachDecideProposal(proposal, apply: true))
    h.sync(); gym.refresh()
    #expect(gym.routines.first?.entries.map(\.exerciseId) == [ID("edited-bench"), ID("edited-deadlift")] && gym.notices.isEmpty)
    #expect(gym.proposals.first?.state == "superseded" && gym.coachProposalOutOfDate(proposal))
  }
  // A removal's answer is recorded once: a launch after it lands, before the lifter sees its card, records nothing more.
  @Test(arguments: [false, true])
  func aSettledRemovalIsRecordedOnceAcrossLaunches(refused: Bool) throws {
    let (h, _) = fixture(), first = TelemetryRecorder()
    let gym = GymModel(runner: h.runner, telemetry: first); gym.account = "coach-owner"
    gym.run(CreateExercise(Exercise(id: ID("recorded-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routine = Draft(new: Routine(id: ID("recorded-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("recorded-bench"))]))
    #expect(saved(gym.save(&routine)))
    h.sync(); gym.refresh()
    #expect(try h.runner.run(ProposeRoutine(id: ID("recorded-removal"), routineId: routine.id, name: "", entries: [], summary: "Remove", removing: true)).receipt != nil)
    h.sync(); gym.refresh()
    #expect(gym.coachDecideProposal(try #require(gym.proposals.first), apply: true))
    if refused { h.server.refuse(code: .invalid) }
    h.sync(); gym.refresh(); gym.refresh()
    let outcomes = { (recorder: TelemetryRecorder) in
      recorder.entries.withLock { $0.filter { $0.name == "gym_proposal_outcome" }.map { $0.properties["outcome"] ?? "-" } }
    }
    #expect(gym.coachRemovalReceipts.map(\.outcome) == [refused ? .refused : .applied])
    #expect(outcomes(first) == [refused ? "failed" : "decided"])
    for _ in 0..<2 {
      let relaunch = TelemetryRecorder(), cold = GymModel(runner: h.runner, telemetry: relaunch)
      cold.refresh()
      #expect(cold.coachRemovalReceipts.count == 1 && outcomes(relaunch).isEmpty)
    }
  }
  // Retry records what its push met, not the phone's network: no answer at all is offline, a failure the log answered is
  // failed.
  @Test(arguments: [(0, "offline"), (503, "failed")])
  func aRetryRecordsWhatItsPushMet(status: Int, outcome: String) async throws {
    let transport = WorkoutFaultTransport(), telemetry = TelemetryRecorder(), runtime = try WorkoutStateTests.faultRuntime(transport, drivesLoops: true)
    let owner = transport.model.identity(email: "retry-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime.engine.start()
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry)
    defer { gym.stop() }
    var routine = Draft(new: Routine(id: ID("retry-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect(saved(gym.save(&routine)))
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.routines.first?.revision != nil }
    #expect(gym.run(ProposeRoutine(id: ID("retry-change"), routineId: routine.id, name: "Push B", entries: [RoutineEntry(exerciseId: ID("bench-press"))], summary: "Rename it."))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.baseRevision != nil }
    transport.failure.withLock { $0 = status }
    #expect(gym.coachDecideProposal(try #require(gym.proposals.first), apply: true))
    try await settle { runtime.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
    #expect(runtime.engine.status.online)
    // Only a push that got no answer says *No connection*; the log's own failure states no cause.
    #expect(ProposalCard(gym: gym, id: try #require(gym.proposals.first).id.description).failure == (outcome == "offline" ? "No connection. Not applied." : nil))
    let retries = { telemetry.entries.withLock { $0.filter { $0.name == "gym_proposal_outcome" && $0.properties["action"] == "retry" }.map(\.properties) } }
    gym.coachResendDecision(try #require(gym.proposals.first).id)
    try await settle { !retries().isEmpty }
    #expect(retries() == [["screen": "coach", "target": "routine", "action": "retry", "outcome": outcome]])
  }
  // A move reads its places against the routine while the proposal waits; once applied the routine holds the new order, so
  // the applied card keeps the blocks the phone read while it waited.
  @Test func aMoveReadsItsPlacesWhileTheProposalWaits() throws {
    let (h, gym) = fixture()
    for (id, name) in [("order-squat", "Squat"), ("order-row", "Row")] {
      gym.run(CreateExercise(Exercise(id: ID(RecordID(id)), name: name, pattern: "squat", equipment: "barbell", stepKg: 2.5)))
    }
    var routine = Draft(new: Routine(id: ID("order-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("order-squat")), RoutineEntry(exerciseId: ID("order-row"))]))
    #expect(saved(gym.save(&routine)))
    h.sync(); gym.refresh()
    gym.run(ProposeRoutine(id: ID("order-proposal"), routineId: routine.id, name: "Push A",
                           entries: [RoutineEntry(exerciseId: ID("order-row")), RoutineEntry(exerciseId: ID("order-squat"))], summary: "Row first"))
    h.sync(); gym.refresh()
    let lines = { (proposal: Proposal) in
      gym.coachDiff(proposal).blocks.map { block in ([block.kind.rawValue] + block.fields.map { "\($0.label) \($0.before ?? "-") → \($0.after ?? "-")" }).joined(separator: " | ") }
    }
    let pending = try #require(gym.proposals.first)
    #expect(lines(pending) == ["moved | Order 2nd → 1st"] && pending.changeCount == 1)
    #expect(gym.coachDecideProposal(pending, apply: true))
    h.sync(); gym.refresh()
    let applied = try #require(gym.proposals.first)
    #expect(applied.state == "applied" && gym.routines.first?.entries.map(\.exerciseId) == [ID<Exercise>("order-row"), ID<Exercise>("order-squat")])
    #expect(lines(applied) == ["moved | Order 2nd → 1st"] && gym.coachChangeCount(applied) == 1)
    #expect(ProposalDiff(applied, routine: gym.coachRoutine(applied)).blocks.isEmpty, "The routine no longer holds the order it replaced")
  }
  // The card reads the domain's blocks, named from the catalogue: the new name, the changed movements, removals, then
  // additions, with the movements it keeps folded into one count.
  @Test func aProposalsCardReadsItsChangesAsBlocks() throws {
    let (h, gym) = fixture()
    for (id, name) in [("card-squat", "Squat"), ("card-row", "Row"), ("card-curl", "Curl"), ("card-dips", "Dips"), ("card-bench", "Bench")] {
      gym.run(CreateExercise(Exercise(id: ID(RecordID(id)), name: name, pattern: "squat", equipment: "barbell", stepKg: 2.5)))
    }
    let plan = { (id: String, sets: [SetTarget]?, rest: Int?) in RoutineEntry(exerciseId: ID(RecordID(id)), sets: sets, restSeconds: rest) }
    var routine = Draft(new: Routine(id: ID("card-routine"), name: "Push A", entries: [
      plan("card-squat", [SetTarget(reps: 5, weightKg: 80)], 90), plan("card-row", [SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 8, weightKg: 60)], nil),
      plan("card-curl", [SetTarget(reps: 10, weightKg: 20), SetTarget(reps: 10, weightKg: 20)], nil),
      plan("card-dips", Array(repeating: SetTarget(reps: 8, weightKg: 40), count: 3), nil)]))
    #expect(saved(gym.save(&routine)))
    h.sync(); gym.refresh()
    _ = try h.runner.run(ProposeRoutine(id: ID("card-proposal"), routineId: routine.id, name: "Push A2", entries: [
      plan("card-squat", [SetTarget(reps: 3, weightKg: 90)], 120), plan("card-row", [SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 6, weightKg: 65)], 90),
      plan("card-curl", [SetTarget(reps: 10, weightKg: 20), SetTarget(reps: 10, weightKg: 20)], nil), plan("card-bench", nil, nil)], summary: "Triples"))
    _ = try h.runner.run(ProposeRoutine(id: ID("card-removal"), routineId: routine.id, name: "", entries: [], summary: "Remove", removing: true))
    h.sync(); gym.refresh()
    let revision = try #require(gym.proposals.first { $0.id == ID("card-proposal") })
    let card = ProposalCard(gym: gym, id: revision.id.record.string!)
    #expect(gym.coachDiff(revision).blocks.map { block in
      ([block.kind.rawValue, gym.coachTitle(block) ?? "-"] + block.fields.map { "\($0.label) \($0.before ?? "-") → \($0.after ?? "-")" }).joined(separator: " | ")
    } == ["renamed | - | Name Push A → Push A2",
          "changed | Squat | Sets 1 → 1 | Reps 5 → 3 | Load 80 kg → 90 kg | Rest 90 s → 2 min",
          "changed | Row | Set 1 8 × 60 kg → 8 × 60 kg | Set 2 8 × 60 kg → 6 × 65 kg | Rest Default → 90 s",
          "removed | Dips | Sets 3 → - | Reps 8 → - | Load 40 kg → -", "added | Bench | Target - → None"])
    #expect(gym.coachDiff(revision).unchanged == 1)
    #expect(gym.coachChangeCount(revision) == 5 && revision.changeCount == 5)
    let counted = Proposal(id: ID("counted"), routineId: routine.id, intent: "revise", proposedName: "Push A", summary: "", changes: [], changeCount: 7)
    let uncounted = Proposal(id: ID("uncounted"), routineId: routine.id, intent: "revise", proposedName: "Push A2", summary: "", changes: [])
    #expect(gym.coachChangeCount(counted) == 7 && gym.coachChangeCount(uncounted) == 1)
    #expect(card.decision(stalled: false).title == "Apply")
    let removal = try #require(gym.proposals.first { $0.id == ID("card-removal") })
    #expect(gym.coachDiff(removal).blocks.isEmpty)
    #expect(ProposalCard(gym: gym, id: removal.id.record.string!).decision(stalled: false).title == "Remove routine")
  }
  // A decision's stall is recorded once, however many waits run out on it — a Retry's own, or its card drawn again; a
  // decision made again after the log refused the first stalls afresh.
  @Test func aDecisionRecordsItsStallOnceHoweverManyWaitsRunOut() throws {
    let (h, _) = fixture(), telemetry = TelemetryRecorder()
    let gym = GymModel(runner: h.runner, telemetry: telemetry); gym.account = "coach-owner"
    gym.run(CreateExercise(Exercise(id: ID("stall-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routine = Draft(new: Routine(id: ID("stall-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("stall-bench"))]))
    #expect(saved(gym.save(&routine)))
    h.sync(); gym.refresh()
    #expect(gym.run(ProposeRoutine(id: ID("stall-proposal"), routineId: routine.id, name: "Push B", entries: routine.current.entries, summary: "Rename"))?.receipt != nil)
    h.sync(); gym.refresh()
    let proposal = try #require(gym.proposals.first)
    h.server.refuse(code: Gym.Codes.proposalSuperseded, detail: ["reason": "routine-changed"])
    #expect(gym.coachDecideProposal(proposal, apply: true))
    #expect((0..<3).map { _ in gym.coachDecisionStalled(proposal.id) } == [true, true, true])
    h.sync(); gym.refresh()
    #expect(gym.proposals.first?.state == "pending" && !gym.coachDecisionStalled(proposal.id))
    #expect(gym.coachDecideProposal(try #require(gym.proposals.first), apply: true))
    #expect((0..<2).map { _ in gym.coachDecisionStalled(proposal.id) } == [true, true])
    h.sync(); gym.refresh()
    #expect(gym.proposals.first?.state == "applied")
    #expect(telemetry.entries.withLock { $0.filter { $0.name == "gym_proposal_outcome" }.map(\.properties) }
            == ["stalled", "failed", "stalled", "decided"].map { ["screen": "coach", "target": "routine", "action": "apply", "outcome": $0] })
  }
  // An Apply the log refused leaves the card on the lifter again: one line over its buttons says nothing was applied, and
  // Apply reads Try again, which decides afresh.
  @Test func aRefusedApplySaysSoOverItsButtonsAndTryAgainDecidesAfresh() throws {
    let (h, gym) = fixture()
    gym.run(CreateExercise(Exercise(id: ID("refused-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routine = Draft(new: Routine(id: ID("refused-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("refused-bench"))]))
    #expect(saved(gym.save(&routine)))
    h.sync(); gym.refresh()
    #expect(gym.run(ProposeRoutine(id: ID("refused-proposal"), routineId: routine.id, name: "Push B", entries: routine.current.entries, summary: "Rename"))?.receipt != nil)
    h.sync(); gym.refresh()
    let card = ProposalCard(gym: gym, id: "refused-proposal")
    #expect(gym.coachDecideProposal(try #require(gym.proposals.first), apply: true))
    #expect(card.pending && card.failure == nil && card.decision(stalled: false).title == "Applying…")
    h.server.refuse(code: .invalid)
    h.sync(); gym.refresh()
    #expect(card.stance == .open && !card.pending && card.decidable)
    #expect(card.failure == "Not applied." && card.decision(stalled: false).title == "Try again")
    #expect(gym.coachDecideProposal(try #require(gym.proposals.first), apply: true))
    #expect(card.pending && card.failure == nil && card.decision(stalled: false).title == "Applying…")
    h.sync(); gym.refresh()
    #expect(card.stance == .applied && card.failure == nil && gym.routines.first?.name == "Push B")
  }
  // Only an Apply this phone sent that the log took lands, with the bounce and the haptic: one refused before it was sent,
  // one the log refused and one applied elsewhere settle without them.
  @Test func onlyAnApplyThisPhoneSentAndTheLogTookLands() throws {
    let (h, gym) = fixture(), elsewhere = GymModel(runner: h.runner)
    elsewhere.account = "coach-owner"
    gym.run(CreateExercise(Exercise(id: ID("landed-bench"), name: "Bench", pattern: "press", equipment: "barbell", stepKg: 2.5)))
    var routines = ["push", "pull"].map { Draft(new: Routine(id: ID(RecordID("landed-" + $0)), name: $0.capitalized, entries: [RoutineEntry(exerciseId: ID("landed-bench"))])) }
    for index in routines.indices { #expect(saved(gym.save(&routines[index]))) }
    h.sync(); gym.refresh()
    #expect(gym.run(ProposeRoutine(id: ID("landed-here"), routineId: routines[0].id, name: "Push B", entries: routines[0].current.entries, summary: "Rename"))?.receipt != nil)
    #expect(gym.run(ProposeRoutine(id: ID("landed-elsewhere"), routineId: routines[1].id, name: "Pull B", entries: routines[1].current.entries, summary: "Rename"))?.receipt != nil)
    h.sync(); gym.refresh(); elsewhere.refresh()
    let here = ProposalCard(gym: gym, id: "landed-here"), applied = ProposalCard(gym: gym, id: "landed-elsewhere")
    let proposal = { (id: String) in try #require(gym.proposals.first { $0.id == ID(RecordID(id)) }) }
    #expect(!here.pending && !here.landed && here.failure == nil)
    #expect(gym.coachDecideProposal(try proposal("landed-here"), apply: true))
    h.server.refuse(code: .invalid)
    h.sync(); gym.refresh()
    #expect(here.stance == .open && !here.landed && here.failure == "Not applied.")
    #expect(elsewhere.coachDecideProposal(try #require(elsewhere.proposals.first { $0.id == ID("landed-elsewhere") }), apply: true))
    h.sync(); gym.refresh()
    #expect(applied.stance == .applied && !applied.landed)
    #expect(gym.coachDecideProposal(try proposal("landed-here"), apply: true))
    #expect(here.pending && !here.landed)
    h.sync(); gym.refresh()
    #expect(here.stance == .applied && here.landed && gym.landedCoachApplies == [ID("landed-here")])
  }
  // The refusal the engine keeps as a notice names its cause, and the card says that cause over its buttons.
  @Test func aRefusedApplySaysTheCauseItsNoticeNames() async throws {
    let transport = WorkoutFaultTransport(), runtime = try WorkoutStateTests.faultRuntime(transport, drivesLoops: true)
    let owner = transport.model.identity(email: "refused-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime.engine.start()
    let gym = GymModel(runner: runtime.runner, runtime: runtime)
    defer { gym.stop() }
    var routine = Draft(new: Routine(id: ID("noticed-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect(saved(gym.save(&routine)))
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.routines.first?.revision != nil }
    #expect(gym.run(ProposeRoutine(id: ID("noticed-change"), routineId: routine.id, name: "Push B", entries: [RoutineEntry(exerciseId: ID("bench-press"))], summary: "Rename it."))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.baseRevision != nil }
    let card = ProposalCard(gym: gym, id: "noticed-change")
    transport.model.state.withLock { $0.server.refuse(code: Gym.Codes.proposalSuperseded, detail: ["reason": "routine-changed"]) }
    #expect(gym.coachDecideProposal(try #require(gym.proposals.first), apply: true))
    try await settle { gym.refresh(); return !card.pending && !gym.notices.isEmpty }
    #expect(card.stance == .open && card.decidable)
    #expect(card.failure == "Push A changed after this suggestion. Not applied." && card.decision(stalled: false).title == "Try again")
  }
  // A refused Apply says only the cause its refusal names, then that nothing was applied.
  @Test func aRefusedApplyNamesOnlyTheCauseItsRefusalKnows() {
    let refusal = { (code: RefusalCode, subject: RecordRef?, detail: JSON?) in GymRefusal(Refused(code, subject: subject, detail: detail, path: .notice)) }
    let proposal = ID<Proposal>("refused").ref, routine = ID<Routine>("refused").ref
    let refusals: [GymRefusal?] = [
      refusal(Gym.Codes.proposalSuperseded, proposal, ["reason": "routine-changed"]), refusal(Gym.Codes.proposalSuperseded, proposal, ["reason": "replaced"]),
      refusal(Gym.Codes.proposalSuperseded, proposal, ["reason": "superseded"]), refusal(Gym.Codes.proposalSettled, proposal, ["state": "applied"]),
      refusal(.unknownRecord, routine, nil), refusal(.unknownRecord, proposal, nil),
      refusal(.invalid, proposal, nil), nil]
    #expect(refusals.map { CoachCopy.notApplied($0, routine: "Push A") } == [
      "Push A changed after this suggestion. Not applied.", "A newer suggestion replaced this one. Not applied.",
      "This suggestion is out of date. Not applied.", "This suggestion was already answered. Not applied.",
      "Push A is no longer in your program. Not applied.", "Not applied.",
      "Not applied.", "Not applied."])
  }
  @Test func waitingDecisionSaysSoAfterItsWaitAndRetryPushesTheSameCommand() async throws {
    let transport = WorkoutFaultTransport(), telemetry = TelemetryRecorder(), runtime = try WorkoutStateTests.faultRuntime(transport, drivesLoops: true)
    let owner = transport.model.identity(email: "removal-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime.engine.start()
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry)
    defer { gym.stop() }
    var routine = Draft(new: Routine(id: ID("waiting-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect(saved(gym.save(&routine)))
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.routines.first?.revision != nil }
    #expect(gym.run(ProposeRoutine(id: ID("waiting-removal"), routineId: routine.id, name: "", entries: [], summary: "Remove this routine.", removing: true))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.baseRevision != nil }
    let proposal = try #require(gym.proposals.first)
    transport.failure.withLock { $0 = 503 }
    #expect(gym.coachDecideProposal(proposal, apply: true))
    try await settle { runtime.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
    let card = ProposalCard(gym: gym, id: proposal.id.description, stallAfter: .milliseconds(200))
    #expect(card.pending && gym.coachQueuedDecision(proposal.id) == .apply)
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = RemovalReceiptHost(rootView: card.environment(\.scenePhase, .active)); window.makeKeyAndVisible()
    defer { window.isHidden = true; window.rootViewController = nil }
    let outcomes = { telemetry.entries.withLock { $0.filter { $0.name == "gym_proposal_outcome" }.map(\.properties) } }
    #expect(card.decision(stalled: false) == .init(title: "Removing…", retries: false, applies: false, rejects: false))
    try await settle { outcomes().contains(["screen": "coach", "target": "routine", "action": "apply", "outcome": "stalled"]) }
    #expect(card.decision(stalled: gym.coachDecisionStalled(proposal.id)) == .init(title: "Try again", retries: true, applies: true, rejects: false))
    #expect(card.failure == nil, "A wait the log answered with a failure, online, states no cause")
    transport.failure.withLock { $0 = nil }
    gym.coachResendDecision(proposal.id)
    try await settle { gym.refresh(); return !card.pending && outcomes().count == 3 }
    #expect(gym.proposals.first?.state == "applied" && gym.routines.isEmpty)
    #expect(try runtime.runner.read(Gym.scope) { try $0.commands().isEmpty })
    #expect(outcomes().first == ["screen": "coach", "target": "routine", "action": "apply", "outcome": "stalled"])
    #expect(Set(outcomes().dropFirst()) == [["screen": "coach", "target": "routine", "action": "retry", "outcome": "ok"], ["screen": "coach", "target": "routine", "action": "apply", "outcome": "decided"]])
  }
  @Test(arguments: [true, false])
  func aDecisionIsRecordedWhenTheLogsAnswerArrivesNotWhenItsPushEnds(apply: Bool) async throws {
    let transport = WorkoutFaultTransport(), telemetry = TelemetryRecorder()
    let runtime = try WorkoutStateTests.faultRuntime(transport, drivesLoops: true)
    let owner = transport.model.identity(email: "decided-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime.engine.start()
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry)
    defer { gym.stop() }
    var routine = Draft(new: Routine(id: ID("decided-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect(saved(gym.save(&routine)))
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.routines.first?.revision != nil }
    #expect(gym.run(ProposeRoutine(id: ID("decided-change"), routineId: routine.id, name: "Push B", entries: [RoutineEntry(exerciseId: ID("bench-press"))], summary: "Rename it."))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.baseRevision != nil }
    let proposal = try #require(gym.proposals.first)
    transport.pullDelay.withLock { $0 = .milliseconds(600) }
    let outcomes = { telemetry.entries.withLock { $0.filter { $0.name == "gym_proposal_outcome" }.map(\.properties) } }
    #expect(gym.coachDecideProposal(proposal, apply: apply))
    try await settle { gym.refresh(); return gym.proposals.first?.state == (apply ? "applied" : "dismissed") && !outcomes().isEmpty }
    try await Task.sleep(for: .milliseconds(300)); gym.refresh()
    #expect(outcomes() == [["screen": "coach", "target": "routine", "action": apply ? "apply" : "reject", "outcome": "decided"]])
  }
  // A change to this workout rewrites the running plan and no routine, its outcome recorded once the log answers; a later
  // change goes out of date once a set lands on a movement it changes, and its card names the movement.
  @Test func aWorkoutProposalRewritesTheRunningPlanAndNoRoutine() async throws {
    let transport = WorkoutFaultTransport(), telemetry = TelemetryRecorder()
    let runtime = try WorkoutStateTests.faultRuntime(transport, drivesLoops: true)
    let owner = transport.model.identity(email: "workout-proposal-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime.engine.start()
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry)
    defer { gym.stop() }
    let bench = RoutineEntry(exerciseId: ID("dumbbell-bench-press"), sets: [SetTarget(reps: 8, weightKg: 16)], restSeconds: 120)
    let row = RoutineEntry(exerciseId: ID("seated-cable-row"), sets: [SetTarget(reps: 10, weightKg: 50)])
    var routine = Draft(new: Routine(id: ID("upper-routine"), name: "Upper A", entries: [bench, row]))
    #expect(saved(gym.save(&routine)))
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.routines.first?.revision != nil }
    let session = gym.runner.mint(Session.self)
    #expect(gym.run(StartSession(id: session, routineId: routine.id))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.openSession?.plan != nil && gym.openSession?.routineRevision != nil }
    let lighter = [bench, RoutineEntry(exerciseId: ID("seated-cable-row"), sets: [SetTarget(reps: 12, weightKg: 40)], restSeconds: 120)]
    #expect(gym.run(ProposeWorkout(id: ID("lighter-row-change"), sessionId: session, entries: lighter, summary: ""))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.workoutProposals.first?.baseRevision == 1 }
    let proposal = try #require(gym.workoutProposals.first)
    #expect(gym.coachWorkoutProposalStance(proposal) == .open && gym.coachWorkoutChangeCount(proposal) == 1)
    let diff = gym.coachWorkoutDiff(proposal)
    #expect(diff.blocks.map(\.kind) == [.changed] && diff.unchanged == 1)
    #expect(diff.blocks.first?.fields == [ProposalDiff.Field("Sets", before: "1", after: "1"), ProposalDiff.Field("Reps", before: "10", after: "12"), ProposalDiff.Field("Load", before: "50 kg", after: "40 kg"),
                                          ProposalDiff.Field("Rest", before: "Default", after: "2 min")])
    let outcomes = { telemetry.entries.withLock { $0.filter { $0.name == "gym_proposal_outcome" }.map(\.properties) } }
    #expect(gym.coachDecideWorkoutProposal(proposal, apply: true))
    #expect(gym.openSession?.plan?.entries == lighter, "Apply rewrites the running plan at once")
    try await settle { gym.refresh(); return !outcomes().isEmpty }
    #expect(outcomes() == [["screen": "coach", "target": "workout", "action": "apply", "outcome": "decided"]])
    #expect(gym.workoutProposals.first.map(gym.coachWorkoutProposalStance) == .applied)
    #expect(gym.openSession?.plan?.entries == lighter && gym.openSession?.planRevision == 2)
    #expect(gym.routines.first?.entries == [bench, row], "No routine changes")
    let again = [bench, RoutineEntry(exerciseId: ID("seated-cable-row"), sets: [SetTarget(reps: 12, weightKg: 35)], restSeconds: 120)]
    #expect(gym.run(ProposeWorkout(id: ID("lighter-again"), sessionId: session, entries: again, summary: ""))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.workoutProposals.first { $0.id == ID("lighter-again") }?.baseRevision == 2 }
    #expect(gym.run(AppendSet(TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: session, exerciseId: ID("seated-cable-row"), weightKg: 40, reps: 12,
                                          completedAt: gym.dates.moment.now)))?.receipt != nil)
    gym.refresh()
    let stale = try #require(gym.workoutProposals.first { $0.id == ID("lighter-again") })
    #expect(gym.coachWorkoutProposalStance(stale) == .outOfDate(.workoutMoved(ID("seated-cable-row"))))
    #expect(CoachCopy.outOfDateReason(.workoutMoved(ID("seated-cable-row")), routine: "Upper A", catalogue: gym.catalogue)
            == "You logged Seated Cable Row since this suggestion. Nothing was applied.")
    #expect(!gym.coachDecideWorkoutProposal(stale, apply: true) && gym.openSession?.plan?.entries == lighter)
  }

  @Test(arguments: [false, true])
  func retryRecordsWhetherTheLogTookTheDecision(offline: Bool) async throws {
    let connectivity = SwitchedConnectivity(), transport = WorkoutFaultTransport(), telemetry = TelemetryRecorder()
    let runtime = try WorkoutStateTests.faultRuntime(transport, connectivity: connectivity, drivesLoops: true)
    let owner = transport.model.identity(email: "retry-owner@example.com")
    #expect(try await runtime.engine.signIn(account: owner.account, token: owner.token).isComplete)
    await runtime.engine.start()
    let gym = GymModel(runner: runtime.runner, runtime: runtime, telemetry: telemetry)
    defer { gym.stop() }
    var routine = Draft(new: Routine(id: ID("retry-routine"), name: "Push A", entries: [RoutineEntry(exerciseId: ID("bench-press"))]))
    #expect(saved(gym.save(&routine)))
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.routines.first?.revision != nil }
    #expect(gym.run(ProposeRoutine(id: ID("retry-removal"), routineId: routine.id, name: "", entries: [], summary: "Remove this routine.", removing: true))?.receipt != nil)
    await runtime.engine.flushOnLeave(); runtime.engine.foreground()
    try await settle { gym.refresh(); return gym.proposals.first?.baseRevision != nil }
    let proposal = try #require(gym.proposals.first)
    transport.failure.withLock { $0 = 503 }
    #expect(gym.coachDecideProposal(proposal, apply: true))
    try await settle { runtime.engine.status.failedPushes[Gym.scope]?.isEmpty == false }
    if offline {
      transport.failure.withLock { $0 = 0 }
      connectivity.set(online: false)
      try await settle { runtime.engine.status.online == false }
    }
    #expect(try runtime.runner.read(Gym.scope) { try GymModel.queuedDecision(proposal.id, in: $0)?.isAdmitted } == false)
    let retries = { telemetry.entries.withLock { $0.filter { $0.name == "gym_proposal_outcome" && $0.properties["action"] == "retry" }.map(\.properties) } }
    gym.coachResendDecision(proposal.id)
    try await settle { !retries().isEmpty }
    try await Task.sleep(for: .milliseconds(200))
    #expect(retries() == [["screen": "coach", "target": "routine", "action": "retry", "outcome": offline ? "offline" : "failed"]])
    #expect(gym.coachProposalAwaitingReceipt(proposal.id))
  }
  @Test func anUnreadableQueueReportsOnceAndCountsAsWaiting() throws {
    let fault = GymStoreFault(), telemetry = TelemetryRecorder()
    let gym = GymModel(runner: try GymModelTests().runtime(failing: fault, telemetry: telemetry).runner, telemetry: telemetry)
    fault.point.withLock { $0 = .read }
    #expect(gym.coachProposalAwaitingReceipt(ID("unreadable-proposal")) && gym.coachProposalAwaitingReceipt(ID("unreadable-proposal")))
    #expect(gym.coachQueuedDecision(ID("unreadable-proposal")) == .unreadable && gym.coachDecisionStalled(ID("unreadable-proposal")))
    #expect(telemetry.entries.withLock { $0.filter { ["client_error", "gym_proposal_outcome"].contains($0.name) }.map { [$0.name: $0.properties] } } == [
      ["client_error": ["operation": "gym_read", "failure_kind": "unexpected"]], ["gym_proposal_outcome": ["screen": "coach", "target": "routine", "outcome": "stalled"]]
    ])
    gym.proposals = [Proposal(id: ID("unreadable-proposal"), routineId: ID("unreadable-routine"), intent: "revise", proposedName: "Push A", summary: "", changes: [])]
    #expect(ProposalCard(gym: gym, id: "unreadable-proposal").decision(stalled: false).title == "Sending…")
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
  enum Reply: Sendable { case http(Int, String, String = "application/json"), partial(String), failure(URLError.Code), stalled }
  struct Request: Sendable, Equatable { let path: String; let method: String; let authorization: String?; let mediaType: String?; let body: Data?; var schema: String? = nil }
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
      state.requests.append(Request(path: request.url!.path, method: request.httpMethod!, authorization: request.value(forHTTPHeaderField: "Authorization"), mediaType: request.value(forHTTPHeaderField: "Content-Type"), body: body, schema: request.value(forHTTPHeaderField: "Sync-Schema")))
      state.active = self; state.activeByPath[request.url!.path] = self; return state.replies[request.url!.path] ?? state.reply
    }
    switch reply {
    case .http(let status, let body, let type): respond(status, body, type: type)
    case .partial(let body):
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
      if !body.isEmpty { client?.urlProtocol(self, didLoad: Data(body.utf8)) }
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
