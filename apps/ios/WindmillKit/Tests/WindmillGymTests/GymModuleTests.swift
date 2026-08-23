import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

@MainActor
final class GymDeviceTests: XCTestCase {
    private var queueURL: URL!
    private var localURL: URL!

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-device-\(UUID().uuidString).json")
        localURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-device-local-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
        try? FileManager.default.removeItem(at: localURL)
    }

    private func queue() -> SetQueue { SetQueue(url: queueURL, deviceHolds: nil) }

    private func summary() -> GymDevice.Summary {
        GymDevice.summary(url: queueURL, localURL: localURL)
    }

    private func aSet(_ id: String, at completedAtMs: Int64) -> TrainingSet {
        TrainingSet(id: id, exerciseId: "back-squat", weightKg: 100, reps: 5, completedAtMs: completedAtMs)
    }

    func testWithNothingOnThisDeviceTheHubSaysNothingIsRunning() {
        XCTAssertEqual(summary(), .none)
        XCTAssertEqual(summary().sessions, 0)
    }

    func testAnOpenSessionNamesItsRoutineAndCountsItsSets() {
        let held = queue()
        held.hold(Session(id: "ses_1", startedAtMs: 1_000,
                          plan: PlanSnapshot(routine: "Push A", entries: [])))
        held.store(aSet("set_1", at: 2_000), in: "ses_1", needsPush: true)
        held.store(aSet("set_2", at: 3_000), in: "ses_1", needsPush: false)
        held.flush()

        let summarised = summary()
        XCTAssertEqual(summarised.routine, "Push A")
        XCTAssertEqual(summarised.sets, 2, "a set on this device counts whether or not the log has it yet")
        XCTAssertEqual(summarised.sessions, 1)
    }

    func testAnAdHocSessionStillNamesItself() {
        let held = queue()
        held.hold(Session(id: "ses_1", startedAtMs: 1_000))
        held.flush()
        XCTAssertEqual(summary().routine, "Logging without a routine")
    }

    func testUnclaimedFinishedSessionsCountTowardWhatIsOnThisDevice() {
        let kept = LocalLog(url: localURL, deviceHolds: nil)
        kept.keep(Session(id: "ses_done", startedAtMs: 1_000, finishedAtMs: 2_000),
                  sets: [aSet("set_1", at: 1_500)])
        kept.flush()

        XCTAssertEqual(summary().sessions, 1)
        XCTAssertNil(summary().routine, "a finished session is not a running one")

        let live = queue()
        live.hold(Session(id: "ses_live", startedAtMs: 3_000))
        live.flush()
        XCTAssertEqual(summary().sessions, 2, "the live session counts beside the kept one")
    }

    func testTheSummaryFollowsTheFilesRatherThanItsOwnMemory() {
        let held = queue()
        held.hold(Session(id: "ses_1", startedAtMs: 1_000,
                          plan: PlanSnapshot(routine: "Legs", entries: [])))
        held.flush()
        XCTAssertEqual(summary().routine, "Legs")

        try? FileManager.default.removeItem(at: queueURL)
        XCTAssertEqual(summary(), .none,
                       "a discarded queue leaves nothing behind, and the hub must not remember it")
    }
}

@MainActor
final class GymModuleTests: XCTestCase {
    private let module = GymModule()

    private var account: Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: nil)
    }

    private var signedIn: Account {
        Account(api: WindmillApi(baseURL: URL(string: "https://windmill.works")!, credential: { nil }),
                user: User(id: "u1", email: "lifter@windmill.works", name: "Lifter"))
    }

    func testGymIsPresentOnThisPhone() {
        guard case .here = module.presence else {
            return XCTFail("gym has a room on this device")
        }
        XCTAssertEqual(module.id, "gym")
        XCTAssertEqual(module.label, "Gym")
        XCTAssertEqual(module.entry.verb, "Log a workout")
    }

    func testGymCountsSessions() {
        XCTAssertEqual(module.holdings(account).noun, "session")
    }

    func testTheHubLineRestsOnWhatTheDeviceKnows() {
        let line = module.hubLine(signedIn)
        XCTAssertEqual(line.eyebrow, "Today")
        XCTAssertEqual(line.headline, "Nothing running.")
        XCTAssertNil(line.meta)
        XCTAssertFalse(line.running)
    }

    func testSignedOutAFreshDeviceReadsLikeAnyRestingGym() {
        let line = module.hubLine(account)
        XCTAssertEqual(line.eyebrow, "Today")
        XCTAssertEqual(line.headline, "Nothing running.")
        XCTAssertNil(line.meta, "a fresh device has no log to point at and nothing to warn about")
        XCTAssertFalse(line.running)
    }

    func testTheFirstRunCardCarriesNoCaveat() {
        XCTAssertNil(module.entry.caveat)
        XCTAssertNil(module.caveat, "gym's room is HERE and opens signed out — nothing to warn about")
    }
}
