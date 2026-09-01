import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// What a withheld delete takes out of the lists while its window runs, and what comes back. A
// routine and a finished workout are server-only verbs: nothing is sent until the window closes, so
// the row has to leave the list here and the device's own copy has to keep holding it.
@MainActor
final class WithheldRowsTests: XCTestCase {
    private var queueURL: URL!
    private var catalogURL: URL!
    private var accountURL: URL!
    private var localURL: URL!
    private var bodyweightURL: URL!

    override func setUp() async throws {
        let stem = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-withheld-\(UUID().uuidString)")
        queueURL = stem.appendingPathExtension("queue.json")
        catalogURL = stem.appendingPathExtension("catalog.json")
        accountURL = stem.appendingPathExtension("account.json")
        localURL = stem.appendingPathExtension("local.json")
        bodyweightURL = stem.appendingPathExtension("bodyweight.json")
    }

    override func tearDown() async throws {
        for url in [queueURL, catalogURL, accountURL, localURL, bodyweightURL] {
            try? FileManager.default.removeItem(at: url!)
        }
    }

    private func makeStore(_ server: FakeTraining) -> TrainingStore {
        TrainingStore(queue: SetQueue(url: queueURL, deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: catalogURL),
                      accountCopy: AccountCopy(url: accountURL),
                      localLog: LocalLog(url: localURL, deviceHolds: nil),
                      bodyweightStore: BodyweightStore(url: bodyweightURL),
                      sync: { $0.isSignedIn ? server : nil })
    }

