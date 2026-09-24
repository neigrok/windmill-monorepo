import Combine
import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// `Log set` holds nothing back: the set is on its way the moment it is tapped, and a wrong one is
// corrected in its fix sheet, opened off its own pill in the logger. The nine-second window is a
// delete's alone, and it still holds.
@MainActor
final class LogSetTests: XCTestCase {
    private var queueURL: URL!
    private var catalogURL: URL!
    private var clockMs: Int64 = 1_000

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-log-set-\(UUID().uuidString).json")
        catalogURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-log-set-catalog-\(UUID().uuidString).json")
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

    // Holds an append on the wire: the log has it or not only once the test opens the gate.
    private final class Gate: @unchecked Sendable {
        private var waiting: [CheckedContinuation<Void, Never>] = []
        private var opened = false

        func wait() async {
            if opened { return }
            await withCheckedContinuation { waiting.append($0) }
        }

        func open() {
            opened = true
            let held = waiting
            waiting = []
            for one in held { one.resume() }
        }
    }

    private func until(_ condition: @escaping () -> Bool) async {
        for _ in 0..<2_000 where !condition() {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    // The store's window is left at its nine-second default on purpose: a log that still waited on
    // it would send nothing below.
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

    func testLoggingASetSendsItAtOnceWithNoHold() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(server.appended.map(\.weightKg), [82.5], "sent with no time passing")
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1000"])
        XCTAssertEqual(store.sets.map(\.id), ["set_1000"])
        XCTAssertEqual(store.saveState, .onTheLog)
        XCTAssertTrue(queueOnDisk().pending.isEmpty, "nothing is left waiting on the device")
    }

    func testASetThatCannotLandIsSaidAtOnce() async {
        let server = FakeTraining()
        let store = await liveStore(server)

        server.online = false
        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(store.saveState, .blocked(.offline))
        XCTAssertEqual(store.strandedCount, 1, "no window to wait out first")
        XCTAssertEqual(queueOnDisk().pending.map(\.owes), [.append])
    }

    func testFinishSendsTheSetBeforeTheClose() async {
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

    func testDeletingALoggedSetIsStillWithheldAndTakenBack() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        await store.logSet(weightKg: 82.5, reps: 5)
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }

        await store.delete(logged, in: "ses_1")
        XCTAssertEqual(store.sets, [], "the row leaves the screen at once")
        XCTAssertEqual(server.deleted, [], "and the log inside the window")
        XCTAssertEqual(queueOnDisk().pending.map(\.owes), [.delete])

        let undone = await store.restore(logged, in: "ses_1")
        XCTAssertTrue(undone)
        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()

        XCTAssertEqual(server.deleted, [], "nothing was ever deleted")
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1000"])
        XCTAssertEqual(store.sets.map(\.id), ["set_1000"])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    func testADeleteLeftAloneGoesWhenItsWindowCloses() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        await store.logSet(weightKg: 82.5, reps: 5)
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }

        await store.delete(logged, in: "ses_1")
        await store.flushPendingSets()
        XCTAssertEqual(server.deleted, [], "a walk inside the window sends nothing")

        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()

