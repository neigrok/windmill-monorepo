import SwiftUI
import WindmillPlatform

// Gym's one seam into the superapp. Everything the product is sits behind this; the shell knows only
// that a room exists, what one line it lends the hub, and how much of gym is on this device.

public struct GymModule: ProductModule {
    public let id = "gym"
    public let label = "Gym"
    public let symbol = "figure.strengthtraining.traditional"

    public init() {}

    public let entry = EntryDoor(
        verb: "Log a workout",
        line: "sets and weights, two taps each",
        made: "Your first session is logged.",
        back: "Back to the log"
    )

    public func room(_ account: Account) -> AnyView {
        AnyView(GymRoom(account: account))
    }

    // Read straight off the DEVICE and never off the network: the hub is the first frame of a cold
    // launch, and a front door that waited for a round trip would be a front door you wait at.
    //
    // `running` is the one thing that reorders the hub — a workout in progress sinks gym to the
    // bottom of the stack, under the thumb, and puts the dot on the capsule from every other room.
    public func hubLine(_ account: Account) -> HubLine {
        let device = GymDevice.summary()
        guard let running = device.routine else {
            return HubLine(eyebrow: "Today", headline: "Nothing running.")
        }
        return HubLine(eyebrow: "Session running",
                       headline: running,
                       meta: Readout.setCount(device.sets) + " so far",
                       running: true)
    }

    // What gym is holding HERE, which is the live session and no more: a finished session lives on
    // the account, and this device lets go of its rows the moment it closes. The noun is the
    // product's own — a gym counts sessions, never workouts and never entries.
    public func holdings(_ account: Account) -> Holdings {
        Holdings(count: GymDevice.summary().sessions, noun: "session")
    }
}

// THE CHEAP READ. `hubLine` and `holdings` are called on every hub render and on every capsule tap —
// the shell maps hubLine across all products just to decide whether the dot is on — so answering by
// decoding a training log per frame is not an option. This summarises once and then answers from the
// file's own modification stamp: unchanged file, unchanged answer, no decode.
//
// Main-actor by construction, because ProductModule is: the cache needs no lock and cannot be raced.
@MainActor
enum GymDevice {
    struct Summary: Equatable {
        let sessions: Int
        let routine: String?        // the open session's plan name, or its own honest fallback
        let sets: Int

        static let none = Summary(sessions: 0, routine: nil, sets: 0)
    }

    private static var stamp: Date?
    private static var summarised = Summary.none

    static func summary(url: URL = SetQueue.defaultURL()) -> Summary {
        let written = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
        // No file is no session, and it is also the state the cache must not answer stale from: a
        // discarded queue leaves nothing behind, and the hub would otherwise go on naming a workout
        // that was deleted.
        guard let written else {
            stamp = nil
            summarised = .none
            return summarised
        }
        if written == stamp { return summarised }

        let queue = SetQueue(url: url)
        stamp = written
        summarised = read(queue)
        return summarised
    }

    private static func read(_ queue: SetQueue) -> Summary {
        guard let live = queue.session else { return .none }
        return Summary(sessions: 1,
                       routine: live.plan?.routine ?? "Logging without a routine",
                       sets: queue.sets(in: live.id).count)
    }
}
