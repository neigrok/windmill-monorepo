import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

private func refusal(_ status: Int, code: String = "", message: String) -> WindmillApiError {
    let body = code.isEmpty
        ? #"{"error":"\#(message)"}"#
        : #"{"error":"\#(message)","code":"\#(code)"}"#
    return .refused(status, Refusal(Data(body.utf8)))
}

private let storageFailure = refusal(500, message: "internal error")

@MainActor
final class TrainingStoreTests: XCTestCase {
    private var queueURL: URL!
    private var catalogURL: URL!
    private var localURL: URL!
    private var accountURL: URL!

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-\(UUID().uuidString).json")
        catalogURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-catalog-\(UUID().uuidString).json")
        localURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-local-\(UUID().uuidString).json")
        accountURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-account-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
        try? FileManager.default.removeItem(at: catalogURL)
        try? FileManager.default.removeItem(at: localURL)
        try? FileManager.default.removeItem(at: accountURL)
    }

    private func makeStore(sync: FakeTraining?,
                           mintSet: @escaping () -> String = { Ids.set() },
                           retryAfter: Duration = .seconds(4)) -> TrainingStore {
        var ms: Int64 = 1_000
        return TrainingStore(
            queue: SetQueue(url: queueURL, deviceHolds: nil),
            deviceCatalog: DeviceCatalog(url: catalogURL),
            accountCopy: AccountCopy(url: accountURL),
            localLog: LocalLog(url: localURL, deviceHolds: nil),
            now: { ms += 1; return ms },
            mintSession: { "ses_minted" },
            mintSet: mintSet,
            undoWindowMs: 0,
            retryAfter: retryAfter,
            sync: { _ in sync }
        )
    }

    private func queueOnDisk(of seat: String? = "u1") -> SetQueue {
        let held = SetQueue(url: queueURL, deviceHolds: nil)
        held.open(under: seat)
        return held
    }

    private func shelfOnDisk(of seat: String? = "u1") -> LocalLog {
        let held = LocalLog(url: localURL, deviceHolds: nil)
        held.open(under: seat)
        return held
    }

    // `verified: false` is the seat a launch with no signal stands on: the device's last-known user, whom
    // `/v1/me` could not confirm. A signed-out account is also the seat nobody has named YET, because the
    // room mounts before `/v1/me` answers.
    private func account(signedIn: Bool, id: String = "u1", verified: Bool = true) -> Account {
        Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: signedIn ? User(id: id, email: "\(id)@example.com", name: "Sam") : nil,
            verified: verified
        )
    }

    private func liveStore(_ server: FakeTraining,
                           movement: String = "bench-press",
                           plan: PlanSnapshot? = nil,
                           mintSet: @escaping () -> String = { Ids.set() },
                           retryAfter: Duration = .seconds(4)) async -> TrainingStore {
        server.open(Session(id: "ses_1", startedAtMs: 1_000, plan: plan))
        let store = makeStore(sync: server, mintSet: mintSet, retryAfter: retryAfter)
        await store.connect(to: account(signedIn: true))
        await store.choose(movement)
        return store
    }

    func testASetLoggedOfflineSurvivesARelaunchAndFlushesOnReconnect() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.online = false
        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(store.saveState, .blocked(.offline))
        XCTAssertEqual(store.saveState.line, "offline · saved here")
        XCTAssertEqual(store.sets.map(\.weightKg), [82.5], "the row is on screen — the device is holding it")
        XCTAssertEqual(queueOnDisk(of: "u1").pending.count, 1)

        server.online = true
        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5])
        XCTAssertEqual(relaunched.sets.map(\.setNumber), [1], "the log numbered it, so it is the log's now")
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty)
    }

    func testASetIdAlreadySpentIsMintedAgainAndLands() async {
        let server = FakeTraining()
        var ids = ["set_first", "set_second"]
        let store = await liveStore(server, mintSet: { ids.removeFirst() })

        var spent = false
        server.refuse = { _ in
            if spent { return nil }
            spent = true
            return refusal(409, code: "set-id-taken", message: "a sentence nobody has ever shipped")
        }
        await store.logSet(weightKg: 100, reps: 3)

        XCTAssertEqual(server.appended.map(\.id), ["set_first", "set_second"])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_second"])
        XCTAssertEqual(store.sets.map(\.id), ["set_second"])
        XCTAssertEqual(store.saveState, .onTheLog)
        XCTAssertTrue(store.refusals.isEmpty, "a repaired collision is not a loss and must not be said")
    }

    func testASetRefusedByAClosedSessionIsDroppedAndSaidOutLoud() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.refuse = { _ in refusal(409, code: "session-finished", message: "reworded on a Tuesday") }
        await store.logSet(weightKg: 60, reps: 10)

        XCTAssertTrue(store.sets.isEmpty, "a set that never landed is not drawn as though it had")
        XCTAssertEqual(store.refusals.map(\.reason), ["the session closed before this set reached it"])
        XCTAssertEqual(store.refusals.compactMap(\.set).map(\.exerciseId), ["bench-press"])
        XCTAssertEqual(store.refusals.compactMap(\.set).map(\.weightKg), [60])
        XCTAssertEqual(store.saveState.line, "the session closed before this set reached it")
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty)
    }

    func testAReplyThatNeverArrivedIsReplayedAndTheLogStillHoldsOneRow() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.swallowReplies = 1
        await store.logSet(weightKg: 82.5, reps: 5)
        XCTAssertEqual(store.saveState, .blocked(.offline))
        XCTAssertEqual(queueOnDisk(of: "u1").pending.count, 1)

        await store.flushPendingSets()

        XCTAssertEqual(server.appended.count, 2, "the same set went out twice")
        XCTAssertEqual(server.sets["ses_1"]?.count, 1, "and the log converged on one row")
        XCTAssertEqual(store.sets.map(\.setNumber), [1])
        XCTAssertEqual(store.saveState, .onTheLog)
    }

    func testFinishingSendsWhatIsOwedBeforeItClosesTheSession() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.online = false
        await store.logSet(weightKg: 100, reps: 5)
        await store.logSet(weightKg: 100, reps: 5)
        server.online = true

        let outcome = await store.finish()

        XCTAssertEqual(server.sets["ses_1"]?.count, 2)
        guard case .closed(let closed) = outcome else { return XCTFail("the session did not close: \(outcome)") }
        XCTAssertFalse(closed.isOpen)
        XCTAssertNil(store.session, "the room has nothing running once the log has answered")

        let landed = server.calls.lastIndex(of: "append")
        let finished = server.calls.firstIndex(of: "finish")
        XCTAssertNotNil(landed)
        XCTAssertNotNil(finished)
        XCTAssertTrue(landed! < finished!, "every set of this session is on the log before it closes")
    }

    func testFinishingIsRefusedWhileASetOfThisSessionIsStillOwed() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.online = false
        await store.logSet(weightKg: 100, reps: 5)
        let outcome = await store.finish()

        XCTAssertEqual(outcome, .stranded(1))
        XCTAssertFalse(server.calls.contains("finish"))
        XCTAssertNotNil(store.session, "the session stays open — a closed one could not take that set")
    }

    func testASetTappedWhileTheSessionIsClosingIsNotFiledIntoIt() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.onFinish = { [weak store] in await store?.logSet(weightKg: 60, reps: 10) }
        let outcome = await store.finish()

        guard case .closed = outcome else { return XCTFail("the session did not close: \(outcome)") }
        XCTAssertNil(server.sets["ses_1"], "nothing was filed into a session that was closing")
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty, "and nothing was left owed against it")
    }

    func testAStorageFailureKeepsTheSetQueuedRatherThanRefusingIt() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.refuse = { _ in storageFailure }
        await store.logSet(weightKg: 90, reps: 5)

        XCTAssertEqual(queueOnDisk(of: "u1").pending.count, 1)
        XCTAssertTrue(store.refusals.isEmpty, "the server failing is not the set being refused")
        XCTAssertEqual(store.saveState, .blocked(.logFailed))
        XCTAssertEqual(store.saveState.line, "the log didn’t answer · saved here")
        XCTAssertEqual(store.strandedBy, .logFailed)
        XCTAssertEqual(store.sets.count, 1, "the row stays on screen — the device is holding it")

        server.refuse = { _ in .malformed }
        await store.flushPendingSets()
        XCTAssertEqual(store.saveState, .blocked(.logFailed))
        XCTAssertEqual(store.strandedBy, .logFailed)

        server.refuse = { _ in refusal(404, code: "set-not-found", message: "no such set") }
        await store.flushPendingSets()
        XCTAssertEqual(store.saveState, .blocked(.logFailed))
        XCTAssertEqual(store.strandedBy, .logFailed)
        XCTAssertEqual(store.strandedCount, 1)

        server.refuse = { _ in refusal(401, message: "sign in to open your training log") }
        await store.flushPendingSets()
        XCTAssertEqual(store.saveState, .blocked(.signInLapsed))
        XCTAssertEqual(store.saveState.line, "sign in again · saved here")
        XCTAssertEqual(store.strandedBy, .signInLapsed)

        server.refuse = { _ in nil }
        server.online = false
        await store.flushPendingSets()
        XCTAssertEqual(store.saveState, .blocked(.offline))
        XCTAssertEqual(store.saveState.line, "offline · saved here")
        XCTAssertEqual(store.strandedBy, .offline)
    }

    func testASetThatCannotLandHoldsUpItsOwnMovementAndNoOther() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.refuse = { $0.exerciseId == "bench-press" ? storageFailure : nil }
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.choose("back-squat")
        await store.logSet(weightKg: 100, reps: 5)

        XCTAssertEqual(server.sets["ses_1"]?.map(\.exerciseId), ["back-squat"])
        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.set.exerciseId), ["bench-press"])
        XCTAssertEqual(store.sets.map(\.exerciseId), ["bench-press", "back-squat"],
                       "both are on screen — one is on the log and one is on the device")
    }

    func testAStartWhileASessionIsOpenIsRefusedAndTheOpenWorkoutIsAdopted() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        server.open(Session(id: "ses_live", startedAtMs: 500,
                            plan: PlanSnapshot(routine: "Push A",
                                               entries: [PlanEntry(exerciseId: "bench-press", sets: 5,
                                                                   reps: 5, weightKg: 82.5)])))
        server.sets["ses_live"] = [TrainingSet(id: "set_old", exerciseId: "bench-press", setNumber: 1,
                                               weightKg: 82.5, reps: 5, completedAtMs: 600)]

        guard case .failure(let why) = await store.start(routineId: "rt_other") else {
            return XCTFail("a start into an account with an open workout is a refusal, never a join")
        }
        XCTAssertEqual(why, .refused("a session is already open"), "in the log's own words")
        XCTAssertEqual(server.started.last?.joinOpenSession, false, "the tapped start said so explicitly")
        XCTAssertEqual(store.session?.id, "ses_live", "the open workout was adopted for the room to stand in")
        XCTAssertEqual(store.session?.plan?.routine, "Push A",
                       "under that session's own snapshot — never the routine the tap asked for")
        XCTAssertEqual(store.sets.map(\.id), ["set_old"], "with the sets already logged into it")
    }

    func testThePrefillTakesThePlanUntilTheLifterHasLiftedSomething() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000,
                            plan: PlanSnapshot(routine: "Push A",
                                               entries: [PlanEntry(exerciseId: "bench-press", sets: 5,
                                                                   reps: 5, weightKg: 82.5)])))
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        await store.choose("bench-press")

        XCTAssertEqual(store.prefill, Prefill(weightKg: 82.5, reps: 5))

        await store.logSet(weightKg: 85, reps: 4)
        XCTAssertEqual(store.prefill, Prefill(weightKg: 85, reps: 4), "the sticky carry-forward follows the thumb")
    }

    func testAWarmupIsWrittenAsAWarmupAndCarriesNothingForward() async {
        let server = FakeTraining()
        let plan = PlanSnapshot(routine: "Legs", entries: [
            PlanEntry(exerciseId: "back-squat", sets: 5, reps: 5, weightKg: 100),
        ])
        let store = await liveStore(server, movement: "back-squat", plan: plan)
        XCTAssertEqual(store.prefill, Prefill(weightKg: 100, reps: 5))

        await store.logSet(weightKg: 60, reps: 10, kind: .warmup)

        XCTAssertEqual(server.appended.map(\.kind), [.warmup], "the kind travels on the wire")
        XCTAssertEqual(server.sets["ses_1"]?.map(\.kind), [.warmup])
        XCTAssertEqual(store.sets.map(\.kind), [.warmup])
        XCTAssertEqual(store.prefill, Prefill(weightKg: 100, reps: 5),
                       "a ramp-up is not the weight the next set starts from — the dial stays on the plan")

        await store.logSet(weightKg: 100, reps: 5)
        XCTAssertEqual(store.sets.map(\.kind), [.warmup, .working])
        XCTAssertEqual(store.prefill, Prefill(weightKg: 100, reps: 5))

        await store.logSet(weightKg: 105, reps: 3)
        XCTAssertEqual(store.prefill, Prefill(weightKg: 105, reps: 3),
                       "and a working set does carry, past the warmup that came before it")
    }

    func testARefusalInOneLaneStillLeavesTheOtherLaneCarriedAndCounted() async {
        let server = FakeTraining()
        let store = await liveStore(server, retryAfter: .milliseconds(100))

        server.refuse = { write in
            write.exerciseId == "bench-press"
                ? storageFailure
                : refusal(400, code: "unknown-exercise", message: "no such exercise")
        }
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.choose("zercher-squat")
        await store.logSet(weightKg: 100, reps: 5)

        XCTAssertEqual(store.refusals.compactMap(\.set).map(\.exerciseId), ["zercher-squat"])
        XCTAssertEqual(store.saveState, .refused("that movement is not in the catalog"))
        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.set.exerciseId), ["bench-press"])
        XCTAssertEqual(store.strandedCount, 1,
                       "the strip says the bench set is on this device, whatever the other lane answered")

        let sent = server.appended.filter { $0.exerciseId == "bench-press" }.count
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertGreaterThan(server.appended.filter { $0.exerciseId == "bench-press" }.count, sent,
                             "and the retry fired on its own, with nobody tapping anything")
    }

    func testAStartRefusedForANamedReasonSaysTheReason() async {
        let server = FakeTraining()
        server.refuseStart = refusal(404, message: "no such routine")
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        guard case .failure(let why) = await store.start(routineId: "rt_deleted_elsewhere") else {
            return XCTFail("a 404 is not a session")
        }
        XCTAssertEqual(why, .refused("no such routine"))
        XCTAssertEqual(why.line("a session starts there"), "no such routine")
        XCTAssertNil(store.session)
    }

    func testAStartWithNoSignalComposesOnTheDeviceFromTheAccountsRoutineAndTheClaimLandsIt() async {
        let server = FakeTraining()
        server.written["rt_push_a"] = Routine(id: "rt_push_a", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ])
        let online = makeStore(sync: server)
        await online.connect(to: account(signedIn: true))
        XCTAssertEqual(online.routines.map(\.id), ["rt_push_a"], "read once, online")

        server.online = false
        let basement = makeStore(sync: server, retryAfter: .milliseconds(40))
        await basement.connect(to: account(signedIn: true))
        XCTAssertEqual(basement.routines.map(\.id), ["rt_push_a"], "R7: the program is drawn from the device copy")

        guard case .success(let opened) = await basement.start(routineId: "rt_push_a") else {
            return XCTFail("a basement start composes on the device")
        }
        XCTAssertEqual(opened.plan, PlanSnapshot(routine: "Push A", entries: [
            PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
        ]), "the plan froze off the routine the store holds")
        XCTAssertEqual(basement.session?.id, opened.id)
        XCTAssertTrue(queueOnDisk(of: "u1").sessionIsUnclaimed, "held unclaimed until the claim lands it")

        await basement.choose("bench-press")
        XCTAssertEqual(basement.prefill, Prefill(weightKg: 82.5, reps: 5), "and the dial is the plan's")
        await basement.logSet(weightKg: 82.5, reps: 5)
        XCTAssertEqual(basement.saveState, .onThisDevice, "parked with its session, not offline")

        server.online = true
        for _ in 0..<200 where server.sets[opened.id] == nil { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(server.started.map(\.id), [opened.id, opened.id],
                       "the start that got no answer, then the claim's replay UNDER THE SAME ID — so a start "
                       + "that had landed after all is answered with its own row, never a second workout")
        XCTAssertEqual(server.started.map(\.routineId), ["rt_push_a", "rt_push_a"])
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false, false])
        XCTAssertEqual(server.sets[opened.id]?.map(\.weightKg), [82.5], "the cadence claimed it and the set went out")
        XCTAssertFalse(queueOnDisk(of: "u1").sessionIsUnclaimed)
        XCTAssertEqual(basement.session?.id, opened.id, "the same workout, on the log now")
    }

    func testAStartTheLogDroppedOrRefusedForItsClockComposesOnTheDeviceAndANamedRefusalDoesNot() async {
        let server = FakeTraining()
        server.refuseStart = storageFailure
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        guard case .success(let fallen) = await store.start() else { return XCTFail("a 500 is not a wall") }
        XCTAssertTrue(queueOnDisk(of: "u1").sessionIsUnclaimed)
        _ = await store.discard(fallen.id)

        server.refuseStart = refusal(400, code: "clock-ahead", message: "this device's clock is 9 minutes ahead")
        guard case .success = await store.start() else { return XCTFail("clock-ahead ages into the past by itself") }
        XCTAssertTrue(queueOnDisk(of: "u1").sessionIsUnclaimed)
        _ = await store.discard(store.session!.id)

        server.refuseStart = refusal(401, message: "sign in to open your training log")
        guard case .failure(let said) = await store.start() else { return XCTFail("a refusal with a reason is a wall") }
        XCTAssertEqual(said, .refused("sign in to open your training log"))
        XCTAssertNil(store.session)
    }

    func testASetIntoAWorkoutDiscardedElsewhereIsSaidAndTheWorkoutIsForgotten() async {
        let server = FakeTraining()
        let store = await liveStore(server, retryAfter: .milliseconds(40))
        await store.logSet(weightKg: 82.5, reps: 5)
        XCTAssertEqual(store.saveState, .onTheLog)

        try? await server.discardSession("ses_1")
        await store.logSet(weightKg: 85, reps: 3)

        XCTAssertEqual(store.refusals, [.set(RefusedSet(
            TrainingSet(id: store.refusals.first!.id, exerciseId: "bench-press", weightKg: 85, reps: 3,
                        completedAtMs: 0),
            reason: "that workout is no longer on the log"))])
        XCTAssertEqual(store.saveState, .refused("that workout is no longer on the log"))
        XCTAssertNil(store.session, "the workout is forgotten — the room has nothing running")
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty, "nothing is left retrying")
        XCTAssertEqual(store.strandedCount, 0)
        XCTAssertNil(store.strandedBy)
        XCTAssertEqual(store.recent, [], "and the log was re-read: the discarded workout is not a row")
        XCTAssertEqual(server.calls.filter { $0 == "sessions" }.count, 2, "one boot read, one re-read")

        try? await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(server.appended.filter { $0.weightKg == 85 }.count, 1, "no cadence ever re-sent it")
    }

    func testFinishSaysWhatTheLogSaidAndAGoneWorkoutIsForgotten() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.online = false
        let quiet = await store.finish()
        XCTAssertEqual(quiet, .failed(.noAnswer))
        XCTAssertNotNil(store.session, "the session stays open")

        server.online = true
        server.refuseFinish = refusal(400, message: "a session cannot finish before it began")
        let refused = await store.finish()
        XCTAssertEqual(refused, .failed(.refused("a session cannot finish before it began")))
        XCTAssertNotNil(store.session)

        server.refuseFinish = nil
        try? await server.discardSession("ses_1")
        let gone = await store.finish()
        XCTAssertEqual(gone, .failed(.refused("that workout is no longer on the log")))
        XCTAssertNil(store.session, "there is nothing left to close")
        XCTAssertTrue(queueOnDisk(of: "u1").session == nil)
        XCTAssertEqual(store.recent, [], "the log was re-read")
    }

    func testASignedInConnectWithNoSignalDrawsTheAccountFromTheDeviceCopy() async {
        let server = FakeTraining()
        server.catalog = [Exercise(id: "bench-press", name: "Bench (renamed)", pattern: "press",
                                   equipment: "barbell", stepKg: 2.5)]
        server.written["rt_push_a"] = Routine(id: "rt_push_a", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ])
        server.lastSets = [LastSet(exerciseId: "bench-press", weightKg: 82.5, reps: 5, atMs: 900)]
        server.settings = GymPreferences.defaults.with(units: .lb)
        let online = makeStore(sync: server)
        await online.connect(to: account(signedIn: true))
        await online.loadLastSets()
        XCTAssertEqual(online.preferences.units, .lb)

        server.online = false
        let basement = makeStore(sync: server)
        await basement.connect(to: account(signedIn: true))
        await basement.loadLastSets()

        XCTAssertEqual(basement.routines, [server.written["rt_push_a"]!], "the program, off the copy")
        XCTAssertEqual(basement.lastSets?["bench-press"]?.weightKg, 82.5, "the picker's lines, off the copy")
        XCTAssertEqual(basement.catalog.first { $0.id == "bench-press" }?.name, "Bench (renamed)",
                       "the account's names, off the copy")
        XCTAssertEqual(basement.preferences.units, .lb, "the settings, off the shelf")
        XCTAssertEqual(LocalLog(url: localURL, deviceHolds: nil).preferences?.units, .lb,
                       "and the account's document was not let go of")
        XCTAssertEqual(basement.logFoot, .failed, "the log page is the one thing that honestly failed")

        let stranger = makeStore(sync: server)
        await stranger.connect(to: account(signedIn: true, id: "u2"))
        XCTAssertEqual(stranger.routines, [])
        await stranger.loadLastSets()
        XCTAssertNil(stranger.lastSets)
        XCTAssertEqual(stranger.preferences, .defaults)
    }

    func testARoutineReadWithNoSignalComesOffTheDeviceCopyAndItsHistoryIsSaidToBeOutOfReach() async {
        let server = FakeTraining()
        server.written["rt_push_a"] = Routine(id: "rt_push_a", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ])
        let online = makeStore(sync: server)
        await online.connect(to: account(signedIn: true))
        guard case .read(let served) = await online.routine("rt_push_a") else {
            return XCTFail("the log answers for a routine it holds")
        }
        XCTAssertEqual(served.entries.map(\.exerciseId), ["bench-press"])

        server.online = false
        let basement = makeStore(sync: server)
        // The launch the shell performs, both seats of it: the room mounts before `/v1/me` answers, so the
        // first connect is under a seat nobody has named yet, and offline the second stands unverified on
        // the device's last-known user. A copy thrown away on the first is not there for the second.
        await basement.connect(to: account(signedIn: false))
        await basement.connect(to: account(signedIn: true, verified: false))
        guard case .remembered(let held) = await basement.routine("rt_push_a") else {
            return XCTFail("a read with no answer falls back on the copy rather than on a dead end")
        }
        XCTAssertEqual(held.entries.map(\.exerciseId), ["bench-press"],
                       "the movements are named in a basement, which is where the routine is read")
        XCTAssertTrue(held.history.isEmpty, "the copy is written out without a history")

        guard case .failed(let why) = await basement.routine("rt_nobody") else {
            return XCTFail("a routine on neither the log nor the copy is out of reach")
        }
        XCTAssertEqual(why, .noAnswer)
        XCTAssertEqual(why.line("this routine isn\u{2019}t drawn"),
                       "the log didn\u{2019}t answer — this routine isn\u{2019}t drawn")
    }

    // Only silence falls back on the copy. `the log didn’t answer` is a claim about the log, so a log that
    // DID answer keeps its own sentence rather than being drawn as a remembered routine with no history.
    func testARoutineReadTheLogRefusesIsSaidInTheLogsOwnWordsAndNotRememberedQuietly() async {
        let server = FakeTraining()
        server.written["rt_push_a"] = Routine(id: "rt_push_a", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ])
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        guard case .read = await store.routine("rt_push_a") else {
            return XCTFail("the log answers for a routine it holds, so the copy is written")
        }

        server.refuseRoutine = refusal(403, message: "your grant no longer covers this routine")

        guard case .failed(let why) = await store.routine("rt_push_a") else {
            return XCTFail("an answered refusal is not a routine this device remembered")
        }
        XCTAssertEqual(why, .refused("your grant no longer covers this routine"))
        XCTAssertEqual(why.line("this routine isn\u{2019}t drawn"), "your grant no longer covers this routine",
                       "the screen draws the log's own sentence")
    }

    func testAWriteBackThatDidNotLandSaysWhatDidNotHappen() async {
        let server = FakeTraining()
        server.written["rt_push_a"] = Routine(id: "rt_push_a", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ])
        let store = await liveStore(server)

        server.online = false
        let quiet = await store.save(87.5, toRoutine: "rt_push_a", at: 1, for: "bench-press")
        XCTAssertEqual(quiet, .noAnswer)
        XCTAssertEqual(quiet?.line("Push A wasn’t changed"),
                       "the log didn’t answer — Push A wasn’t changed")
        XCTAssertEqual(server.written["rt_push_a"]?.entries.first?.targetWeightKg, 82.5,
                       "and nothing moved")

        server.online = true
        let gone = await store.save(87.5, toRoutine: "rt_gone", at: 1, for: "bench-press")
        XCTAssertEqual(gone, .refused("that routine is no longer on the log"))

        let landed = await store.save(87.5, toRoutine: "rt_push_a", at: 1, for: "bench-press")
        XCTAssertNil(landed, "a write that landed says nothing at all")
        XCTAssertEqual(server.written["rt_push_a"]?.entries.first?.targetWeightKg, 87.5)
    }

    func testAWriteBackAgainstALineTheRoutineNoLongerHoldsIsRefusedWithoutAPut() async {
        let server = FakeTraining()
        server.written["rt_push_a"] = Routine(id: "rt_push_a", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "overhead-press", targetSets: 3, targetReps: 8,
                         targetWeightKg: 45),
        ])
        let store = await liveStore(server)

        let moved = await store.save(87.5, toRoutine: "rt_push_a", at: 1, for: "bench-press")
        XCTAssertEqual(moved, .refused("Push A has changed since this session started"))
        XCTAssertEqual(moved?.line("Push A wasn’t changed"), "Push A has changed since this session started")

        let gone = await store.save(87.5, toRoutine: "rt_push_a", at: 2, for: "bench-press")
        XCTAssertEqual(gone, .refused("Push A has changed since this session started"))

        XCTAssertFalse(server.calls.contains("replaceRoutine"), "nothing to write, so nothing was PUT")
        XCTAssertEqual(server.routineWrites, [])
        XCTAssertEqual(server.written["rt_push_a"]?.entries.map(\.targetWeightKg), [45])
    }

    func testAMovementThatWasNotCreatedSaysSoInTheLogsOwnWords() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.refuseCreate = refusal(409, code: "exercise-id-taken", message: "that movement id is taken")
        guard case .failure(let why) = await store.create("Zercher Squat", loadedAs: "barbell") else {
            return XCTFail("a refused create is not a movement")
        }
        XCTAssertEqual(why, .refused("that movement id is taken"))
        XCTAssertFalse(store.catalog.contains { $0.name == "Zercher Squat" })

        server.refuseCreate = nil
        guard case .success(let made) = await store.create("Zercher Squat", loadedAs: "barbell") else {
            return XCTFail("the second attempt lands")
        }
        XCTAssertEqual(made.name, "Zercher Squat")
        XCTAssertEqual(store.catalog.map(\.name), ["Zercher Squat"])
    }

    func testTheMovementNamesAreHeldPerSeatAndAreThereBeforeTheFirstFrame() async {
        let server = FakeTraining()
        server.catalog = [Exercise(id: "bench-press", name: "Bench Press"),
                          Exercise(id: "back-squat", name: "Back Squat")]
        let store = await liveStore(server)
        XCTAssertEqual(store.catalog.map(\.name), ["Bench Press", "Back Squat"])

        server.online = false
        let relaunched = makeStore(sync: server, retryAfter: .seconds(600))
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(relaunched.catalog.map(\.id), ["bench-press", "back-squat"])
        XCTAssertEqual(Readout.movement("bench-press", in: relaunched.catalog), "Bench Press")

        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        XCTAssertEqual(anonymous.catalog, DeviceCatalog.seeded)
        XCTAssertEqual(Readout.movement("bench-press", in: anonymous.catalog), "Bench Press",
                       "the seeds are global — the name only becomes an account's when it is changed")
    }

    func testAReorderMovesTheWalkAndNotOneSet() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.choose("cable-fly")
        await store.logSet(weightKg: 22.5, reps: 12)
        await store.choose("face-pull")
        XCTAssertEqual(store.order, ["bench-press", "cable-fly", "face-pull"])

        store.reorder(from: IndexSet(integer: 2), to: 0)

        XCTAssertEqual(store.order, ["face-pull", "bench-press", "cable-fly"])
        XCTAssertEqual(store.sets.map { "\($0.exerciseId) \(Readout.effort(weightKg: $0.weightKg, reps: $0.reps))" },
                       ["bench-press 82.5 × 5", "cable-fly 22.5 × 12"],
                       "every set is where it was, under the movement that owns it")
        XCTAssertEqual(queueOnDisk(of: "u1").order, ["face-pull", "bench-press", "cable-fly"],
                       "and it is on disk, so the app dying does not undo it")

        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(relaunched.order, ["face-pull", "bench-press", "cable-fly"],
                       "the redraw keeps what the device holds at the head — nothing re-sorts it")
    }

    func testASwipeCanOnlyTakeAMovementNothingIsHoldingOnTo() async {
        let server = FakeTraining()
        let plan = PlanSnapshot(routine: "Push A",
                                entries: [PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5)])
        let store = await liveStore(server, plan: plan)
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.choose("cable-fly")
        await store.logSet(weightKg: 22.5, reps: 12)
        await store.choose("face-pull")

        await store.drop("bench-press")
        XCTAssertEqual(store.order, ["bench-press", "cable-fly", "face-pull"],
                       "the plan names it and it has sets — two reasons it stays")
        await store.drop("cable-fly")
        XCTAssertEqual(store.order, ["bench-press", "cable-fly", "face-pull"], "and this one was lifted")
        XCTAssertEqual(store.sets.count, 2, "nothing a refused swipe touched went anywhere")

        await store.drop("face-pull")
        XCTAssertEqual(store.order, ["bench-press", "cable-fly"])
        XCTAssertEqual(queueOnDisk(of: "u1").order, ["bench-press", "cable-fly"])
    }

    func testDroppingTheMovementInHandMovesTheHand() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.choose("cable-fly")
        XCTAssertEqual(store.exerciseId, "cable-fly")

        await store.drop("cable-fly")
        XCTAssertEqual(store.exerciseId, "bench-press", "back to where the sets are")

        let empty = makeStore(sync: nil)
        await empty.connect(to: account(signedIn: false))
        _ = await empty.start()
        await empty.choose("cable-fly")
        await empty.drop("cable-fly")
        XCTAssertNil(empty.exerciseId, "nothing left to stand on is the picker, not a blank movement")
        XCTAssertEqual(empty.order, [])
    }

    func testThePickerMetaIsNilUntilAReadLandsAndSparseAfterward() async {
        let server = FakeTraining()
        server.lastSets = [LastSet(exerciseId: "bench-press", weightKg: 82.5, reps: 5, atMs: 900)]
        let store = await liveStore(server)
        XCTAssertNil(store.lastSets, "nothing has been asked yet")

        server.online = false
        await store.loadLastSets()
        XCTAssertNil(store.lastSets, "and a read that did not answer asserts nothing either")

        server.online = true
        await store.loadLastSets()
        XCTAssertEqual(store.lastSets?["bench-press"]?.weightKg, 82.5)
        XCTAssertNil(store.lastSets?["cable-fly"], "a movement with no line has never been trained")
    }

    func testThePickerMetaFoldsThisDevicesOwnSessionsOverTheAccounts() async {
        let shelf = shelfOnDisk(of: "u1")
        shelf.keep(Session(id: "ses_local", startedAtMs: 5_000, finishedAtMs: 6_000),
                   sets: [TrainingSet(id: "set_l", exerciseId: "bench-press", weightKg: 90, reps: 3,
                                      completedAtMs: 5_500)])
        shelf.flush()

        let server = FakeTraining()
        server.online = false
        server.lastSets = [LastSet(exerciseId: "bench-press", weightKg: 82.5, reps: 5, atMs: 900),
                           LastSet(exerciseId: "deadlift", weightKg: 140, reps: 3, atMs: 800)]
        let store = makeStore(sync: server, retryAfter: .seconds(600))
        await store.connect(to: account(signedIn: true))
        server.online = true
        await store.loadLastSets()

        XCTAssertEqual(store.lastSets?["bench-press"]?.weightKg, 90, "the device's is the newer one")
        XCTAssertEqual(store.lastSets?["deadlift"]?.weightKg, 140, "and the account's stands alone")
    }

    func testAPrefillReadThatDidNotLandIsSaidRatherThanDialledOverInSilence() async {
        let server = FakeTraining()
        server.lastTimes["back-squat"] = LastTime(
            exerciseId: "back-squat",
            session: Session(id: "ses_0", startedAtMs: 100, finishedAtMs: 200),
            sets: [TrainingSet(id: "set_h", exerciseId: "back-squat", weightKg: 105, reps: 5,
                               completedAtMs: 150)])
        let store = await liveStore(server)

        server.online = false
        await store.choose("back-squat")

        XCTAssertNil(store.lastTime, "nothing was learned about the movement")
        XCTAssertTrue(store.lastTimeFailed, "and the room may not pretend otherwise")
        XCTAssertEqual(store.prefill, Prefill.emptyBar)

        server.online = true
        await store.choose("back-squat")

        XCTAssertEqual(store.lastTime?.sets.map(\.weightKg), [105])
        XCTAssertFalse(store.lastTimeFailed)
        XCTAssertEqual(store.prefill, Prefill(weightKg: 105, reps: 5))
    }

    func testAFailedReadForAMovementAlreadyLeftDoesNotMarkTheOneInHand() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.online = false
        await store.choose("back-squat")
        XCTAssertTrue(store.lastTimeFailed)

        server.online = true
        await store.choose("bench-press")
        XCTAssertFalse(store.lastTimeFailed, "the walk moved on, and the failure went with it")
    }

    private func finished(_ count: Int, from: Int64 = 100_000) -> [Session] {
        (0..<count).map { Session(id: "ses_\($0)", startedAtMs: from + Int64($0) * 1_000,
                                  finishedAtMs: from + Int64($0) * 1_000 + 500) }
    }

    private func log(_ sessions: [Session]) -> FakeTraining {
        let server = FakeTraining()
        for session in sessions { server.stored[session.id] = session }
        return server
    }

    func testAShortFirstPageIsTheBottomOfTheLog() async {
        let store = makeStore(sync: log(finished(3)))
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.logFoot, .bottom)
        XCTAssertEqual(store.recent.count, 3)
    }

    func testAFullPageOffersOlderAndTheNextTapAppendsRatherThanReplaces() async {
        let store = makeStore(sync: log(finished(58)))
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.logFoot, .more)
        XCTAssertEqual(store.recent.count, 50)

        await store.loadOlder()

        XCTAssertEqual(store.logFoot, .bottom)
        XCTAssertEqual(store.recent.count, 58, "the page landed on top of what was already loaded")
        XCTAssertEqual(store.recent.first?.id, "ses_57", "newest first, across the page edge")
        XCTAssertEqual(store.recent.last?.id, "ses_0")
        XCTAssertEqual(Set(store.recent.map(\.id)).count, 58, "no row is read twice across the edge")
    }

    func testAFailedFirstReadIsSaidAndTheRetryAsksForTheHeadOfTheLogAgain() async {
        let server = log(finished(3))
        server.online = false
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.logFoot, .failed)
        XCTAssertTrue(store.recent.isEmpty)

        server.online = true
        await store.loadOlder()

        XCTAssertEqual(store.logFoot, .bottom)
        XCTAssertEqual(store.recent.count, 3, "the retry read the head, not what comes before nothing")
    }

    func testAPageThatFailedLeavesTheRowsAlreadyLoadedOnScreen() async {
        let server = log(finished(58))
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        server.online = false
        await store.loadOlder()

        XCTAssertEqual(store.logFoot, .failed)
        XCTAssertEqual(store.recent.count, 50)
    }

    func testTheServedFloorIsTheOldestRowTheSERVERAnsweredWith() async {
        let shelf = shelfOnDisk(of: "u1")
        shelf.keep(Session(id: "ses_local", startedAtMs: 1_000, finishedAtMs: 2_000), sets: [])
        shelf.flush()

        let server = log(finished(58))
        server.refuseStart = storageFailure
        let store = makeStore(sync: server, retryAfter: .seconds(600))
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.logFoot, .more)
        XCTAssertEqual(store.deviceOnly, ["ses_local"])
        XCTAssertEqual(store.recent.last?.id, "ses_local",
                       "the device's own session is the oldest row on screen")
        XCTAssertEqual(store.servedOldestMs, 108_000,
                       "and the floor is ses_8, the oldest row the server has answered with")

        await store.loadOlder()

        XCTAssertEqual(store.logFoot, .bottom)
        XCTAssertEqual(store.servedOldestMs, 100_000, "the second page moved the floor to ses_0")
    }

    func testTheRecordReadTellsAMissingMovementApartFromASilentLog() async {
        let server = FakeTraining()
        server.records["back-squat"] = MovementRecord(exercise: Exercise(id: "back-squat",
                                                                        name: "Back Squat"),
                                                      sessionCount: 34)
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        guard case .success(let found) = await store.record(of: "back-squat") else {
            return XCTFail("the log holds this one")
        }
        XCTAssertEqual(found.record.sessionCount, 34)
        XCTAssertEqual(found.source, .theLog, "and the LOG answered, so the estimates are its to give")

        guard case .failure(let absent) = await store.record(of: "front-squat") else {
            return XCTFail("a movement the log does not hold is not a record")
        }
        XCTAssertEqual(absent, .refused("that movement is no longer in your catalog"))

        server.online = false
        guard case .failure(let quiet) = await store.record(of: "back-squat") else {
            return XCTFail("an unreachable log answers with nothing")
        }
        XCTAssertEqual(quiet, .noAnswer)
    }

    func testDeletingARoutineForgetsItAndA404IsTheOutcomeAskedFor() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        var draft = RoutineDraft(name: "Push A", position: 0)
        draft.add("bench-press")
        guard case .success(let made) = await store.create(draft) else { return XCTFail("no routine") }

        let gone = await store.deleteRoutine(made.id)
        XCTAssertNil(gone)
        XCTAssertTrue(store.routines.isEmpty)
        XCTAssertTrue(server.calls.contains("deleteRoutine"))

        let again = await store.deleteRoutine(made.id)
        XCTAssertNil(again, "already gone is gone, not a failure")
    }

    func testADeleteTheLogDidNotAnswerLeavesTheRoutineStanding() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        var draft = RoutineDraft(name: "Push A", position: 0)
        draft.add("bench-press")
        guard case .success(let made) = await store.create(draft) else { return XCTFail("no routine") }

        server.online = false
        let why = await store.deleteRoutine(made.id)
        XCTAssertEqual(why, .noAnswer)
        XCTAssertEqual(store.routines.map(\.id), [made.id])
    }

    func testARenameMovesTheNameAndNeverTheId() async {
        let server = FakeTraining()
        server.catalog = [Exercise(id: "back-squat", name: "Back Squat", pattern: "squat",
                                   equipment: "barbell", stepKg: 2.5)]
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        let renamed = await store.rename("back-squat", to: "Low-bar Squat")
        XCTAssertNil(renamed)
        XCTAssertEqual(store.catalog, [Exercise(id: "back-squat", name: "Low-bar Squat",
                                                pattern: "squat", equipment: "barbell", stepKg: 2.5)])
        XCTAssertEqual(DeviceCatalog(url: catalogURL).open(under: "u1").map(\.name), ["Low-bar Squat"],
                       "and the next cold launch draws the new name rather than the seeded one")

        XCTAssertEqual(DeviceCatalog(url: catalogURL).open(under: "u2"), DeviceCatalog.seeded)
        XCTAssertEqual(DeviceCatalog(url: catalogURL).open(under: nil), DeviceCatalog.seeded)

        server.online = false
        let quiet = await store.rename("back-squat", to: "Back Squat")
        XCTAssertEqual(quiet, .noAnswer, "a rename that did not land says so rather than pretending")
    }

    func testRenamingAnUnclaimedMovementRewritesTheCreateTheClaimWillReplay() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        guard case .success(let minted) = await store.create("Bench", loadedAs: "barbell") else {
            return XCTFail("the device mints its own movements signed out")
        }

        let renamed = await store.rename(minted.id, to: "Bench Press")
        XCTAssertNil(renamed)
        XCTAssertEqual(store.catalog.last?.name, "Bench Press")
        XCTAssertEqual(shelfOnDisk(of: nil).exercises.map(\.name), ["Bench Press"])
        XCTAssertEqual(shelfOnDisk(of: nil).exercises.map(\.id), [minted.id],
                       "the id the sets already name does not move")

        let refused = await store.rename("back-squat", to: "Low-bar Squat")
        XCTAssertEqual(refused, .refused("renaming this movement needs your account — sign in first"))
    }

    func testAnUnclaimedMovementReadsAndRenamesOnTheDeviceEvenSignedIn() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success(let minted) = await anonymous.create("Zercher", loadedAs: "barbell") else {
            return XCTFail("the device mints its own movements signed out")
        }
        _ = await anonymous.start()
        await anonymous.choose(minted.id)
        await anonymous.logSet(weightKg: 80, reps: 5)
        guard case .closed = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.online = false
        let store = makeStore(sync: server, retryAfter: .seconds(600))
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.catalog.last?.id, minted.id,
                       "this device's own unclaimed movement is in the catalog under every seat")
        XCTAssertEqual(store.catalog.count, DeviceCatalog.seeded.count + 1,
                       "over the seeds, which a seat that answered nothing still has")
        guard case .success(let answered) = await store.record(of: minted.id) else {
            return XCTFail("the device answers for what it is still the only home of")
        }
        XCTAssertEqual(answered.source, .thisDevice)
        XCTAssertEqual(answered.record.sessionCount, 1)
        XCTAssertFalse(server.calls.contains("record"), "and the log is not asked about it at all")

        let renamed = await store.rename(minted.id, to: "Zercher Squat")
        XCTAssertNil(renamed)
        guard case .success(let again) = await store.record(of: minted.id) else {
            return XCTFail("the re-read the rename sheet triggers is the same local read")
        }
        XCTAssertEqual(again.record.exercise.name, "Zercher Squat")
        XCTAssertFalse(server.calls.contains("renameExercise"),
                       "a PATCH against a movement the log has never held would 404")

        XCTAssertTrue(store.unclaimed(minted.id))
        XCTAssertFalse(store.unclaimed("back-squat"),
                       "an unclaimed session of one movement is not a caveat on another's page")
    }

    func testSettingsSetBeforeThereIsAnAccountSurviveARelaunch() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        XCTAssertEqual(anonymous.preferences, .defaults)

        await anonymous.save(GymPreferences.defaults.resting(120).with(restSound: false))

        let relaunched = makeStore(sync: nil)
        await relaunched.connect(to: account(signedIn: false))
        XCTAssertFalse(relaunched.preferences.restSound)
        XCTAssertEqual(relaunched.preferences.restSeconds, 120)
    }

    func testSigningInClaimsTheDevicesSettingsOverTheAccountsOwn() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        await anonymous.save(GymPreferences.defaults.with(units: .lb).resting(180))

        let server = FakeTraining()
        server.settings = GymPreferences.defaults.with(confirmSound: true)
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.settingsWrites.map(\.units), [.lb])
        XCTAssertEqual(server.settings?.restSeconds, 180)
        XCTAssertEqual(store.preferences.units, .lb)
        XCTAssertEqual(store.preferences.restSeconds, 180)
        XCTAssertFalse(store.preferences.confirmSound,
                       "the account's older answer does not come back over the one just made")

        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(server.settingsWrites.count, 1, "nothing is owed any more, so nothing replays")
        XCTAssertEqual(relaunched.preferences.units, .lb)
    }

    func testTheAccountsSettingsAreReadAndKeptOnTheDevice() async {
        let server = FakeTraining()
        server.settings = GymPreferences.defaults.resting(90).with(units: .lb)
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.preferences.restSeconds, 90)
        XCTAssertEqual(store.preferences.units, .lb)
        XCTAssertTrue(server.settingsWrites.isEmpty, "a read is not a write")
        XCTAssertEqual(LocalLog(url: localURL, deviceHolds: nil).preferences?.units, .lb)
    }

    func testASettingTheLogCannotTakeStaysOnTheDeviceAndIsSaid() async {
        let server = FakeTraining()
        let store = makeStore(sync: server, retryAfter: .seconds(600))
        await store.connect(to: account(signedIn: true))

        server.online = false
        let why = await store.save(GymPreferences.defaults.resting(120))

        XCTAssertEqual(why, .noAnswer)
        XCTAssertEqual(why?.line("that setting is on this device, not on the log"),
                       "the log didn’t answer — that setting is on this device, not on the log")
        XCTAssertEqual(store.preferences.restSeconds, 120)
        XCTAssertTrue(LocalLog(url: localURL, deviceHolds: nil).preferencesOwed)

        server.online = true
        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(server.settings?.restSeconds, 120, "the claim sends what is still owed")
        XCTAssertFalse(LocalLog(url: localURL, deviceHolds: nil).preferencesOwed)
    }

    func testTwoTapsInFlightLeaveTheLogHoldingTheSecond() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        server.onSavePreferences = { [weak store] in
            server.onSavePreferences = {}
            await store?.save(GymPreferences.defaults.resting(180))
        }
        await store.save(GymPreferences.defaults.resting(90))

        XCTAssertEqual(server.settingsWrites.count, 2, "the second tap is sent, and only once")
        XCTAssertEqual(server.settings?.restSeconds, 180,
                       "the log's last word is the lifter's last tap")
        XCTAssertEqual(store.preferences.restSeconds, 180)
        XCTAssertFalse(LocalLog(url: localURL, deviceHolds: nil).preferencesOwed)
    }

    func testADocumentTheLogRefusesIsNotReplayedForever() async {
        let server = FakeTraining()
        server.refusePreferences = refusal(400, code: "rest-target", message: "a rest target runs from 15 to 900 seconds")
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        _ = await store.save(GymPreferences.defaults.resting(120))
        XCTAssertEqual(store.preferences.restSeconds, 120)
        XCTAssertFalse(LocalLog(url: localURL, deviceHolds: nil).preferencesOwed)

        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(server.settingsWrites.count, 1, "refused once is refused")
    }

    func testOneLiftersSettingsAreNeitherDrawnNorSentInAnothersRoom() async {
        let hers = FakeTraining()
        hers.settings = GymPreferences.defaults.resting(180).with(units: .lb)
        let herRoom = makeStore(sync: hers)
        await herRoom.connect(to: account(signedIn: true))
        XCTAssertEqual(herRoom.preferences.restSeconds, 180, "her own document, on her own seat")

        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        XCTAssertEqual(anonymous.preferences, .defaults)
        XCTAssertNil(LocalLog(url: localURL, deviceHolds: nil).open(preferencesUnder: nil),
                     "the shelf hands her document to no seat but hers")

        let his = FakeTraining()
        his.online = false
        his.settings = GymPreferences.defaults.with(units: .lb)
        let hisRoom = makeStore(sync: his)
        await hisRoom.connect(to: account(signedIn: true, id: "u2"))
        XCTAssertEqual(hisRoom.preferences, .defaults)
        XCTAssertNil(LocalLog(url: localURL, deviceHolds: nil).preferences,
                     "and another account ARRIVING is what lets go of it, on disk as well as in memory")

        his.online = true
        await hisRoom.save(hisRoom.preferences.with(confirmSound: true))
        XCTAssertEqual(his.settingsWrites.map(\.units), [.kg])
        XCTAssertEqual(his.settingsWrites.map(\.restSeconds), [nil])
        XCTAssertTrue(his.settings?.confirmSound == true)
    }

    // The room mounts and connects before `/v1/me` answers, so a seat nobody has named YET is not a
    // seat that left. Her document waits for her own seat rather than being dropped before the first read.
    func testTheLaunchBeforeTheSeatIsNamedKeepsTheLiftersOwnSettings() async {
        let hers = makeStore(sync: nil)
        await hers.connect(to: account(signedIn: true))
        await hers.save(GymPreferences.defaults.resting(180).with(units: .lb))

        let launching = makeStore(sync: nil)
        await launching.connect(to: account(signedIn: false))
        XCTAssertEqual(launching.preferences, .defaults, "an unnamed seat is served nobody's document")
        XCTAssertEqual(LocalLog(url: localURL, deviceHolds: nil).preferences?.restSeconds, 180,
                       "and the launch did not drop it from disk on its way past")

        await launching.connect(to: account(signedIn: true))
        XCTAssertEqual(launching.preferences, GymPreferences.defaults.resting(180).with(units: .lb),
                       "the seat the document was written for gets it back")
    }

    func testTheAnonymousDocumentCrossesIntoTheAccountAndNotBackOut() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        await anonymous.save(GymPreferences.defaults.resting(120).with(units: .lb))

        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(server.settings?.units, .lb, "the claim carried it to the account")
        XCTAssertEqual(store.preferences.restSeconds, 120)

        let again = makeStore(sync: nil)
        await again.connect(to: account(signedIn: false))
        XCTAssertEqual(again.preferences, .defaults, "it is the account's now, not this handset's")
    }

    func testATapDuringTheClaimIsSentByTheClaimItself() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        await anonymous.save(GymPreferences.defaults.resting(120))

        let server = FakeTraining()
        let store = makeStore(sync: server)
        server.onSavePreferences = { [weak store] in
            server.onSavePreferences = {}
            await store?.save(GymPreferences.defaults.resting(180))
        }
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.settingsWrites.map(\.restSeconds), [120, 180])
        XCTAssertEqual(server.settings?.restSeconds, 180, "the log's last word is the lifter's last tap")
        XCTAssertEqual(store.preferences.restSeconds, 180)
        XCTAssertFalse(LocalLog(url: localURL, deviceHolds: nil).preferencesOwed)
    }

    func testAFailingSettingsWriteDoesNotHoldASetOffTheLog() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 80, reps: 5)
        guard case .closed = await anonymous.finish() else { return XCTFail("no close") }
        await anonymous.save(GymPreferences.defaults.resting(120))

        let server = FakeTraining()
        server.refusePreferences = refusal(503, message: "no such route")
        let store = makeStore(sync: server, retryAfter: .seconds(600))
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets.values.flatMap { $0 }.map(\.weightKg), [80],
                       "the lift is on the log even though the settings write failed")
        XCTAssertTrue(LocalLog(url: localURL, deviceHolds: nil).preferencesOwed)
        XCTAssertTrue(shelfOnDisk(of: "u1").sessions.isEmpty, "and the session was claimed")
    }
}

