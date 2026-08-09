import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The hub asks these two questions on every render, and both must be answerable off the DEVICE — the
// hub is the first frame of a cold launch, and a front door that waited for a round trip would be a
// front door you wait at. `running` is the one answer that reorders the hub.

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

    private func queue() -> SetQueue { SetQueue(url: queueURL) }

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

    // A workout in progress is the one thing that sinks gym to the bottom of the hub, under the
    // thumb, and puts the dot on the capsule from every other room.
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

    // A session with no routine is still a session, and the hub says what it is rather than leaving
    // the headline blank.
    func testAnAdHocSessionStillNamesItself() {
        let held = queue()
        held.hold(Session(id: "ses_1", startedAtMs: 1_000))
        held.flush()
        XCTAssertEqual(summary().routine, "Logging without a routine")
    }

    // The local shelf is a real home now: a finished session nobody has claimed counts toward what
    // gym is holding here, which is what signed-out You states and the house trigger waits on.
    func testUnclaimedFinishedSessionsCountTowardWhatIsOnThisDevice() {
        let kept = LocalLog(url: localURL)
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

    // The cache answers from the files' own modification stamps. What must never happen is a hub
    // that goes on naming a workout the device has let go of.
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

    // The room is HERE now. `presence` is the platform's default, and a module that still overrode it
    // would be telling the switcher the log lives somewhere else.
    func testGymIsPresentOnThisPhone() {
        guard case .here = module.presence else {
            return XCTFail("gym has a room on this device")
        }
        XCTAssertEqual(module.id, "gym")
        XCTAssertEqual(module.label, "Gym")
        XCTAssertEqual(module.entry.verb, "Log a workout")
    }

    // The noun is the PRODUCT's vocabulary and nothing else may choose it: a gym counts sessions.
    func testGymCountsSessions() {
        XCTAssertEqual(module.holdings(account).noun, "session")
    }

    // Nothing running is the resting state, and it is said without a claim about a log this frame has
    // not read — the device knows whether a session is open and nothing else.
    func testTheHubLineRestsOnWhatTheDeviceKnows() {
        let line = module.hubLine(signedIn)
        XCTAssertEqual(line.eyebrow, "Today")
        XCTAssertEqual(line.headline, "Nothing running.")
        XCTAssertNil(line.meta)
        XCTAssertFalse(line.running)
    }

    // THE WALL IS GONE. The room is anonymous-first: a fresh signed-out phone reads exactly like a
    // signed-in one at rest, because there is no precondition to warn about — Today's claim offer is
    // the only account sentence gym carries, and it lives inside the room, under the work.
    func testSignedOutAFreshDeviceReadsLikeAnyRestingGym() {
        let line = module.hubLine(account)
        XCTAssertEqual(line.eyebrow, "Today")
        XCTAssertEqual(line.headline, "Nothing running.")
        XCTAssertNil(line.meta, "a fresh device has no log to point at and nothing to warn about")
        XCTAssertFalse(line.running)
    }

    // A door that opens straight onto work carries no caveat — nil is the promise, and gym now
    // keeps it: sessions open against the device's own log before there is an account.
    func testTheFirstRunCardCarriesNoCaveat() {
        XCTAssertNil(module.entry.caveat)
        XCTAssertNil(module.caveat, "gym's room is HERE and opens signed out — nothing to warn about")
    }
}
