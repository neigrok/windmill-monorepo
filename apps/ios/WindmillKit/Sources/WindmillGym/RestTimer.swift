import Foundation

public enum Rest {
    // nil is a choice on the dial: no timer.
    public static let choices: [Int?] = [nil, 90, 120, 180]

    public static func target(planEntry: PlanEntry?, preferences: GymPreferences) -> Int? {
        planEntry?.restSeconds ?? preferences.restSeconds
    }

    // A chime later than this is dropped as a false confirmation.
    public static let lateChimeSeconds: Int64 = 5

    // Keyed on both fields: a target changed mid-rest replaces the scheduled sleep.
    public struct Clock: Equatable {
        public let startedAtMs: Int64
        public let targetSeconds: Int

        public init(startedAtMs: Int64, targetSeconds: Int) {
            self.startedAtMs = startedAtMs
            self.targetSeconds = targetSeconds
        }
    }

    public static func filled(targetSeconds: Int, startedAtMs: Int64, now: Int64) -> Double {
        guard targetSeconds > 0 else { return 1 }
        let elapsed = Double(now - startedAtMs) / 1000
        return min(1, max(0, elapsed / Double(targetSeconds)))
    }

    public static func reading(targetSeconds: Int, startedAtMs: Int64, now: Int64) -> String {
        let left = Int64(targetSeconds) - (now - startedAtMs) / 1000
        guard left < 0 else { return Readout.clock(left * 1000) }
        return "+" + Readout.clock(-left * 1000)
    }
}
