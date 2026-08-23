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
final class FixSetTests: XCTestCase {
    private var queueURL: URL!
    private var catalogURL: URL!
    private var localURL: URL!
    private var clockMs: Int64 = 1_000

    override func setUp() async throws {
        let stem = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-fix-\(UUID().uuidString)")
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

    private func makeStore(sync: FakeTraining?, undoWindowMs: Int64 = 0,
                           retryAfter: Duration = .seconds(4)) -> TrainingStore {
        TrainingStore(
            queue: SetQueue(url: queueURL, deviceHolds: nil),
            deviceCatalog: DeviceCatalog(url: catalogURL),
            accountCopy: AccountCopy(url: catalogURL.appendingPathExtension("account")),
            localLog: LocalLog(url: localURL, deviceHolds: nil),
            now: { self.clockMs += 1; return self.clockMs },
            mintSession: Ids.session,
            mintSet: Ids.set,
            undoWindowMs: undoWindowMs,
            retryAfter: retryAfter,
            sync: { $0.isSignedIn ? sync : nil }
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

    private func account(signedIn: Bool) -> Account {
        Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: signedIn ? User(id: "u1", email: "sam@example.com", name: "Sam") : nil
        )
    }

    private func shelf(of seat: String? = nil) -> LocalLog { shelfOnDisk(of: seat) }

    private func liveUnclaimedStore(_ server: FakeTraining, undoWindowMs: Int64 = 0) async -> TrainingStore {
        server.online = false
        let store = makeStore(sync: server, undoWindowMs: undoWindowMs)
        await store.connect(to: account(signedIn: false))
        _ = await store.start()
        await store.choose("bench-press")
        await store.logSet(weightKg: 100, reps: 5)
        await store.logSet(weightKg: 100, reps: 4)
        await store.connect(to: account(signedIn: true))
        return store
    }

    private func set(_ id: String, _ weightKg: Double, _ reps: Int, at completedAtMs: Int64,
                     number: Int? = nil, kind: SetKind = .working) -> TrainingSet {
        TrainingSet(id: id, exerciseId: "bench-press", setNumber: number, weightKg: weightKg,
                    reps: reps, kind: kind, completedAtMs: completedAtMs)
    }

    private func loggedStore(_ server: FakeTraining) async -> TrainingStore {
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 5_000))
        server.sets["ses_1"] = [set("set_1", 82.5, 5, at: 2_000, number: 1),
                                set("set_2", 82.5, 4, at: 3_000, number: 2)]
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        return store
    }

    private func seedShelf(routineId: String? = nil) {
        let kept = shelf()
        kept.keep(Session(id: "ses_local", startedAtMs: 1_000, finishedAtMs: 5_000,
                          routineId: routineId,
                          plan: routineId == nil ? nil
                              : PlanSnapshot(routine: "Push A",
                                             entries: [PlanEntry(exerciseId: "bench-press", sets: 3,
                                                                 reps: 5, weightKg: 82.5)])),
                  sets: [set("set_1", 82.5, 5, at: 2_000), set("set_2", 100, 4, at: 3_000)])
        if let routineId {
            kept.keep(Routine(id: routineId, name: "Push A", position: 0, entries: [
                RoutineEntry(position: 1, exerciseId: "bench-press", targetSets: 3, targetReps: 5,
                             targetWeightKg: 82.5),
            ]))
        }
        kept.flush()
    }

    func testACorrectionMovesThreeFieldsAndCopiesEverythingElse() {
        let logged = TrainingSet(id: "set_1", exerciseId: "bench-press", setNumber: 2, weightKg: 100,
                                 reps: 4, kind: .working, rpe: 8.5, note: "felt heavy",
                                 completedAtMs: 3_000)

        let corrected = logged.corrected(by: SetFix(weightKg: 90, reps: 5, kind: .drop))

        XCTAssertEqual(corrected, TrainingSet(id: "set_1", exerciseId: "bench-press", setNumber: 2,
                                              weightKg: 90, reps: 5, kind: .drop, rpe: 8.5,
                                              note: "felt heavy", completedAtMs: 3_000))
    }

