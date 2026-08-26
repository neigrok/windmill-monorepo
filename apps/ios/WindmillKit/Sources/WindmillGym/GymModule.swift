import SwiftUI
import WindmillPlatform

// Gym's one seam into the superapp.

public struct GymModule: ProductModule {
    public let id = "gym"
    public let label = "Gym"
    public let symbol = "figure.strengthtraining.traditional"
    // The room draws its own bar, capsule and seat included, so the shell lays nothing over it.
    public let hostsTopChrome = true

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

    // Read off the device, never the network: the hub is the first frame of a cold launch.
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

    public func holdings(_ account: Account) -> Holdings {
        Holdings(count: GymDevice.summary(seat: account.user?.id).sessions, noun: "session")
    }
}

// Summarises once per seat and re-reads only when a shelf's modification stamp moves: windmill-gym-sets.json (the live
// queue) and windmill-gym-local.json (unclaimed sessions). Main-actor: the cache needs no lock.
@MainActor
enum GymDevice {
    struct Summary: Equatable {
        let sessions: Int
        let routine: String?
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
        // No files is no gym on this device; the cache must not answer stale from it.
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
