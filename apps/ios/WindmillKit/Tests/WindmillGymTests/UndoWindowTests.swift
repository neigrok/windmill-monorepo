import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

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

    private func queueOnDisk(of seat: String? = "u1") -> SetQueue {
        let held = SetQueue(url: queueURL, deviceHolds: nil)
        held.open(under: seat)
        return held
    }

    private func liveStore(_ server: FakeTraining) async -> TrainingStore {
        server.open(Session(id: "ses_1", startedAtMs: 1_000))
        let store = TrainingStore(queue: SetQueue(url: queueURL, deviceHolds: nil),
                                  deviceCatalog: DeviceCatalog(url: catalogURL),
                                  accountCopy: AccountCopy(url: catalogURL.appendingPathExtension("account")),
                                  localLog: LocalLog(url: catalogURL.appendingPathExtension("local"), deviceHolds: nil),
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

    func testASetJustLoggedIsOnTheDeviceAndNotYetOnTheLog() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(store.sets.map(\.weightKg), [82.5])
        XCTAssertEqual(server.appended.count, 0, "nothing goes out while it can still be taken back")
        XCTAssertEqual(store.undoable?.weightKg, 82.5)
        XCTAssertEqual(queueOnDisk().pending.count, 1, "and it is on disk, not in memory")
    }

    func testASetInsideItsWindowIsNotCalledOffline() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(store.saveState, .idle)
        XCTAssertNil(store.saveState.line)
    }

    func testUndoTakesTheSetBackAndTheLogNeverHearsOfIt() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        XCTAssertTrue(store.undoLast())

        XCTAssertEqual(store.sets, [])
        XCTAssertEqual(server.appended.count, 0)
        XCTAssertEqual(queueOnDisk().pending.count, 0, "and the disk agrees")
        XCTAssertNil(store.undoable)
    }

    func testUndoTakesBackTheNewestSetAndLeavesTheRest() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        clockMs += 1_000
        await store.logSet(weightKg: 85, reps: 3)
        XCTAssertTrue(store.undoLast())

        XCTAssertEqual(store.sets.map(\.weightKg), [82.5])
    }

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

    func testUndoAfterTheSetHasLandedRefusesRatherThanPretending() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()

        XCTAssertFalse(store.undoLast())
        XCTAssertEqual(store.sets.map(\.weightKg), [82.5], "the set the log has stays on screen")
    }

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

    // Leaving keeps the window. There is no forced flush left to end one early: what is held stays
    // held on the queue's own on-disk clock, and only that clock sends it.
    func testLeavingTheRoomKeepsTheWindowAndSendsNothingEarly() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)
        await store.flushPendingSets()
        XCTAssertEqual(server.appended.count, 0, "leaving the room keeps the window")
        XCTAssertEqual(store.undoable?.weightKg, 82.5, "and the way back is still open")

        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()
        XCTAssertEqual(server.appended.map(\.weightKg), [82.5])
    }

    func testAReadOfTheLogSendsWhatIsHeldFirst() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        await store.logSet(weightKg: 82.5, reps: 5)

        let relaunched = TrainingStore(queue: SetQueue(url: queueURL, deviceHolds: nil),
                                       deviceCatalog: DeviceCatalog(url: catalogURL),
                                       accountCopy: AccountCopy(url: catalogURL.appendingPathExtension("account")),
                                       localLog: LocalLog(url: catalogURL.appendingPathExtension("local"), deviceHolds: nil),
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
