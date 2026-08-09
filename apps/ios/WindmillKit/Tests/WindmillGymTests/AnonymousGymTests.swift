import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// THE ANONYMOUS-FIRST ROOM AND ITS CLAIM (wave contract §C and §D). Signed out, gym runs whole out
// of two files on this device — a session starts, freezes its plan off the LOCAL routine, logs,
// finishes into local history, and feeds the prefill, the review and the statistics. Signing in
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
                           mintSession: @escaping () -> String = Ids.session) -> TrainingStore {
        TrainingStore(
            queue: SetQueue(url: queueURL),
            deviceCatalog: DeviceCatalog(url: catalogURL),
            localLog: LocalLog(url: localURL),
            now: { self.clockMs += 1; return self.clockMs },
            mintSession: mintSession,
            mintSet: Ids.set,
            undoWindowMs: 0,
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

    // The whole signed-out life of a session, on this device and nowhere else: start, log, finish,
    // and the log page Today draws from local history.
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
        XCTAssertEqual(store.recent.map(\.setCount), [2], "Today's log page reads the local shelf")
        XCTAssertEqual(store.recent.map(\.id), [closed.id])

        let reopened = shelf()
        XCTAssertEqual(reopened.sessions.map { $0.session.id }, [closed.id])
        XCTAssertEqual(reopened.sessions.first?.sets.map(\.weightKg), [82.5, 85])
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty,
                      "the finished session's sets moved shelves — the queue owes nothing")
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

    // A fresh phone has no catalog at all, so the picker's Create must work signed out — and the
    // routine kept at the end of a session lands on the same shelf.
    func testSignedOutCreateAndKeepLandOnTheDevice() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))

        guard case .success(let made) = await store.create("Zercher Squat") else {
            return XCTFail("a movement can be minted onto this device")
        }
        XCTAssertTrue(made.custom)
        XCTAssertEqual(store.catalog.map(\.name), ["Zercher Squat"])

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

    // The prefill's four states hold signed out too: the device's own history answers, and a
    // movement it has never seen is an honest first time — never "reading your log…".
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

    // The review and the statistics answer from the local shelf — the three facts and the honest
    // word over a short session, weeks and movement lines over the finished history. No e1RM is
    // invented on this device, so the movement line's axis is the load.
    func testSignedOutReviewAndStatisticsAnswerFromTheLocalLog() async {
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

        guard case .success(let statistics) = await store.statistics() else {
            return XCTFail("the local log always answers")
        }
        XCTAssertEqual(statistics.weeks.map(\.sessions), [1])
        XCTAssertEqual(statistics.weeks.map(\.workingSets), [2])
        XCTAssertEqual(statistics.weeks.first?.startedAtMs,
                       LocalLog.weekStartMs(of: opened.startedAtMs))
        XCTAssertEqual(statistics.movements.map(\.exerciseId), ["bench-press"])
        XCTAssertEqual(statistics.movements.first?.points.map(\.weightKg), [85])
        XCTAssertNil(statistics.movements.first?.points.first?.e1rm, "no Epley is computed here")
        XCTAssertEqual(statistics.movements.first?.heaviest?.weightKg, 85)
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

        guard case .success(let statistics) = await store.statistics() else {
            return XCTFail("the local log always answers")
        }
        XCTAssertEqual(statistics.movements.first?.heaviest,
                       MovementBest(weightKg: 100, reps: 8, atMs: second.startedAtMs),
                       "a tied load goes to more reps")

        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 100, reps: 8)
        guard case .closed = await store.finish() else { return XCTFail("no third close") }

        guard case .success(let again) = await store.statistics() else { return XCTFail("no statistics") }
        XCTAssertEqual(again.movements.first?.heaviest,
                       MovementBest(weightKg: 100, reps: 8, atMs: second.startedAtMs),
                       "a full tie keeps the earlier mark")
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

        guard case .success(let made) = await anonymous.create("Zercher Squat") else {
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
    // the local shelf keeps everything for the next connect.
    func testTheClaimWaitsWhileAnotherSessionIsOpen() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let closed) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.open(Session(id: "ses_phone", startedAtMs: 500))
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))

        XCTAssertEqual(server.started.map(\.joinOpenSession), [false])
        XCTAssertNil(server.sets[closed.id], "not one set went out against a start that waited")
        XCTAssertNil(server.finishes[closed.id])
        XCTAssertEqual(shelf().sessions.map { $0.session.id }, [closed.id], "nothing was dropped")
        XCTAssertTrue(claimed.refusals.isEmpty, "waiting is not a refusal")
        XCTAssertTrue(claimed.recent.map(\.id).contains(closed.id),
                      "the unclaimed session still reads in the merged log")
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
        XCTAssertEqual(claimed.refusals.map(\.weightKg), [82.5])
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
    // and the loss is SAID: every set that named it replays into a refusal the banner carries.
    // This let-go-and-say shape is the terminal-refusal contract for both phones.
    func testAClaimWriteRefusedOutrightIsLetGoAndItsSetsAreSaid() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success(let made) = await anonymous.create("Zercher Squat") else {
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
        XCTAssertEqual(claimed.refusals.map(\.exerciseId), [made.id])
        XCTAssertEqual(claimed.refusals.map(\.weightKg), [60])
        XCTAssertEqual(claimed.refusals.map(\.reason), ["that movement is not in the catalog"],
                       "the loss is said through the refusals surface, not silently let go")
        XCTAssertEqual(server.sets[closed.id]?.map(\.weightKg), [82.5],
                       "the rest of the session still lands")
        XCTAssertNotNil(server.finishes[closed.id])
        XCTAssertTrue(shelf().sessions.isEmpty, "the session claimed whole once the loss was said")
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