    func testACorrectionMadeSignedOutReplaysCorrectedAndNeverTwice() async {
        seedShelf()
        let signedOut = makeStore(sync: nil)
        await signedOut.connect(to: account(signedIn: false))

        guard case .success(let read) = await signedOut.sessionDetail("ses_local") else {
            return XCTFail("a session on this device's shelf is readable with nobody signed in")
        }
        guard let typo = read.sets.first(where: { $0.id == "set_2" }) else {
            return XCTFail("the shelf holds both sets")
        }
        await signedOut.fix(typo, in: "ses_local", by: SetFix(weightKg: 10, reps: 4, kind: .working))

        let server = FakeTraining()
        let signedIn = makeStore(sync: server)
        await signedIn.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets["ses_local"]?.map(\.id), ["set_1", "set_2"],
                       "one row per set, and the correction is not a second one")
        XCTAssertEqual(server.sets["ses_local"]?.map(\.weightKg), [82.5, 10],
                       "the account receives the corrected number, never the one that was typed")
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty, "the shelf lets go once the log has it")
        XCTAssertTrue(signedIn.refusals.isEmpty)
    }

    func testASetDeletedSignedOutIsNeverReplayed() async {
        seedShelf()
        let signedOut = makeStore(sync: nil)
        await signedOut.connect(to: account(signedIn: false))
        await signedOut.delete(set("set_2", 100, 4, at: 3_000), in: "ses_local")

        XCTAssertEqual(shelf().session("ses_local")?.sets.map(\.id), ["set_1"])

        let server = FakeTraining()
        let signedIn = makeStore(sync: server)
        await signedIn.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets["ses_local"]?.map(\.id), ["set_1"])
        XCTAssertEqual(server.appended.map(\.id), ["set_1"], "the deleted set was never sent")
        XCTAssertTrue(signedIn.refusals.isEmpty)
    }

    func testACorrectionOnTheShelfMovesWhatThisDeviceAnswers() async {
        seedShelf()
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))

        XCTAssertEqual(store.recent.first?.topSet, TopSet(weightKg: 100, reps: 4))
        XCTAssertEqual(store.recent.first?.tonnageKg, 82.5 * 5 + 100 * 4)

        await store.fix(set("set_2", 100, 4, at: 3_000), in: "ses_local",
                        by: SetFix(weightKg: 60, reps: 4, kind: .working))

        XCTAssertEqual(store.recent.first?.topSet, TopSet(weightKg: 82.5, reps: 5))
        XCTAssertEqual(store.recent.first?.tonnageKg, 82.5 * 5 + 60 * 4)
        XCTAssertEqual(shelf().session("ses_local")?.sets.map(\.weightKg), [82.5, 60])
    }

    func testACorrectionOfAnUnclaimedSessionStaysOnTheShelfAndTravelsWithTheClaim() async {
        seedShelf()
        let server = FakeTraining()
        server.online = false
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))

        await store.fix(set("set_1", 82.5, 5, at: 2_000), in: "ses_local",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))
        await store.delete(set("set_2", 100, 4, at: 3_000), in: "ses_local")

        XCTAssertTrue(server.corrected.isEmpty)
        XCTAssertTrue(server.deleted.isEmpty)
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty, "no wire write was ever enqueued")
        XCTAssertEqual(shelf(of: "u1").session("ses_local")?.sets.map(\.weightKg), [85])

        server.online = true
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets["ses_local"]?.map(\.weightKg), [85])
        XCTAssertEqual(server.appended.map(\.id), ["set_1"], "the deleted set was never sent either")
        XCTAssertTrue(store.refusals.isEmpty)
    }

    func testACorrectionOfALiveSetTheLogHasNeverSeenRewritesTheAppend() async {
        let server = FakeTraining()
        let store = await liveUnclaimedStore(server)
        XCTAssertTrue(queueOnDisk(of: "u1").sessionIsUnclaimed, "signed in, and still this device's")
        guard let live = store.session, let typo = store.sets.last else {
            return XCTFail("the device composed a session and holds both sets")
        }

        await store.fix(typo, in: live.id, by: SetFix(weightKg: 100, reps: 6, kind: .working))

        XCTAssertEqual(store.sets.map(\.reps), [5, 6], "the corrected row is on screen at once")
        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.owes), [.append, .append],
                       "two sets still to append, and no change filed over either")
        XCTAssertTrue(server.corrected.isEmpty)

        server.online = true
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets[live.id]?.map(\.reps), [5, 6],
                       "both sets reached the account, one of them corrected")
        XCTAssertTrue(server.corrected.isEmpty, "no PATCH ever named a set the log had not seen")
        XCTAssertTrue(store.refusals.isEmpty)
    }

    func testDeletingALiveSetTheLogHasNeverSeenIsTakenBackHereAndNeverSent() async {
        let server = FakeTraining()
        let store = await liveUnclaimedStore(server)
        guard let live = store.session, let mistake = store.sets.last else {
            return XCTFail("the device composed a session and holds both sets")
        }

        await store.delete(mistake, in: live.id)

        XCTAssertEqual(store.sets.map(\.reps), [5])
        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.owes), [.append])

        server.online = true
        await store.connect(to: account(signedIn: true))

        XCTAssertTrue(server.deleted.isEmpty, "no DELETE ever named a set the log had not seen")
        XCTAssertEqual(server.appended.count, 1, "and the deleted set was never appended either")
        XCTAssertEqual(server.sets[live.id]?.map(\.reps), [5])
        XCTAssertTrue(store.refusals.isEmpty)
    }

    func testTakingBackTheDeleteOfALiveSetPutsItsAppendBack() async {
        let server = FakeTraining()
        let store = await liveUnclaimedStore(server, undoWindowMs: 9_000)
        guard let live = store.session, let mistake = store.sets.last else {
            return XCTFail("the device composed a session and holds both sets")
        }

        await store.delete(mistake, in: live.id)
        XCTAssertEqual(store.restorable?.set.id, mistake.id)
        let undone = await store.restore()
        XCTAssertTrue(undone)

        XCTAssertEqual(store.sets.map(\.reps), [5, 4])

        server.online = true
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets[live.id]?.map(\.reps), [5, 4])
        XCTAssertTrue(server.deleted.isEmpty)
    }

    func testACorrectionOfALandedSetPatchesTheLogUnderTheSameId() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        let corrected = await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(server.corrected, ["set_2"])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5, 85])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.reps), [5, 5])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.setNumber), [1, 2], "a correction never renumbers")
        XCTAssertEqual(corrected.setNumber, 2)
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty)
        XCTAssertTrue(store.refusals.isEmpty)
    }

    func testACorrectionMadeOfflineIsHeldAndDrawnOverTheLogsOwnRow() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        server.online = false
        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.owes), [.fix])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5, 82.5], "nothing reached the log")

        server.online = true
        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5, 85])
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty)
    }

    func testASessionReadBackCarriesTheCorrectionThisDeviceIsStillHolding() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        server.online = false
        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        server.online = true
        guard case .success(let read) = await store.sessionDetail("ses_1") else {
            return XCTFail("the log answers for its own session")
        }
        XCTAssertEqual(read.sets.map(\.weightKg), [82.5, 85])
        XCTAssertEqual(read.sets.map(\.id), ["set_1", "set_2"])
    }

    func testASessionReadBackDropsARowThisDeviceHasDeleted() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        server.online = false
        await store.delete(set("set_1", 82.5, 5, at: 2_000, number: 1), in: "ses_1")

        server.online = true
        guard case .success(let read) = await store.sessionDetail("ses_1") else {
            return XCTFail("the log answers for its own session")
        }
        XCTAssertEqual(read.sets.map(\.id), ["set_2"])
    }

    func testACorrectionKeepsEveryPageOfTheLogTheLifterHadLoaded() async {
        let server = FakeTraining()
        for index in 0..<60 {
            let id = String(format: "ses_%03d", index)
            let startedAt = Int64(1_000 + index * 1_000)
            server.open(Session(id: id, startedAtMs: startedAt, finishedAtMs: startedAt + 500))
            server.sets[id] = [set("set_\(index)", 82.5, 5, at: startedAt + 100, number: 1)]
        }
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        await store.loadOlder()

        XCTAssertEqual(store.recent.count, 60)
        XCTAssertEqual(store.logFoot, .bottom)

        await store.fix(set("set_0", 82.5, 5, at: 1_100, number: 1), in: "ses_000",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(server.sets["ses_000"]?.map(\.weightKg), [85], "the correction landed")
        XCTAssertEqual(store.recent.count, 60, "and the page it was made on is still loaded")
        XCTAssertEqual(store.recent.last?.id, "ses_000")
        XCTAssertEqual(store.logFoot, .bottom)
    }

    func testASettledCorrectionLeavesNothingBehindInTheQueueFile() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        let reopened = queueOnDisk(of: "u1")
        XCTAssertTrue(reopened.pending.isEmpty)
        XCTAssertTrue(reopened.sets(in: "ses_1").isEmpty,
                      "a file rewritten on every tap keeps no row per correction ever made")
    }

    func testACorrectionJammedInTheQueueDoesNotCallALandedSetUnsaved() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        guard case .success = await store.start() else { return XCTFail("a new session opens") }
        await store.choose("bench-press")
        await store.logSet(weightKg: 60, reps: 12)
        XCTAssertEqual(store.saveState, .onTheLog)

        server.refuseFix = refusal(500, message: "internal error")
        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.owes), [.fix], "the change is still owed")
        XCTAssertEqual(store.saveState, .onTheLog, "and the set the lifter logged is still on the log")
        XCTAssertEqual(store.strandedCount, 0)
    }

    func testACorrectionOfASetTheLogNoLongerHasIsDroppedAndSaidAsAChange() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.sets["ses_1"] = server.sets["ses_1"]?.filter { $0.id != "set_2" }

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(store.refusals.map(\.reason), ["that set is no longer on the log"])
        XCTAssertEqual(store.refusals.map(\.id), ["change-set_2"])
        XCTAssertEqual(RefusalRows.headline(of: store.refusals[0], in: []),
                       "bench-press 85 × 5 — that change didn’t land")
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty, "a terminal write is not retried forever")
    }

    func testACorrectionTheLogCannotReadIsTerminalAndSaid() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.refuseFix = refusal(400, code: "fix-unreadable", message: "reworded on a Tuesday")

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(store.refusals.map(\.reason), ["reworded on a Tuesday"])
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty)
    }

    func testAStorageFailureLeavesTheCorrectionOwed() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.refuseFix = refusal(500, message: "internal error")

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertTrue(store.refusals.isEmpty, "a 500 is not a refusal, it is a wait")
        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.owes), [.fix])

        server.refuseFix = nil
        await store.flushPendingSets(force: true)

        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5, 85])
    }

    func testACorrectionIsNeverRemintedOntoAFreshId() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.refuseFix = refusal(409, code: "set-id-taken", message: "that id is taken")

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(server.corrected, ["set_2"], "one attempt, under the id the set already has")
        XCTAssertEqual(store.refusals.map(\.id), ["change-set_2"])
    }

    func testARefusedCorrectionAnswersWithTheRowTheLogStillHolds() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.refuseFix = refusal(400, code: "fix-unreadable", message: "the log could not read that")
        let logged = set("set_2", 82.5, 4, at: 3_000, number: 2)

        let stands = await store.fix(logged, in: "ses_1", by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(stands, logged, "the numbers the log still holds, not the ones it refused")
        XCTAssertEqual(store.refusals.map(\.id), ["change-set_2"])
    }

    func testAnAppendThatMeetsSetNotFoundIsKeptRatherThanDropped() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000))
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        server.refuse = { _ in refusal(404, code: "set-not-found", message: "no such set") }

        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertTrue(store.refusals.isEmpty, "the set was not dropped")
        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.owes), [.append], "it is still owed")
        XCTAssertEqual(store.stalled.count, 1)
    }

    func testADeleteLeavesTheScreenAtOnceAndTheLogWhenTheWindowCloses() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 5_000))
        server.sets["ses_1"] = [set("set_1", 82.5, 5, at: 2_000, number: 1),
                                set("set_2", 82.5, 4, at: 3_000, number: 2)]
        let store = makeStore(sync: server, undoWindowMs: 9_000)
        await store.connect(to: account(signedIn: true))

        await store.delete(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1")

        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1", "set_2"],
                       "inside its window the log still holds the row")
        XCTAssertEqual(queueOnDisk(of: "u1").pending.map(\.owes), [.delete])
        XCTAssertEqual(store.restorable?.set.id, "set_2")

        await store.flushPendingSets(force: true)

        XCTAssertEqual(server.deleted, ["set_2"])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1"])
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty)
    }

    func testADeleteTakenBackInsideItsWindowNeverReachesTheLog() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 5_000))
        server.sets["ses_1"] = [set("set_1", 82.5, 5, at: 2_000, number: 1)]
        let store = makeStore(sync: server, undoWindowMs: 9_000)
        await store.connect(to: account(signedIn: true))

        await store.delete(set("set_1", 82.5, 5, at: 2_000, number: 1), in: "ses_1")
        let undone = await store.restore()
        XCTAssertTrue(undone)

        await store.flushPendingSets(force: true)

        XCTAssertTrue(server.deleted.isEmpty, "nothing was ever deleted")
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1"])
        XCTAssertEqual(server.corrected, ["set_1"], "what came back re-asserts what this device holds")
        XCTAssertNil(store.restorable, "one deletion, one undo")
    }

    func testADeleteCannotBeTakenBackOnceItsWindowHasClosed() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        await store.delete(set("set_1", 82.5, 5, at: 2_000, number: 1), in: "ses_1")

        XCTAssertNil(store.restorable)
        let undone = await store.restore()
        XCTAssertFalse(undone)
        XCTAssertEqual(server.deleted, ["set_1"])
    }

    func testAShelfDeleteTakenBackPutsTheRowBackWhereItWas() async {
        seedShelf()
        let store = makeStore(sync: nil, undoWindowMs: 9_000)
        await store.connect(to: account(signedIn: false))

        await store.delete(set("set_1", 82.5, 5, at: 2_000), in: "ses_local")
        XCTAssertEqual(shelf().session("ses_local")?.sets.map(\.id), ["set_2"])

        let undone = await store.restore()
        XCTAssertTrue(undone)

        XCTAssertEqual(shelf().session("ses_local")?.sets.map(\.id), ["set_1", "set_2"])
        XCTAssertEqual(store.recent.first?.setCount, 2)
    }

    func testAnUndoTheClosedSessionRefusesIsSaidRatherThanSwallowed() async {
        seedShelf()
        let server = FakeTraining()
        server.online = false
        let store = makeStore(sync: server, undoWindowMs: 9_000)
        await store.connect(to: account(signedIn: true))

        await store.delete(set("set_2", 100, 4, at: 3_000), in: "ses_local")

        server.online = true
        await store.connect(to: account(signedIn: true))
        XCTAssertTrue(shelf(of: "u1").sessions.isEmpty, "the claim took the shelf while the window was open")
        XCTAssertEqual(server.sets["ses_local"]?.map(\.id), ["set_1"], "and the deleted row never went")
        XCTAssertNotNil(server.finishes["ses_local"], "the claim finished the session on the log")
        XCTAssertEqual(store.restorable?.set.id, "set_2", "the offer is still on screen")

        let undone = await store.restore()
        XCTAssertTrue(undone)
        await store.flushPendingSets(force: true)

        XCTAssertEqual(server.sets["ses_local"]?.map(\.id), ["set_1"], "a finished session takes no new set")
        XCTAssertEqual(store.refusals.map(\.id), ["set_2"])
        XCTAssertEqual(store.refusals.map(\.reason), ["the session closed before this set reached it"])
        XCTAssertEqual(RefusalRows.headline(of: store.refusals[0], in: []),
                       "bench-press 100 × 4 never reached the log")
        XCTAssertTrue(queueOnDisk(of: "u1").pending.isEmpty)
    }

    func testFixingAndDeletingASetLeaveTheFrozenPlanAndTheRoutineUntouched() async {
        seedShelf(routineId: "rt_local")
        let store = makeStore(sync: nil)
        await store.connect(to: account(signedIn: false))
        let plan = shelf().session("ses_local")?.session.plan
        let routine = shelf().routine("rt_local")

        await store.fix(set("set_1", 82.5, 5, at: 2_000), in: "ses_local",
                        by: SetFix(weightKg: 95, reps: 3, kind: .drop))
        await store.delete(set("set_2", 100, 4, at: 3_000), in: "ses_local")

        XCTAssertEqual(shelf().session("ses_local")?.session.plan, plan)
        XCTAssertEqual(shelf().session("ses_local")?.session.routineId, "rt_local")
        XCTAssertEqual(shelf().routine("rt_local"), routine)
        XCTAssertEqual(shelf().session("ses_local")?.sets.map(\.weightKg), [95])
        XCTAssertEqual(shelf().session("ses_local")?.sets.map(\.kind), [.drop])
    }

    func testACorrectionOwedIsNotCountedAsASetSavedOnThisDevice() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        server.online = false
        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))
        await store.delete(set("set_1", 82.5, 5, at: 2_000, number: 1), in: "ses_1")

        XCTAssertEqual(queueOnDisk(of: "u1").pending.count, 2)
        XCTAssertEqual(store.strandedCount, 0)
        XCTAssertTrue(store.stalled.isEmpty)
        XCTAssertNil(store.undoable, "the logger's Undo answers a set that was just LOGGED")
    }

    func testAQueueFileFromBeforeCorrectionsOpensWithEveryOwedRowAnAppend() throws {
        let legacy = """
        {"entries":{"set_1":{"set":{"id":"set_1","exerciseId":"bench-press","weightKg":82.5,\
        "reps":5,"kind":"working","note":"","completedAt":2000},"sessionId":"ses_1",\
        "needsPush":true,"remints":0}}}
        """
        try Data(legacy.utf8).write(to: queueURL)

        let queue = SetQueue(url: queueURL, deviceHolds: "u1")
        queue.open(under: "u1")

        XCTAssertEqual(queue.pending.map(\.set.id), ["set_1"])
        XCTAssertEqual(queue.pending.map(\.owes), [.append])
        XCTAssertEqual(queue.sets(in: "ses_1").map(\.weightKg), [82.5])
    }
}
