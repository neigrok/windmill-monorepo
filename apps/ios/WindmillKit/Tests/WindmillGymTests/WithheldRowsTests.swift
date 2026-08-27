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

    override func setUp() async throws {
        let stem = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-withheld-\(UUID().uuidString)")
        queueURL = stem.appendingPathExtension("queue.json")
        catalogURL = stem.appendingPathExtension("catalog.json")
        accountURL = stem.appendingPathExtension("account.json")
        localURL = stem.appendingPathExtension("local.json")
    }

    override func tearDown() async throws {
        for url in [queueURL, catalogURL, accountURL, localURL] {
            try? FileManager.default.removeItem(at: url!)
        }
    }

    private func makeStore(_ server: FakeTraining) -> TrainingStore {
        TrainingStore(queue: SetQueue(url: queueURL, deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: catalogURL),
                      accountCopy: AccountCopy(url: accountURL),
                      localLog: LocalLog(url: localURL, deviceHolds: nil),
                      sync: { $0.isSignedIn ? server : nil })
    }

    private func signedIn() -> Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: User(id: "u1", email: "sam@example.com", name: "Sam"))
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
}
