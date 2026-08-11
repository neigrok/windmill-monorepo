import XCTest
@testable import WindmillGym

// The ladder's truth is packages/api-contract/gym-ladder.json, read here straight out of the repo
// working tree — not copied into the test bundle as a resource. A copied fixture is a copy, and
// copies are the thing that package exists to prevent.

final class LadderTests: XCTestCase {
    struct Golden: Decodable {
        let bands: [GoldenBand]
        let weightCases: [WeightCase]
        let roundCases: [RoundCase]
        let repCases: [RepCase]
    }

    struct GoldenBand: Decodable {
        let under: Double?
        let small: Double
        let large: Double
    }

    struct WeightCase: Decodable {
        let weight: Double
        let labels: [String]
        let down: Double
        let downBig: Double
        let up: Double
        let upBig: Double
    }

    struct RoundCase: Decodable {
        let value: Double
        let rounded: Double
    }

    struct RepCase: Decodable {
        let reps: Int
        let down: Int
        let up: Int
    }

    // Every golden value sits on the 0.01 grid and is therefore exact as decimal — but binary
    // doubles are not, so 20.01 − 2 lands a few ulps off −22.01. The tolerance is for the
    // representation, never for the rule.
    let tolerance = 1e-9

    // Walk up from this file until the golden turns up, rather than counting directories: a
    // hard-coded depth is a tripwire that fires the day the package moves, and this suite is
    // exactly the thing that must not quietly stop finding its contract when that happens.
    static let goldenURL: URL = {
        let relative = "packages/api-contract/gym-ladder.json"
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory = directory.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(relative)
    }()

    var golden: Golden!

    override func setUpWithError() throws {
        // A golden that cannot be found must fail the suite, never quietly skip it — an unrun
        // contract is drift nobody sees. The throw stops the bodies from running on nil.
        if !FileManager.default.fileExists(atPath: Self.goldenURL.path) {
            XCTFail("ladder golden not found at \(Self.goldenURL.path) — this suite reads the repo's packages/api-contract/gym-ladder.json, not a bundled copy")
        }
        golden = try JSONDecoder().decode(Golden.self, from: Data(contentsOf: Self.goldenURL))
    }

    // A loop over an empty array is a green test, so every case-driven test below is only as honest
    // as the fixture is full. Emptying it disarms BOTH languages at once from a file neither owns —
    // exactly the move someone makes to turn a red build green.
    func testTheGoldenStillCarriesItsCases() {
        XCTAssertEqual(golden.bands.count, 3, "the golden's band table changed shape")
        XCTAssertGreaterThanOrEqual(golden.weightCases.count, 22, "weightCases shrank to \(golden.weightCases.count)")
        XCTAssertGreaterThanOrEqual(golden.roundCases.count, 8, "roundCases shrank to \(golden.roundCases.count)")
        XCTAssertGreaterThanOrEqual(golden.repCases.count, 4, "repCases shrank to \(golden.repCases.count)")
        // Both signs must survive. The assisted rows are the only ones that kill a rule read off the
        // SIGNED weight, which makes them the first thing a pruner mistakes for redundant.
        XCTAssertTrue(golden.weightCases.contains { $0.weight < 0 }, "no assisted weights left")
        XCTAssertTrue(golden.weightCases.contains { $0.weight > 0 }, "no loaded weights left")
    }

    // A weight is rehydrated from storage on both surfaces, so it is not always a number a lifter
    // typed. Swift cannot fall off the band table the way JS can, but the ANSWER still has to match:
    // anything unorderable reads the top band.
    func testUnorderableWeightReadsTheTopBand() {
        for value in [Double.nan, .infinity, -.infinity] {
            for lightening in [false, true] {
                let step = Ladder.steps(magnitude: abs(value), lightening: lightening)
                XCTAssertEqual(step.small, 2.5, accuracy: tolerance, "small step at \(value), lightening \(lightening)")
                XCTAssertEqual(step.large, 10, accuracy: tolerance, "large step at \(value), lightening \(lightening)")
            }
        }
    }

    func testBandTableMatchesTheGolden() {
        XCTAssertEqual(Ladder.bands.count, golden.bands.count, "the Swift band table and the golden's bands are different lengths")
        for (index, expected) in golden.bands.enumerated() {
            let band = Ladder.bands[index]
            XCTAssertEqual(band.under, expected.under, "band \(index) boundary")
            XCTAssertEqual(band.small, expected.small, accuracy: tolerance, "band \(index) small step")
            XCTAssertEqual(band.large, expected.large, accuracy: tolerance, "band \(index) large step")
        }
    }

    func testEveryWeightCase() {
        for expected in golden.weightCases {
            let weight = expected.weight
            XCTAssertEqual(Ladder.labels(for: weight), expected.labels, "labels at \(weight) kg")
            XCTAssertEqual(Ladder.bump(weight: weight, direction: -1, big: false), expected.down, accuracy: tolerance, "down at \(weight) kg")
            XCTAssertEqual(Ladder.bump(weight: weight, direction: -1, big: true), expected.downBig, accuracy: tolerance, "down big at \(weight) kg")
            XCTAssertEqual(Ladder.bump(weight: weight, direction: 1, big: false), expected.up, accuracy: tolerance, "up at \(weight) kg")
            XCTAssertEqual(Ladder.bump(weight: weight, direction: 1, big: true), expected.upBig, accuracy: tolerance, "up big at \(weight) kg")
        }
    }

    // Every roundCase is an exact IEEE tie — the one place the two languages' default rounding
    // rules disagree, and reachable because typed entry rounds whatever the keypad accepts.
    func testEveryRoundCase() {
        for expected in golden.roundCases {
            XCTAssertEqual(Ladder.round(expected.value), expected.rounded, accuracy: tolerance, "round(\(expected.value))")
            XCTAssertEqual(Ladder.round(-expected.value), -Ladder.round(expected.value), accuracy: tolerance, "round(−x) == −round(x) at \(expected.value)")
        }
    }

    func testEveryRepCase() {
        for expected in golden.repCases {
            XCTAssertEqual(Ladder.bumpReps(expected.reps, direction: -1), expected.down, "down from \(expected.reps) reps")
            XCTAssertEqual(Ladder.bumpReps(expected.reps, direction: 1), expected.up, "up from \(expected.reps) reps")
        }
        // The floor is 1 because the server refuses reps < 1: at 0 the logger drew a tappable set the
        // log could only answer with a refusal. The golden pins 1 and the stored 0; anything below
        // that is unreachable through the UI, and the down key still answers there — by climbing.
        XCTAssertEqual(Ladder.bumpReps(-3, direction: -1), 1)
    }

    // The law that makes one rule serve both sides of zero: bump(−w, −direction, big) is exactly
    // −bump(w, direction, big). An implementation that reads its down-band off the SIGNED weight
    // gets the loaded side right and breaks here.
    func testMirrorSymmetry() {
        for expected in golden.weightCases {
            for direction in [-1, 1] {
                for big in [false, true] {
                    XCTAssertEqual(
                        Ladder.bump(weight: -expected.weight, direction: -direction, big: big),
                        -Ladder.bump(weight: expected.weight, direction: direction, big: big),
                        accuracy: tolerance,
                        "mirror at \(expected.weight) kg, direction \(direction), big \(big)"
                    )
                }
            }
        }
    }
}
