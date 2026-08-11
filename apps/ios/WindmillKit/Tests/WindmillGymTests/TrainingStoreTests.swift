import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// What has to be true for a set somebody lifted to survive: it is on the device before the log is
// consulted, it stays there when the log cannot be reached, the four refusals each get the repair
// they ask for, and a set that will never land is SAID rather than swallowed. These are the paths
// that lose training.

// Refusals as the wire delivers them — a sentence for a human under "error", and, for the reasons a
// client must branch on, a machine word under "code". The tests below deliberately reword the
// sentences: the code is the contract and nothing here may read English to decide what to do.
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

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-\(UUID().uuidString).json")
        catalogURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-catalog-\(UUID().uuidString).json")
        localURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-local-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
        try? FileManager.default.removeItem(at: catalogURL)
        try? FileManager.default.removeItem(at: localURL)
    }

    // The undo window is off here on purpose. What every test below is about is what happens to a
    // set once the walk REACHES it — the refusals, the remints, the lanes, the ordering — and a
    // nine-second hold in front of that would only be a delay between the tap and the subject.
    // The window has its own tests (UndoWindowTests), where it is the subject.
    private func makeStore(sync: FakeTraining?,
                           mintSet: @escaping () -> String = { Ids.set() },
                           retryAfter: Duration = .seconds(4)) -> TrainingStore {
        var ms: Int64 = 1_000
        return TrainingStore(
            queue: SetQueue(url: queueURL),
            deviceCatalog: DeviceCatalog(url: catalogURL),
            localLog: LocalLog(url: localURL),
            now: { ms += 1; return ms },
            mintSession: { "ses_minted" },
            mintSet: mintSet,
            undoWindowMs: 0,
            retryAfter: retryAfter,
            sync: { _ in sync }
        )
    }

    private func account(signedIn: Bool) -> Account {
        Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: signedIn ? User(id: "u1", email: "sam@example.com", name: "Sam") : nil
        )
    }

    // A store standing where the room stands mid-workout: a session open on the log, a movement in
    // hand, nothing owed yet.
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

    // The set is the lifter's the instant they tap and the network's problem afterwards — so a
    // basement gym costs nothing, a relaunch costs nothing, and the words say exactly that.
    func testASetLoggedOfflineSurvivesARelaunchAndFlushesOnReconnect() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.online = false
        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(store.saveState, .offline)
        XCTAssertEqual(store.saveState.line, "offline · saved here")
        XCTAssertEqual(store.sets.map(\.weightKg), [82.5], "the row is on screen — the device is holding it")
        XCTAssertEqual(SetQueue(url: queueURL).pending.count, 1)

        server.online = true
        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5])
        XCTAssertEqual(relaunched.sets.map(\.setNumber), [1], "the log numbered it, so it is the log's now")
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty)
    }

    // 409 `set-id-taken` means that id names a row outside this session. A new id lands the same set;
    // treating it as terminal would drop a lift over a collision the device can repair by itself.
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

    // 409 `session-finished` is the one refusal that costs a set: it never landed and never will. It
    // is removed and SAID — the banner is the last copy of it, so it carries the movement too.
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
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty)
    }

    // The queue's whole premise: send in any order, any number of times, and converge on one row per
    // minted id. A reply that never arrived leaves the set owed, and the replay answers with the row
    // the log already stored rather than filing it a second time.
    func testAReplyThatNeverArrivedIsReplayedAndTheLogStillHoldsOneRow() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.swallowReplies = 1
        await store.logSet(weightKg: 82.5, reps: 5)
        XCTAssertEqual(store.saveState, .offline)
        XCTAssertEqual(SetQueue(url: queueURL).pending.count, 1)

        await store.flushPendingSets()

        XCTAssertEqual(server.appended.count, 2, "the same set went out twice")
        XCTAssertEqual(server.sets["ses_1"]?.count, 1, "and the log converged on one row")
        XCTAssertEqual(store.sets.map(\.setNumber), [1])
        XCTAssertEqual(store.saveState, .onTheLog)
    }

    // A session that closed before a set reached it refuses that set forever, so finishing drains
    // first and closes second. The order is the whole rule.
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

    // ...and when they cannot be drained, Finish does not fire at all. Closing over an undelivered
    // set is the one loss the device can see coming.
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

    // The close is a round trip, and a set logged into a session that closes under it is refused
    // forever. The pad is shut for exactly that window — and `isFinishing` is published so the room
    // can say where that set can still go rather than swallowing the tap.
    func testASetTappedWhileTheSessionIsClosingIsNotFiledIntoIt() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.onFinish = { [weak store] in await store?.logSet(weightKg: 60, reps: 10) }
        let outcome = await store.finish()

        guard case .closed = outcome else { return XCTFail("the session did not close: \(outcome)") }
        XCTAssertNil(server.sets["ses_1"], "nothing was filed into a session that was closing")
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty, "and nothing was left owed against it")
    }

    // A 500 is the STORE failing, not the set being refused. Keeping it queued is the difference
    // between a five-second lock wait and a lift thrown away.
    func testAStorageFailureKeepsTheSetQueuedRatherThanRefusingIt() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.refuse = { _ in storageFailure }
        await store.logSet(weightKg: 90, reps: 5)

        XCTAssertEqual(SetQueue(url: queueURL).pending.count, 1)
        XCTAssertTrue(store.refusals.isEmpty, "the server failing is not the set being refused")
        XCTAssertEqual(store.saveState, .offline)
        XCTAssertEqual(store.sets.count, 1, "the row stays on screen — the device is holding it")
    }

    // Order is per (session, movement), because that is the only order the server keeps. A jam that
    // stopped the whole queue would stop a whole workout, silently.
    func testASetThatCannotLandHoldsUpItsOwnMovementAndNoOther() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.refuse = { $0.exerciseId == "bench-press" ? storageFailure : nil }
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.choose("back-squat")
        await store.logSet(weightKg: 100, reps: 5)

        XCTAssertEqual(server.sets["ses_1"]?.map(\.exerciseId), ["back-squat"])
        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.set.exerciseId), ["bench-press"])
        XCTAssertEqual(store.sets.map(\.exerciseId), ["bench-press", "back-squat"],
                       "both are on screen — one is on the log and one is on the device")
    }

    // Pressing Start cannot re-plan a workout that is already running: the session that comes back is
    // the live one, with ITS snapshot, and its sets come with it rather than being drawn over.
    func testStartingWhileASessionIsOpenJoinsItWithItsOwnSets() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_live", startedAtMs: 500,
                            plan: PlanSnapshot(routine: "Push A",
                                               entries: [PlanEntry(exerciseId: "bench-press", sets: 5,
                                                                   reps: 5, weightKg: 82.5)])))
        server.sets["ses_live"] = [TrainingSet(id: "set_old", exerciseId: "bench-press", setNumber: 1,
                                               weightKg: 82.5, reps: 5, completedAtMs: 600)]
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        let joined = try? await store.start(routineId: "rt_other").get()

        XCTAssertEqual(joined?.id, "ses_live", "a start joins the open session rather than opening a second")
        XCTAssertEqual(store.session?.plan?.routine, "Push A",
                       "and it keeps that session's own snapshot — Start cannot re-plan a running workout")
        XCTAssertEqual(store.sets.map(\.id), ["set_old"], "the sets already logged into it come with it")
    }

    // The number in front of the lifter before they touch anything: the plan's target while the
    // movement is untouched, then their own last set the moment there is one.
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

    // Signed out is a supported state, not a degraded one: the room is anonymous-first, and the
    // whole signed-out life of a session — start, log, finish, claim — has its own suite
    // (AnonymousGymTests). What this file keeps is the signed-in walk.

    // A WARMUP IS A KIND THE LOGGER CAN WRITE, and it counts toward nothing. Before the toggle
    // existed every set this surface could produce was `working`, so a 60 kg ramp-up was fed to the
    // record rules as the mark to beat — and the finish screen minted a gold personal record for it.
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

    // A set refused in one lane must not take the retry away from a set merely jammed in another.
    // Nothing else carries the jammed one: the walk cancelled the task it arrived with, so returning
    // at the refusal left it on the device with no retry and no strip saying it was there.
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
        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.set.exerciseId), ["bench-press"])
        XCTAssertEqual(store.strandedCount, 1,
                       "the strip says the bench set is on this device, whatever the other lane answered")

        let sent = server.appended.filter { $0.exerciseId == "bench-press" }.count
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertGreaterThan(server.appended.filter { $0.exerciseId == "bench-press" }.count, sent,
                             "and the retry fired on its own, with nobody tapping anything")
    }

    // A log that answered with a reason is not a log that went quiet. The routine was deleted from
    // the web; saying "the log didn't answer" points the lifter at their signal instead of at the
    // program that is gone.
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

        server.refuseStart = nil
        server.online = false
        guard case .failure(let quiet) = await store.start() else {
            return XCTFail("an unreachable log is not a session either")
        }
        XCTAssertEqual(quiet, .noAnswer)
        XCTAssertEqual(quiet.line("a session starts there"),
                       "the log didn’t answer — a session starts there")
    }

    // The write that moves next week's target. It answered with a bool nobody read, so the sheet
    // closed identically whether or not the routine changed — and the lifter believed it had.
    func testAWriteBackThatDidNotLandSaysWhatDidNotHappen() async {
        let server = FakeTraining()
        server.written["rt_push_a"] = Routine(id: "rt_push_a", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ])
        let store = await liveStore(server)

        server.online = false
        let quiet = await store.save(87.5, toRoutine: "rt_push_a", for: "bench-press")
        XCTAssertEqual(quiet, .noAnswer)
        XCTAssertEqual(quiet?.line("Push A wasn’t changed"),
                       "the log didn’t answer — Push A wasn’t changed")
        XCTAssertEqual(server.written["rt_push_a"]?.entries.first?.targetWeightKg, 82.5,
                       "and nothing moved")

        server.online = true
        let gone = await store.save(87.5, toRoutine: "rt_gone", for: "bench-press")
        XCTAssertEqual(gone, .refused("that routine is no longer on the log"))

        let landed = await store.save(87.5, toRoutine: "rt_push_a", for: "bench-press")
        XCTAssertNil(landed, "a write that landed says nothing at all")
        XCTAssertEqual(server.written["rt_push_a"]?.entries.first?.targetWeightKg, 87.5)
    }

    // The picker closed on a movement that was never minted, and absolutely nothing was said.
    func testAMovementThatWasNotCreatedSaysSoInTheLogsOwnWords() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.refuseCreate = refusal(409, code: "exercise-id-taken", message: "that movement id is taken")
        guard case .failure(let why) = await store.create("Zercher Squat") else {
            return XCTFail("a refused create is not a movement")
        }
        XCTAssertEqual(why, .refused("that movement id is taken"))
        XCTAssertFalse(store.catalog.contains { $0.name == "Zercher Squat" })

        server.refuseCreate = nil
        guard case .success(let made) = await store.create("Zercher Squat") else {
            return XCTFail("the second attempt lands")
        }
        XCTAssertEqual(made.name, "Zercher Squat")
        XCTAssertEqual(store.catalog.map(\.name), ["Zercher Squat"])
    }

    // A movement is a stable id everywhere except on screen. Held only in memory, a cold launch in a
    // basement drew `bench-press` at 28pt where `Bench Press` belongs — for the whole session.
    func testTheMovementNamesAreHeldOnTheDeviceAndAreThereBeforeTheFirstFrame() async {
        let server = FakeTraining()
        server.catalog = [Exercise(id: "bench-press", name: "Bench Press"),
                          Exercise(id: "back-squat", name: "Back Squat")]
        let store = await liveStore(server)
        XCTAssertEqual(store.catalog.map(\.name), ["Bench Press", "Back Squat"])

        // A cold launch with no signal: nothing is read, and the names are already there.
        let relaunched = makeStore(sync: nil)
        XCTAssertEqual(relaunched.catalog.map(\.id), ["bench-press", "back-squat"])
        XCTAssertEqual(Readout.movement("bench-press", in: relaunched.catalog), "Bench Press")

        await relaunched.connect(to: account(signedIn: false))
        XCTAssertEqual(relaunched.catalog.map(\.name), ["Bench Press", "Back Squat"],
                       "signing out does not forget what a movement is called")
    }

    // ── the foot of the log ────────────────────────────────────────────────────────────────────

    // The server's page is 50 (`TrainingStore.logPage`), so a full one means there may be more and a
    // short one is the bottom. Nothing here counts sessions to decide that — the page length is the
    // only thing that knows.
    private func finished(_ count: Int, from: Int64 = 100_000) -> [Session] {
        (0..<count).map { Session(id: "ses_\($0)", startedAtMs: from + Int64($0) * 1_000,
                                  finishedAtMs: from + Int64($0) * 1_000 + 500) }
    }

    private func log(_ sessions: [Session]) -> FakeTraining {
        let server = FakeTraining()
        for session in sessions { server.stored[session.id] = session }
        return server
    }

    // A short first page IS the bottom, and the bottom is the one state that may name somebody's
    // first session — so nothing reaches it on a guess.
    func testAShortFirstPageIsTheBottomOfTheLog() async {
        let store = makeStore(sync: log(finished(3)))
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.logFoot, .bottom)
        XCTAssertEqual(store.recent.count, 3)
    }

    // A full page is not an answer about the log's length — it is the reason `Load older` is there.
    // The tap is the lifter's: twelve weeks back is a destination and infinite scroll has no arrival.
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

    // A read that failed says so and offers the one move. The rows already loaded STAY — they are
    // real sessions and worth reading — and the foot never claims the log ends where a failure did.
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

    // HOW FAR THE READING GOT IS THE SERVER'S ANSWER AND NOT THE SCREEN'S BOTTOM ROW. This device's
    // unclaimed sessions are merged into the log at ANY age, so one whose claim cannot land sits
    // BELOW the served page — and the log's fold takes its floor from here. Taking it from `recent`
    // instead would call the half-loaded week above that row whole and caption it with a total that
    // grows on the next tap of `Load older`.
    func testTheServedFloorIsTheOldestRowTheSERVERAnsweredWith() async {
        let shelf = LocalLog(url: localURL)
        shelf.keep(Session(id: "ses_local", startedAtMs: 1_000, finishedAtMs: 2_000), sets: [])
        shelf.flush()

        let server = log(finished(58))
        server.refuseStart = storageFailure          // the claim is retryable, so it never lands
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
}