final class VerdictTests: XCTestCase {
    func testTheTwoSpentIdRefusalsAskForAFreshIdWhateverTheySay() {
        XCTAssertEqual(Verdict(refusing: refusal(409, code: "set-id-taken", message: "anything at all")),
                       .remint("anything at all"))
        XCTAssertEqual(Verdict(refusing: refusal(409, code: "session-id-taken", message: "anything at all")),
                       .remint("anything at all"))
    }

    func testAClosedSessionDropsTheSetForeverAndCarriesASentenceToSay() {
        XCTAssertEqual(Verdict(refusing: refusal(409, code: "session-finished", message: "reworded")),
                       .dropped("the session closed before this set reached it"))
        XCTAssertNotNil(Verdict(refusing: refusal(409, code: "session-finished", message: "reworded"))
            .terminalReason(afterRemints: 0))
    }

    func testAStorageFailureAndATransportFailureAreBothRetries() {
        XCTAssertEqual(Verdict(refusing: storageFailure), .retry)
        XCTAssertEqual(Verdict(refusing: WindmillApiError.offline), .retry)
        XCTAssertEqual(Verdict(refusing: WindmillApiError.malformed), .retry)
        XCTAssertNil(Verdict(refusing: WindmillApiError.offline).terminalReason(afterRemints: 0))
    }

