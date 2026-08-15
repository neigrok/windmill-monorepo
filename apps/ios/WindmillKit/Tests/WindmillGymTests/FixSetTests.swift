import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// FIX A SET (§G18), and everything about it that could lose training. The whole client contract this
// wave lands in — the offline queue, the undo window, the anonymous claim — was built on sets only
// ever being APPENDED, and this is the first mutation to reach it.
//
// The three cases a client has to tell apart, and each of them is here: a set the log has never seen
// (it lives on this device's shelf and is corrected THERE, so the claim replays what the lifter can
// see), a set the log holds (the write rides the queue with the same lanes, retries and verdicts as
// every other), and a set the log refuses (told apart by CODE, never by a sentence).
//
// The one that silently duplicates data if it is wrong has its own name below: a correction made
// signed-out must replay CORRECTED — never the original, and never both.

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

    // The window is off except where it is the subject: what most of these tests are about is where
    // a correction GOES, and nine seconds in front of that would only be a delay before the subject.
    private func makeStore(sync: FakeTraining?, undoWindowMs: Int64 = 0,
                           retryAfter: Duration = .seconds(4)) -> TrainingStore {
        TrainingStore(
            queue: SetQueue(url: queueURL),
            deviceCatalog: DeviceCatalog(url: catalogURL),
            accountCopy: AccountCopy(url: catalogURL.appendingPathExtension("account")),
            localLog: LocalLog(url: localURL),
            now: { self.clockMs += 1; return self.clockMs },
            mintSession: Ids.session,
            mintSet: Ids.set,
            undoWindowMs: undoWindowMs,
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

    // THE ROOM'S DEFAULT STATE since it opened anonymous-first: a session composed on this DEVICE
    // with sets logged into it, an account signed in, and a claim that has not managed to file any
    // of it. The log has never been told a single one of these ids.
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

    // A finished session the log already holds, and the store standing in front of it at rest.
    private func loggedStore(_ server: FakeTraining) async -> TrainingStore {
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 5_000))
        server.sets["ses_1"] = [set("set_1", 82.5, 5, at: 2_000, number: 1),
                                set("set_2", 82.5, 4, at: 3_000, number: 2)]
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        return store
    }

    // A session finished on this device and never claimed — the anonymous room's own history.
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

    // ── the correction rule itself ─────────────────────────────────────────────────────────────

    // The three fields a thumb can move, and the five it cannot. Everything that makes this the SAME
    // set is copied across: a body that moved the id, the movement, the number or the instant would
    // be logging a different set under a repair's name.
    func testACorrectionMovesThreeFieldsAndCopiesEverythingElse() {
        let logged = TrainingSet(id: "set_1", exerciseId: "bench-press", setNumber: 2, weightKg: 100,
                                 reps: 4, kind: .working, rpe: 8.5, note: "felt heavy",
                                 completedAtMs: 3_000)

        let corrected = logged.corrected(by: SetFix(weightKg: 90, reps: 5, kind: .drop))

        XCTAssertEqual(corrected, TrainingSet(id: "set_1", exerciseId: "bench-press", setNumber: 2,
                                              weightKg: 90, reps: 5, kind: .drop, rpe: 8.5,
                                              note: "felt heavy", completedAtMs: 3_000))
    }

    // ── the set the log has never seen ─────────────────────────────────────────────────────────

    // THE ONE THAT DUPLICATES DATA IF IT IS WRONG. A lifter logs signed out, spots a typo, fixes it,
    // and only then signs in: the account has to receive the number they can SEE, once.
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
        XCTAssertTrue(shelf().sessions.isEmpty, "the shelf lets go once the log has it")
        XCTAssertTrue(signedIn.refusals.isEmpty)
    }

    // A set deleted before the claim is a set the account never hears of. Replaying it and then
    // clearing the shelf would resurrect it on the log with no copy left to compare against.
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

    // Corrected on the shelf means corrected for every read the shelf answers: the log page's row is
    // this device's own arithmetic, so its tonnage and its top set move with the set.
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

    // SIGNED IN AND STILL ON THE SHELF, which is the case that decides the rule: the account exists
    // but the claim has not managed to file this session yet, so the log has never heard of that
    // session or that set. A PATCH or a DELETE here would name ids the server has never seen. The
    // repair stays on the shelf, and the claim carries it when the road opens.
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
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty, "no wire write was ever enqueued")
        XCTAssertEqual(shelf().session("ses_local")?.sets.map(\.weightKg), [85])

        server.online = true
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets["ses_local"]?.map(\.weightKg), [85])
        XCTAssertEqual(server.appended.map(\.id), ["set_1"], "the deleted set was never sent either")
        XCTAssertTrue(store.refusals.isEmpty)
    }

    // THE THIRD HOME, and the one a shelf test cannot reach: the LIVE session, composed on this
    // device and not claimed yet, whose sets live in the queue and nowhere else. A correction here
    // rewrites the queued APPEND. Filing a change over it would do two wrong things at once — name a
    // set the server has never had, and replace the one write that was going to put that set on the
    // log at all, so the set dies on its way there.
    func testACorrectionOfALiveSetTheLogHasNeverSeenRewritesTheAppend() async {
        let server = FakeTraining()
        let store = await liveUnclaimedStore(server)
        XCTAssertTrue(SetQueue(url: queueURL).sessionIsUnclaimed, "signed in, and still this device's")
        guard let live = store.session, let typo = store.sets.last else {
            return XCTFail("the device composed a session and holds both sets")
        }

        await store.fix(typo, in: live.id, by: SetFix(weightKg: 100, reps: 6, kind: .working))

        XCTAssertEqual(store.sets.map(\.reps), [5, 6], "the corrected row is on screen at once")
        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.owes), [.append, .append],
                       "two sets still to append, and no change filed over either")
        XCTAssertTrue(server.corrected.isEmpty)

        server.online = true
        await store.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets[live.id]?.map(\.reps), [5, 6],
                       "both sets reached the account, one of them corrected")
        XCTAssertTrue(server.corrected.isEmpty, "no PATCH ever named a set the log had not seen")
        XCTAssertTrue(store.refusals.isEmpty)
    }

    // The same home, the other write: the queued row simply goes. A DELETE would name nothing on the
    // log — benign today only because that route is unconditionally idempotent, which is not a reason
    // to send it.
    func testDeletingALiveSetTheLogHasNeverSeenIsTakenBackHereAndNeverSent() async {
        let server = FakeTraining()
        let store = await liveUnclaimedStore(server)
        guard let live = store.session, let mistake = store.sets.last else {
            return XCTFail("the device composed a session and holds both sets")
        }

        await store.delete(mistake, in: live.id)

        XCTAssertEqual(store.sets.map(\.reps), [5])
        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.owes), [.append])

        server.online = true
        await store.connect(to: account(signedIn: true))

        XCTAssertTrue(server.deleted.isEmpty, "no DELETE ever named a set the log had not seen")
        XCTAssertEqual(server.appended.count, 1, "and the deleted set was never appended either")
        XCTAssertEqual(server.sets[live.id]?.map(\.reps), [5])
        XCTAssertTrue(store.refusals.isEmpty)
    }

    // And the Undo answers out of that same home — the append goes back, so the account receives the
    // set once the claim opens the road.
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

    // ── the set the log holds ──────────────────────────────────────────────────────────────────

    // The ordinary correction: it lands on the log under the same id, the set NUMBER does not move,
    // and nothing is left owed.
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
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty)
        XCTAssertTrue(store.refusals.isEmpty)
    }

    // Offline, the correction is the lifter's anyway: it is on this device, it is what the session
    // reads back as, and it survives a relaunch to be sent later. A screen that showed the log's
    // stale row after a correction would be handing back the number they just moved.
    func testACorrectionMadeOfflineIsHeldAndDrawnOverTheLogsOwnRow() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        server.online = false
        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.owes), [.fix])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5, 82.5], "nothing reached the log")

        server.online = true
        let relaunched = makeStore(sync: server)
        await relaunched.connect(to: account(signedIn: true))

        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5, 85])
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty)
    }

    // The same, read back before the queue drains: the merge is what makes the room local-first
    // about a correction rather than only about a set.
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

    // A deleted row leaves the screen before it leaves the log, and a session read back in between
    // must not hand it back — the log is still honestly answering with the row it has.
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

    // A correction re-reads the log, because the row's arithmetic is the server's — and the re-read
    // may never come back shallower than the lifter had already scrolled. `served` is the cursor the
    // next page is asked from, so a one-page answer would take every older page with it, including
    // the session the correction was just made in.
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

        // The oldest session there is — page two of the log, and nowhere near the first page.
        await store.fix(set("set_0", 82.5, 5, at: 1_100, number: 1), in: "ses_000",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(server.sets["ses_000"]?.map(\.weightKg), [85], "the correction landed")
        XCTAssertEqual(store.recent.count, 60, "and the page it was made on is still loaded")
        XCTAssertEqual(store.recent.last?.id, "ses_000")
        XCTAssertEqual(store.logFoot, .bottom)
    }

    // The queue file is the LIVE session's, plus whatever is still owed to the log. A settled
    // correction of a session that is already history is neither — and nothing would ever collect it:
    // `close` and `forget` run for the live session alone.
    func testASettledCorrectionLeavesNothingBehindInTheQueueFile() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        let reopened = SetQueue(url: queueURL)
        XCTAssertTrue(reopened.pending.isEmpty)
        XCTAssertTrue(reopened.sets(in: "ses_1").isEmpty,
                      "a file rewritten on every tap keeps no row per correction ever made")
    }

    // The note under the logger speaks for the SETS this device is holding, and a correction is not
    // one of them. A fix of last week's session jammed behind a 500 must not put "offline · saved
    // here" over a set that landed a second ago — that is the one thing the note exists to state.
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

        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.owes), [.fix], "the change is still owed")
        XCTAssertEqual(store.saveState, .onTheLog, "and the set the lifter logged is still on the log")
        XCTAssertEqual(store.strandedCount, 0)
    }

    // ── the set the log refuses ────────────────────────────────────────────────────────────────

    // 404 `set-not-found` is the word this wave had to add: the row a correction NAMES is not there,
    // and no amount of waiting puts it back. Nothing is lost but the change — so it is dropped, and
    // said in the sentence a lost CHANGE gets rather than the one a lost set gets.
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
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty, "a terminal write is not retried forever")
    }

    // A body the log cannot read never becomes readable, so it is terminal too — and it is SAID, for
    // the reason every terminal write in gym is: a change dropped quietly counts as intended.
    func testACorrectionTheLogCannotReadIsTerminalAndSaid() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.refuseFix = refusal(400, code: "fix-unreadable", message: "reworded on a Tuesday")

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(store.refusals.map(\.reason), ["reworded on a Tuesday"])
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty)
    }

    // A 500 is the server's and heals on its own. The correction stays owed — dropping it would lose
    // a change over a deadlock — and the next walk sends it.
    func testAStorageFailureLeavesTheCorrectionOwed() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.refuseFix = refusal(500, message: "internal error")

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertTrue(store.refusals.isEmpty, "a 500 is not a refusal, it is a wait")
        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.owes), [.fix])

        server.refuseFix = nil
        await store.flushPendingSets(force: true)

        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5, 85])
    }

    // A spent id is an APPEND's repair and only an append's. Reminting a correction would send the
    // PATCH at a set nobody has ever logged — and the log would answer that it does not exist.
    func testACorrectionIsNeverRemintedOntoAFreshId() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.refuseFix = refusal(409, code: "set-id-taken", message: "that id is taken")

        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(server.corrected, ["set_2"], "one attempt, under the id the set already has")
        XCTAssertEqual(store.refusals.map(\.id), ["change-set_2"])
    }

    // WHAT THE SHEET IS ANSWERED WITH IS WHAT STANDS. A change the log refused outright is not a
    // change — the row is still there under the numbers it had — and the screen is told so, rather
    // than drawing a correction that never happened underneath a banner saying it never happened.
    func testARefusedCorrectionAnswersWithTheRowTheLogStillHolds() async {
        let server = FakeTraining()
        let store = await loggedStore(server)
        server.refuseFix = refusal(400, code: "fix-unreadable", message: "the log could not read that")
        let logged = set("set_2", 82.5, 4, at: 3_000, number: 2)

        let stands = await store.fix(logged, in: "ses_1", by: SetFix(weightKg: 85, reps: 5, kind: .working))

        XCTAssertEqual(stands, logged, "the numbers the log still holds, not the ones it refused")
        XCTAssertEqual(store.refusals.map(\.id), ["change-set_2"])
    }

    // `set-not-found` is a CHANGE's word: it names a row the write expects to already be there.
    // Today's log sends it from one handler and an append cannot honestly meet it — but nothing on
    // either side of the wire pins that, and a set is never lost to a code it was not sent.
    func testAnAppendThatMeetsSetNotFoundIsKeptRatherThanDropped() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000))
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        server.refuse = { _ in refusal(404, code: "set-not-found", message: "no such set") }

        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertTrue(store.refusals.isEmpty, "the set was not dropped")
        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.owes), [.append], "it is still owed")
        XCTAssertEqual(store.stalled.count, 1)
    }

    // ── the delete, and the nine seconds ───────────────────────────────────────────────────────

    // The row leaves the screen on the tap and the log a window later. Nothing about this promises
    // recovery past the window — the sheet says only what is true.
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
        XCTAssertEqual(SetQueue(url: queueURL).pending.map(\.owes), [.delete])
        XCTAssertEqual(store.restorable?.set.id, "set_2")

        await store.flushPendingSets(force: true)

        XCTAssertEqual(server.deleted, ["set_2"])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1"])
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty)
    }

    // Undo inside the window: the DELETE never goes at all, and what comes back is owed as a
    // correction — this device may have been holding numbers the log does not have.
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

    // Past the window there is nothing to take back, and the store says so rather than answering a
    // tap that would have to apologise.
    func testADeleteCannotBeTakenBackOnceItsWindowHasClosed() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        await store.delete(set("set_1", 82.5, 5, at: 2_000, number: 1), in: "ses_1")

        XCTAssertNil(store.restorable)
        let undone = await store.restore()
        XCTAssertFalse(undone)
        XCTAssertEqual(server.deleted, ["set_1"])
    }

    // A shelf deletion is taken back on the shelf, in the order it was performed, and the undo is
    // one door over both homes.
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

    // THE UNDO MUST SURVIVE THE CLAIM — AND BE HONEST ABOUT WHAT THE LOG WILL TAKE. A shelf deletion
    // waits out its window on this device, and the claim rides the queue's own cadence — so an
    // ordinary return to signal can empty the shelf while the offer is still on screen. The row goes
    // back the one way a set ever reaches the log, an APPEND under its own id; and the claim has by
    // then FINISHED that session on the log, which refuses every new set with 409 session-finished
    // (the fake models the rule). So the loss is SAID, with the numbers on it. What may never happen
    // is what did before this was pinned: the record cleared, the row put back nowhere, nothing said.
    func testAnUndoTheClosedSessionRefusesIsSaidRatherThanSwallowed() async {
        seedShelf()
        let server = FakeTraining()
        server.online = false
        let store = makeStore(sync: server, undoWindowMs: 9_000)
        await store.connect(to: account(signedIn: true))

        await store.delete(set("set_2", 100, 4, at: 3_000), in: "ses_local")

        server.online = true
        await store.connect(to: account(signedIn: true))
        XCTAssertTrue(shelf().sessions.isEmpty, "the claim took the shelf while the window was open")
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
        XCTAssertTrue(SetQueue(url: queueURL).pending.isEmpty)
    }

    // ── what must not move ─────────────────────────────────────────────────────────────────────

    // THE CAPTION OF THE WHOLE SCREEN. The session's frozen plan snapshot and the routine it was run
    // against are what "Push A keeps its own numbers" is a promise about, and a correction may not
    // reach either — on the shelf or over the wire.
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

    // A correction and a deletion are not sets saved on this device. The strip and the row marks
    // both count what is STRANDED — a set nowhere but here — and a row the log holds under numbers
    // this device is trying to move is a different fact with a different word.
    func testACorrectionOwedIsNotCountedAsASetSavedOnThisDevice() async {
        let server = FakeTraining()
        let store = await loggedStore(server)

        server.online = false
        await store.fix(set("set_2", 82.5, 4, at: 3_000, number: 2), in: "ses_1",
                        by: SetFix(weightKg: 85, reps: 5, kind: .working))
        await store.delete(set("set_1", 82.5, 5, at: 2_000, number: 1), in: "ses_1")

        XCTAssertEqual(SetQueue(url: queueURL).pending.count, 2)
        XCTAssertEqual(store.strandedCount, 0)
        XCTAssertTrue(store.stalled.isEmpty)
        XCTAssertNil(store.undoable, "the logger's Undo answers a set that was just LOGGED")
    }

    // A queue file written before §G18 has no verb on its rows, and every owed row in one is an
    // append. Reading a missing key as anything else would strand a real set on the next launch.
    func testAQueueFileFromBeforeCorrectionsOpensWithEveryOwedRowAnAppend() throws {
        let legacy = """
        {"entries":{"set_1":{"set":{"id":"set_1","exerciseId":"bench-press","weightKg":82.5,\
        "reps":5,"kind":"working","note":"","completedAt":2000},"sessionId":"ses_1",\
        "needsPush":true,"remints":0}}}
        """
        try Data(legacy.utf8).write(to: queueURL)

        let queue = SetQueue(url: queueURL)

        XCTAssertEqual(queue.pending.map(\.set.id), ["set_1"])
        XCTAssertEqual(queue.pending.map(\.owes), [.append])
        XCTAssertEqual(queue.sets(in: "ses_1").map(\.weightKg), [82.5])
    }
}
