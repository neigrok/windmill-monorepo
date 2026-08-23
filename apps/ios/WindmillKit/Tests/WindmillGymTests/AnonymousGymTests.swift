import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

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
    private var accountURL: URL!
    private var clockMs: Int64 = 1_000

    override func setUp() async throws {
        let stem = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-anon-\(UUID().uuidString)")
        queueURL = stem.appendingPathExtension("queue.json")
        catalogURL = stem.appendingPathExtension("catalog.json")
        localURL = stem.appendingPathExtension("local.json")
        accountURL = stem.appendingPathExtension("account.json")
        clockMs = 1_000
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
        try? FileManager.default.removeItem(at: catalogURL)
        try? FileManager.default.removeItem(at: localURL)
        try? FileManager.default.removeItem(at: accountURL)
    }

    private func makeStore(sync: FakeTraining?,
                           mintSession: @escaping () -> String = Ids.session,
                           retryAfter: Duration = .seconds(4)) -> TrainingStore {
        TrainingStore(
            queue: SetQueue(url: queueURL, deviceHolds: nil),
            deviceCatalog: DeviceCatalog(url: catalogURL),
            accountCopy: AccountCopy(url: accountURL),
            localLog: LocalLog(url: localURL, deviceHolds: nil),
            now: { self.clockMs += 1; return self.clockMs },
            mintSession: mintSession,
            mintSet: Ids.set,
            undoWindowMs: 0,
            retryAfter: retryAfter,
            sync: { $0.isSignedIn ? sync : nil }
        )
    }

    private func account(signedIn: Bool) -> Account {
        account(userId: signedIn ? "u1" : nil)
    }

    private func account(userId: String?) -> Account {
        Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: userId.map { User(id: $0, email: "\($0)@example.com", name: $0) }
        )
    }

    private func shelf(of seat: String? = nil) -> LocalLog {
        let held = LocalLog(url: localURL, deviceHolds: nil)
        held.open(under: seat)
        return held
    }

    private func waiting(of seat: String? = nil) -> SetQueue {
        let held = SetQueue(url: queueURL, deviceHolds: nil)
        held.open(under: seat)
        return held
    }

    private func seedRoutine() {
        let kept = shelf()
        kept.keep(Routine(id: "rt_local", name: "Push A", position: 0, entries: [
            RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 5, targetReps: 5,
                         targetWeightKg: 82.5),
        ]))
        kept.flush()
    }

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

        let reopened = makeStore(sync: nil)
        await reopened.connect(to: account(signedIn: false))

        XCTAssertEqual(reopened.session?.id, opened.id, "the same workout is still running")
        XCTAssertEqual(reopened.sets.map(\.weightKg), [60, 80, 100, 100])
        XCTAssertEqual(reopened.sets.map(\.exerciseId), Array(repeating: "back-squat", count: 4))
        XCTAssertEqual(reopened.order, ["back-squat"])

        guard let resumed = LiveOrder.resume(order: reopened.order, sets: reopened.sets) else {
            return XCTFail("a session with sets in it has somewhere to stand")
        }
        XCTAssertEqual(resumed, "back-squat")
        await reopened.choose(resumed)
        XCTAssertEqual(reopened.prefill.weightKg, 100, "dialled to the weight the last set was at")
        XCTAssertEqual(reopened.todaySets.count, 4)
    }

    func testThePickerMetaIsAskedAgainForTheAccountThatArrives() async {
        let server = FakeTraining()
        server.catalog = DeviceCatalog.seeded
        server.lastSets = [LastSet(exerciseId: "back-squat", weightKg: 140, reps: 5, atMs: 900)]
        let store = makeStore(sync: server, retryAfter: .seconds(600))
        await store.connect(to: account(signedIn: false))

        await store.loadLastSets()
        XCTAssertEqual(store.lastSets, [:])

        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(store.lastSets?["back-squat"]?.weightKg, 140,
                       "the seat that arrived answered what the seat that left was asked")
        let six = PickerOptions.matching(query: "", catalog: store.catalog, taken: store.order,
                                         lastSets: store.lastSets, now: 900)
        XCTAssertEqual(six.six.first?.meta, "last 140 × 5 · today")

        let untouched = FakeTraining()
        let unopened = makeStore(sync: untouched, retryAfter: .seconds(600))
        await unopened.connect(to: account(signedIn: true))
        XCTAssertNil(unopened.lastSets)
        XCTAssertFalse(untouched.calls.contains("lastSets"))
    }

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
        XCTAssertTrue(waiting(of: nil).pending.isEmpty,
                      "the finished session's sets moved shelves — the queue owes nothing")
    }

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

        let retargeted = await store.save(87.5, toRoutine: "rt_local", at: 1, for: "bench-press")
        XCTAssertNil(retargeted)
        XCTAssertEqual(store.session?.plan?.entry(for: "bench-press")?.weightKg, 82.5,
                       "the snapshot is frozen — a retarget moves next week, never this session")
        XCTAssertEqual(shelf().routine("rt_local")?.entries.first?.targetWeightKg, 87.5,
                       "and the local routine did move")

        let stale = await store.save(90, toRoutine: "rt_local", at: 2, for: "bench-press")
        XCTAssertEqual(stale, .refused("Push A has changed since this session started"))
        XCTAssertEqual(shelf().routine("rt_local")?.entries.map(\.targetWeightKg), [87.5])

        guard case .failure(.refused(let why)) = await store.start(routineId: "rt_missing") else {
            return XCTFail("a routine this device does not hold cannot open a session")
        }
        XCTAssertEqual(why, "that routine is not on this device")
    }

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

        let page = Record.page(record, now: opened.startedAtMs, from: answered.source)
        XCTAssertNil(page.best)
        XCTAssertNil(page.chart, "no series is no chart — never an empty frame")
        XCTAssertEqual(page.noChart, .onThisDevice)
        XCTAssertEqual(page.heaviest, Record.Tile(caption: "heaviest", value: "85", under: "kg · for 3"))
        XCTAssertEqual(page.subhead, "barbell · in no routine · 1 session")
        XCTAssertEqual(page.days.map(\.sets), ["82.5 × 5 · 85 × 3"])
        XCTAssertFalse(page.neverLogged)
    }

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

        XCTAssertTrue(shelf(of: "u1").isEmpty, "everything owed was answered for and let go")
        XCTAssertEqual(claimed.recent.map(\.id).sorted(), [first.id, second.id].sorted(),
                       "the server log is the truth now")
    }

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
        XCTAssertEqual(shelf(of: "u1").sessions.map { $0.session.id }, [closed.id], "nothing was dropped")
        XCTAssertTrue(claimed.refusals.isEmpty, "waiting is not a refusal")
        XCTAssertTrue(claimed.recent.map(\.id).contains(closed.id),
                      "the unclaimed session still reads in the merged log")

        try? await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(server.started.map(\.id), [closed.id],
                       "one start asked and one answer taken — WAIT armed no cadence")
    }

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
        XCTAssertTrue(shelf(of: "u1").isEmpty)
    }

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
        XCTAssertTrue(shelf(of: "u1").isEmpty)
    }

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

        XCTAssertEqual(shelf(of: "u1").sessions.map { $0.session.id }, [closed.id])
        XCTAssertTrue(claimed.refusals.isEmpty)
        XCTAssertEqual(claimed.recent.map(\.id), [closed.id],
                       "the room still stands on local state while the wire is down")
    }

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
        XCTAssertEqual(shelf(of: "u1").sessions.map { $0.session.id }, [closed.id],
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
        XCTAssertTrue(shelf(of: "u1").isEmpty, "everything owed was answered for and let go — no remount, no tap")
    }

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

        XCTAssertTrue(shelf(of: "u1").exercises.isEmpty, "the refused movement is let go, never a jam on the shelf")
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
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty, "the session claimed whole once the loss was said")
    }

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
        XCTAssertTrue(shelf(of: "u1").routines.isEmpty,
                      "said and let go — the terminal write is not re-sent on every connect")

        claimed.clearRefusals()
        XCTAssertEqual(claimed.refusals, [], "dismissing the banner clears the shown refusals")
    }

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
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty)
        XCTAssertEqual(store.refusals, [])
    }

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

        let reconnect = Task { await store.connect(to: account(signedIn: true)) }
        for _ in 0..<10 { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(server.started.map(\.id), [past.id],
                       "the reconnect parked its claim — no second runner replayed the shelf")
        XCTAssertFalse(server.calls.contains("sessions"),
                       "and no log page was read while the replay held a session open on the log")

        gate.releaseOne()
        await boot.value
        await reconnect.value

        XCTAssertEqual(server.started.map(\.id), [past.id],
                       "one start ever — the rerun found the shelf already claimed")
        XCTAssertEqual(server.started.map(\.joinOpenSession), [false])
        XCTAssertEqual(server.sets[past.id]?.map(\.weightKg), [82.5])
        XCTAssertEqual(server.finishes[past.id], past.finishedAtMs)
        XCTAssertTrue(shelf(of: "u1").isEmpty)
        XCTAssertEqual(store.recent.map(\.id), [past.id], "the claimed session still reached the log")
        XCTAssertEqual(store.refusals, [])
    }

    func testASignedInStartFromAnUnclaimedRoutineComposesOnTheDevice() async {
        seedRoutine()
        let server = FakeTraining()
        server.online = false
        let store = makeStore(sync: server)
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
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty)
    }

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
        XCTAssertTrue(shelf(of: "u1").isEmpty)

        let review = await store.review(of: closed.id)
        XCTAssertEqual(review?.stats.workingSets, 1,
                       "the finish screen's review reads back under the id the log holds")
    }

    func testACrashedLocalFinishIsReconciledOnConnectAndClaimsOnce() async {
        let benchA = TrainingSet(id: "set_a", exerciseId: "bench-press", weightKg: 82.5, reps: 5,
                                 completedAtMs: 1_500)
        let benchB = TrainingSet(id: "set_b", exerciseId: "bench-press", weightKg: 85, reps: 3,
                                 completedAtMs: 1_800)
        let crashed = waiting(of: nil)
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
        XCTAssertTrue(shelf(of: "u1").isEmpty)
        XCTAssertTrue(waiting(of: "u1").pending.isEmpty, "the queue let go of the stale half")
        XCTAssertEqual(store.recent.map(\.id), ["ses_1"], "Today lists the workout once")
        XCTAssertEqual(store.recent.map(\.setCount), [2])
    }

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

    func testTheUndoWindowIsNineSecondsToTheMillisecond() {
        XCTAssertEqual(SetQueue.undoWindowMs, 9_000,
                       "pinned to Android's SetQueue.kt — the contract's other statement, gym ARCHITECTURE.md §11")
    }

    func testAnOlderQueueFileStillOpensAndReadsAsClaimed() throws {
        let older = #"{"session":{"id":"ses_old","startedAt":1000},"entries":{}}"#
        try Data(older.utf8).write(to: queueURL)

        let queue = SetQueue(url: queueURL, deviceHolds: "u1")
        queue.open(under: "u1")
        XCTAssertEqual(queue.session?.id, "ses_old")
        XCTAssertFalse(queue.sessionIsUnclaimed)
    }

    func testSettlingReadsWaitOutAClaimMidSession() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let past) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.nowMs = past.startedAtMs + Session.autoCloseMs + 60_000
        let gate = FinishGate()
        server.onFinish = { await gate.hold() }
        let store = makeStore(sync: server)
        let boot = Task { await store.connect(to: account(signedIn: true)) }
        for _ in 0..<200 where gate.heldCount == 0 { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(gate.heldCount, 1, "the boot claim is parked on the slow finish")

        let older = Task { await store.loadOlder() }
        let record = Task { await store.record(of: "bench-press") }
        for _ in 0..<10 { try? await Task.sleep(for: .milliseconds(20)) }
        XCTAssertFalse(server.calls.contains("sessions"), "the log page waited")
        XCTAssertFalse(server.calls.contains("record"), "the record waited")
        XCTAssertEqual(store.logFoot, .loading, "and the foot says the page is in flight, not failed")

        gate.releaseOne()
        await boot.value
        await older.value
        _ = await record.value

        XCTAssertEqual(server.finishes[past.id], past.finishedAtMs,
                       "the replayed session closed at its own finish, not under a read")
        XCTAssertTrue(server.calls.contains("sessions"))
        XCTAssertTrue(server.calls.contains("record"))
        XCTAssertTrue(server.calls.firstIndex(of: "sessions")! > server.calls.firstIndex(of: "finish")!,
                      "every settling read came after the runner let go")
        XCTAssertEqual(store.recent.map(\.id), [past.id])
        XCTAssertEqual(store.refusals, [])
    }

    func testOwedSetsOfAClaimedSessionGoOutBeforeAnyStartTheClaimSends() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_live", startedAtMs: 1_000))
        let evening = makeStore(sync: server)
        await evening.connect(to: account(signedIn: true))
        XCTAssertEqual(evening.session?.id, "ses_live", "adopted — the queue holds it CLAIMED")
        await evening.choose("bench-press")
        await evening.logSet(weightKg: 80, reps: 5)
        XCTAssertEqual(server.sets["ses_live"]?.count, 1, "one set landed on the log")

        clockMs = 1_000 + Session.autoCloseMs
        server.online = false
        for reps in [5, 5, 4, 3] { await evening.logSet(weightKg: 82.5, reps: reps) }
        XCTAssertEqual(waiting(of: "u1").owed(in: "ses_live").count, 4)
        let shelved = shelf(of: "u1")
        shelved.keep(Session(id: "ses_shelf", startedAtMs: 500, finishedAtMs: 600),
                     sets: [TrainingSet(id: "set_shelf", exerciseId: "deadlift", weightKg: 140, reps: 3,
                                        completedAtMs: 550)])
        shelved.flush()

        clockMs = 1_000 + Session.autoCloseMs + 10 * 60_000
        server.nowMs = clockMs
        server.online = true
        let beforeMorning = server.calls.count
        let morning = makeStore(sync: server)
        await morning.connect(to: account(signedIn: true))

        let wire = server.calls[beforeMorning...].filter { ["append", "start", "sessions", "finish"].contains($0) }
        XCTAssertEqual(Array(wire.prefix(5)), ["append", "append", "append", "append", "start"],
                       "the queue drains before the claim's first start")
        XCTAssertEqual(server.stored["ses_live"]?.isOpen, true, "the live session was never closed")
        XCTAssertEqual(server.sets["ses_live"]?.map(\.reps), [5, 5, 5, 4, 3], "all four landed")
        XCTAssertEqual(morning.session?.id, "ses_live", "and the room stands in it")
        XCTAssertEqual(morning.refusals, [], "nothing was dropped, nothing said")
        XCTAssertEqual(waiting(of: "u1").owed(in: "ses_live").count, 0)
        XCTAssertEqual(shelf(of: "u1").sessions.map { $0.session.id }, ["ses_shelf"],
                       "the shelf session skipped the phone's own open workout and waits for its finish")
        XCTAssertNil(server.stored["ses_shelf"])
    }

    func testAStartWhoseReplyWasLostComposesUnderTheSameIdAndTheClaimReplaysIt() async {
        let server = FakeTraining()
        server.swallowStartReplies = 1
        var minted = ["ses_a", "ses_b", "ses_c"]
        let store = makeStore(sync: server, mintSession: { minted.removeFirst() },
                              retryAfter: .milliseconds(40))
        await store.connect(to: account(signedIn: true))

        guard case .success(let opened) = await store.start() else { return XCTFail("a lost reply is not a wall") }
        XCTAssertEqual(opened.id, "ses_a", "the id the attempt wore — never a fresh one")
        XCTAssertEqual(server.stored["ses_a"]?.isOpen, true, "the log holds A open")
        XCTAssertEqual(opened.startedAtMs, server.started[0].startedAtMs, "and the instant it wore — the same body")
        XCTAssertTrue(waiting(of: "u1").sessionIsUnclaimed, "held unclaimed until the claim replays it")

        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        for _ in 0..<200 where server.sets["ses_a"] == nil { try? await Task.sleep(for: .milliseconds(20)) }

        XCTAssertEqual(server.started.map(\.id), ["ses_a", "ses_a"], "the claim replayed the same start")
        XCTAssertEqual(server.started.map(\.startedAtMs), [opened.startedAtMs, opened.startedAtMs])
        XCTAssertEqual(Array(server.stored.keys), ["ses_a"], "one workout on the log — there is no B")
        XCTAssertEqual(server.sets["ses_a"]?.map(\.weightKg), [82.5], "and the owed set landed into it")
        XCTAssertFalse(waiting(of: "u1").sessionIsUnclaimed)
        XCTAssertEqual(store.session?.id, "ses_a")
        XCTAssertEqual(store.refusals, [])
    }

    func testAWorkoutComposedOfflineUnderOneAccountIsNotReplayedIntoTheNext() async {
        let logOfA = FakeTraining()
        logOfA.online = false
        let asA = makeStore(sync: logOfA)
        await asA.connect(to: account(userId: "u-a"))
        guard case .success = await asA.start() else { return XCTFail("no signal is not a wall") }
        await asA.choose("back-squat")
        await asA.logSet(weightKg: 100, reps: 5)
        _ = await asA.finish()
        XCTAssertEqual(shelf(of: "u-a").sessions.count, 1, "composed on the device, under A's name")

        let logOfB = FakeTraining()
        let asB = makeStore(sync: logOfB)
        await asB.connect(to: account(userId: "u-b"))

        XCTAssertEqual(logOfB.started, [], "B's log is told about no workout of A's")
        XCTAssertEqual(logOfB.appended, [])
        XCTAssertEqual(asB.recent, [], "and B's log page draws none of it")
        XCTAssertEqual(shelf(of: "u-a").sessions.count, 1, "A's workout is still A's, still on the device")

        logOfA.online = true
        let asAAgain = makeStore(sync: logOfA)
        await asAAgain.connect(to: account(userId: "u-a"))
        XCTAssertEqual(logOfA.sets.values.map(\.count), [1], "and it lands when A comes back")
        XCTAssertTrue(shelf(of: "u-a").sessions.isEmpty)
    }

    func testAnOwedSetIsNeitherDrawnNorDeliveredUnderTheNextAccount() async {
        let logOfA = FakeTraining()
        let asA = makeStore(sync: logOfA)
        await asA.connect(to: account(userId: "u-a"))
        guard case .success(let live) = await asA.start() else { return XCTFail("A's start") }
        await asA.choose("bench-press")
        logOfA.online = false
        await asA.logSet(weightKg: 82.5, reps: 5)
        XCTAssertEqual(waiting(of: "u-a").pending.count, 1)

        let logOfB = FakeTraining()
        let asB = makeStore(sync: logOfB)
        await asB.connect(to: account(userId: "u-b"))

        XCTAssertNil(asB.session, "B does not draw A's live workout")
        XCTAssertEqual(logOfB.appended, [], "and B's bearer never carried A's set")
        XCTAssertEqual(waiting(of: "u-a").pending.count, 1, "which is why it is still owed, not dropped")

        logOfA.online = true
        let asAAgain = makeStore(sync: logOfA)
        await asAAgain.connect(to: account(userId: "u-a"))
        XCTAssertEqual(logOfA.sets[live.id]?.map(\.weightKg), [82.5])
        XCTAssertTrue(waiting(of: "u-a").pending.isEmpty)
    }

    func testASignedOutScreenDrawsNoAccountsWorkout() async {
        let logOfA = FakeTraining()
        let asA = makeStore(sync: logOfA)
        await asA.connect(to: account(userId: "u-a"))
        guard case .success = await asA.start() else { return XCTFail("A's start") }
        await asA.choose("bench-press")
        await asA.logSet(weightKg: 82.5, reps: 5)

        let signedOut = makeStore(sync: nil)
        await signedOut.connect(to: account(userId: nil))

        XCTAssertNil(signedOut.session)
        XCTAssertEqual(signedOut.sets, [])
        XCTAssertEqual(signedOut.recent, [])
    }

    func testTheAnonymousShelfIsStillClaimedByWhoeverSignsIn() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        guard case .success = await anonymous.start() else { return XCTFail("the tapped start") }
        await anonymous.choose("back-squat")
        await anonymous.logSet(weightKg: 60, reps: 5)
        _ = await anonymous.finish()

        let server = FakeTraining()
        let signedIn = makeStore(sync: server)
        await signedIn.connect(to: account(userId: "u-a"))

        XCTAssertEqual(server.started.count, 1, "the claim replayed the anonymous session")
        XCTAssertEqual(server.appended.map(\.weightKg), [60])
        XCTAssertTrue(shelf(of: "u1").isEmpty, "and the anonymous shelf is empty once the log has it")
    }

    func testAPreSeatShelfGoesToTheAccountTheDeviceIsHolding() throws {
        let older = #"{"sessions":[{"session":{"id":"ses_old","startedAt":500,"finishedAt":600},"sets":[]}]}"#
        try Data(older.utf8).write(to: localURL)

        let migrated = LocalLog(url: localURL, deviceHolds: "u1")

        migrated.open(under: "u1")
        XCTAssertEqual(migrated.sessions.map { $0.session.id }, ["ses_old"])
        migrated.open(under: nil)
        XCTAssertTrue(migrated.sessions.isEmpty, "and it is not anonymous work — it has an owner")
    }

    func testAPreSeatShelfIsQuarantinedWhenTheDeviceHoldsNobody() async throws {
        let older = #"{"sessions":[{"session":{"id":"ses_old","startedAt":500,"finishedAt":600},"sets":[]}]}"#
        try Data(older.utf8).write(to: localURL)

        let migrated = LocalLog(url: localURL, deviceHolds: nil)

        for seat in [nil, "u1", "u-b"] {
            migrated.open(under: seat)
            XCTAssertTrue(migrated.sessions.isEmpty, "unreachable from every seat, including anonymous")
        }

        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(server.started, [], "and no account is given it by a claim")
    }

    func testAShelfSessionTheLogLosesAfterItsStartIsSaidAndLetGo() async {
        let shelved = shelf()
        shelved.keep(Session(id: "ses_gone_a", startedAtMs: 500, finishedAtMs: 600),
                     sets: [TrainingSet(id: "set_a1", exerciseId: "bench-press", weightKg: 80, reps: 5,
                                        completedAtMs: 550)])
        shelved.keep(Session(id: "ses_gone_b", startedAtMs: 700, finishedAtMs: 800),
                     sets: [TrainingSet(id: "set_b1", exerciseId: "deadlift", weightKg: 140, reps: 3,
                                        completedAtMs: 750)])
        shelved.flush()

        let server = FakeTraining()
        server.refuse = { write in
            if write.id == "set_a1" { server.stored["ses_gone_a"] = nil }
            return nil
        }
        server.onFinish = { server.stored["ses_gone_b"] = nil }
        let store = makeStore(sync: server, retryAfter: .milliseconds(40))
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(store.refusals, [
            .claim(RefusedClaim(id: "ses_gone_a", name: "\(Readout.noRoutine) · \(Readout.dateWithYear(500))",
                                reason: "that workout is no longer on the log")),
            .claim(RefusedClaim(id: "ses_gone_b", name: "\(Readout.noRoutine) · \(Readout.dateWithYear(700))",
                                reason: "that workout is no longer on the log")),
        ])
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty, "both let go — never re-sent")
        XCTAssertEqual(server.started.map(\.id), ["ses_gone_a", "ses_gone_b"], "A's loss did not halt B")
        XCTAssertEqual(server.sets["ses_gone_b"]?.map(\.weightKg), [140], "B's sets went out before its finish met the 404")

        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(server.started.count, 2, "no cadence ever re-sent either start")
        XCTAssertEqual(server.appended.filter { $0.id == "set_a1" }.count, 1)
    }

    func testAShelfSessionBehindThePhonesOwnLiveWorkoutIsSkippedAndClaimedAtTheFinish() async {
        let server = FakeTraining()
        server.online = false
        let offline = makeStore(sync: server)
        await offline.connect(to: account(signedIn: true))
        guard case .success(let past) = await offline.start() else { return XCTFail("no basement start") }
        await offline.choose("bench-press")
        await offline.logSet(weightKg: 82.5, reps: 5)
        guard case .closed = await offline.finish() else { return XCTFail("no local close") }
        XCTAssertEqual(shelf(of: "u1").sessions.map { $0.session.id }, [past.id])

        server.online = true
        guard case .success(let live) = await offline.start() else { return XCTFail("no server start") }
        XCTAssertNotEqual(live.id, past.id)
        XCTAssertEqual(server.stored[live.id]?.isOpen, true)

        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))
        XCTAssertEqual(relaunched.session?.id, live.id, "the live workout is still the room's")
        XCTAssertEqual(shelf(of: "u1").sessions.map { $0.session.id }, [past.id], "the shelf session waits")
        XCTAssertNil(server.finishes[past.id])
        XCTAssertEqual(relaunched.refusals, [], "a skip is not a loss and nothing is said")

        await relaunched.choose("bench-press")
        await relaunched.logSet(weightKg: 90, reps: 3)
        XCTAssertEqual(server.sets[live.id]?.map(\.weightKg), [90], "the live workout was never held up")

        guard case .closed(let closed) = await relaunched.finish() else { return XCTFail("no close") }
        XCTAssertEqual(closed.id, live.id)
        XCTAssertEqual(server.sets[past.id]?.map(\.weightKg), [82.5], "the finish claimed the shelf session")
        XCTAssertNotNil(server.finishes[past.id])
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty)
        XCTAssertEqual(Set(relaunched.recent.map(\.id)), [past.id, live.id])
    }

    func testAClockAheadShelfStartRetriesAndAnyOther400IsSaidAndLetGo() async {
        let anonymous = makeStore(sync: nil)
        await anonymous.connect(to: account(signedIn: false))
        _ = await anonymous.start()
        await anonymous.choose("bench-press")
        await anonymous.logSet(weightKg: 82.5, reps: 5)
        guard case .closed(let ahead) = await anonymous.finish() else { return XCTFail("no close") }

        let server = FakeTraining()
        server.refuseStart = refusal(400, code: "clock-ahead",
                                     message: "this device's clock is 9 minutes ahead of the log")
        let store = makeStore(sync: server, retryAfter: .milliseconds(40))
        await store.connect(to: account(signedIn: true))
        XCTAssertEqual(shelf(of: "u1").sessions.map { $0.session.id }, [ahead.id], "kept for the cadence")
        XCTAssertEqual(store.refusals, [], "transient by construction — nothing is said")

        server.refuseStart = nil
        for _ in 0..<200 where server.finishes[ahead.id] == nil {
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(server.sets[ahead.id]?.map(\.weightKg), [82.5], "the cadence landed it on its own")
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty)

        let again = makeStore(sync: nil)
        await again.connect(to: account(signedIn: false))
        _ = await again.start()
        await again.choose("deadlift")
        await again.logSet(weightKg: 140, reps: 3)
        guard case .closed(let broken) = await again.finish() else { return XCTFail("no close") }

        server.refuseStart = refusal(400, message: "could not read that start")
        let refused = makeStore(sync: server)
        await refused.connect(to: account(signedIn: true))
        XCTAssertEqual(refused.refusals, [.claim(RefusedClaim(
            id: broken.id,
            name: "\(Readout.noRoutine) · \(Readout.dateWithYear(broken.startedAtMs))",
            reason: "could not read that start"))])
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty, "let go — not resent on every connect")

        server.refuseStart = nil
        let later = makeStore(sync: server)
        await later.connect(to: account(signedIn: true))
        XCTAssertEqual(server.started.filter { $0.id == broken.id }.count, 1,
                       "the next connect never sent it again")
        XCTAssertEqual(later.refusals, [])
    }

    func testAnAbandonedLocalSessionIsClosedAtItsLastSetOnConnectAndClaimsThatWay() async {
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        guard case .success(let opened) = await store.start() else { return XCTFail("no session") }
        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        await store.logSet(weightKg: 82.5, reps: 5)
        let lastSetAt = store.sets.last!.completedAtMs

        clockMs = lastSetAt + 2 * 24 * 60 * 60 * 1000
        let reopened = makeStore(sync: nil)
        await reopened.connect(to: account(signedIn: false))

        XCTAssertNil(reopened.session, "the workout is over")
        XCTAssertEqual(shelf().sessions.map { $0.session.id }, [opened.id])
        XCTAssertEqual(shelf().session(opened.id)?.session.finishedAtMs, lastSetAt,
                       "finished AT the last set, not at now")
        XCTAssertEqual(reopened.recent.first?.session.finishedAtMs, lastSetAt)

        let server = FakeTraining()
        let claimed = makeStore(sync: server)
        await claimed.connect(to: account(signedIn: true))
        XCTAssertEqual(server.finishes[opened.id], lastSetAt, "and it claimed as a workout that ended then")
        XCTAssertEqual(server.sets[opened.id]?.count, 2)
    }
}

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