    func testASetWaitingForASignInIsNeitherLostNorRefused() {
        XCTAssertEqual(Verdict(refusing: refusal(401, message: "sign in to open your training log")), .retry)
        XCTAssertEqual(Verdict(refusing: refusal(404, message: "no such session")), .retry)
    }

    func testAnUnreadableBodyIsTerminalBecauseRetryingNeverMakesItReadable() {
        XCTAssertEqual(Verdict(refusing: refusal(400, code: "unknown-exercise", message: "no such exercise")),
                       .refused("that movement is not in the catalog"))
        XCTAssertEqual(Verdict(refusing: refusal(400, message: "could not read that set")),
                       .refused("could not read that set"))
    }

    func testTheIdRepairBudgetRunsOutAndThenTheSetIsSaid() {
        let verdict = Verdict(refusing: refusal(409, code: "set-id-taken", message: "that set id is already used"))
        XCTAssertNil(verdict.terminalReason(afterRemints: SetQueue.maxRemints - 1))
        XCTAssertEqual(verdict.terminalReason(afterRemints: SetQueue.maxRemints), "that set id is already used")
    }
}

final class SetQueueTests: XCTestCase {
    private func makeQueue() -> (SetQueue, URL) {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-\(UUID().uuidString).json")
        return (SetQueue(url: url, deviceHolds: nil), url)
    }

