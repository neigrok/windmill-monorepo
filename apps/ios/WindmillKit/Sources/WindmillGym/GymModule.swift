import SwiftUI
import WindmillPlatform

// Gym's one seam into the superapp. Everything the product is sits behind this; the shell knows only
// that a room exists, what one line it lends the hub, and how much of gym is on this device.

public struct GymModule: ProductModule {
    public let id = "gym"
    public let label = "Gym"
    public let symbol = "figure.strengthtraining.traditional"

    public init() {}

    // No caveat, and that is the point: the room is anonymous-first. A session opens against the
    // device's own log before there is an account, and signing in CLAIMS what the device holds —
    // so the door opens straight onto work, which is exactly what a nil caveat promises.
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
    //
    // A live session is on the device whether or not anybody is signed in, so it outranks the
    // account note: a lifter mid-workout is told about the workout. At rest and signed out with a
    // log on this device, the meta says where that log is — the hub's half of home's quiet claim
    // offer, and never a wall.
    public func hubLine(_ account: Account) -> HubLine {
        let device = GymDevice.summary(seat: account.user?.id)
        if let running = device.routine {
            return HubLine(eyebrow: "Session running",
                           headline: running,
                           meta: Readout.setCount(device.sets) + " so far",
                           running: true)
        }
        if !account.isSignedIn && device.sessions > 0 {
            return HubLine(eyebrow: "Today", headline: "Nothing running.",
                           meta: "your log is saved on this device")
        }
        return HubLine(eyebrow: "Today", headline: "Nothing running.")
    }

    // What gym is holding HERE: the live session, and every finished one signed-in hands have not
    // yet claimed — the local shelf is a real home now, and signed-out You counts it. The noun is
    // the product's own — a gym counts sessions, never workouts and never entries.
    public func holdings(_ account: Account) -> Holdings {
        Holdings(count: GymDevice.summary(seat: account.user?.id).sessions, noun: "session")
    }
}

// THE CHEAP READ. `hubLine` and `holdings` are called on every hub render and on every capsule tap —
// the shell maps hubLine across all products just to decide whether the dot is on — so answering by
// decoding a training log per frame is not an option. This summarises once and then answers from the
// two files' own modification stamps: unchanged files, unchanged answer, no decode.
//
// Two files because the device now holds two shelves: the queue (`windmill-gym-sets.json`, the live
// session — its name and shape are load-bearing, this read depends on them) and the local log
// (`windmill-gym-local.json`, finished sessions nobody has claimed yet).
//
// It answers for ONE SEAT — the shelves are opened under whoever is signed in, exactly as the room
// opens them, so a signed-out hub never counts the previous lifter's sessions or names the workout
// they left running (audit MOBILE-3). The seat is part of what the cache is keyed on, because two
// adjacent renders can be two different people.
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

    private static var stamps: [Date?] = [nil, nil]
    private static var summarised = Summary.none
    private static var summarisedFor: String??

    static func summary(seat: String? = nil,
                        url: URL = SetQueue.defaultURL(),
                        localURL: URL = LocalLog.defaultURL()) -> Summary {
        let written = [stamp(of: url), stamp(of: localURL)]
        // No files is no gym on this device, and it is also the state the cache must not answer
        // stale from: a discarded queue leaves nothing behind, and the hub would otherwise go on
        // naming a workout that was deleted.
        guard written.contains(where: { $0 != nil }) else {
            stamps = [nil, nil]
            summarisedFor = nil
            summarised = .none
            return summarised
        }
        if written == stamps, summarisedFor == seat { return summarised }

        stamps = written
        summarisedFor = seat
        let queue = SetQueue(url: url)
        queue.open(under: seat)
        let localLog = LocalLog(url: localURL)
        localLog.open(under: seat)
        summarised = read(queue, localLog)
        return summarised
    }

    private static func stamp(of url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
    }

    private static func read(_ queue: SetQueue, _ localLog: LocalLog) -> Summary {
        let kept = localLog.sessions.count
        guard let live = queue.session else {
            return Summary(sessions: kept, routine: nil, sets: 0)
        }
        return Summary(sessions: kept + 1,
                       routine: live.plan?.routine ?? "Logging without a routine",
                       sets: queue.sets(in: live.id).count)
    }
}
