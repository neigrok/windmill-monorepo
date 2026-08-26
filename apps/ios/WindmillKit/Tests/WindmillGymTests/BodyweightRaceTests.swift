import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// A reply that lands late: after the seat moved on, or after the lifter deleted the day it answers for.
@MainActor
final class BodyweightRaceTests: XCTestCase {
    private var stem: URL!
    private var clockMs: Int64 = 1_000

    override func setUp() async throws {
        stem = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("gym-bw-race-\(UUID().uuidString)")
        clockMs = 1_000
    }

    override func tearDown() async throws {
        for ext in ["queue.json", "catalog.json", "local.json", "account.json", "bodyweight.json"] {
            try? FileManager.default.removeItem(at: stem.appendingPathExtension(ext))
        }
    }

    private func makeStore(sync: FakeTraining, retryAfter: Duration = .seconds(4)) -> TrainingStore {
        TrainingStore(queue: SetQueue(url: stem.appendingPathExtension("queue.json"), deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: stem.appendingPathExtension("catalog.json")),
                      accountCopy: AccountCopy(url: stem.appendingPathExtension("account.json")),
                      localLog: LocalLog(url: stem.appendingPathExtension("local.json"), deviceHolds: nil),
                      bodyweightStore: BodyweightStore(url: stem.appendingPathExtension("bodyweight.json")),
                      now: { self.clockMs += 1; return self.clockMs },
                      undoWindowMs: 0,
                      retryAfter: retryAfter,
                      sync: { $0.isSignedIn ? sync : nil })
    }