    private func aSet(_ id: String, _ exerciseId: String = "bench-press", at completedAtMs: Int64) -> TrainingSet {
        TrainingSet(id: id, exerciseId: exerciseId, weightKg: 82.5, reps: 5, completedAtMs: completedAtMs)
    }

    func testTheLiveSessionAndItsOwedSetsSurviveBeingReadBackFromDisk() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        queue.hold(Session(id: "ses_1", startedAtMs: 1_000))
        queue.store(aSet("set_a", at: 1_100), in: "ses_1", needsPush: true)
        queue.flush()

        let reopened = SetQueue(url: url, deviceHolds: nil)
        XCTAssertEqual(reopened.session?.id, "ses_1")
        XCTAssertEqual(reopened.sets.map(\.id), ["set_a"])
        XCTAssertEqual(reopened.pending.count, 1, "an unsent set is still owed after a relaunch")
    }

    func testAnUnreadableFileOpensEmptyRatherThanCrashing() {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-\(UUID().uuidString).json")
        try? Data("not json at all".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let queue = SetQueue(url: url, deviceHolds: nil)
        XCTAssertNil(queue.session)
        XCTAssertTrue(queue.pending.isEmpty)
    }

    func testWhatIsOwedComesBackInTheOrderItWasPerformed() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        queue.store(aSet("set_c", at: 3_000), in: "ses_1", needsPush: true)
        queue.store(aSet("set_a", at: 1_000), in: "ses_1", needsPush: true)
        queue.store(aSet("set_b", at: 2_000), in: "ses_1", needsPush: true)

        XCTAssertEqual(queue.pending.map(\.set.id), ["set_a", "set_b", "set_c"],
                       "the server numbers sets max+1 per movement, so the queue sends in that order")
    }

    func testABlockedLaneIsSteppedOverAndTheNextMovementIsOffered() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        queue.store(aSet("set_a", "bench-press", at: 1_000), in: "ses_1", needsPush: true)
        queue.store(aSet("set_b", "back-squat", at: 2_000), in: "ses_1", needsPush: true)

        let first = queue.nextOwed(skipping: [], readyAt: nil)
        XCTAssertEqual(first?.set.id, "set_a")
        XCTAssertEqual(queue.nextOwed(skipping: [first!.lane], readyAt: nil)?.set.id, "set_b")
    }

    func testAServerRowArrivingForAnOwedSetSettlesIt() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        queue.store(aSet("set_a", at: 1_000), in: "ses_1", needsPush: true)
        queue.store(TrainingSet(id: "set_a", exerciseId: "bench-press", setNumber: 4, weightKg: 82.5,
                                reps: 5, completedAtMs: 1_000), in: "ses_1", needsPush: false)

        XCTAssertTrue(queue.pending.isEmpty)
        XCTAssertEqual(queue.sets(in: "ses_1").map(\.setNumber), [4])
    }

    func testARemintMovesTheSetToTheFreshIdAndSpendsOneOfTheRepairs() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        queue.store(aSet("set_a", at: 1_000), in: "ses_1", needsPush: true)
        queue.remint("set_a", as: "set_b")

        XCTAssertEqual(queue.pending.map(\.set.id), ["set_b"])
        XCTAssertEqual(queue.pending.map(\.remints), [1])
        XCTAssertEqual(queue.pending.map(\.set.weightKg), [82.5], "a remint moves the key and nothing else")
    }

    func testClosingASessionLetsGoOfTheDeliveredRowsAndKeepsTheOwedOne() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        queue.hold(Session(id: "ses_1", startedAtMs: 1_000))
        queue.store(aSet("set_landed", at: 1_100), in: "ses_1", needsPush: false)
        queue.store(aSet("set_owed", at: 1_200), in: "ses_1", needsPush: true)
        queue.close("ses_1")

        XCTAssertNil(queue.session)
        XCTAssertEqual(queue.pending.map(\.set.id), ["set_owed"])
        XCTAssertEqual(queue.sets(in: "ses_1").map(\.id), ["set_owed"])
    }

    func testRemappingAMovementRewritesTheSetsTheWalkOrderAndTheFrozenPlan() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        let plan = PlanSnapshot(routine: "Push A", entries: [
            PlanEntry(exerciseId: "ex_local", sets: 5, reps: 5, weightKg: 82.5, restSeconds: 120),
            PlanEntry(exerciseId: "bench-press", sets: 3, reps: 8, weightKg: 60),
        ])
        queue.hold(Session(id: "ses_1", startedAtMs: 1_000, routineId: "rt_1", plan: plan),
                   unclaimed: true)
        queue.append("ex_local")
        queue.append("bench-press")
        queue.store(aSet("set_a", "ex_local", at: 1_100), in: "ses_1", needsPush: true)

        queue.remapExercise("ex_local", to: "ex_fresh")

        XCTAssertEqual(queue.pending.map(\.set.exerciseId), ["ex_fresh"])
        XCTAssertEqual(queue.order, ["ex_fresh", "bench-press"])
        XCTAssertEqual(queue.session?.plan, PlanSnapshot(routine: "Push A", entries: [
            PlanEntry(exerciseId: "ex_fresh", sets: 5, reps: 5, weightKg: 82.5, restSeconds: 120),
            PlanEntry(exerciseId: "bench-press", sets: 3, reps: 8, weightKg: 60),
        ]), "the plan lines follow the fresh id and keep everything else")
        XCTAssertEqual(queue.session?.routineId, "rt_1")
    }

    func testTwoSameNamedClaimLossesAreTwoRowsNotOne() {
        let movement = RefusedWrite.claim(RefusedClaim(id: "ex_press", name: "Press", reason: "refused"))
        let routine = RefusedWrite.claim(RefusedClaim(id: "rt_press", name: "Press", reason: "refused"))

        XCTAssertEqual(movement.id, "claim-ex_press")
        XCTAssertEqual(routine.id, "claim-rt_press")
        XCTAssertNotEqual(movement.id, routine.id,
                          "a name collision must not fold two losses into one banner row")
    }

    func testForgettingADiscardedSessionTakesTheOwedSetsWithIt() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        queue.hold(Session(id: "ses_1", startedAtMs: 1_000))
        queue.store(aSet("set_owed", at: 1_200), in: "ses_1", needsPush: true)
        queue.forget("ses_1")

        XCTAssertNil(queue.session)
        XCTAssertTrue(queue.pending.isEmpty)
    }
}