// The four verdicts, derived from the status and the machine word and NEVER from the sentence. The
// wording is copy and may be edited any day; a queue that string-compared it would degrade to
// "terminal, reason unknown" the first time one was reworded — and drop a set it should have minted
// a fresh id for.
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

    // 401 waits for a sign-in and 404 for a session to exist. Terminal and retryable never both hold,
    // and neither follows from the other's absence — reading "not retryable" as "lost" throws away a
    // set that was only waiting for the Keychain to come back.
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

    // The repair budget is its own counter, and it is bounded: a collision that keeps happening is
    // not a coincidence, and re-minting forever would hammer the log instead of telling the lifter.
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
        return (SetQueue(url: url), url)
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

        let reopened = SetQueue(url: url)
        XCTAssertEqual(reopened.session?.id, "ses_1")
        XCTAssertEqual(reopened.sets.map(\.id), ["set_a"])
        XCTAssertEqual(reopened.pending.count, 1, "an unsent set is still owed after a relaunch")
    }

    func testAnUnreadableFileOpensEmptyRatherThanCrashing() {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-\(UUID().uuidString).json")
        try? Data("not json at all".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let queue = SetQueue(url: url)
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

    // A jammed lane is skipped, not the queue. Every other movement keeps moving.
    func testABlockedLaneIsSteppedOverAndTheNextMovementIsOffered() {
        let (queue, url) = makeQueue()
        defer { try? FileManager.default.removeItem(at: url) }

        queue.store(aSet("set_a", "bench-press", at: 1_000), in: "ses_1", needsPush: true)
        queue.store(aSet("set_b", "back-squat", at: 2_000), in: "ses_1", needsPush: true)

        let first = queue.nextOwed(skipping: [], readyAt: nil)
        XCTAssertEqual(first?.set.id, "set_a")
        XCTAssertEqual(queue.nextOwed(skipping: [first!.lane], readyAt: nil)?.set.id, "set_b")
    }

    // The log holding the row IS delivery, however the news arrived — a reply to our own write, or a
    // read that found it there.
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

    // Closing keeps what is owed and lets go of what is on the log. An owed set is dropped by nobody
    // quietly — it waits for the log to answer for it, and that answer is what tells the lifter.
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

    // The claim reminted a movement the live session's frozen plan names: the repair reaches the
    // sets, the walk order AND the plan's own lines — a plan row left on the dead id would miss the
    // planEntry lookup and draw an id the remapped catalog no longer knows.
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

    // The banner keys its rows off RefusedWrite.id. A claim row keyed on the NAME folded two
    // same-named losses into one — ForEach drew one row for both, and one loss went unsaid.
    func testTwoSameNamedClaimLossesAreTwoRowsNotOne() {
        let movement = RefusedWrite.claim(RefusedClaim(id: "ex_press", name: "Press", reason: "refused"))
        let routine = RefusedWrite.claim(RefusedClaim(id: "rt_press", name: "Press", reason: "refused"))

        XCTAssertEqual(movement.id, "claim-ex_press")
        XCTAssertEqual(routine.id, "claim-rt_press")
        XCTAssertNotEqual(movement.id, routine.id,
                          "a name collision must not fold two losses into one banner row")
    }

    // Discard is the one case where an owed set has nowhere left to go: the session id no longer
    // names anything, so keeping it would re-send it against nothing, forever.
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

// The two shapes a said loss takes, unwrapped for assertions — the same cast Android's tests make
// on RefusedWrite.
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

// A log entirely under the test's control: it can be unreachable, it can already hold a session and
// its sets, it can refuse a named movement, and it can store a set and then lose the reply. Its
// start walks the server's own resolution order — the caller's OWN row first (a replay answers the
// stored session), then the open session for a joining start, then a refusal for `false` — because
// the claim replay's whole safety rests on that order and a fake that joined anyway would prove
// nothing.
final class FakeTraining: TrainingSyncing, @unchecked Sendable {
    var online = true
    var catalog: [Exercise] = []
    var stored: [String: Session] = [:]
    var sets: [String: [TrainingSet]] = [:]
    var written: [String: Routine] = [:]
    var lastTimes: [String: LastTime] = [:]
    var reviews: [String: Review] = [:]
    var shares: [String: SessionShare] = [:]
    var stats = TrainingStatistics()
    var refuse: (SetWrite) -> WindmillApiError? = { _ in nil }
    var refuseStart: WindmillApiError?
    var refuseCreate: WindmillApiError?
    var refuseCreateRoutine: WindmillApiError?
    var refuseShare: WindmillApiError?
    var refuseRevoke: WindmillApiError?
    var refuseStats: WindmillApiError?
    // Ids some OTHER account already spent — the 409s whose code asks for a remint.
    var takenSessionIds: Set<String> = []
    var takenRoutineIds: Set<String> = []
    var takenExerciseIds: Set<String> = []
    var swallowReplies = 0
    // The close is a round trip, and this is the only way a test can stand inside it.
    var onFinish: () async -> Void = {}

    private(set) var appended: [SetWrite] = []
    private(set) var started: [SessionStart] = []
    private(set) var finishes: [String: Int64] = [:]
    private(set) var routineWrites: [RoutineWrite] = []
    private(set) var exerciseWrites: [ExerciseWrite] = []
    private(set) var calls: [String] = []

    func open(_ session: Session) {
        stored[session.id] = session
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
        if takenSessionIds.contains(start.id) {
            throw refusal(409, code: "session-id-taken", "that session id is taken")
        }
        // The server's heldFor: a replayed start answers the caller's own stored row, open or
        // closed, before any join or refusal is considered.
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
        return opened
    }

    func appendSet(to sessionId: String, _ write: SetWrite) async throws -> TrainingSet {
        calls.append("append")
        appended.append(write)
        guard online else { throw WindmillApiError.offline }
        if let refusal = refuse(write) { throw refusal }
        // The id IS the idempotency key: a replay answers with the stored row, even after the
        // session closed, and never files a second one.
        if let already = sets[sessionId]?.first(where: { $0.id == write.id }) { return already }

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

    func finishSession(_ sessionId: String, at finishedAtMs: Int64) async throws -> Session {
        calls.append("finish")
        await onFinish()
        guard online else { throw WindmillApiError.offline }
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

    // A page of the log, and it honours the CURSOR and the LIMIT, because the client's paging is what
    // half these tests are about: the cursor is both halves of the sort key, so a fake that ignored
    // the id would hide the one bug a shared instant can cause.
    func sessions(before: Int64?, beforeId: String?, limit: Int) async throws -> [SessionSummary] {
        calls.append("sessions")
        guard online else { throw WindmillApiError.offline }
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

    func routines() async throws -> [Routine] {
        calls.append("routines")
        guard online else { throw WindmillApiError.offline }
        return written.values.sorted { $0.position < $1.position }
    }

    func routine(_ id: String) async throws -> Routine? {
        calls.append("routine")
        guard online else { throw WindmillApiError.offline }
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
        return try await createRoutine(write)
    }

    func deleteRoutine(_ id: String) async throws {
        calls.append("deleteRoutine")
        guard online else { throw WindmillApiError.offline }
        written[id] = nil
    }

    func statistics() async throws -> TrainingStatistics {
        calls.append("statistics")
        guard online else { throw WindmillApiError.offline }
        if let refuseStats { throw refuseStats }
        return stats
    }

    // Idempotent on the session, exactly as the log is: a second mint for a session that already has
    // a live share hands back the same token rather than a second capability.
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
}