        XCTAssertEqual(server.deleted, ["set_1000"])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), [])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    // MARK: - the fix sheet, opened off a landed pill

    func testALandedPillOpensTheFixSheetForItsOwnSet() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        await store.logSet(weightKg: 80, reps: 5)
        clockMs += 60_000
        await store.logSet(weightKg: 82.5, reps: 4)

        let slots = LiveLines.slots(store.todaySets, plan: store.planEntry, stalled: store.stalled)
        let doors = slots.compactMap { slot -> FixSheet.Subject? in
            guard case .landed(let row) = slot else { return nil }
            return FixSheet.Subject(landed: row, in: store.todaySets, catalog: store.catalog)
        }

        XCTAssertEqual(doors.map(\.id), ["set_1000", "set_61000"], "each pill opens its own set")
        XCTAssertEqual(doors.map(\.number), ["1", "2"])
        XCTAssertEqual(doors.map(\.set.weightKg), [80, 82.5])
        XCTAssertEqual(doors.map(\.movement), Array(repeating: Readout.movement("bench-press", in: store.catalog),
                                                     count: 2))
    }

    func testAFixFromTheLoggerRewritesTheLandedSet() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        await store.logSet(weightKg: 82.5, reps: 5)
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }

        await store.fix(logged, in: "ses_1", by: SetFix(weightKg: 85, reps: 4))

        XCTAssertEqual(server.corrected, ["set_1000"], "a PATCH under the id the set already has")
        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [85])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.reps), [4])
        XCTAssertEqual(store.sets.map(\.weightKg), [85])
        XCTAssertEqual(store.sets.map(\.reps), [4])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    // Only a set that never went out is this device's alone: the lane stopped at the one before it.
    func testAFixOfASetNeverSentRewritesItsAppend() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        server.online = false
        await store.logSet(weightKg: 80, reps: 5)
        clockMs += 60_000
        await store.logSet(weightKg: 82.5, reps: 5)
        guard let unsent = store.sets.last else { return XCTFail("the set was drawn") }

        await store.fix(unsent, in: "ses_1", by: SetFix(weightKg: 85, reps: 4))
        XCTAssertEqual(queueOnDisk().pending.map(\.owes), [.append, .append], "still two appends, never a fix over one")
        XCTAssertEqual(store.sets.map(\.weightKg), [80, 85])

        server.online = true
        await store.flushPendingSets()

        XCTAssertEqual(server.corrected, [])
        XCTAssertEqual(server.sets["ses_1"], [
            TrainingSet(id: "set_1000", exerciseId: "bench-press", setNumber: 1, weightKg: 80, reps: 5,
                        kind: .working, completedAtMs: 1_000),
            TrainingSet(id: "set_61000", exerciseId: "bench-press", setNumber: 2, weightKg: 85, reps: 4,
                        kind: .working, completedAtMs: 61_000),
        ])
    }

    // A send that failed may still have reached the log, so the correction waits behind the append.
    func testAFixOfASetWhoseSendFailedGoesBehindItsAppend() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        server.online = false
        await store.logSet(weightKg: 82.5, reps: 5)
        guard let queued = store.sets.first else { return XCTFail("the set was drawn") }

        await store.fix(queued, in: "ses_1", by: SetFix(weightKg: 85, reps: 4))
        XCTAssertEqual(queueOnDisk().pending.map(\.owes), [.fix])
        XCTAssertEqual(queueOnDisk().pending.map(\.mayBeOnTheLog), [true])
        XCTAssertEqual(store.sets.map(\.weightKg), [85])

        server.online = true
        let offline = server.calls.count
        await store.flushPendingSets()

        XCTAssertEqual(server.calls[offline...].filter { ["append", "fixSet", "deleteSet"].contains($0) },
                       ["append", "fixSet"])
        XCTAssertEqual(server.sets["ses_1"], [
            TrainingSet(id: "set_1000", exerciseId: "bench-press", setNumber: 1, weightKg: 85, reps: 4,
                        kind: .working, completedAtMs: 1_000),
        ])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    // The fix sheet's Delete is the same act as the session page's: the room's window holds it.
    func testDeletingFromTheFixSheetIsWithheldAndUndoable() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        let window = WithheldWindow(windowMs: SetQueue.undoWindowMs, now: { self.clockMs })
        await store.logSet(weightKg: 82.5, reps: 5)
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }

        await window.hold(Withheld(deleting: logged, in: "ses_1", from: store))
        XCTAssertEqual(window.line, "82.5 × 5 is out of the log.")
        XCTAssertEqual(store.sets, [], "the pill leaves at once")
        XCTAssertEqual(server.deleted, [], "and the log waits out the window")

        let undone = await window.undo()
        XCTAssertEqual(undone, .set)
        XCTAssertEqual(store.sets.map(\.id), ["set_1000"])

        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()
        XCTAssertEqual(server.deleted, [], "nothing was ever deleted")
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1000"])
    }

    func testADeleteFromTheFixSheetLeftAloneGoesWhenTheWindowCloses() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        let window = WithheldWindow(windowMs: 50, now: { self.clockMs })
        await store.logSet(weightKg: 82.5, reps: 5)
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }

        await window.hold(Withheld(deleting: logged, in: "ses_1", from: store))
        clockMs += 51
        let deadline = Date().addingTimeInterval(4)
        while window.isOpen, Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }

        XCTAssertFalse(window.isOpen)
        XCTAssertEqual(server.deleted, ["set_1000"])
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), [])
        XCTAssertEqual(store.sets, [])
    }

    // MARK: - a change made while the append may be on the log

    func testAFixMadeWhileTheAppendIsOnTheWireLandsBehindIt() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        let gate = Gate()
        server.onAppend = { await gate.wait() }

        let logging = Task { await store.logSet(weightKg: 82.5, reps: 5) }
        await until { server.calls.contains("append") }
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }
        let fixing = Task { await store.fix(logged, in: "ses_1", by: SetFix(weightKg: 85, reps: 4)) }
        await until { store.sets.map(\.weightKg) == [85] }
        XCTAssertEqual(store.sets.map(\.weightKg), [85], "the correction is drawn at once")
        gate.open()
        await logging.value
        let stands = await fixing.value

        let corrected = TrainingSet(id: "set_1000", exerciseId: "bench-press", setNumber: 1, weightKg: 85,
                                    reps: 4, kind: .working, completedAtMs: 1_000)
        XCTAssertEqual(stands, TrainingSet(id: "set_1000", exerciseId: "bench-press", weightKg: 85, reps: 4,
                                           kind: .working, completedAtMs: 1_000))
        XCTAssertEqual(server.calls.filter { ["append", "fixSet", "deleteSet"].contains($0) },
                       ["append", "fixSet"], "the append lands first, then the correction goes as a PATCH")
        XCTAssertEqual(server.sets["ses_1"], [corrected])
        XCTAssertEqual(store.sets, [corrected])
        XCTAssertEqual(store.saveState, .onTheLog)
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    func testADeleteMadeWhileTheAppendIsOnTheWireTakesTheRowOffTheLog() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        let gate = Gate()
        server.onAppend = { await gate.wait() }

        let logging = Task { await store.logSet(weightKg: 82.5, reps: 5) }
        await until { server.calls.contains("append") }
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }
        let deleting = Task { await store.delete(logged, in: "ses_1") }
        await until { store.sets.isEmpty }
        XCTAssertEqual(store.sets, [], "the row leaves the screen at once")
        gate.open()
        await logging.value
        await deleting.value

        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1000"], "the append landed; the delete waits out its window")
        XCTAssertEqual(queueOnDisk().pending.map(\.owes), [.delete])
        XCTAssertEqual(queueOnDisk().pending.map(\.mayBeOnTheLog), [false], "the log answered the append")

        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()

        XCTAssertEqual(server.calls.filter { ["append", "fixSet", "deleteSet"].contains($0) },
                       ["append", "deleteSet"])
        XCTAssertEqual(server.deleted, ["set_1000"])
        XCTAssertEqual(server.sets["ses_1"], [])
        XCTAssertEqual(store.sets, [])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    func testAFixAfterTheAppendsAnswerWasLostLandsAsAPatch() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        server.swallowReplies = 1
        await store.logSet(weightKg: 82.5, reps: 5)
        XCTAssertEqual(server.sets["ses_1"]?.map(\.weightKg), [82.5], "the log took the set; its answer was lost")
        XCTAssertEqual(queueOnDisk().pending.map(\.mayBeOnTheLog), [true], "the send is on the disk")
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }

        let stands = await store.fix(logged, in: "ses_1", by: SetFix(weightKg: 85, reps: 4))

        let corrected = TrainingSet(id: "set_1000", exerciseId: "bench-press", setNumber: 1, weightKg: 85,
                                    reps: 4, kind: .working, completedAtMs: 1_000)
        XCTAssertEqual(stands, TrainingSet(id: "set_1000", exerciseId: "bench-press", weightKg: 85, reps: 4,
                                           kind: .working, completedAtMs: 1_000))
        XCTAssertEqual(server.calls.filter { ["append", "fixSet", "deleteSet"].contains($0) },
                       ["append", "append", "fixSet"], "the replay answers the stored row, then the PATCH")
        XCTAssertEqual(server.sets["ses_1"], [corrected])
        XCTAssertEqual(store.sets, [corrected])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    func testADeleteAfterTheAppendsAnswerWasLostTakesTheRowOffTheLog() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        server.swallowReplies = 1
        await store.logSet(weightKg: 82.5, reps: 5)
        guard let logged = store.sets.first else { return XCTFail("the set was drawn") }

        await store.delete(logged, in: "ses_1")
        clockMs += SetQueue.undoWindowMs + 1
        await store.flushPendingSets()

        XCTAssertEqual(server.calls.filter { ["append", "fixSet", "deleteSet"].contains($0) },
                       ["append", "append", "deleteSet"])
        XCTAssertEqual(server.deleted, ["set_1000"])
        XCTAssertEqual(server.sets["ses_1"], [])
        XCTAssertEqual(store.sets, [])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    // A set sent after the app died with its answer still out is one the log may hold, all the same.
    func testASendMarkedBeforeTheAppDiedStillPutsTheFixBehindTheAppend() async {
        let server = FakeTraining()
        let first = await liveStore(server)
        server.swallowReplies = 1
        await first.logSet(weightKg: 82.5, reps: 5)
        server.online = false

        let relaunched = await liveStore(server)
        guard let logged = relaunched.sets.first else { return XCTFail("the set came back off the disk") }
        await relaunched.fix(logged, in: "ses_1", by: SetFix(weightKg: 85, reps: 4))
        XCTAssertEqual(queueOnDisk().pending.map(\.owes), [.fix])
        XCTAssertEqual(queueOnDisk().pending.map(\.mayBeOnTheLog), [true])
        server.online = true
        let offline = server.calls.count
        await relaunched.flushPendingSets()

        XCTAssertEqual(server.calls[offline...].filter { ["append", "fixSet", "deleteSet"].contains($0) },
                       ["append", "fixSet"], "the replay answers the stored row, then the PATCH")
        XCTAssertEqual(server.sets["ses_1"], [TrainingSet(id: "set_1000", exerciseId: "bench-press", setNumber: 1,
                                                          weightKg: 85, reps: 4, kind: .working,
                                                          completedAtMs: 1_000)])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    // MARK: - the band

    func testASetOnItsFirstTryIsNeverCalledStranded() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        let gate = Gate()
        server.onAppend = { await gate.wait() }
        var seen: [Int] = []
        let watching = store.$strandedCount.sink { seen.append($0) }

        let logging = Task { await store.logSet(weightKg: 82.5, reps: 5) }
        await until { server.calls.contains("append") }
        clockMs += 60_000
        let second = Task { await store.logSet(weightKg: 82.5, reps: 5) }
        await until { store.sets.count == 2 }
        gate.open()
        await logging.value
        await second.value
        watching.cancel()

        XCTAssertEqual(Set(seen), [0], "no band while the first try of each set is on the wire")
        XCTAssertEqual(server.sets["ses_1"]?.map(\.id), ["set_1000", "set_61000"])
        XCTAssertTrue(queueOnDisk().pending.isEmpty)
    }

    func testEverySetBehindOneThatCouldNotLandIsStranded() async {
        let server = FakeTraining()
        let store = await liveStore(server)
        server.online = false

        await store.logSet(weightKg: 82.5, reps: 5)
        clockMs += 60_000
        await store.logSet(weightKg: 82.5, reps: 5)

        XCTAssertEqual(store.strandedCount, 2)
        XCTAssertEqual(queueOnDisk().pending.map(\.mayBeOnTheLog), [true, false],
                       "the lane stopped at the first, so the second never went out")
    }
}