extension RefusedWrite {
    var set: RefusedSet? {
        guard case .set(let set) = self else { return nil }
        return set
    }

    var claim: RefusedClaim? {
        guard case .claim(let claim) = self else { return nil }
        return claim
    }
}

final class FakeTraining: TrainingSyncing, @unchecked Sendable {
    var online = true
    var nowMs: Int64 = 0
    var catalog: [Exercise] = []
    var stored: [String: Session] = [:]
    var sets: [String: [TrainingSet]] = [:]
    var written: [String: Routine] = [:]
    var revisions: [String: Int] = [:]
    var ledger: [Proposal] = []
    var lastTimes: [String: LastTime] = [:]
    var lastSets: [LastSet] = []
    var reviews: [String: Review] = [:]
    var shares: [String: SessionShare] = [:]
    var records: [String: MovementRecord] = [:]
    var refuse: (SetWrite) -> WindmillApiError? = { _ in nil }
    var refuseFix: WindmillApiError?
    var refuseDelete: WindmillApiError?
    var refuseStart: WindmillApiError?
    var refuseFinish: WindmillApiError?
    var refuseCreate: WindmillApiError?
    var refuseCreateRoutine: WindmillApiError?
    var refuseRoutines: WindmillApiError?
    var refuseRoutine: WindmillApiError?
    var refuseProposals: WindmillApiError?
    var refuseApply: WindmillApiError?
    var refuseShare: WindmillApiError?
    var refuseRevoke: WindmillApiError?
    var refuseRecord: WindmillApiError?
    var refuseRename: WindmillApiError?
    var refusePreferences: WindmillApiError?
    var refuseBodyweight: WindmillApiError?
    // Nil is an account that has never answered; the read serves the defaults.
    var settings: GymPreferences?
    // One row per local day, the newer `recordedAt` standing, exactly as the SQL keeps it.
    var weighIns: [String: BodyweightEntry] = [:]
    // Ids another account already spent — 409, asking for a remint.
    var takenSessionIds: Set<String> = []
    var takenRoutineIds: Set<String> = []
    var takenExerciseIds: Set<String> = []
    var swallowReplies = 0
    // A start whose reply is lost: the row is stored, the caller hears nothing.
    var swallowStartReplies = 0
    var onFinish: () async -> Void = {}
    var onSavePreferences: () async -> Void = {}
    // Awaited once the call is counted and before the fake acts: a test holds a reply in flight here.
    var onBodyweightRead: () async -> Void = {}
    var onPutBodyweight: () async -> Void = {}
    var onDeleteBodyweight: () async -> Void = {}

