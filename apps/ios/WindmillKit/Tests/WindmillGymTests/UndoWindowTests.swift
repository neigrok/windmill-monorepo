import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// THE UNDO WINDOW — the one promise in gym that the DEVICE keeps rather than asks the log for. While
// a set is still owed this device is the only place it exists, so a mis-tapped one is taken back
// here and nobody else has to be told. A set the log already holds is §G18's business, and it has a
// window of its own on the same clock.
//
// Everything below is a way that window can go wrong: a set that never leaves because the hold never
// ends, a set taken back after the log already has it, and a session closing over a set still inside
// its nine seconds — which the log would refuse forever.

@MainActor
final class UndoWindowTests: XCTestCase {
    private var queueURL: URL!
    private var catalogURL: URL!
    private var clockMs: Int64 = 1_000

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-undo-\(UUID().uuidString).json")
        catalogURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-undo-catalog-\(UUID().uuidString).json")
        clockMs = 1_000
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
        try? FileManager.default.removeItem(at: catalogURL)
    }

    private func liveStore(_ server: FakeTraining) async -> TrainingStore {
        server.open(Session(id: "ses_1", startedAtMs: 1_000))
        let store = TrainingStore(queue: SetQueue(url: queueURL),
                                  deviceCatalog: DeviceCatalog(url: catalogURL),
                                  localLog: LocalLog(url: catalogURL.appendingPathExtension("local")),
                                  now: { self.clockMs },
                                  mintSession: { "ses_1" },
                                  mintSet: { "set_\(self.clockMs)" },
                                  sync: { _ in server })
        await store.connect(to: Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: User(id: "u1", email: "sam@example.com", name: "Sam")
        ))
        await store.choose("bench-press")
        return store
    }

    // The set is on the device the instant it is tapped — the window changes when it is SENT, never
    // whether it was kept.
    func testASetJustLoggedIsOnTheDeviceAndNotYetOnTheLog() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(store.sets.map(\.weightKg), [82.5])
        XCTAssertEqual(server.appended.count, 0, "nothing goes out while it can still be taken back")
        XCTAssertEqual(store.undoable?.weightKg, 82.5)
        XCTAssertEqual(SetQueue(url: queueURL).pending.count, 1, "and it is on disk, not in memory")
    }

    // "Offline" would be the wrong word for a send nobody has attempted. Silence is the honest state
    // while the window is open.
    func testASetInsideItsWindowIsNotCalledOffline() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(store.saveState, .idle)
        XCTAssertNil(store.saveState.line)
    }

    // The gesture the window exists for: the set never reaches the log at all, so nothing already
    // written is destroyed by one tap.
    func testUndoTakesTheSetBackAndTheLogNeverHearsOfIt() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        XCTAssertTrue(store.undoLast())

        XCTAssertEqual(store.sets, [])
        XCTAssertEqual(server.appended.count, 0)
        XCTAssertEqual(SetQueue(url: queueURL).pending.count, 0, "and the disk agrees")
        XCTAssertNil(store.undoable)
    }

    // Undo answers the tap the lifter just made, not the oldest one still waiting.
    func testUndoTakesBackTheNewestSetAndLeavesTheRest() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        clockMs += 1_000
        await store.logSet(weightKg: 85, reps: 3)
        XCTAssertTrue(store.undoLast())

        XCTAssertEqual(store.sets.map(\.weightKg), [82.5])
    }

    // Once the window closes the set goes out on its own — a hold that never ended would be a set
    // that never landed.
    func testWhenTheWindowClosesTheSetGoesOutByItself() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()

        XCTAssertEqual(server.appended.map(\.weightKg), [82.5])
        XCTAssertEqual(store.saveState, .onTheLog)
        XCTAssertNil(store.undoable, "and there is nothing left to take back")
    }

    // Past the window the log holds the row, and moving it is §G18's business — it confirms, and it
    // offers a window of its own. The answer here is no rather than a screen that quietly disagrees
    // with the account.
    func testUndoAfterTheSetHasLandedRefusesRatherThanPretending() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()

        XCTAssertFalse(store.undoLast())
        XCTAssertEqual(store.sets.map(\.weightKg), [82.5], "the set the log has stays on screen")
    }

    // Finishing is this device's statement that everything the session holds is already delivered. A
    // walk that skipped a held set would leave it behind, and the close would refuse it FOREVER.
    func testFinishSendsASetStillInsideItsWindowBeforeItCloses() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 100, reps: 5)
        guard case .closed = await store.finish() else {
            return XCTFail("the session closed, because nothing was left to lose")
        }

        XCTAssertEqual(server.appended.map(\.weightKg), [100])
        let order = server.calls.filter { $0 == "append" || $0 == "finish" }
        XCTAssertEqual(order, ["append", "finish"], "the set goes out before the close, never after")
    }

    // Leaving the room ends the window whether or not its nine seconds are up: the affordance goes
    // with the subtree, and the store that would have sent it is about to be deallocated.
    func testLeavingTheRoomEndsTheWindowAndSendsWhatIsHeld() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        await store.flushPendingSets()
        XCTAssertEqual(server.appended.count, 0, "backgrounding the phone keeps the window")

        await store.flushPendingSets(force: true)
        XCTAssertEqual(server.appended.map(\.weightKg), [82.5])
    }

    // A relaunch is the other end of the same rule: the row is gone from the screen, so the window is
    // protecting a gesture nobody can still make — and the boot read would settle the session over it.
    func testAReadOfTheLogSendsWhatIsHeldFirst() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        await store.logSet(weightKg: 82.5, reps: 5)

        let relaunched = TrainingStore(queue: SetQueue(url: queueURL),
                                       deviceCatalog: DeviceCatalog(url: catalogURL),
                                       localLog: LocalLog(url: catalogURL.appendingPathExtension("local")),
                                       now: { self.clockMs },
                                       mintSession: { "ses_1" },
                                       mintSet: { "set_x" },
                                       sync: { _ in server })
        await relaunched.connect(to: Account(
            api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
            user: User(id: "u1", email: "sam@example.com", name: "Sam")
        ))

        XCTAssertEqual(server.appended.map(\.weightKg), [82.5])
        _ = store
    }
}
