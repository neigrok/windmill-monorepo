import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// THE ANONYMOUS-FIRST ROOM AND ITS CLAIM (wave contract §C and §D). Signed out, gym runs whole out
// of two files on this device — a session starts, freezes its plan off the LOCAL routine, logs,
// finishes into local history, and feeds the prefill, the review and a movement's record. Signing in
// CLAIMS all of it, and the replay's order is the part that loses lifts if it drifts: movements,
// then routines, then sessions oldest first — each strictly start (joinOpenSession: false, the join
// default once filed a past session's sets into a live workout) → sets per lane in original order →
// finish at the true instant — with no log read interleaved, and verdicts read by CODE only.

private func refusal(_ status: Int, code: String = "", message: String) -> WindmillApiError {
    let body = code.isEmpty
        ? #"{"error":"\#(message)"}"#
        : #"{"error":"\#(message)","code":"\#(code)"}"#
    return .refused(status, Refusal(Data(body.utf8)))
}

@MainActor
final class AnonymousGymTests: XCTestCase {
    private var queueURL: URL!
    private var catalogURL: URL!
    private var localURL: URL!
    private var clockMs: Int64 = 1_000

    override func setUp() async throws {
        let stem = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-anon-\(UUID().uuidString)")
        queueURL = stem.appendingPathExtension("queue.json")
        catalogURL = stem.appendingPathExtension("catalog.json")
        localURL = stem.appendingPathExtension("local.json")
        clockMs = 1_000
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
        try? FileManager.default.removeItem(at: catalogURL)
        try? FileManager.default.removeItem(at: localURL)
    }

    private func makeStore(sync: FakeTraining?,
                           mintSession: @escaping () -> String = Ids.session,
                           retryAfter: Duration = .seconds(4)) -> TrainingStore {
        TrainingStore(
            queue: SetQueue(url: queueURL),
            deviceCatalog: DeviceCatalog(url: catalogURL),
            localLog: LocalLog(url: localURL),
            now: { self.clockMs += 1; return self.clockMs },
            mintSession: mintSession,
            mintSet: Ids.set,
            undoWindowMs: 0,
            retryAfter: retryAfter,
            sync: { $0.isSignedIn ? sync : nil }
        )
    }