    private func signedIn() -> Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: User(id: "u1", email: "sam@example.com", name: "Sam"))
    }

    // No user, so `makeStore`'s seam hands the room no log at all: every write is the device's own.
    private func signedOut() -> Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: nil)
    }

    private func deviceCopy() -> AccountCopy {
        let held = AccountCopy(url: accountURL)
        held.open(under: "u1")
        return held
    }

    private func aRoutine(in store: TrainingStore, named name: String) async -> Routine {
        var draft = RoutineDraft(name: name, position: store.routines.count)
        draft.add("bench-press")
        guard case .success(let made) = await store.create(draft) else {
            XCTFail("the routine was not created")
            return Routine(id: "rt_none", name: name, position: 0, entries: [])
        }
        return made
    }

    func testAWithheldRoutineLeavesTheListAndNothingIsOnTheWire() async {
        let server = FakeTraining()
        let store = makeStore(server)
        await store.connect(to: signedIn())
        let made = await aRoutine(in: store, named: "Push A")

        store.withhold(routine: made)

        XCTAssertTrue(store.routines.isEmpty, "the row is gone from the list")
        XCTAssertFalse(server.calls.contains("deleteRoutine"), "and nothing was sent")
    }

    // The device's own copy is what a launch with no answer from the log draws. A delete that has
    // not happened may not take a routine out of it.
    func testAWithheldRoutineStaysInTheDevicesOwnCopyUntilTheDeleteLands() async {
        let server = FakeTraining()
        let store = makeStore(server)
        await store.connect(to: signedIn())
        let made = await aRoutine(in: store, named: "Push A")
        XCTAssertEqual(deviceCopy().routines.map(\.id), [made.id])

        store.withhold(routine: made)
        // A read while the window runs would otherwise write the shortened list straight to the cache.
        await store.connect(to: signedIn())

        XCTAssertTrue(store.routines.isEmpty, "still not drawn")
        XCTAssertEqual(deviceCopy().routines.map(\.id), [made.id], "and still on this device")

        let landed = await store.settleDelete(routine: made.id)
        XCTAssertNil(landed)
        XCTAssertTrue(server.calls.contains("deleteRoutine"))
        XCTAssertTrue(deviceCopy().routines.isEmpty, "the cache lets go when the delete lands")
    }

    func testTakingBackARoutineDeletePutsTheRowStraightBack() async {
        let server = FakeTraining()
        let store = makeStore(server)
        await store.connect(to: signedIn())
        let made = await aRoutine(in: store, named: "Push A")

        store.withhold(routine: made)
        store.restore(routine: made)

        XCTAssertEqual(store.routines.map(\.id), [made.id])
        XCTAssertFalse(server.calls.contains("deleteRoutine"), "nothing was ever sent to take back")
    }

    func testARoutineDeleteTheLogRefusedIsNotHiddenTwice() async {
        let server = FakeTraining()
        let store = makeStore(server)
        await store.connect(to: signedIn())
        let made = await aRoutine(in: store, named: "Push A")

        store.withhold(routine: made)
        server.online = false
        let refused = await store.settleDelete(routine: made.id)
        XCTAssertEqual(refused, .noAnswer)

        // The room answers a refused settle by putting the row back; the store has already stopped
        // hiding it, so nothing hides it twice.
        store.restore(routine: made)
        XCTAssertEqual(store.routines.map(\.id), [made.id])
    }

    func testAWithheldSessionLeavesTheLogAndTheServerStillHoldsIt() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 5_000))
        let store = makeStore(server)
        await store.connect(to: signedIn())
        XCTAssertEqual(store.recent.map(\.id), ["ses_1"])

        store.withhold(session: "ses_1")

        XCTAssertTrue(store.recent.isEmpty, "the row is gone from the log")
        XCTAssertFalse(server.calls.contains("discard"), "and nothing was sent")

        store.restore(session: "ses_1")
        XCTAssertEqual(store.recent.map(\.id), ["ses_1"], "and it comes straight back")

        store.withhold(session: "ses_1")
        let went = await store.settleDelete(session: "ses_1")
        XCTAssertTrue(went)
        XCTAssertTrue(server.calls.contains("discard"))
        XCTAssertTrue(store.recent.isEmpty)
    }

    // MARK: - what the account holds, beside what the window leaves drawn

    // The store answers twice because the screens need both answers: `routines` is what the list
    // draws and `allRoutines` is the program the account holds. `RoutinesScreen`'s empty stance
    // carries `Build a routine` — a drawn act — and may not stand over a program that still holds a
    // routine. And the settle has to leave the READ as well, or the stance never becomes true:
    // deleting the only routine would draw neither the row nor the words.
    func testAWithheldRoutineIsStillTheProgramTheAccountHolds() async {
        let server = FakeTraining()
        let store = makeStore(server)
        await store.connect(to: signedIn())
        let made = await aRoutine(in: store, named: "Push A")

        store.withhold(routine: made)

        XCTAssertTrue(store.routines.isEmpty, "the row is out of the drawn list")
        XCTAssertEqual(store.allRoutines.map(\.id), [made.id],
                       "and the program still holds it, so no empty stance and no Build a routine")

        let landed = await store.settleDelete(routine: made.id)

        XCTAssertNil(landed)
        XCTAssertTrue(store.allRoutines.isEmpty,
                      "the settled delete leaves the read too, so the stance becomes true")
    }

    // Same two answers over the log. `LogScreen` reads `allSessions` for its empty stance and for the
    // day the log began, and `recent` for the week sections and the count that captions them.
    func testAWithheldSessionIsStillTheLogTheAccountHolds() async {
        let server = FakeTraining()
        server.open(Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 5_000))
        let store = makeStore(server)
        await store.connect(to: signedIn())
        XCTAssertEqual(store.allSessions.map(\.id), ["ses_1"])

        store.withhold(session: "ses_1")

        XCTAssertTrue(store.recent.isEmpty, "the row is out of the drawn log")
        XCTAssertEqual(store.allSessions.map(\.id), ["ses_1"],
                       "and the account still holds the session, so nothing invites a first one")

        store.restore(session: "ses_1")
        XCTAssertEqual(store.allSessions.map(\.id), ["ses_1"], "an undo changes neither answer")

        store.withhold(session: "ses_1")
        let sent = await store.settleDelete(session: "ses_1")
        XCTAssertTrue(sent)
        XCTAssertTrue(store.allSessions.isEmpty, "the settled delete leaves the read too")
    }

    // The same two answers on the seat gym opens on. Nothing is signed in, so the workout is the
    // device's own and `discard` never asks the log — the local branch is the only thing that takes
    // the row out of the READ. Without it the last session is drawn nowhere and held for ever: no
    // rows, and no *No sessions yet* either, which is a page with nothing on it.
    func testDeletingTheOnlySessionOnAnUnsignedSeatLeavesTheReadAndNotOnlyTheDrawnLog() async {
        let store = makeStore(FakeTraining())
        await store.connect(to: signedOut())
        guard case .success(let opened) = await store.start() else {
            return XCTFail("the session never opened on this device")
        }
        await store.choose("bench-press")
        await store.logSet(weightKg: 82.5, reps: 5)
        guard case .closed = await store.finish() else {
            return XCTFail("the session never closed")
        }
        XCTAssertEqual(store.allSessions.map(\.id), [opened.id])

        store.withhold(session: opened.id)

        XCTAssertTrue(store.recent.isEmpty, "the row is out of the drawn log")
        XCTAssertEqual(store.allSessions.map(\.id), [opened.id],
                       "and the device still holds the session, so nothing invites a first one")

        let went = await store.settleDelete(session: opened.id)

        XCTAssertTrue(went)
        XCTAssertTrue(store.allSessions.isEmpty, "the settled delete leaves the read too")
    }

    // The series' turn: `BodyweightScreen` charts `allWeighIns` for the sentence that stands in place
    // of the chart and `bodyweight` for the dots.
    func testAWithheldWeighInIsStillTheSeriesTheAccountHolds() async {
        let server = FakeTraining()
        let store = makeStore(server)
        await store.connect(to: signedIn())
        let today = Bodyweight.dateLocal(Date())
        let written = await store.weighIn(82.5, on: today)
        XCTAssertNil(written)
        XCTAssertEqual(store.allWeighIns.map(\.dateLocal), [today])

        store.withhold(weighInOn: today)

        XCTAssertTrue(store.bodyweight.isEmpty, "the dot is off the chart")
        XCTAssertEqual(store.allWeighIns.map(\.dateLocal), [today],
                       "and the series still holds the day, so no *no weigh-in yet* over it")

        let deleted = await store.settleDelete(weighInOn: today)
        XCTAssertNil(deleted)
        XCTAssertTrue(store.allWeighIns.isEmpty, "the settled delete leaves the read too")
    }

    // The conversations are read back from the server and never crossed out locally, so the screen is
    // what answers twice. Both halves are pinned here: the window takes the row and leaves the count,
    // and the settle takes the row out of the count as well.
    func testASettledConversationDeleteLeavesTheReadAndNotOnlyTheDrawnRows() async {
        let window = WithheldWindow(windowMs: 60)
        let served = [thread("thr_1"), thread("thr_2")]
        XCTAssertEqual(ThreadsScreen.standing(served, outside: window).count, 2)

        await window.hold(Withheld(.thread, subject: "thr_2", line: WithheldWords.thread))

        XCTAssertEqual(ThreadsScreen.standing(served, outside: window).map(\.id), ["thr_1", "thr_2"],
                       "inside its window the conversation is still on the log, so the count says two")
        XCTAssertTrue(window.hides(.thread, "thr_2"), "and the row it holds is out of the drawn list")

        await waitForWindowsToClose(window)

        XCTAssertEqual(ThreadsScreen.standing(served, outside: window).map(\.id), ["thr_1"],
                       "the delete landed, so the count follows it without a second read")
    }

    // The one delete that could leave a screen with neither its rows nor its words: the only row goes,
    // the window closes, and a `standing` list read off the server alone would hold it forever — so the
    // empty stance would never be drawn.
    func testDeletingTheOnlyConversationEndsInTheEmptyStanceAndNotABlankPage() async {
        let window = WithheldWindow(windowMs: 60)
        let served = [thread("thr_1")]

        await window.hold(Withheld(.thread, subject: "thr_1", line: WithheldWords.thread))
        XCTAssertFalse(ThreadsScreen.standing(served, outside: window).isEmpty,
                       "nine seconds of no rows and no stance, with Undo on screen")

        await waitForWindowsToClose(window)

        XCTAssertTrue(ThreadsScreen.standing(served, outside: window).isEmpty,
                      "and then the words, rather than a page with nothing on it")
    }

    // Where hosting cannot reach, the read itself is pinned: every one of these screens draws its
    // state off the store's own list, and its rows — with the count that captions them — off the
    // window (`13-gestures.md`).
    func testEveryGymScreenReadsTheStoreForItsStateAndTheWindowForItsRows() throws {
        let routines = try source("RoutinesScreen.swift")
        XCTAssertTrue(routines.contains("if store.allRoutines.isEmpty {"),
                      "the empty stance and its `Build a routine` read the standing program")
        XCTAssertTrue(routines.contains("if !store.allRoutines.isEmpty {"), "the reach band too")
        XCTAssertTrue(routines.contains("ForEach(store.routines) { routine in"),
                      "and only the rows read the window")
        XCTAssertTrue(routines.contains("Readout.routineCount(store.routines.count)"),
                      "the count captions those rows, so it follows them")

        let log = try source("LogScreen.swift")
        XCTAssertTrue(log.contains("if store.allSessions.isEmpty, store.logFoot == .bottom {"),
                      "the empty stance is read off the log the account holds")
        XCTAssertTrue(log.contains("if let first = store.allSessions.last {"),
                      "and so is the day the log began")
        XCTAssertTrue(log.contains("let weeks = LogWeeks.fold(store.recent,"))
        XCTAssertTrue(log.contains("LogWeeks.loaded(sessions: store.recent.count, weeks: weeks)"),
                      "the head's count captions the week sections, so it follows them")

        let bodyweight = try source("BodyweightScreen.swift")
        XCTAssertTrue(bodyweight.contains("Bodyweight.chart(store.allWeighIns, window: window, today: today)"),
                      "the sentence in place of the chart is charted off the standing series")
        XCTAssertTrue(bodyweight.contains("if let empty = Bodyweight.emptyWindow(standing) {"))
        XCTAssertTrue(bodyweight.contains("let chart = Bodyweight.chart(store.bodyweight,"))

        let threads = try source("ThreadsScreen.swift")
        XCTAssertTrue(threads.contains("let standing = Self.standing(served, outside: withheld)"),
                      "the conversations screen reads one list twice")
        XCTAssertTrue(threads.contains("if standing.isEmpty {"), "the stance off the account's answer")
        XCTAssertTrue(threads.contains("Section { meta(rows.count) }"), "the count off the drawn rows")
        XCTAssertTrue(threads.contains("months(of: rows)"))

        // The room's own claims about the account: *your first session*, where a new routine sits, and
        // whether saving a draft is a replace or a create.
        let room = try source("GymRoom.swift")
        XCTAssertTrue(room.contains("isFirst: store.allSessions.count <= 1)"),
                      "*your first session* is read off the log the account holds")
        XCTAssertTrue(room.contains("RoutineDraft(position: store.allRoutines.count)"))
        XCTAssertTrue(room.contains("let written = store.allRoutines.contains { $0.id == draft.id }"),
                      "a write branch may not read a list a window has thinned")
    }

    private func thread(_ id: String) -> AskThread {
        AskThread(id: id, title: "q", createdAtMs: 1_000, askedAtMs: 1_000,
                  outcome: ThreadOutcome(kind: .readOnly))
    }

    private func waitForWindowsToClose(_ open: WithheldWindow, timeout: TimeInterval = 4) async {
        let deadline = Date().addingTimeInterval(timeout)
        while open.isOpen, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(open.isOpen, "the window closed and the delete went")
    }

    private func source(_ name: String) throws -> String {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/\(name)")
        return try String(contentsOf: file, encoding: .utf8)
    }
}