    private func account(signedIn: Bool, id: String = "u1") -> Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: signedIn ? User(id: id, email: "\(id)@example.com", name: id) : nil)
    }

    private func shelf(of seat: String?) -> BodyweightStore {
        let held = BodyweightStore(url: stem.appendingPathExtension("bodyweight.json"))
        held.open(under: seat)
        return held
    }

    private func entry(_ day: String, _ kg: Double, at recordedAt: Int64) -> BodyweightEntry {
        BodyweightEntry(dateLocal: day, weightKg: kg, recordedAt: recordedAt)
    }

    // Holds a reply until the test lets it go.
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

    func testASeriesServedForOneSeatNeverLandsOnTheShelfOfTheNext() async {
        let server = FakeTraining()
        server.weighIns["2026-08-25"] = entry("2026-08-25", 82.4, at: 1)
        let gate = Gate()
        server.onBodyweightRead = { await gate.wait() }
        let store = makeStore(sync: server)

        let signingIn = Task { await store.connect(to: account(signedIn: true)) }
        await until { server.calls.contains("bodyweight") }
        server.onBodyweightRead = {}
        await store.connect(to: account(signedIn: false))
        gate.open()
        await signingIn.value

        XCTAssertEqual(store.bodyweight, [], "the signed-out seat draws nobody's weigh-ins")
        XCTAssertEqual(shelf(of: nil).entries, [], "and keeps none on disk")
        XCTAssertEqual(shelf(of: "u1").entries, [], "the reply answered a seat that is gone; nothing was written")

        // The fake serves one account's rows to every seat, so an empty log leaves the anonymous shelf the only
        // place the next account could inherit the row from.
        server.weighIns = [:]
        await store.connect(to: account(signedIn: true, id: "u2"))
        XCTAssertEqual(store.bodyweight, [], "the next account does not inherit u1's row through the anonymous shelf")
    }

    func testAWriteAnsweredAfterSignOutTouchesNoShelf() async {
        let server = FakeTraining()
        let gate = Gate()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        server.onPutBodyweight = { await gate.wait() }

        let saving = Task { await store.weighIn(82.4, on: "2026-08-25") }
        await until { server.calls.contains("putBodyweight") }
        server.onPutBodyweight = {}
        await store.connect(to: account(signedIn: false))
        gate.open()
        _ = await saving.value

        XCTAssertEqual(store.bodyweight, [])
        XCTAssertEqual(shelf(of: nil).entries, [], "the reply does not settle a row onto the anonymous shelf")
        XCTAssertEqual(shelf(of: "u1").owed.map(\.entry.dateLocal), ["2026-08-25"],
                       "u1's shelf still owes the write; the next sign-in claims it")
    }

    // Save, then delete the day while the save is still in flight: the deletion stands here and on the log.
    func testADeletionMadeWhileTheSaveIsInFlightIsNotUndoneByTheSavesReply() async {
        let server = FakeTraining()
        let gate = Gate()
        let store = makeStore(sync: server, retryAfter: .milliseconds(20))
        await store.connect(to: account(signedIn: true))
        server.onPutBodyweight = { await gate.wait() }

        let saving = Task { await store.weighIn(82.4, on: "2026-08-25") }
        await until { server.calls.contains("putBodyweight") }
        XCTAssertEqual(store.bodyweight.map(\.weightKg), [82.4])
        server.onPutBodyweight = {}
        let deleted = await store.deleteWeighIn(on: "2026-08-25")
        XCTAssertNil(deleted)
        XCTAssertEqual(store.bodyweight, [])
        // The log acts on the save after the deletion: the row the lifter removed is back on the server.
        gate.open()
        let saved = await saving.value

        XCTAssertNil(saved)
        XCTAssertEqual(store.bodyweight, [], "the lifter's deletion stands on this device")
        XCTAssertEqual(shelf(of: "u1").entries, [], "and on disk")
        XCTAssertEqual(shelf(of: "u1").owed.map(\.deleted), [true], "the deletion is owed again")

        await until { server.weighIns.isEmpty }
        XCTAssertEqual(server.weighIns, [:], "and the cadence tells the log")
        XCTAssertTrue(shelf(of: "u1").isEmpty)
    }

    func testANewerSaveMadeWhileTheFirstIsInFlightStandsOverTheFirstsReply() async {
        let server = FakeTraining()
        let gate = Gate()
        let store = makeStore(sync: server, retryAfter: .milliseconds(20))
        await store.connect(to: account(signedIn: true))
        server.onPutBodyweight = { await gate.wait() }

        let first = Task { await store.weighIn(82.4, on: "2026-08-25") }
        await until { server.calls.contains("putBodyweight") }
        server.onPutBodyweight = {}
        server.online = false
        _ = await store.weighIn(82.9, on: "2026-08-25")
        XCTAssertEqual(store.bodyweight.map(\.weightKg), [82.9])
        server.online = true
        gate.open()
        _ = await first.value

        XCTAssertEqual(store.bodyweight.map(\.weightKg), [82.9], "the first reply does not roll the day back")
        XCTAssertEqual(shelf(of: "u1").owed.map(\.entry.weightKg), [82.9], "the correction is still owed")
        await until { server.weighIns["2026-08-25"]?.weightKg == 82.9 }
        XCTAssertEqual(server.weighIns["2026-08-25"]?.weightKg, 82.9, "and the claim carries it")
    }

    // Delete, then save the same day again while the deletion is still in flight: the new save stands.
    func testASaveMadeWhileTheDeletionIsInFlightIsNotDroppedByTheDeletionsReply() async {
        let server = FakeTraining()
        server.weighIns["2026-08-25"] = entry("2026-08-25", 83.3, at: 1)
        let gate = Gate()
        let store = makeStore(sync: server, retryAfter: .milliseconds(20))
        await store.connect(to: account(signedIn: true))
        server.onDeleteBodyweight = { await gate.wait() }

        let deleting = Task { await store.deleteWeighIn(on: "2026-08-25") }
        await until { server.calls.contains("deleteBodyweight") }
        server.onDeleteBodyweight = {}
        server.online = false
        _ = await store.weighIn(82.4, on: "2026-08-25")
        XCTAssertEqual(store.bodyweight.map(\.weightKg), [82.4])
        server.online = true
        gate.open()
        _ = await deleting.value

        XCTAssertEqual(store.bodyweight.map(\.weightKg), [82.4], "the deletion's reply does not take the new save")
        XCTAssertEqual(shelf(of: "u1").owed.map(\.entry.weightKg), [82.4], "still owed")
        await until { server.weighIns["2026-08-25"]?.weightKg == 82.4 }
        XCTAssertEqual(server.weighIns["2026-08-25"]?.weightKg, 82.4, "and the claim carries it")
    }

    func testAWeighInDatedAfterTodayIsRefusedBeforeItTouchesTheShelf() async {
        let server = FakeTraining()
        let store = makeStore(sync: server)
        await store.connect(to: account(signedIn: true))
        let tomorrow = Bodyweight.dateLocal(Calendar.current.date(byAdding: .day, value: 1, to: Date())!)

        let refused = await store.weighIn(82.4, on: tomorrow)

        XCTAssertEqual(refused, .refused("A weigh-in is not a forecast — today or earlier."))
        XCTAssertEqual(store.bodyweight, [])
        XCTAssertTrue(shelf(of: "u1").isEmpty)
        XCTAssertEqual(server.bodyweightWrites, [], "never sent")
    }
}
