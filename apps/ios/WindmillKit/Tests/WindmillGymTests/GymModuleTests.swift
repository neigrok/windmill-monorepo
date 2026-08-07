import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// The hub asks these two questions on every render, and both must be answerable off the DEVICE — the
// hub is the first frame of a cold launch, and a front door that waited for a round trip would be a
// front door you wait at. `running` is the one answer that reorders the hub.

@MainActor
final class GymDeviceTests: XCTestCase {
    private var queueURL: URL!

    override func setUp() async throws {
        queueURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gym-device-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: queueURL)
    }

    private func queue() -> SetQueue { SetQueue(url: queueURL) }

    private func aSet(_ id: String, at completedAtMs: Int64) -> TrainingSet {
        TrainingSet(id: id, exerciseId: "back-squat", weightKg: 100, reps: 5, completedAtMs: completedAtMs)
    }

    func testWithNothingOnThisDeviceTheHubSaysNothingIsRunning() {
        XCTAssertEqual(GymDevice.summary(url: queueURL), .none)
        XCTAssertEqual(GymDevice.summary(url: queueURL).sessions, 0)
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

        let summary = GymDevice.summary(url: queueURL)
        XCTAssertEqual(summary.routine, "Push A")
        XCTAssertEqual(summary.sets, 2, "a set on this device counts whether or not the log has it yet")
        XCTAssertEqual(summary.sessions, 1)
    }

    // A session with no routine is still a session, and the hub says what it is rather than leaving
    // the headline blank.
    func testAnAdHocSessionStillNamesItself() {
        let held = queue()
        held.hold(Session(id: "ses_1", startedAtMs: 1_000))
        held.flush()
        XCTAssertEqual(GymDevice.summary(url: queueURL).routine, "Logging without a routine")
    }

    // The cache answers from the file's own modification stamp. What must never happen is a hub that
    // goes on naming a workout the device has let go of.
    func testTheSummaryFollowsTheFileRatherThanItsOwnMemory() {
        let held = queue()
        held.hold(Session(id: "ses_1", startedAtMs: 1_000,
                          plan: PlanSnapshot(routine: "Legs", entries: [])))
        held.flush()
        XCTAssertEqual(GymDevice.summary(url: queueURL).routine, "Legs")

        try? FileManager.default.removeItem(at: queueURL)
        XCTAssertEqual(GymDevice.summary(url: queueURL), .none,
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

    // A DOOR SAYS WHAT IT NEEDS BEFORE IT IS CHOSEN. Signed out, every Start behind this card answers
    // with a refusal — the plan snapshot is frozen server-side — so the hub card carries the same
    // account sentence the first-run card does instead of reading like an empty gym.
    func testSignedOutTheHubCardNamesTheAccountItNeeds() {
        let line = module.hubLine(account)
        XCTAssertEqual(line.eyebrow, "Today")
        XCTAssertEqual(line.headline, "Nothing running.")
        XCTAssertEqual(line.meta, "sessions are kept on your account")
        XCTAssertFalse(line.running)
    }

    // The same fact on the very first screen a phone ever draws, where it matters most: picking this
    // card as the first act on a fresh device used to land on a sign-in wall nothing had mentioned.
    func testTheFirstRunCardNamesTheAccountItNeeds() {
        XCTAssertEqual(module.entry.caveat, "Sessions are kept on your account — you sign in first.")
        XCTAssertEqual(module.caveat, module.entry.caveat,
                       "gym's room is HERE, so its caveat is its own entry line and not a presence")
    }
}
