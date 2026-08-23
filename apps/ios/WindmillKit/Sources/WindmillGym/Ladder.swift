// Pinned against packages/api-contract/gym-ladder.json, as are web/src/products/gym/logger/ladder.js and Android's Ladder.kt.
// Bands are read off the magnitude, so the ladder behaves the same below zero.

public enum Ladder {
    public struct Band: Sendable {
        public let under: Double?
        public let small: Double
        public let large: Double
    }

    public static let bands = [
        Band(under: 20, small: 1, large: 2.5),
        Band(under: 50, small: 2.5, large: 5),
        Band(under: nil, small: 2.5, large: 10),
    ]

    // Lightening reads the band just below the magnitude, so a +1 that carried 19 → 20 is answered by −1.
    public static func steps(magnitude: Double, lightening: Bool) -> (small: Double, large: Double) {
        let band = bands[self.band(magnitude: magnitude, lightening: lightening)]
        return (band.small, band.large)
    }

    static func band(magnitude: Double, lightening: Bool) -> Int {
        bands.firstIndex { band in
            guard let under = band.under else { return true }
            return lightening ? magnitude <= under : magnitude < under
        } ?? bands.count - 1
    }

    // Half away from zero: round(−x) must equal −round(x).
    public static func round(_ weight: Double) -> Double {
        (weight * 100).rounded() / 100
    }

    public static func bump(weight: Double, direction: Int, big: Bool) -> Double {
        let step = steps(magnitude: abs(weight), lightening: Double(direction) * weight < 0)
        return round(weight + Double(direction) * (big ? step.large : step.small))
    }

    public static func labels(for weight: Double) -> [String] {
        let down = steps(magnitude: abs(weight), lightening: weight > 0)
        let up = steps(magnitude: abs(weight), lightening: weight < 0)
        return ["−\(text(down.large))", "−\(text(down.small))", "+\(text(up.small))", "+\(text(up.large))"]
    }

    // Steps print bare ("−5", not "−5.0"); the minus is U+2212, the plus ASCII.
    static func text(_ step: Double) -> String {
        if step == step.rounded() { return String(Int(step)) }
        return String(step)
    }

    // The server refuses reps < 1, and the floor clamps INTO the range rather than holding at the
    // value: a stored 0 climbs out on either key, so `bumpReps(0, -1)` is 1. `repCases` pins it.
    public static func bumpReps(_ reps: Int, direction: Int) -> Int {
        if direction < 0 { return max(1, reps - 1) }
        return reps + 1
    }
}