    private func account(signedIn: Bool) -> Account {
        Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: signedIn ? User(id: "u1", email: "sam@example.com", name: "Sam") : nil
        )
    }

    private func shelf() -> LocalLog { LocalLog(url: localURL) }

    // A routine already on the device, the way "Keep this as a routine" leaves one there.
    private func seedRoutine() {
        let kept = shelf()
        kept.keep(Routine(id: "rt_local", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ]))
        kept.flush()
    }

    // ── the room, signed out ───────────────────────────────────────────────────────────────────

    // THE FIRST ARRIVAL, END TO END: a phone that has never held anything opens gym onto the empty
    // Routines home, the lifter taps "Just start logging" (nothing starts by itself — the arrival
    // auto-start retired 2026-08-13, R6), four sets go in, the app dies with nothing drained and
    // nothing finished — and NOTHING IS LOST. No account, no network, no reply from anybody.
    //
    // The picker has to be able to name a movement here or the tapped start lands on a screen you
    // cannot get past — which is what the sixty-four seeds in the app bundle are for.
    func testAFreshArrivalLogsFourSetsAndLosesNothingWhenTheAppDies() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))

        XCTAssertNil(store.session)
        XCTAssertTrue(store.recent.isEmpty)
        XCTAssertTrue(store.routines.isEmpty)
        XCTAssertEqual(store.logFoot, .bottom)

        guard case .success(let opened) = await store.start() else {
            return XCTFail("the tapped start opens a session, and it needs nobody's permission")
        }
        XCTAssertNil(store.exerciseId, "the picker is what a session with nothing chosen draws")

        // §J22's list, on a device that has never reached a server.
        let waiting = PickerOptions.matching(query: "", catalog: store.catalog, taken: store.order,
                                             lastSets: store.lastSets, now: 0)
        XCTAssertEqual(waiting.six.map(\.name),
                       ["Back Squat", "Bench Press", "Deadlift", "Overhead Press", "Barbell Row",
                        "Chin Up"])
        XCTAssertEqual(waiting.six.map(\.meta), Array(repeating: nil, count: 6),
                       "nothing has been read, so nothing is claimed about what was never lifted")

        await store.loadLastSets()
        let read = PickerOptions.matching(query: "", catalog: store.catalog, taken: store.order,
                                          lastSets: store.lastSets, now: 0)
        XCTAssertEqual(read.six.map(\.meta), Array(repeating: "never logged", count: 6),
                       "the device IS the log signed out, and it has answered")

        await store.choose("back-squat")
        for weight in [60.0, 80.0, 100.0, 100.0] {
            await store.logSet(weightKg: weight, reps: 5)
        }
        XCTAssertEqual(store.sets.count, 4)
        XCTAssertEqual(store.saveState, .onThisDevice)

        // The app dies here: no finish, no flush, no drain. A phone in a locker.
        let reopened = makeStore(sync: nil)
        await reopened.connect(to: account(signedIn: false))

        XCTAssertEqual(reopened.session?.id, opened.id, "the same workout is still running")
        XCTAssertEqual(reopened.sets.map(\.weightKg), [60, 80, 100, 100])
        XCTAssertEqual(reopened.sets.map(\.exerciseId), Array(repeating: "back-squat", count: 4))
        XCTAssertEqual(reopened.order, ["back-squat"])

        // And the room stands where the lifter left off rather than back in the picker — the walk it
        // resumes at is the movement the last set went into (GymRoom's own task, in two lines).
        guard let resumed = LiveOrder.resume(order: reopened.order, sets: reopened.sets) else {
            return XCTFail("a session with sets in it has somewhere to stand")
        }
        XCTAssertEqual(resumed, "back-squat")
        await reopened.choose(resumed)
        XCTAssertEqual(reopened.prefill.weightKg, 100, "dialled to the weight the last set was at")
        XCTAssertEqual(reopened.todaySets.count, 4)
    }

    // (`holdsNothing` — the arrival start's guard against reading a failed log as an empty one —
    // retired with the auto-start it existed for, 2026-08-13 R6. A start is the lifter's own tap
    // now, so there is no read whose failure could start a session over an unseen history.)

    // THE PICKER'S META CROSSES THE SIGN-IN, because the screen that asked for it does. §J22's card
    // is a door OUT of the room and the room stays mounted behind it — that is what lands the lifter
    // back mid-session — so the opening picker's own `.task` never runs a second time. Without the
    // re-read at the tail of `connect`, every row lost its line for the rest of the session and the
    // account's real history was never asked for at all: the six read blank to a lifter whose log
    // holds all six.
    func testThePickerMetaIsAskedAgainForTheAccountThatArrives() async {
        let server = FakeTraining()
        server.catalog = DeviceCatalog.seeded
        server.lastSets = [LastSet(exerciseId: "back-squat", weightKg: 140, reps: 5, atMs: 900)]
        let store = makeStore(sync: server, retryAfter: .seconds(600))
        await store.connect(to: account(signedIn: false))

        // The opening picker asks. Signed out the device is the log, and it has never held a squat.
        await store.loadLastSets()
        XCTAssertEqual(store.lastSets, [:])

        // Build my routine → You → signed in. The room never unmounted, so nothing asks again.
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.lastSets?["back-squat"]?.weightKg, 140,
                       "the seat that arrived answered what the seat that left was asked")
        let six = PickerOptions.matching(query: "", catalog: store.catalog, taken: store.order,
                                         lastSets: store.lastSets, now: 900)
        XCTAssertEqual(six.six.first?.meta, "last 140 × 5 · today")

        // And a launch nobody opened a picker on still costs no read: this is a picker-open read.
        let untouched = FakeTraining()
        let unopened = makeStore(sync: untouched, retryAfter: .seconds(600))
        await unopened.connect(to: account(signedIn: true))
        XCTAssertNil(unopened.lastSets)
        XCTAssertFalse(untouched.calls.contains("lastSets"))
    }

    // The whole signed-out life of a session, on this device and nowhere else: start, log, finish,
    // and the log page the room draws from local history.
    func testSignedOutASessionRunsWholeOnThisDevice() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))

        guard case .success(let opened) = await store.start() else {
            return XCTFail("an anonymous start needs no log")
        }
        XCTAssertNil(opened.plan, "an ad-hoc session has no plan to freeze")

        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.logSet(weightKg: 85, reps: 3)
        XCTAssertEqual(store.saveState, .onThisDevice)
        XCTAssertEqual(store.saveState.line, "saved on this device")
        XCTAssertEqual(store.sets.map(\.weightKg), [82.5, 85])
        XCTAssertEqual(store.strandedCount, 0, "nothing is stranded — there is no log to reach")

        guard case .closed(let closed) = await store.finish() else {
            return XCTFail("an anonymous finish closes on the device")
        }
        XCTAssertFalse(closed.isOpen)
        XCTAssertNil(store.session)
        XCTAssertEqual(store.recent.map(\.setCount), [2], "the log tab reads the local shelf")
        XCTAssertEqual(store.recent.map(\.id), [closed.id])

        let reopened = shelf()
        XCTAssertEqual(reopened.sessions.map { $0.session.id }, [closed.id])
        XCTAssertEqual(reopened.sessions.first?.sets.map(\.weightKg), [82.5, 85])
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty,
                      "the finished session's sets moved shelves — the queue owes nothing")
    }

    // THE DEVICE'S LOG IS THE WHOLE LOG WHEN NOBODY IS SIGNED IN — there is no page to ask anybody
    // for, so the foot of the log is its bottom from the first frame, and every row on it is one
    // only this phone has. That is what the hollow ring says, and on this surface it is REAL.
    //
    // The two numbers beside it are arithmetic and this device does them: the working sets, and the
    // tonnage with every set clamped at zero. The estimate is not arithmetic — Epley lives in one
    // place per language and this is not it — so the row carries none and draws nothing there.
    func testSignedOutEveryRowIsThisDevicesAndCarriesTheTwoNumbersItCanHonestlyMake() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 40, reps: 8, kind: .warmup)
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.logSet(weightKg: -20, reps: 6)
        _ = await store.finish()

        XCTAssertEqual(store.logFoot, .bottom)
        XCTAssertEqual(store.deviceOnly, Set(store.recent.map(\.id)))
        XCTAssertEqual(store.recent.first?.setCount, 3)
        XCTAssertEqual(store.recent.first?.workingSetCount, 2, "a warmup counts toward nothing")
        XCTAssertEqual(store.recent.first?.tonnageKg, 412.5,
                       "band-assisted work moved no external load — it contributes zero, never less")
        XCTAssertEqual(store.recent.first?.topE1rm, nil)
    }

    // A row the log has answered for is not this device's any more, and the ring goes with it.
    func testARowTheLogHasTakenIsNoLongerMarkedAsThisDevices() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: false))
        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        _ = await store.finish()
        XCTAssertEqual(store.deviceOnly.count, 1)

        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.recent.count, 1, "one session, not two — the claim converged")
        XCTAssertTrue(store.deviceOnly.isEmpty, "the account holds it now")
    }

    // The plan freezes off the LOCAL routine at start — same staleness rule as the server's,
    // different shelf — so a retarget after Start must not re-plan the running workout.
    func testSignedOutThePlanFreezesOffTheLocalRoutineAtStart() async {
        seedRoutine()
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        XCTAssertEqual(store.routines.map(\.id), ["rt_local"])

        guard case .success(let opened) = await store.start(routineId: "rt_local") else {
            return XCTFail("a local routine can open a local session")
        }
        XCTAssertEqual(opened.plan, PlanSnapshot(routine: "Push A", entries: [
            PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
        ]))

        await store.choose("bench-press")
        XCTAssertEqual(store.prefill, Prefill(weightKg: 82.5, reps: 5))

        let retargeted = await store.save(87.5, toRoutine: "rt_local", for: "bench-press")
        XCTAssertNil(retargeted)
        XCTAssertEqual(store.session?.plan?.entry(for: "bench-press")?.weightKg, 82.5,
                       "the snapshot is frozen — a retarget moves next week, never this session")
        XCTAssertEqual(shelf().routine("rt_local")?.entries.first?.targetWeightKg, 87.5,
                       "and the local routine did move")

        guard case .failure(.refused(let why)) = await store.start(routineId: "rt_missing") else {
            return XCTFail("a routine this device does not hold cannot open a session")
        }
        XCTAssertEqual(why, "that routine is not on this device")
    }

    // A fresh phone holds the sixty-four seeds and nothing else, so the picker's Create must work
    // signed out for anything they do not name — and the routine kept at the end of a session lands
    // on the same shelf.
    func testSignedOutCreateAndKeepLandOnTheDevice() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))

        guard case .success(let made) = await store.create("Zercher Squat", loadedAs: "barbell") else {
            return XCTFail("a movement can be minted onto this device")
        }
        XCTAssertTrue(made.custom)
        XCTAssertEqual(store.catalog.count, DeviceCatalog.seeded.count + 1)
        XCTAssertEqual(store.catalog.last?.name, "Zercher Squat",
                       "what this device minted sits after the seeds it shipped with")

        let performed = [
            TrainingSet(id: "set_a", exerciseId: made.id, weightKg: 60, reps: 5, completedAtMs: 2_000),
            TrainingSet(id: "set_b", exerciseId: made.id, weightKg: 60, reps: 5, completedAtMs: 3_000),
        ]
        let kept = await store.keep(performed, asRoutineNamed: "Squat day")
        XCTAssertEqual(kept?.name, "Squat day")
        XCTAssertEqual(store.routines.map(\.name), ["Squat day"])

        let reopened = shelf()
        XCTAssertEqual(reopened.exercises.map(\.name), ["Zercher Squat"])
        XCTAssertEqual(reopened.routines.map(\.name), ["Squat day"])
        XCTAssertEqual(reopened.routines.first?.entries.map(\.exerciseId), [made.id])
    }

    // The prefill holds signed out too: the device's own history answers synchronously, a movement
    // it has never seen is an honest first time, and nothing can have FAILED to answer — there is
    // nobody to ask, so the logger's "the log didn't answer" may never be drawn under this seat.
    func testSignedOutThePrefillReadsThisDevicesHistory() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.logSet(weightKg: 85, reps: 3)
        _ = await store.finish()

        _ = await store.start()
        await store.choose("bench-press")
        XCTAssertEqual(store.lastTime?.sets.map(\.weightKg), [82.5, 85])
        XCTAssertEqual(store.lastTime?.isFirstTime, false)
        XCTAssertFalse(store.lastTimeFailed)
        XCTAssertEqual(store.prefill, Prefill(weightKg: 85, reps: 5),
                       "weight from the last working set, reps from the first — the same asymmetry")

        await store.choose("deadlift")
        XCTAssertEqual(store.lastTime, LastTime(exerciseId: "deadlift"),
                       "no history is a fact, not a failure")
        XCTAssertFalse(store.lastTimeFailed)
    }

    // The review and a movement's record answer from the local shelf — the three facts and the
    // honest word over a short session, and the counts, the heaviest set and the recent days over
    // the finished history. No e1RM is invented on this device, so the estimate, the series and the
    // record ladder are ABSENT rather than zero, and §H's page draws no chart over them.
    func testSignedOutReviewAndTheMovementRecordAnswerFromTheLocalLog() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        guard case .success(let opened) = await store.start() else { return XCTFail("no session") }
        await store.choose("bench-press")
        await store.logSet(weightKg: 60, reps: 10, kind: .warmup)
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.logSet(weightKg: 85, reps: 3)
        guard case .closed(let closed) = await store.finish() else { return XCTFail("no close") }

        let review = await store.review(of: closed.id)
        XCTAssertEqual(review?.stats.workingSets, 2, "warmups count toward nothing")
        XCTAssertEqual(review?.slight, true, "under four working sets is a session ended early")
        XCTAssertNil(review?.record, "a record is a claim against account history this device lacks")
        XCTAssertNil(review?.against)

        guard case .success(let detail) = await store.sessionDetail(closed.id) else {
            return XCTFail("the local session reads back")
        }
        XCTAssertEqual(detail.sets.map(\.weightKg), [60, 82.5, 85])

        guard case .success(let answered) = await store.record(of: "bench-press") else {
            return XCTFail("the local log always answers")
        }
        let record = answered.record
        XCTAssertEqual(answered.source, .thisDevice,
                       "it says who answered, because that decides what an absent estimate means")
        XCTAssertEqual(record.sessionCount, 1)
        XCTAssertEqual(record.routineCount, 0, "no program names it, and that zero is a real answer")
        XCTAssertEqual(record.heaviest, MovementMark(weightKg: 85, reps: 3, atMs: opened.startedAtMs))
        XCTAssertNil(record.bestE1rm, "no Epley is computed on this device")
        XCTAssertEqual(record.e1rmSeries, [])
        XCTAssertEqual(record.records, [])
        XCTAssertEqual(record.recentDays.map(\.sessionId), [closed.id])
        XCTAssertEqual(record.recentDays.first?.sets.map(\.weightKg), [82.5, 85],
                       "a warmup counts toward nothing and is not a recent set")

        // And the page over it: the tiles it can state, no chart at all, and the sets by day. The
        // missing chart is blamed on WHERE THE ESTIMATE IS COMPUTED and never on the load, which is
        // the one thing the device cannot know about a movement it holds every set of.
        let page = Record.page(record, now: opened.startedAtMs, from: answered.source)
        XCTAssertNil(page.best)
        XCTAssertNil(page.chart, "no series is no chart — never an empty frame")
        XCTAssertEqual(page.noChart, .onThisDevice)
        XCTAssertEqual(page.heaviest, Record.Tile(caption: "heaviest", value: "85", under: "kg · for 3"))
        XCTAssertEqual(page.subhead, "barbell · in no routine · 1 session")
        XCTAssertEqual(page.days.map(\.sets), ["82.5 × 5 · 85 × 3"])
        XCTAssertFalse(page.neverLogged)
    }

    // A SESSION OF NOTHING BUT DROP SETS, logged on the device, walked all the way to the page. The
    // two lists count different things on purpose — the count is over working sets and the days are
    // over everything but a warmup — so this is the one movement that is in the days and in no
    // count, on the device exactly as on the server.
    //
    // The page therefore may not say `never logged` over the sets it is printing, may not draw a
    // tile lane with nothing in it, and may not blame the bar: a 40 kg drop set has a load, and the
    // reason there is no estimate is that nothing here counts a drop.
    func testAMovementWorkedOnlyInDropSetsIsInTheDaysAndInNoCount() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        guard case .success(let opened) = await store.start() else { return XCTFail("no session") }
        await store.choose("bench-press")
        await store.logSet(weightKg: 60, reps: 10, kind: .warmup)
        await store.logSet(weightKg: 40, reps: 12, kind: .drop)
        guard case .closed = await store.finish() else { return XCTFail("no close") }

        guard case .success(let answered) = await store.record(of: "bench-press") else {
            return XCTFail("the local log always answers")
        }
        XCTAssertEqual(answered.record.sessionCount, 0, "a drop set is not a session worked")
        XCTAssertNil(answered.record.heaviest, "and it is no standing best either")
        XCTAssertEqual(answered.record.recentDays.first?.sets.map(\.weightKg), [40],
                       "the warmup is gone and the drop is kept — that list is what you DID")

        let page = Record.page(answered.record, now: opened.startedAtMs, from: answered.source)
        XCTAssertFalse(page.neverLogged, "there are sets on this page")
        XCTAssertEqual(page.subhead, "barbell · in no routine · no working sets")
        XCTAssertNil(page.best)
        XCTAssertNil(page.heaviest)
        XCTAssertEqual(page.days.map(\.sets), ["40 × 12 drop"])
        XCTAssertEqual(page.noChart, .onThisDevice,
                       "who answered outranks it: this device computes no estimate for anything")
    }

    // The standing best at a TIED top load matches the server's marks projection: more reps takes
    // the mark, a full tie keeps the earlier one — so the same log shows the same best before and
    // after the claim, never 100×5 on the device and 100×8 on the log.
    func testTheLocalHeaviestBreaksALoadTieByRepsExactlyAsTheServerDoes() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))

        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 100, reps: 5)
        guard case .closed = await store.finish() else { return XCTFail("no first close") }

        guard case .success(let second) = await store.start() else { return XCTFail("no second session") }
        await store.choose("bench-press")
        await store.logSet(weightKg: 100, reps: 8)
        guard case .closed = await store.finish() else { return XCTFail("no second close") }

        guard case .success(let record) = await store.record(of: "bench-press") else {
            return XCTFail("the local log always answers")
        }
        XCTAssertEqual(record.record.heaviest,
                       MovementMark(weightKg: 100, reps: 8, atMs: second.startedAtMs),
                       "a tied load goes to more reps")

        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 100, reps: 8)
        guard case .closed = await store.finish() else { return XCTFail("no third close") }

        guard case .success(let again) = await store.record(of: "bench-press") else {
            return XCTFail("no record")
        }
        XCTAssertEqual(again.record.heaviest,
                       MovementMark(weightKg: 100, reps: 8, atMs: second.startedAtMs),
                       "a full tie keeps the earlier mark")
        XCTAssertEqual(again.record.sessionCount, 3)
    }

    // Discarding a local session is the device's own delete — no server, no 404, and the shelf and
    // the log page agree it is gone.
    func testSignedOutDiscardDeletesTheLocalSession() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let closed) = await store.finish() else { return XCTFail("no close") }

        let gone = await store.discard(closed.id)
        XCTAssertTrue(gone)
        XCTAssertEqual(store.recent, [])
        XCTAssertTrue(shelf().sessions.isEmpty)
    }

    // ── the claim, on sign-in ──────────────────────────────────────────────────────────────────

    // The whole replay, in its exact order: movements → routines → sessions oldest first, each
    // session start → its sets in performed order → finish at the true local instant, and not one
    // log read until everything owed has been answered for.
    func testSigningInClaimsTheDeviceLogInDependencyOrder() async {
        seedRoutine()
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))

        guard case .success(let made) = await anonymous.create("Zercher Squat", loadedAs: "barbell") else {
            return XCTFail("no movement")
        }
        guard case .success(let first) = await anonymous.start(routineId: "rt_local") else {
            return XCTFail("no first session")
        }
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        await anonymous.logSet(weightKg: 85, reps: 3)
        await anonymous.choose(made.id)
        await anonymous.logSet(weightKg: 60, reps: 8)
        guard case .closed = await anonymous.finish() else { return XCTFail("no first close") }

        guard case .success(let second) = await anonymous.start() else {
            return XCTFail("no second session")
        }
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 87.5, reps: 2)
        guard case .closed = await anonymous.finish() else { return XCTFail("no second close") }

        let owed = shelf().sessions
        XCTAssertEqual(owed.map { $0.session.id }, [first.id, second.id], "oldest first")
        let firstFinishedAt = owed[0].session.finishedAtMs!
        let secondFinishedAt = owed[1].session.finishedAtMs!

        let server = FakeTraining()
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        XCTAssertEqual(server.exerciseWrites.map(\.id), [made.id])
        XCTAssertEqual(server.routineWrites.map(\.id), ["rt_local"])
        XCTAssertEqual(server.started.map(\.id), [first.id, second.id])
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false, false],
                       "NEVER the join default — it files past sets into a live workout")
        XCTAssertEqual(server.started.map(\.startedAtMs), [first.startedAtMs, second.startedAtMs])
        XCTAssertEqual(server.started.map(\.routineId), ["rt_local", nil])

        XCTAssertEqual(server.sets[first.id]?.map(\.weightKg), [82.5, 85, 60])
        XCTAssertEqual(server.sets[first.id]?.map(\.setNumber), [1, 2, 1],
                       "the server numbers per lane, in the order the lanes replayed")
        XCTAssertEqual(server.sets[second.id]?.map(\.weightKg), [87.5])
        XCTAssertEqual(server.finishes, [first.id: firstFinishedAt, second.id: secondFinishedAt])

        let walk = server.calls.filter { ["createExercise", "createRoutine", "start", "finish", "sessions"].contains($0) }
        XCTAssertEqual(Array(walk.prefix(6)),
                       ["createExercise", "createRoutine", "start", "finish", "start", "finish"],
                       "dependency order, one session at a time")
        XCTAssertEqual(walk.last, "sessions", "no log read interleaves the claim")

        XCTAssertTrue(shelf().isEmpty, "everything owed was answered for and let go")
        XCTAssertEqual(claimed.recent.map(\.id).sorted(), [first.id, second.id].sorted(),
                       "the server log is the truth now")
    }

    // 409 session-already-open is WAIT, never drop and never join: the claim stands down whole and
    // the local shelf keeps everything for the next connect. And WAIT stays EVENT-DRIVEN (wave 2
    // §A): the retry cadence carries offline and 5xx, never a poll of a remote human's open workout.
    func testTheClaimWaitsWhileAnotherSessionIsOpen() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let closed) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.open(Session(id: "ses_phone", startedAtMs: 500))
        let claimed = makeStore(sync: server, retryAfter: .milliseconds(40))
        await claimed.connect(to: account(signedIn: true))

        XCTAssertEqual(server.started.map(\.joinOpenSession), [false])
        XCTAssertNil(server.sets[closed.id], "not one set went out against a start that waited")
        XCTAssertNil(server.finishes[closed.id])
        XCTAssertEqual(shelf().sessions.map { $0.session.id }, [closed.id], "nothing was dropped")
        XCTAssertTrue(claimed.refusals.isEmpty, "waiting is not a refusal")
        XCTAssertTrue(claimed.recent.map(\.id).contains(closed.id),
                      "the unclaimed session still reads in the merged log")

        try? await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(server.started.map(\.id), [closed.id],
                       "one start asked and one answer taken — WAIT armed no cadence")
    }

    // 409 session-id-taken remints the session id AND remaps its sets — the one repair a spent id
    // allows, applied to a whole session.
    func testTheClaimRemintsASpentSessionIdAndRemapsItsSets() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let closed) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.takenSessionIds = [closed.id]
        let claimed = makeStore(sync: server, mintSession: { "ses_fresh" })
        await claimed.connect(to: account(signedIn: true))

        XCTAssertEqual(server.started.map(\.id), [closed.id, "ses_fresh"])
        XCTAssertEqual(server.sets["ses_fresh"]?.map(\.weightKg), [82.5])
        XCTAssertNotNil(server.finishes["ses_fresh"])
        XCTAssertTrue(shelf().isEmpty)
    }

    // 409 session-finished mid-claim is the one refusal that costs a set, and it is SAID — the
    // banner is the last copy of it — while the session still closes with everything else it held.
    func testAClaimSetRefusedByACloseIsDroppedAndSaid() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let closed) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.refuse = { _ in refusal(409, code: "session-finished", message: "reworded any day") }
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        XCTAssertEqual(claimed.refusals.map(\.reason),
                       ["the session closed before this set reached it"])
        XCTAssertEqual(claimed.refusals.compactMap(\.set).map(\.weightKg), [82.5])
        XCTAssertNotNil(server.finishes[closed.id], "the close still lands — the loss is said, not hidden")
        XCTAssertTrue(shelf().isEmpty)
    }

    // Offline, the claim retries later and drops nothing — 401/404/5xx/offline are all the same
    // verdict: what is owed stays owed.
    func testAnOfflineSignInClaimsNothingAndLosesNothing() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let closed) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.online = false
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        XCTAssertEqual(shelf().sessions.map { $0.session.id }, [closed.id])
        XCTAssertTrue(claimed.refusals.isEmpty)
        XCTAssertEqual(claimed.recent.map(\.id), [closed.id],
                       "the room still stands on local state while the wire is down")
    }

    // Wave 2 §A: a claim that failed RETRYABLY rides the queue's own cadence — the same scheduler
    // that carries a jammed set — and lands the moment the road heals, with no remount and no tap.
    func testAClaimThatFailedOfflineRetriesOnTheQueuesCadenceAndLands() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let closed) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.online = false
        let claimed = makeStore(sync: server, retryAfter: .milliseconds(40))
        await claimed.connect(to: account(signedIn: true))
        XCTAssertEqual(shelf().sessions.map { $0.session.id }, [closed.id],
                       "offline, the shelf keeps everything for the retry")

        server.online = true
        for _ in 0..<200 where server.finishes[closed.id] == nil {
            try? await Task.sleep(for: .milliseconds(20))
        }

        XCTAssertEqual(server.sets[closed.id]?.map(\.weightKg), [82.5])
        XCTAssertEqual(server.finishes[closed.id], closed.finishedAtMs,
                       "the cadence claimed the session on its own once the network returned")
        XCTAssertEqual(server.started.last?.joinOpenSession, false)
        XCTAssertTrue(claimed.refusals.isEmpty)
        XCTAssertTrue(shelf().isEmpty, "everything owed was answered for and let go — no remount, no tap")
    }

    // The live session claims minus finish, and the ordinary queue owns it from there — the next
    // set logged goes to the log like any signed-in set.
    func testTheLiveLocalSessionClaimsMinusFinishAndTheQueueTakesOver() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success(let live) = await anonymous.start() else { return XCTFail("no session") }
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)

        let server = FakeTraining()
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        XCTAssertEqual(server.started.map(\.id), [live.id])
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false])
        XCTAssertNil(server.finishes[live.id], "minus finish — the workout is still running")
        XCTAssertEqual(server.sets[live.id]?.map(\.weightKg), [82.5],
                       "the queue delivered the parked set the moment the start landed")
        XCTAssertEqual(claimed.session?.id, live.id)

        await claimed.choose("bench-press")
        await claimed.logSet(weightKg: 85, reps: 3)
        XCTAssertEqual(server.sets[live.id]?.map(\.weightKg), [82.5, 85])
        XCTAssertEqual(claimed.saveState, .onTheLog)
    }

    // A movement the log refuses OUTRIGHT is let go of the shelf rather than jamming the claim —
    // and the loss is SAID twice over: the claim-level row under the movement's NAME (wave 2 §B,
    // Android's RefusedClaim to the word), and every set that named it replays into a refusal the
    // banner carries. This let-go-and-say shape is the terminal-refusal contract for both phones.
    func testAClaimWriteRefusedOutrightIsLetGoAndItsSetsAreSaid() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success(let made) = await anonymous.create("Zercher Squat", loadedAs: "barbell") else {
            return XCTFail("no movement")
        }
        _ = await anonymous.start()
        await anonymous.choose(made.id)
        await anonymous.logSet(weightKg: 60, reps: 8)
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let closed) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.refuseCreate = refusal(400, code: "bad-request", message: "the log wouldn’t take that movement")
        server.refuse = { write in
            write.exerciseId == made.id
                ? refusal(400, code: "unknown-exercise", message: "no such exercise")
                : nil
        }
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        XCTAssertTrue(shelf().exercises.isEmpty, "the refused movement is let go, never a jam on the shelf")
        XCTAssertEqual(claimed.refusals.first,
                       .claim(RefusedClaim(id: made.id, name: "Zercher Squat",
                                           reason: "the log wouldn’t take that movement")),
                       "the claim-level loss is said by NAME, in the log's own words")
        XCTAssertEqual(claimed.refusals.compactMap(\.set).map(\.exerciseId), [made.id])
        XCTAssertEqual(claimed.refusals.compactMap(\.set).map(\.weightKg), [60])
        XCTAssertEqual(claimed.refusals.compactMap(\.set).map(\.reason), ["that movement is not in the catalog"],
                       "the loss is said through the refusals surface, not silently let go")
        XCTAssertEqual(server.sets[closed.id]?.map(\.weightKg), [82.5],
                       "the rest of the session still lands")
        XCTAssertNotNil(server.finishes[closed.id])
        XCTAssertTrue(shelf().sessions.isEmpty, "the session claimed whole once the loss was said")
    }

    // Wave 2 §B: a loss said during a BOOT claim has no logger to carry it — no session is open, so
    // home (Routines) is the standing screen and it draws the same refusal banner the logger uses.
    // The loss is said by NAME with the server's own sentence, and dismissing clears it.
    func testABootClaimLossIsSaidByNameOnHomeAndDismissClears() async {
        seedRoutine()
        let server = FakeTraining()
        server.refuseCreateRoutine = refusal(400, code: "bad-request",
                                             message: "the log wouldn’t take that routine")
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        XCTAssertNil(claimed.session, "no live session — home is the screen that carries the banner")
        XCTAssertEqual(claimed.refusals,
                       [.claim(RefusedClaim(id: "rt_local", name: "Push A",
                                            reason: "the log wouldn’t take that routine"))])
        XCTAssertEqual(claimed.refusals.map(\.id), ["claim-rt_local"],
                       "the banner keys the row by the document's id, never by the name")
        XCTAssertEqual(claimed.refusals.map { RefusalRows.headline(of: $0, in: claimed.catalog) },
                       ["“Push A” couldn’t be claimed"],
                       "said by NAME — the convergence pin with Android's RefusedClaim row")
        XCTAssertTrue(shelf().routines.isEmpty,
                      "said and let go — the terminal write is not re-sent on every connect")

        claimed.clearRefusals()
        XCTAssertEqual(claimed.refusals, [], "dismissing the banner clears the shown refusals")
    }

    // A Start tapped while the claim is mid-replay must NOT reach the server: a server start would
    // default-JOIN the replayed session and file today's sets into yesterday's workout. It composes
    // on the device instead, and the same claim's own tail picks it up.
    func testAStartTappedMidClaimComposesOnTheDeviceAndJoinsNothing() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success(let past) = await anonymous.start() else { return XCTFail("no session") }
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        let store = makeStore(sync: server)
        server.onFinish = { [weak store] in
            guard let store else { return }
            guard await store.session == nil else { return }
            _ = await store.start()
        }
        await store.connect(to: account(signedIn: true))

        guard let composed = store.session else {
            return XCTFail("the mid-claim start composed a session on the device")
        }
        XCTAssertNotEqual(composed.id, past.id, "the start joined nothing")
        XCTAssertEqual(server.started.map(\.id), [past.id, composed.id])
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false, false],
                       "no start ever rode the join default")
        XCTAssertEqual(server.sets[past.id]?.map(\.weightKg), [82.5],
                       "yesterday's workout kept only its own sets")
        XCTAssertNotNil(server.finishes[past.id])

        await store.choose("bench-press")
        await store.logSet(weightKg: 999, reps: 1)
        XCTAssertEqual(server.sets[composed.id]?.map(\.weightKg), [999],
                       "today's set filed into today's session")
        XCTAssertEqual(server.sets[past.id]?.map(\.weightKg), [82.5])
    }

    // The overlap repro, rebuilt on the gate: a boot claim parked on a slow finish, a local finish
    // asking to claim behind it, and a Start tapped while the rerun holds the replayed session
    // OPEN on the log. One runner serializes all of it — the finish parks a rerun instead of
    // walking beside the runner, `claiming` holds until the rerun has walked too, and the Start
    // composes on the device instead of JOINing the mid-replay session.
    func testAFinishMidClaimParksAndAStartDuringTheRerunNeverJoins() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success(let past) = await anonymous.start() else { return XCTFail("no session") }
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        let gate = FinishGate()
        server.onFinish = { await gate.hold() }
        let store = makeStore(sync: server)
        let boot = Task { await store.connect(to: account(signedIn: true)) }
        for _ in 0..<200 where gate.heldCount == 0 { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(gate.heldCount, 1, "the boot claim is parked on yesterday's slow finish")

        guard case .success(let todays) = await store.start() else { return XCTFail("no mid-claim start") }
        XCTAssertNotEqual(todays.id, past.id, "the mid-claim start joined nothing")
        await store.choose("bench-press")
        await store.logSet(weightKg: 999, reps: 1)
        XCTAssertNil(server.sets[todays.id], "the set is parked with its unclaimed session, not sent")
        XCTAssertEqual(store.saveState, .onThisDevice)

        let closing = Task { await store.finish() }
        for _ in 0..<200 where store.session != nil { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(server.started.map(\.id), [past.id],
                       "the finish's claim parked a rerun — no second walk started beside the runner")
        XCTAssertEqual(server.finishes, [:], "nothing has finished on the log yet — the walk is inside it")

        gate.releaseOne()
        for _ in 0..<200 where gate.heldCount == 0 { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(server.started.map(\.id), [past.id, todays.id],
                       "the rerun claims today's finished session — and is parked on ITS finish now")
        XCTAssertEqual(server.sets[todays.id]?.map(\.weightKg), [999])

        guard case .success(let third) = await store.start() else { return XCTFail("no start during the rerun") }
        XCTAssertNotEqual(third.id, todays.id,
                          "the replayed session stands open on the log and the start did NOT join it")
        XCTAssertEqual(store.session?.id, third.id, "it composed on the device")
        XCTAssertEqual(server.started.map(\.id), [past.id, todays.id],
                       "no server start went out while the claim held the room")

        gate.releaseOne()
        guard case .closed(let closedToday) = await closing.value else { return XCTFail("no local close") }
        XCTAssertEqual(closedToday.id, todays.id)
        await boot.value

        XCTAssertEqual(server.started.map(\.id), [past.id, todays.id, third.id],
                       "the runner's own tail claimed the composed session once the rerun settled")
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false, false, false],
                       "no start ever rode the join default")
        XCTAssertEqual(server.sets[past.id]?.map(\.weightKg), [82.5])
        XCTAssertEqual(server.sets[todays.id]?.map(\.weightKg), [999])
        XCTAssertEqual(server.finishes[todays.id], closedToday.finishedAtMs)
        XCTAssertEqual(store.session?.id, third.id, "the lifter's live workout survived the whole claim")
        XCTAssertTrue(shelf().sessions.isEmpty)
        XCTAssertEqual(store.refusals, [])
    }

    // A reconnect arriving while the claim is mid-replay parks ONE rerun on the running walk
    // rather than replaying the shelf beside it — and the walk that outlived its seat settles the
    // flags for nobody, because the reconnect's own rerun owns them now.
    func testAConnectMidClaimParksARerunInsteadOfASecondRunner() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let past) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        let gate = FinishGate()
        server.onFinish = { await gate.hold() }
        let store = makeStore(sync: server)
        let boot = Task { await store.connect(to: account(signedIn: true)) }
        for _ in 0..<200 where gate.heldCount == 0 { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(gate.heldCount, 1, "the boot claim is parked on the slow finish")

        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(server.started.map(\.id), [past.id],
                       "the reconnect parked its claim — no second runner replayed the shelf")

        gate.releaseOne()
        await boot.value

        XCTAssertEqual(server.started.map(\.id), [past.id],
                       "one start ever — the rerun found the shelf already claimed")
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false])
        XCTAssertEqual(server.sets[past.id]?.map(\.weightKg), [82.5])
        XCTAssertEqual(server.finishes[past.id], past.finishedAtMs)
        XCTAssertTrue(shelf().isEmpty)
        XCTAssertEqual(store.recent.map(\.id), [past.id], "the claimed session still reached the log")
        XCTAssertEqual(store.refusals, [])
    }

    // A signed-in start naming a routine still on the LOCAL shelf composes on the device: the log
    // has never heard of that routine, and a server start would 404 a plan this device is holding.
    func testASignedInStartFromAnUnclaimedRoutineComposesOnTheDevice() async {
        seedRoutine()
        let server = FakeTraining()
        server.online = false
        let store = makeStore(sync: server)
        // Offline, so the claim could not land the routine — it is still this device's only copy.
        await store.connect(to: account(signedIn: true))

        server.online = true
        guard case .success(let opened) = await store.start(routineId: "rt_local") else {
            return XCTFail("the plan is on this device — the start cannot need the server")
        }
        XCTAssertEqual(opened.plan, PlanSnapshot(routine: "Push A", entries: [
            PlanEntry(exerciseId: "bench-press", sets: 5, reps: 5, weightKg: 82.5),
        ]), "the snapshot froze off the only copy that exists")
        XCTAssertFalse(server.started.contains { $0.routineId == "rt_local" },
                       "no server start named a routine the log has never heard of")

        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        XCTAssertEqual(store.saveState, .onThisDevice, "the session is parked until the claim lands it")

        guard case .closed(let closed) = await store.finish() else { return XCTFail("no close") }
        XCTAssertNotNil(server.written["rt_local"], "the finish's claim landed the routine first")
        XCTAssertEqual(server.started.map(\.id), [closed.id])
        XCTAssertEqual(server.started.map(\.routineId), ["rt_local"])
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false])
        XCTAssertEqual(server.sets[closed.id]?.map(\.weightKg), [82.5])
        XCTAssertNotNil(server.finishes[closed.id])
        XCTAssertTrue(shelf().sessions.isEmpty)
    }

    // A signed-in local finish whose claim meets 409 session-id-taken remints the id — and the
    // finish screen is handed the session the LOG holds, so the review and the discard on that
    // screen aim at an id that exists.
    func testALocalFinishWhoseClaimRemintsTheIdHandsBackTheLogsSession() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success(let live) = await anonymous.start() else { return XCTFail("no session") }
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)

        let server = FakeTraining()
        server.online = false
        server.takenSessionIds = [live.id]
        let store = makeStore(sync: server, mintSession: { "ses_fresh" })
        // Offline, so the connect's claim could not land the live session — it stays this device's.
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.session?.id, live.id)

        server.online = true
        server.reviews["ses_fresh"] = Review(stats: Review.Stats(durationMs: 60_000, workingSets: 1))
        guard case .closed(let closed) = await store.finish() else { return XCTFail("no close") }

        XCTAssertEqual(closed.id, "ses_fresh", "the session handed on is the one the log holds")
        XCTAssertNotNil(closed.finishedAtMs)
        XCTAssertEqual(server.started.map(\.id), [live.id, live.id, "ses_fresh"],
                       "one offline attempt, one spent id, one landing")
        XCTAssertEqual(server.sets["ses_fresh"]?.map(\.weightKg), [82.5])
        XCTAssertNotNil(server.finishes["ses_fresh"])
        XCTAssertNil(server.sets[live.id])
        XCTAssertTrue(shelf().isEmpty)

        let review = await store.review(of: closed.id)
        XCTAssertEqual(review?.stats.workingSets, 1,
                       "the finish screen's review reads back under the id the log holds")
    }

    // A crash between the local finish's two flushes leaves the workout on both shelves — live in
    // the queue, finished in local history. The connect reconciles: the finished copy wins, carries
    // any set only the queue still held, and the claim files the session ONCE.
    func testACrashedLocalFinishIsReconciledOnConnectAndClaimsOnce() async {
        let benchA = TrainingSet(id: "set_a", exerciseId: "bench-press", weightKg: 82.5, reps: 5,
                                 completedAtMs: 1_500)
        let benchB = TrainingSet(id: "set_b", exerciseId: "bench-press", weightKg: 85, reps: 3,
                                 completedAtMs: 1_800)
        let crashed = SetQueue(url: queueURL)
        crashed.hold(Session(id: "ses_1", startedAtMs: 1_000), unclaimed: true)
        crashed.store(benchA, in: "ses_1", needsPush: true)
        crashed.store(benchB, in: "ses_1", needsPush: true)
        crashed.flush()
        let kept = shelf()
        kept.keep(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 2_000), sets: [benchA])
        kept.flush()

        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        XCTAssertNil(store.session, "a workout that finished is not resumed as live")
        XCTAssertEqual(server.started.map(\.id), ["ses_1"], "the session was filed once, not twice")
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5, 85],
                       "the set only the queue still held rode with the finished copy")
        XCTAssertEqual(server.finishes["ses_1"], 2_000)
        XCTAssertTrue(shelf().isEmpty)
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty, "the queue let go of the stale half")
        XCTAssertEqual(store.recent.map(\.id), ["ses_1"], "Today lists the workout once")
        XCTAssertEqual(store.recent.map(\.setCount), [2])
    }

    // The last-time answers cannot survive a change of account: signed out they were computed off
    // this device's shelf, and the account's log may disagree. The connect drops the cache and
    // asks again for the movement in hand.
    func testSigningInMidWorkoutReplacesTheShelfComputedLastTimeWithTheLogs() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: false))
        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 60, reps: 10)
        guard case .closed = await store.finish() else { return XCTFail("no close") }

        _ = await store.start()
        await store.choose("bench-press")
        XCTAssertEqual(store.lastTime?.sets.map(\.weightKg), [60], "the shelf answers signed out")

        server.lastTimes["bench-press"] = LastTime(
            exerciseId: "bench-press",
            session: Session(id: "ses_history", startedAtMs: 100, finishedAtMs: 200),
            sets: [TrainingSet(id: "set_h", exerciseId: "bench-press", setNumber: 1, weightKg: 90,
                               reps: 3, completedAtMs: 150)])
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.lastTime?.sets.map(\.weightKg), [90],
                       "the log's answer replaced the shelf's — the cache did not ride the account change")
        XCTAssertTrue(server.calls.contains("lastTime"), "the log was asked, not assumed")
        XCTAssertEqual(store.prefill, Prefill(weightKg: 90, reps: 3))
    }

    // ── the contract's pins ────────────────────────────────────────────────────────────────────

    func testTheUndoWindowIsNineSecondsToTheMillisecond() {
        XCTAssertEqual(SetQueue.undoWindowMs, 9_000,
                       "pinned to Android's SetQueue.kt — the contract's other statement, gym ARCHITECTURE.md §11")
    }

    // A queue file from before the claim flag existed still opens with its session — and reads as
    // CLAIMED, because every session before the flag was opened by the server.
    func testAnOlderQueueFileStillOpensAndReadsAsClaimed() throws {
        let older = #"{"session":{"id":"ses_old","startedAt":1000},"entries":{}}"#
        try Data(older.utf8).write(to: queueURL)

        let queue = SetQueue(url: queueURL)
        XCTAssertEqual(queue.session?.id, "ses_old")
        XCTAssertFalse(queue.sessionIsUnclaimed)
    }
}

// Parks every finish the fake is asked for until the test releases one — the only way a test can
// stand INSIDE the claim's replay, with a session started on the log and not yet finished there.
@MainActor
private final class FinishGate {
    private var held: [CheckedContinuation<Void, Never>] = []

    var heldCount: Int { held.count }

    func hold() async {
        await withCheckedContinuation { held.append($0) }
    }

    func releaseOne() {
        guard !held.isEmpty else { return }
        held.removeFirst().resume()
    }
}
