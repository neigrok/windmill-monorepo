// THE LADDER — the one place in gym where a weight moves by a tap. There are three copies of this
// rule in Windmill — this one, web/src/products/gym/logger/ladder.js and Android's Ladder.kt —
// because there are three languages. What keeps them one rule is
// packages/api-contract/gym-ladder.json: every copy reads that file as a test, so a change here
// that the others do not make fails CI.
//
// The bands are read off the MAGNITUDE, so the ladder behaves the same on the negative side of
// zero — band-assisted pull-ups sit at −20 kg, a point on the number line and never a mode. The
// step buttons do not clamp; only typed entry is bounded.

public enum Ladder {
    public struct Band: Sendable {
        public let under: Double?
        public let small: Double
        public let large: Double
    }

    // The golden's `bands` array, same rows in the same order. A band added there and not here is
    // exactly the drift LadderTests exists to catch.
    //
    // RETIERED 2026-08-11: the FINE button is the program step and the COARSE button is a plate
    // change. The mined tiers put ±2 and ±5 in the middle band and ±5/±10 above it, which left the
    // +2.5 kg step a barbell program is written in off the ladder entirely above 50 kg — 85 was not
    // reachable from 82.5 at any depth, only through the keypad.
    public static let bands = [
        Band(under: 20, small: 1, large: 2.5),
        Band(under: 50, small: 2.5, large: 5),
        Band(under: nil, small: 2.5, large: 10),
    ]

    // A move that lightens the load reads the band JUST BELOW the magnitude, so the +1 that carried
    // you 19 → 20 is answered by a −1 back to 19 rather than a −2.5 down to 17.5. That is the whole
    // difference, and it is one comparison: `<` tightens to `<=`. It is the limit of `magnitude − ε`
    // with no epsilon to pick. It buys reversibility at the edge and nowhere else: 19.5 +1→ 20.5
    // −2.5→ 18 crosses a boundary rather than landing on it, and does not come back.
    public static func steps(magnitude: Double, lightening: Bool) -> (small: Double, large: Double) {
        let band = bands[self.band(magnitude: magnitude, lightening: lightening)]
        return (band.small, band.large)
    }

    // Which row of the table a load sits in. The open top band (`under: nil`) answers true without
    // comparing, so it catches NaN too and the fallback is unreachable — it is written out because
    // the compiler cannot know that. The web copy spells its top band `Infinity` and DOES compare, so
    // NaN falls through there and it needs a live fallback. Neither surface may throw on a weight
    // rehydrated from storage.
    static func band(magnitude: Double, lightening: Bool) -> Int {
        bands.firstIndex { band in
            guard let under = band.under else { return true }
            return lightening ? magnitude <= under : magnitude < under
        } ?? bands.count - 1
    }

    // The caption §K hangs under the buttons — `over 50 kg · fine 2.5 · plate 10`. It is READ OFF THE
    // TABLE and never typed beside it, so a retier moves the caption in the same edit that moves the
    // steps.
    //
    // IT READS THE BUTTONS' OWN TWO ROWS, not one of them. ON A BOUNDARY the reversibility rule above
    // sends the DOWN pair to the row below — at exactly 20 kg the buttons are −2.5 −1 +2.5 +5, which
    // is the design's own "from exactly 20 kg, down lands on 19" — and a single `fine 2.5` over that
    // would contradict the button it is drawn under, at the load an empty bar opens on. So a step
    // whose two directions differ is spelled ↓ and ↑, and the caption says exactly what the four
    // buttons do. Everywhere else the two rows agree and the line is §K's, unchanged.
    //
    // The band is the MAGNITUDE's, because the ladder is: band-assisted work at −20 kg steps like
    // 20 kg does. The `±` says so where it matters, rather than telling a lifter looking at −20 kg
    // that they are between 20 and 50.
    public static func caption(for weight: Double) -> String {
        let magnitude = abs(weight)
        let down = steps(magnitude: magnitude, lightening: weight > 0)
        let up = steps(magnitude: magnitude, lightening: weight < 0)
        let fine = down.small == up.small
            ? "fine \(text(up.small))"
            : "fine \(text(down.small))↓ \(text(up.small))↑"
        let plate = down.large == up.large
            ? "plate \(text(up.large))"
            : "plate \(text(down.large))↓ \(text(up.large))↑"
        let moves = "\(fine) · \(plate)"
        let index = band(magnitude: magnitude, lightening: false)
        let row = bands[index]
        let sign = weight < 0 ? "±" : ""
        // A row is named by the bounds it has: the first has no floor, the last no ceiling, and a
        // table of one row names no band at all.
        switch (index == 0 ? nil : bands[index - 1].under, row.under) {
        case (nil, let ceiling?): return "under \(sign)\(text(ceiling)) kg · \(moves)"
        case (let floor?, nil): return "over \(sign)\(text(floor)) kg · \(moves)"
        case (let floor?, let ceiling?):
            return "\(sign)\(text(floor))–\(text(ceiling)) kg · \(moves)"
        case (nil, nil): return moves
        }
    }

    // Half away from zero, which `.rounded()` already is — and it is a law, not a default, because
    // it is the mirror symmetry one level down: round(−x) must equal −round(x). JS `Math.round` is
    // half-UP and breaks that, so the web copy rounds the magnitude and reapplies the sign to land
    // here. No ladder step ever reaches a tie; typed entry does — a lifter keying −2.505 is what
    // makes the two surfaces disagree, and `roundCases` in the golden pins them.
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

    // Steps print bare: the golden reads "−5" and "+10", never "−5.0". The minus is U+2212, the
    // plus is ASCII — both copies must agree on the glyph, not just the number.
    static func text(_ step: Double) -> String {
        if step == step.rounded() { return String(Int(step)) }
        return String(step)
    }

    // A set of zero reps is not a set, and the server says so — Training.cpp refuses reps < 1 — so a
    // ladder that floored at 0 offered a tap the log could only answer with a refusal. The floor is a
    // CLAMP INTO the range and never a hold at the value: a stored 0 from an older build is climbed
    // out of by whichever button the thumb finds first. repCases pins that answer for both languages.
    public static func bumpReps(_ reps: Int, direction: Int) -> Int {
        if direction < 0 { return max(1, reps - 1) }
        return reps + 1
    }
}