    private(set) var appended: [SetWrite] = []
    private(set) var corrected: [String] = []
    private(set) var deleted: [String] = []
    private(set) var started: [SessionStart] = []
    private(set) var finishes: [String: Int64] = [:]
    private(set) var routineWrites: [RoutineWrite] = []
    private(set) var exerciseWrites: [ExerciseWrite] = []
    private(set) var settingsWrites: [GymPreferences] = []
    private(set) var bodyweightWrites: [String] = []
    private(set) var calls: [String] = []

    func open(_ session: Session) {
        stored[session.id] = session
    }

    func settleOpen() {
        for (id, session) in stored where session.isOpen {
            guard let closeAt = session.autoCloseAt(lastSetAtMs: sets[id]?.last?.completedAtMs,
                                                    nowMs: nowMs) else { continue }
            stored[id] = Session(id: session.id, startedAtMs: session.startedAtMs, finishedAtMs: closeAt,
                                 routineId: session.routineId, plan: session.plan)
        }
    }

    private func refusal(_ status: Int, code: String, _ message: String) -> WindmillApiError {
        .refused(status, Refusal(Data(#"{"error":"\#(message)","code":"\#(code)"}"#.utf8)))
    }

    func exercises() async throws -> [Exercise] {
        calls.append("exercises")
        guard online else { throw WindmillApiError.offline }
        return catalog
    }

    func createExercise(_ write: ExerciseWrite) async throws -> Exercise {
        calls.append("createExercise")
        exerciseWrites.append(write)
        guard online else { throw WindmillApiError.offline }
        if let refuseCreate { throw refuseCreate }
        if let already = catalog.first(where: { $0.id == write.id }) { return already }
        if takenExerciseIds.contains(write.id) {
            throw refusal(409, code: "exercise-id-taken", "that movement id is taken")
        }
        let made = Exercise(id: write.id, name: write.name, pattern: write.pattern,
                            equipment: write.equipment, stepKg: write.stepKg, custom: true)
        catalog.append(made)
        return made
    }

    func startSession(_ start: SessionStart) async throws -> Session {
        calls.append("start")
        started.append(start)
        guard online else { throw WindmillApiError.offline }
        if let refuseStart { throw refuseStart }
        settleOpen()
        if takenSessionIds.contains(start.id) {
            throw refusal(409, code: "session-id-taken", "that session id is taken")
        }
        if let mine = stored[start.id] { return mine }
        if let live = stored.values.first(where: \.isOpen) {
            guard start.joinOpenSession != false else {
                throw refusal(409, code: "session-already-open", "a session is already open")
            }
            return live
        }
        let plan = start.routineId.flatMap { written[$0] }.map { routine in
            PlanSnapshot(routine: routine.name,
                         entries: routine.entries.sorted { $0.position < $1.position }.map {
                             PlanEntry(exerciseId: $0.exerciseId, sets: $0.targetSets,
                                       reps: $0.targetReps, weightKg: $0.targetWeightKg,
                                       restSeconds: $0.restSeconds)
                         })
        }
        if start.routineId != nil, plan == nil {
            throw refusal(404, code: "not-found", "no such routine")
        }
        let opened = Session(id: start.id, startedAtMs: start.startedAtMs,
                             routineId: start.routineId, plan: plan)
        stored[opened.id] = opened
        if swallowStartReplies > 0 {
            swallowStartReplies -= 1
            throw WindmillApiError.offline
        }
        return opened
    }

    func appendSet(to sessionId: String, _ write: SetWrite) async throws -> TrainingSet {
        calls.append("append")
        appended.append(write)
        guard online else { throw WindmillApiError.offline }
        if let refusal = refuse(write) { throw refusal }
        if let already = sets[sessionId]?.first(where: { $0.id == write.id }) { return already }
        guard let held = stored[sessionId] else { throw WindmillApiError.refused(404, Refusal(Data())) }
        if !held.isOpen { throw refusal(409, code: "session-finished", "that session is finished") }

        let number = (sets[sessionId] ?? []).filter { $0.exerciseId == write.exerciseId }.count + 1
        let row = TrainingSet(id: write.id, exerciseId: write.exerciseId, setNumber: number,
                              weightKg: write.weightKg, reps: write.reps, kind: write.kind,
                              completedAtMs: write.completedAtMs)
        sets[sessionId, default: []].append(row)
        if swallowReplies > 0 {
            swallowReplies -= 1
            throw WindmillApiError.offline
        }
        return row
    }

    func fixSet(_ setId: String, in sessionId: String, _ fix: SetFix) async throws -> TrainingSet {
        calls.append("fixSet")
        corrected.append(setId)
        guard online else { throw WindmillApiError.offline }
        if let refuseFix { throw refuseFix }
        guard var held = sets[sessionId], let index = held.firstIndex(where: { $0.id == setId }) else {
            throw refusal(404, code: "set-not-found", "no such set")
        }
        held[index] = held[index].corrected(by: fix)
        sets[sessionId] = held
        return held[index]
    }

    func deleteSet(_ setId: String, in sessionId: String) async throws {
        calls.append("deleteSet")
        deleted.append(setId)
        guard online else { throw WindmillApiError.offline }
        if let refuseDelete { throw refuseDelete }
        sets[sessionId] = sets[sessionId]?.filter { $0.id != setId }
    }

    func finishSession(_ sessionId: String, at finishedAtMs: Int64) async throws -> Session {
        calls.append("finish")
        await onFinish()
        guard online else { throw WindmillApiError.offline }
        if let refuseFinish { throw refuseFinish }
        guard let live = stored[sessionId] else { throw WindmillApiError.refused(404, Refusal(Data())) }
        finishes[sessionId] = finishedAtMs
        let closed = Session(id: live.id, startedAtMs: live.startedAtMs, finishedAtMs: finishedAtMs,
                             routineId: live.routineId, plan: live.plan)
        stored[sessionId] = closed
        return closed
    }

    func discardSession(_ sessionId: String) async throws {
        calls.append("discard")
        guard online else { throw WindmillApiError.offline }
        stored[sessionId] = nil
        sets[sessionId] = nil
    }

    func sessions(before: Int64?, beforeId: String?, limit: Int) async throws -> [SessionSummary] {
        calls.append("sessions")
        guard online else { throw WindmillApiError.offline }
        settleOpen()
        let ordered = stored.values.sorted {
            $0.startedAtMs == $1.startedAtMs ? $0.id > $1.id : $0.startedAtMs > $1.startedAtMs
        }
        let older = ordered.filter { session in
            guard let before else { return true }
            guard session.startedAtMs == before else { return session.startedAtMs < before }
            return session.id < (beforeId ?? "")
        }
        return older.prefix(limit).map { session in
            let held = sets[session.id] ?? []
            let working = held.filter { $0.kind == .working }
            return SessionSummary(session: session, setCount: held.count,
                                  exercises: held.map(\.exerciseId),
                                  workingSetCount: working.count,
                                  tonnageKg: working.reduce(0) { $0 + max($1.weightKg, 0) * Double($1.reps) })
        }
    }

    func session(_ id: String) async throws -> SessionDetail? {
        calls.append("session")
        guard online else { throw WindmillApiError.offline }
        guard let found = stored[id] else { return nil }
        return SessionDetail(session: found, sets: sets[id] ?? [])
    }

    func review(of sessionId: String) async throws -> Review {
        calls.append("review")
        guard online else { throw WindmillApiError.offline }
        guard let found = reviews[sessionId] else { throw WindmillApiError.refused(404, Refusal(Data())) }
        return found
    }

    func lastTime(_ exerciseId: String) async throws -> LastTime {
        calls.append("lastTime")
        guard online else { throw WindmillApiError.offline }
        return lastTimes[exerciseId] ?? LastTime(exerciseId: exerciseId)
    }

    func lastSets() async throws -> [LastSet] {
        calls.append("lastSets")
        guard online else { throw WindmillApiError.offline }
        return lastSets
    }

    func routines() async throws -> [Routine] {
        calls.append("routines")
        guard online else { throw WindmillApiError.offline }
        if let refuseRoutines { throw refuseRoutines }
        return written.values.sorted { $0.position < $1.position }
    }

    func routine(_ id: String) async throws -> Routine? {
        calls.append("routine")
        guard online else { throw WindmillApiError.offline }
        if let refuseRoutine { throw refuseRoutine }
        return written[id]
    }

    func createRoutine(_ write: RoutineWrite) async throws -> Routine {
        calls.append("createRoutine")
        routineWrites.append(write)
        guard online else { throw WindmillApiError.offline }
        if let refuseCreateRoutine { throw refuseCreateRoutine }
        if let already = written[write.id] { return already }
        if takenRoutineIds.contains(write.id) {
            throw refusal(409, code: "routine-id-taken", "that routine id is taken")
        }
        let made = Routine(id: write.id, name: write.name, position: write.position,
                           entries: write.entries.enumerated().map { index, entry in
                               RoutineEntry(position: index + 1, exerciseId: entry.exerciseId,
                                            targetSets: entry.targetSets, targetReps: entry.targetReps,
                                            targetWeightKg: entry.targetWeightKg,
                                            restSeconds: entry.restSeconds)
                           })
        written[made.id] = made
        return made
    }

    func replaceRoutine(_ id: String, with write: RoutineWrite) async throws -> Routine {
        calls.append("replaceRoutine")
        guard online else { throw WindmillApiError.offline }
        written[id] = nil
        let saved = try await createRoutine(write)
        revisions[id] = (revisions[id] ?? 1) + 1
        for index in ledger.indices where ledger[index].routineId == id && ledger[index].state == .pending {
            settle(index, as: .superseded)
        }
        return saved
    }

    func deleteRoutine(_ id: String) async throws {
        calls.append("deleteRoutine")
        guard online else { throw WindmillApiError.offline }
        written[id] = nil
    }

    func proposals() async throws -> [ProposalHead] {
        calls.append("proposals")
        guard online else { throw WindmillApiError.offline }
        if let refuseProposals { throw refuseProposals }
        return ledger.map(\.head)
    }

    func proposal(_ id: String) async throws -> Proposal? {
        calls.append("proposal")
        guard online else { throw WindmillApiError.offline }
        return ledger.first { $0.id == id }
    }

    func applyProposal(_ id: String) async throws -> AppliedProposal {
        calls.append("applyProposal")
        guard online else { throw WindmillApiError.offline }
        if let refuseApply { throw refuseApply }
        guard let index = ledger.firstIndex(where: { $0.id == id }) else {
            throw WindmillApiError.refused(404, Refusal(Data(#"{"error":"no such proposal"}"#.utf8)))
        }
        let held = ledger[index]
        if held.state == .applied { return AppliedProposal(proposal: held, routine: written[held.routineId]) }
        if held.state == .dismissed {
            throw refusal(409, code: "proposal-settled", "that proposal was already dismissed")
        }
        if held.state == .superseded || held.baseRevision != (revisions[held.routineId] ?? 1) {
            settle(index, as: .superseded)
            throw refusal(409, code: "proposal-superseded", "the routine moved after this was written")
        }
        settle(index, as: .applied)
        guard held.intent == .revise else {
            let done = ledger[index]
            written[held.routineId] = nil
            ledger.removeAll { $0.routineId == held.routineId }
            return AppliedProposal(proposal: done)
        }
        let base = written[held.routineId]
        let changed = Routine(id: held.routineId, name: held.name, position: base?.position ?? 0,
                              lastTrainedAtMs: base?.lastTrainedAtMs,
                              entries: held.changes.filter { $0.kind != .removed }.map { change in
                                  RoutineEntry(position: change.position, exerciseId: change.exerciseId,
                                               targetSets: change.after?.sets ?? 0,
                                               targetReps: change.after?.reps,
                                               targetWeightKg: change.after?.weightKg,
                                               restSeconds: change.after?.restSeconds)
                              })
        written[changed.id] = changed
        revisions[changed.id] = (revisions[changed.id] ?? 1) + 1
        for other in ledger.indices
        where ledger[other].routineId == changed.id && ledger[other].state == .pending {
            settle(other, as: .superseded)
        }
        return AppliedProposal(proposal: ledger[index], routine: changed)
    }

    func dismissProposal(_ id: String) async throws -> Proposal {
        calls.append("dismissProposal")
        guard online else { throw WindmillApiError.offline }
        guard let index = ledger.firstIndex(where: { $0.id == id }) else {
            throw WindmillApiError.refused(404, Refusal(Data(#"{"error":"no such proposal"}"#.utf8)))
        }
        if ledger[index].state == .dismissed { return ledger[index] }
        guard ledger[index].state == .pending else {
            throw refusal(409, code: "proposal-settled", "that proposal was already settled")
        }
        settle(index, as: .dismissed)
        return ledger[index]
    }

    private func settle(_ index: Int, as state: ProposalState) {
        ledger[index] = settled(ledger[index], as: state)
    }

    private func settled(_ proposal: Proposal, as state: ProposalState) -> Proposal {
        let head = proposal.head
        return Proposal(head: ProposalHead(id: head.id, routineId: head.routineId, intent: head.intent,
                                           state: state, summary: head.summary,
                                           changeCount: head.changeCount, createdAtMs: head.createdAtMs,
                                           settledAtMs: 9_000, source: head.source),
                        baseRevision: proposal.baseRevision, baseName: proposal.baseName,
                        name: proposal.name, changes: proposal.changes)
    }

    func record(of exerciseId: String) async throws -> MovementRecord? {
        calls.append("record")
        guard online else { throw WindmillApiError.offline }
        if let refuseRecord { throw refuseRecord }
        settleOpen()
        return records[exerciseId]
    }

    func renameExercise(_ exerciseId: String, to name: String) async throws -> Exercise? {
        calls.append("renameExercise")
        guard online else { throw WindmillApiError.offline }
        if let refuseRename { throw refuseRename }
        guard let index = catalog.firstIndex(where: { $0.id == exerciseId }) else { return nil }
        let held = catalog[index]
        catalog[index] = Exercise(id: held.id, name: name, pattern: held.pattern,
                                  equipment: held.equipment, stepKg: held.stepKg, custom: held.custom)
        return catalog[index]
    }

    func share(_ sessionId: String) async throws -> SessionShare {
        calls.append("share")
        guard online else { throw WindmillApiError.offline }
        if let refuseShare { throw refuseShare }
        guard stored[sessionId] != nil else { throw WindmillApiError.refused(404, Refusal(Data())) }
        if let live = shares[sessionId] { return live }
        let minted = SessionShare(token: "tok_\(sessionId)", expiresAtMs: 2_592_000_000)
        shares[sessionId] = minted
        return minted
    }

    func revokeShare(_ sessionId: String) async throws {
        calls.append("revokeShare")
        guard online else { throw WindmillApiError.offline }
        if let refuseRevoke { throw refuseRevoke }
        guard shares.removeValue(forKey: sessionId) != nil else {
            throw WindmillApiError.refused(404, Refusal(Data()))
        }
    }

    func preferences() async throws -> GymPreferences {
        calls.append("preferences")
        guard online else { throw WindmillApiError.offline }
        return settings ?? .defaults
    }

    func savePreferences(_ preferences: GymPreferences) async throws -> GymPreferences {
        calls.append("savePreferences")
        settingsWrites.append(preferences)
        await onSavePreferences()
        guard online else { throw WindmillApiError.offline }
        if let refusePreferences { throw refusePreferences }
        settings = preferences
        return preferences
    }

    func bodyweight() async throws -> [BodyweightEntry] {
        calls.append("bodyweight")
        await onBodyweightRead()
        guard online else { throw WindmillApiError.offline }
        if let refuseBodyweight { throw refuseBodyweight }
        return weighIns.values.sorted { $0.dateLocal < $1.dateLocal }
    }

    func bodyweight(on dateLocal: String) async throws -> BodyweightEntry? {
        calls.append("bodyweightOn")
        await onBodyweightRead()
        guard online else { throw WindmillApiError.offline }
        if let refuseBodyweight { throw refuseBodyweight }
        return weighIns[dateLocal]
    }

    // The server's rules: a real date, the 20–400 band, and the later `recordedAt` wins — a stale replay
    // answers 200 with the stored row unchanged.
    func putBodyweight(on dateLocal: String, _ write: BodyweightWrite) async throws -> BodyweightEntry {
        calls.append("putBodyweight")
        bodyweightWrites.append(dateLocal)
        await onPutBodyweight()
        guard online else { throw WindmillApiError.offline }
        if let refuseBodyweight { throw refuseBodyweight }
        guard Bodyweight.isDateLocal(dateLocal) else {
            throw WindmillApiError.refused(400, Refusal(Data(#"{"error":"could not read that date"}"#.utf8)))
        }
        guard write.weightKg >= 20, write.weightKg <= 400 else {
            throw WindmillApiError.refused(400, Refusal(Data(#"{"error":"Between 20 and 400 kg — check the number."}"#.utf8)))
        }
        if let held = weighIns[dateLocal], held.recordedAt > write.recordedAt { return held }
        let stored = BodyweightEntry(dateLocal: dateLocal, weightKg: (write.weightKg * 100).rounded() / 100,
                                     recordedAt: write.recordedAt)
        weighIns[dateLocal] = stored
        return stored
    }

    func deleteBodyweight(on dateLocal: String) async throws {
        calls.append("deleteBodyweight")
        await onDeleteBodyweight()
        guard online else { throw WindmillApiError.offline }
        if let refuseBodyweight { throw refuseBodyweight }
        weighIns[dateLocal] = nil
    }
}
