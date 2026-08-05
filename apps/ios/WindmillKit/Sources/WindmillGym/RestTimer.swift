import Foundation

// THE REST TIMER — a target per movement, and a value that is COMPUTED rather than counted. It reads
// the instant the set landed, never a remaining number it decrements, so a pocketed phone, a locked
// screen and a relaunch all come back to the truth instead of to however long the app stayed awake.
// The Swift statement of web/src/products/gym/logger/rest.js.
//
// Being over the target is not an error and must never look like one: the overrun counts UP, in
// steel, calm and quietly present. Nothing in this file may reach for alarm ink, and nothing here
// moves the lifter on — the rest landing is a fact, not an instruction.

public enum Rest {
    public static let defaultSeconds = 120

    // The design's own table. The accessories agree with the default on purpose: they are written
    // out so the rule reads as a decision rather than as an omission, and a movement the table has
    // never heard of — including one the lifter minted this morning — rests for two minutes.
    private static let seconds: [String: Int] = [
        "back-squat": 180,
        "bench-press": 180,
        "overhead-press": 180,
        "romanian-deadlift": 120,
        "chin-up": 120,
        "barbell-row": 120,
        "dip": 120,
        "face-pull": 60,
    ]

    // The routine's own line wins: a lifter who wrote three minutes against an accessory meant it,
    // and the table is only the answer for a movement nobody has said anything about.
    public static func target(_ exerciseId: String, planEntry: PlanEntry?) -> Int {
        planEntry?.restSeconds ?? seconds[exerciseId] ?? defaultSeconds
    }

    public struct Line: Equatable {
        public let label: String
        public let time: String
        public let overrun: Bool

        public init(targetSeconds: Int, startedAtMs: Int64, now: Int64) {
            let left = Int64(targetSeconds) - (now - startedAtMs) / 1000
            overrun = left < 0
            label = (overrun ? "rest done · target " : "resting · target ")
                + Readout.clock(Int64(targetSeconds) * 1000)
            time = overrun ? "+" + Readout.clock(-left * 1000) : Readout.clock(left * 1000)
        }
    }
}
