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

    private func account(signedIn: Bool, id: String = "u1") -> Account {
        Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: signedIn ? User(id: id, email: "\(id)@example.com", name: "Sam") : nil
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
    //
    // AND THE HELD NAMES BELONG TO A SEAT. What an account CALLS a movement is its own: renaming one
    // of the 64 global seeds writes a per-account display override (§H), so the file is one
    // account's names and not everybody's. A relaunch under the same account draws them back before
    // any read; every other seat — the anonymous room included, where no catalog read ever comes to
    // replace them — falls back to the SEEDS this app ships with rather than to somebody else's
    // private name for a movement they share.
    func testTheMovementNamesAreHeldPerSeatAndAreThereBeforeTheFirstFrame() async {
        let server = FakeTraining()
        server.catalog = [Exercise(id: "bench-press", name: "Bench Press"),
                          Exercise(id: "back-squat", name: "Back Squat")]
        let store = await liveStore(server)
        XCTAssertEqual(store.catalog.map(\.name), ["Bench Press", "Back Squat"])

        // A cold launch with no signal under the same account: no read answers, and the names are
        // there anyway — set in the same synchronous breath as the live session below them.
        server.online = false
        let relaunched = makeStore(sync: server, retryAfter: .seconds(600))
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(relaunched.catalog.map(\.id), ["bench-press", "back-squat"])
        XCTAssertEqual(Readout.movement("bench-press", in: relaunched.catalog), "Bench Press")

        // Nobody's seat is a seat: the anonymous room lets go of the names an account read and opens
        // on the sixty-four the app ships with, which is the whole of the catalog it ever has.
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        XCTAssertEqual(anonymous.catalog, DeviceCatalog.seeded)
        XCTAssertEqual(Readout.movement("bench-press", in: anonymous.catalog), "Bench Press",
                       "the seeds are global — the name only becomes an account's when it is changed")
    }

    // ── the assembly list (§A screen 2) ────────────────────────────────────────────────────────

    // THE WORST DEFECT THIS GESTURE COULD HAVE, asked directly: a reorder that lost a logged set.
    // It cannot, and the reason is structural rather than careful — the walk order is a list of ids
    // and the sets are keyed by session and movement, so nothing a drag does can reach one. The
    // order it leaves behind also has to SURVIVE the next redraw, or the list would spring back
    // under the thumb that just moved it.
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
        XCTAssertEqual(SetQueue(url: queueURL).order, ["face-pull", "bench-press", "cable-fly"],
                       "and it is on disk, so the app dying does not undo it")

        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(relaunched.order, ["face-pull", "bench-press", "cable-fly"],
                       "the redraw keeps what the device holds at the head — nothing re-sorts it")
    }

    // A SWIPE ONLY REACHES WHAT NOTHING IS HOLDING ON TO. A movement that was lifted is a fact, and
    // a movement the frozen plan names is what the routine asked for — both would be put straight
    // back by the next redraw, so the store refuses them rather than flickering.
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
        XCTAssertEqual(SetQueue(url: queueURL).order, ["bench-press", "cable-fly"])
    }

    // Dropping the movement IN HAND moves the hand — standing on a movement the lifter just took off
    // the list would be the screen disagreeing with the edit. It resumes where the sets are; with
    // nothing left it is the picker again, which is the same screen the session opened on.
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

    // ── the picker's meta ──────────────────────────────────────────────────────────────────────

    // The read is SPARSE, so what is absent from it is an assertion — "never logged" — and the store
    // may only let a screen make it once an answer has landed. A read that failed leaves the map nil,
    // and the picker says nothing rather than telling a lifter their history is gone.
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

    // Signed in, this device's own unclaimed sessions are folded over the account's answer: those
    // workouts happened, the log has simply never heard of them, and the newer line is the true one.
    // The claim is offline here because that is the only way a session stays unclaimed — a shelf the
    // claim can reach is a shelf it empties, which is the case that needs no fold at all.
    func testThePickerMetaFoldsThisDevicesOwnSessionsOverTheAccounts() async {
        let shelf = LocalLog(url: localURL)
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

    // A LAST-TIME READ THAT WAS ASKED AND DID NOT LAND IS A DIFFERENT FACT from one nobody has asked
    // yet, and the logger has one line left for it (§K deleted the card, not this). Without the flag
    // the dial falls silently back to the empty bar: a lifter with a year of 105 kg benches, phone in
    // a basement, reads 20 kg under the thumb with nothing anywhere saying the log was never reached.
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

        // It is about ONE read and not about the connection: the answer landing takes the line off.
        server.online = true
        await store.choose("back-squat")

        XCTAssertEqual(store.lastTime?.sets.map(\.weightKg), [105])
        XCTAssertFalse(store.lastTimeFailed)
        XCTAssertEqual(store.prefill, Prefill(weightKg: 105, reps: 5))
    }

    // ...and a reply for a movement the lifter has already walked away from claims nothing about the
    // one in hand — neither an answer nor a failure, since the dial in front of them is not its dial.
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

    // MARK: - a movement's record, and the name it is read under

    // A movement the log no longer holds and a log that went quiet are two different facts, and the
    // record page draws a different sentence for each: collapsing them points a lifter at their
    // signal when the answer was on the server.
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

    // THE ID NEVER MOVES. That is the whole promise the record page exists to make visible: rename
    // the movement and every set, routine entry and frozen plan snapshot still points at it — so
    // what changes here is the catalog's name and nothing else, on the log and on the device.
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

        // AND ONLY FOR THIS SEAT. A rename over a seeded row is a per-account display override, so
        // the held names are held under the account that read them: another lifter's launch, and the
        // anonymous room — where no catalog read ever comes to replace them — fall back to the
        // SHIPPED names rather than spelling somebody's private one for a movement everybody shares.
        XCTAssertEqual(DeviceCatalog(url: catalogURL).open(under: "u2"), DeviceCatalog.seeded)
        XCTAssertEqual(DeviceCatalog(url: catalogURL).open(under: nil), DeviceCatalog.seeded)

        server.online = false
        let quiet = await store.rename("back-squat", to: "Back Squat")
        XCTAssertEqual(quiet, .noAnswer, "a rename that did not land says so rather than pretending")
    }

    // A movement this device minted and has not claimed yet is renamed ON THE SHELF: the shelf entry
    // IS the pending create, so the new name is simply the name the log first hears — and a PATCH
    // against a movement the log has never held would 404.
    func testRenamingAnUnclaimedMovementRewritesTheCreateTheClaimWillReplay() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        guard case .success(let minted) = await store.create("Bench") else {
            return XCTFail("the device mints its own movements signed out")
        }

        let renamed = await store.rename(minted.id, to: "Bench Press")
        XCTAssertNil(renamed)
        XCTAssertEqual(store.catalog.last?.name, "Bench Press")
        XCTAssertEqual(LocalLog(url: localURL).exercises.map(\.name), ["Bench Press"])
        XCTAssertEqual(LocalLog(url: localURL).exercises.map(\.id), [minted.id],
                       "the id the sets already name does not move")

        // Signed out, a movement the ACCOUNT owns is the account's to name: the catalog is global
        // and this device cannot hold a per-account name for a row it does not own.
        let refused = await store.rename("back-squat", to: "Low-bar Squat")
        XCTAssertEqual(refused, .refused("renaming this movement needs your account — sign in first"))
    }

    // A MOVEMENT WHOSE CREATE IS STILL OWED IS THE DEVICE'S TO ANSWER FOR, whoever is signed in —
    // signed in on a phone with no signal is the ordinary way to be here. The log has never heard of
    // the id, so a served read would 404 over a movement that is on screen with a finished session
    // under it; and no set naming it can have landed either, because the claim replays a create
    // BEFORE any session that names it. The device's answer is therefore the whole of it.
    //
    // So the rename rewrites the pending create and the re-read the sheet triggers comes back with
    // the NEW NAME — rather than the sheet closing as a success over a page that then says the
    // movement is no longer in a catalog it is visibly in.
    func testAnUnclaimedMovementReadsAndRenamesOnTheDeviceEvenSignedIn() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success(let minted) = await anonymous.create("Zercher") else {
            return XCTFail("the device mints its own movements signed out")
        }
        _ = await anonymous.start()
        await anonymous.choose(minted.id)
        await anonymous.logSet(weightKg: 80, reps: 5)
        guard case .closed = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.online = false                   // the claim cannot land, so the shelf keeps both
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

        // And the caveat the record page prints is asked PER MOVEMENT: this one has a session the
        // log has not been told about, and every other movement on the phone does not.
        XCTAssertTrue(store.unclaimed(minted.id))
        XCTAssertFalse(store.unclaimed("back-squat"),
                       "an unclaimed session of one movement is not a caveat on another's page")
    }

    // §I's settings are the room's, and the room opens signed out: a lifter who sets their plates in
    // a gym before they have an account keeps them, on this device, across a relaunch.
    func testSettingsSetBeforeThereIsAnAccountSurviveARelaunch() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        XCTAssertEqual(anonymous.preferences, .defaults)

        await anonymous.save(GymPreferences.defaults.toggling(1.25).resting(120))

        let relaunched = makeStore(sync: nil)
        await relaunched.connect(to: account(signedIn: false))
        XCTAssertFalse(relaunched.preferences.owning(1.25))
        XCTAssertEqual(relaunched.preferences.restSeconds, 120)
    }

    // THE CLAIM CARRIES THEM, and the device's copy WINS: those are the values the lifter just
    // touched, the write is last-write-wins, so replaying theirs after sign-in is what settles it.
    // No new verb — one ordinary whole-document PUT, walked behind every lift on the shelf.
    func testSigningInClaimsTheDevicesSettingsOverTheAccountsOwn() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        await anonymous.save(GymPreferences.defaults.with(barWeightKg: 15).resting(180))

        let server = FakeTraining()
        server.settings = GymPreferences.defaults.with(confirmSound: true)
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.settingsWrites.map(\.barWeightKg), [15])
        XCTAssertEqual(server.settings?.restSeconds, 180)
        XCTAssertEqual(store.preferences.barWeightKg, 15)
        XCTAssertEqual(store.preferences.restSeconds, 180)
        XCTAssertFalse(store.preferences.confirmSound,
                       "the account's older answer does not come back over the one just made")

        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(server.settingsWrites.count, 1, "nothing is owed any more, so nothing replays")
        XCTAssertEqual(relaunched.preferences.barWeightKg, 15)
    }

    // Nothing owed, so the account's document is what the room draws — and it is held on the device
    // too, which is what puts the plate set and the rest dial on the first frame of the next launch.
    func testTheAccountsSettingsAreReadAndKeptOnTheDevice() async {
        let server = FakeTraining()
        server.settings = GymPreferences.defaults.resting(90).with(platesKg: [25, 20])
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.preferences.restSeconds, 90)
        XCTAssertEqual(store.preferences.platesKg, [25, 20])
        XCTAssertTrue(server.settingsWrites.isEmpty, "a read is not a write")
        XCTAssertEqual(LocalLog(url: localURL).preferences?.platesKg, [25, 20])
    }

    // A setting the log did not take is still the lifter's: it is on the device, it is what the room
    // draws, the sentence says where it is, and the claim's own cadence sends it again.
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
        XCTAssertTrue(LocalLog(url: localURL).preferencesOwed)

        server.online = true
        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(server.settings?.restSeconds, 120, "the claim sends what is still owed")
        XCTAssertFalse(LocalLog(url: localURL).preferencesOwed)
    }

    // TWO CHIPS TAPPED IN A SECOND ARE TWO WHOLE DOCUMENTS, and two in flight at once could reach the
    // log in either order — last-write-wins would then leave it holding the older one, and a plate
    // would come back on by itself. One at a time, and the send that is in flight picks up the newest
    // thing owed before it ends: the log's last word is the lifter's last tap.
    func testTwoTapsInFlightLeaveTheLogHoldingTheSecond() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        server.onSavePreferences = { [weak store] in
            server.onSavePreferences = {}
            await store?.save(GymPreferences.defaults.toggling(1.25).toggling(2.5))
        }
        await store.save(GymPreferences.defaults.toggling(1.25))

        XCTAssertEqual(server.settingsWrites.count, 2, "the second tap is sent, and only once")
        XCTAssertEqual(server.settings?.platesKg, [25, 20, 15, 10, 5],
                       "the log's last word is the lifter's last tap")
        XCTAssertEqual(store.preferences.platesKg, [25, 20, 15, 10, 5])
        XCTAssertFalse(LocalLog(url: localURL).preferencesOwed)
    }

    // A document the log refuses outright can never land as written, so it is LET GO of rather than
    // replayed against every future connect — and the lifter keeps looking at what they chose.
    func testADocumentTheLogRefusesIsNotReplayedForever() async {
        let server = FakeTraining()
        server.refusePreferences = refusal(400, code: "rest-target", message: "a rest target runs from 15 to 900 seconds")
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        _ = await store.save(GymPreferences.defaults.resting(120))
        XCTAssertEqual(store.preferences.restSeconds, 120)
        XCTAssertFalse(LocalLog(url: localURL).preferencesOwed)

        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(server.settingsWrites.count, 1, "refused once is refused")
    }

    // SETTINGS BELONG TO AN ACCOUNT, AND A PHONE IS LENT. One lifter's document may not be drawn in
    // anybody else's room — a rest timer beeping at somebody who never set one — and it may not be
    // SENT from there either, because every write here is the whole document: the next chip tap would
    // put the first lifter's bar and plates onto the second one's row.
    func testOneLiftersSettingsAreNeitherDrawnNorSentInAnothersRoom() async {
        let hers = FakeTraining()
        hers.settings = GymPreferences.defaults.resting(180).with(barWeightKg: 25, platesKg: [25, 20])
        let herRoom = makeStore(sync: hers)
        await herRoom.connect(to: account(signedIn: true))
        XCTAssertEqual(herRoom.preferences.restSeconds, 180, "her own document, on her own seat")

        // Signed out on the same phone: the anonymous room is nobody's and opens on the defaults.
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        XCTAssertEqual(anonymous.preferences, .defaults)
        XCTAssertNil(LocalLog(url: localURL).preferences, "and the shelf let go of it on disk too")

        // And the next account in, with the log unreachable, draws its own nothing rather than hers —
        // then sends the defaults it drew, never the 25 kg bar and the 180 s rest she set.
        let his = FakeTraining()
        his.online = false
        his.settings = GymPreferences.defaults.with(barWeightKg: 15)
        let hisRoom = makeStore(sync: his)
        await hisRoom.connect(to: account(signedIn: true, id: "u2"))
        XCTAssertEqual(hisRoom.preferences, .defaults)

        his.online = true
        await hisRoom.save(hisRoom.preferences.toggling(1.25))
        XCTAssertEqual(his.settingsWrites.map(\.barWeightKg), [20])
        XCTAssertEqual(his.settingsWrites.map(\.restSeconds), [nil])
        XCTAssertEqual(his.settings?.platesKg, [25, 20, 15, 10, 5, 2.5])
    }

    // The anonymous document is the ONE crossing, and it crosses once: it is what the lifter set
    // before they had an account, so signing in carries it — and signing out again does not carry it
    // back, because by then it is the account's.
    func testTheAnonymousDocumentCrossesIntoTheAccountAndNotBackOut() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        await anonymous.save(GymPreferences.defaults.resting(120).with(barWeightKg: 15))

        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(server.settings?.barWeightKg, 15, "the claim carried it to the account")
        XCTAssertEqual(store.preferences.restSeconds, 120)

        let again = makeStore(sync: nil)
        await again.connect(to: account(signedIn: false))
        XCTAssertEqual(again.preferences, .defaults, "it is the account's now, not this handset's")
    }

    // A TAP THAT LANDS WHILE THE CLAIM IS ON THE WIRE is not left owed until the next launch: the
    // claim's own send picks up the newest document before it ends, the same single-file rule the
    // settings screen's own taps run under.
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
        XCTAssertFalse(LocalLog(url: localURL).preferencesOwed)
    }

    // Settings walk LAST, behind every lift, and the order is load-bearing in one direction: nothing
    // in the log reads this row, so a settings route an older server has never heard of must not be
    // able to keep a set off the log.
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
        XCTAssertTrue(LocalLog(url: localURL).preferencesOwed)
        XCTAssertTrue(LocalLog(url: localURL).sessions.isEmpty, "and the session was claimed")
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
    // What a routine's PUT moves and what a proposal's base is checked against. It is a column on
    // the routine on the wire and read-only there, so it is held beside the routines rather than on
    // them: no client ever sends it and nothing this app draws reads it.
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
    var refuseCreate: WindmillApiError?
    var refuseCreateRoutine: WindmillApiError?
    var refuseRoutines: WindmillApiError?
    var refuseProposals: WindmillApiError?
    var refuseApply: WindmillApiError?
    var refuseShare: WindmillApiError?
    var refuseRevoke: WindmillApiError?
    var refuseRecord: WindmillApiError?
    var refuseRename: WindmillApiError?
    var refusePreferences: WindmillApiError?
    // Nil is an account that has never answered, which the read serves as the defaults.
    var settings: GymPreferences?
    // Ids some OTHER account already spent — the 409s whose code asks for a remint.
    var takenSessionIds: Set<String> = []
    var takenRoutineIds: Set<String> = []
    var takenExerciseIds: Set<String> = []
    var swallowReplies = 0
    // The close is a round trip, and this is the only way a test can stand inside it. The settings
    // write is the other one — a second tap while the first is on the wire is the case that decides
    // which document the log ends up holding.
    var onFinish: () async -> Void = {}
    var onSavePreferences: () async -> Void = {}

    private(set) var appended: [SetWrite] = []
    private(set) var corrected: [String] = []
    private(set) var deleted: [String] = []
    private(set) var started: [SessionStart] = []
    private(set) var finishes: [String: Int64] = [:]
    private(set) var routineWrites: [RoutineWrite] = []
    private(set) var exerciseWrites: [ExerciseWrite] = []
    private(set) var settingsWrites: [GymPreferences] = []
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

    // The correction, and the log's whole vocabulary for it: a set this account does not hold in this
    // session is `set-not-found`, and everything else answers the STORED row — so the same body sent
    // twice comes back byte-identical and the set number never moves.
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

    // 204 however the truth is spelled — already gone, never there, another account's — so absent
    // stays byte-identical to forbidden and a lost reply is safe to send again. No 400, no 404, no
    // 409 on this route at all.
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

    // Sparse, as the route is: only what the test put here comes back, and a movement with no row
    // is one this account has never trained.
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

    // THE HUMAN'S HAND, and it does what the server does in one transaction: the routine's revision
    // moves, and every proposal still pending on it is set aside. A fake that only replaced the
    // document would let a diff apply over a base that no longer stands — which is the exact defect
    // the revision exists to stop.
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

    // THE PROPOSAL LEDGER, and it enforces the two rules the room's whole safety rests on: apply is
    // refused when the routine has moved under the diff, and a decision already taken is not taken
    // again. `revisions` is what a routine's PUT moves — the fake bumps it exactly where the server
    // does, so a test can put a human's hand on a routine and watch the card come back set aside.
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
        // Replay, not an error: asking again for the decision already taken answers the stored row.
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
            // A removal takes its whole ledger with it, exactly as the server's cascade does — so
            // the applied row is answered once and then no longer exists to be read again.
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
        // AN APPLY IS A WRITE LIKE ANY OTHER: the routine just moved, so every other proposal
        // waiting on it is against a base that is gone and the server sets them aside in the same
        // transaction (`supersedeOnRoutine`). A fake that skipped this would leave a card on the
        // phone the log had already settled — and no test could see it.
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

    // One movement's record, and it is a stored answer rather than a computed one: Epley is the
    // server's, so a fake that derived an estimate would be the second copy this product refuses.
    func record(of exerciseId: String) async throws -> MovementRecord? {
        calls.append("record")
        guard online else { throw WindmillApiError.offline }
        if let refuseRecord { throw refuseRecord }
        return records[exerciseId]
    }

    // The rename the log holds: the id never moves, which is the whole thing the record page is
    // there to prove, so this rewrites the catalog row in place and hands back the same id.
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

    // The settings row, and the read NEVER 404s: an account with nothing stored is served the
    // defaults, which is what lets every client draw a rest dial and a plate set on its first frame.
    // The write replaces the whole document and answers the stored one — last write wins, which is
    // the ordering the claim replay rests on.
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
}
