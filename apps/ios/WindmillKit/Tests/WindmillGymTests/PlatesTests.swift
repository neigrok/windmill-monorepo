import XCTest
@testable import WindmillGym

// The readout's truth is packages/api-contract/gym-plate-readout.json, read here straight out of the
// repo working tree — not copied into the test bundle as a resource. A copied fixture is a copy, and
// copies are the thing that package exists to prevent.
//
// The golden pins the ANSWER: which of the five, the decomposition when it is `loaded`, and the two
// totals a load this gym cannot make sits between. The SENTENCE is this room's own — three surfaces
// spell a number three ways — so the lines are asserted below the golden, where changing one cannot
// break the other two languages.

final class PlatesTests: XCTestCase {
    struct Golden: Decodable {
        let grid: Double
        let capKg: Double
        let cases: [Case]
    }

    struct Case: Decodable {
        let totalKg: Double
        let barWeightKg: Double
        let platesKg: [Double]
        let answer: String
        let perSide: [Side]?
        let belowKg: Double?
        let aboveKg: Double?
    }

    struct Side: Decodable {
        let kg: Double
        let count: Int
    }

    private let standard = GymPreferences.defaults

    // Walk up from this file until the golden turns up, rather than counting directories: a
    // hard-coded depth is a tripwire that fires the day the package moves, and this suite is exactly
    // the thing that must not quietly stop finding its contract when that happens.
    static let goldenURL: URL = {
        let relative = "packages/api-contract/gym-plate-readout.json"
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
        // A golden that cannot be found must fail the suite, never quietly skip it — an unrun contract
        // is drift nobody sees. The throw stops the bodies from running on nil.
        if !FileManager.default.fileExists(atPath: Self.goldenURL.path) {
            XCTFail("plate readout golden not found at \(Self.goldenURL.path) — this suite reads the repo's packages/api-contract/gym-plate-readout.json, not a bundled copy")
        }
        golden = try JSONDecoder().decode(Golden.self, from: Data(contentsOf: Self.goldenURL))
    }

    // A loop over an empty array is a green test, so the case-driven test below is only as honest as
    // the fixture is full. Emptying it disarms all THREE languages at once from a file none of them
    // owns — exactly the move someone makes to turn a red build green.
    func testTheGoldenStillCarriesItsCases() {
        XCTAssertGreaterThanOrEqual(golden.cases.count, 22, "cases shrank to \(golden.cases.count)")
        XCTAssertEqual(golden.grid, 0.01, "the hundredths this file counts in ARE the golden's grid")
        XCTAssertEqual(golden.capKg, Plates.capKg, "the cap moved in the golden and not in Swift")
        for answer in ["loaded", "bare", "underBar", "unloadable", "none"] {
            XCTAssertTrue(golden.cases.contains { $0.answer == answer }, "no \(answer) case left")
        }
        // The two RULED edges, and they are the two this copy had wrong — a bar of zero, and a load
        // under the bar. An edge that was argued over is the first case a pruner mistakes for noise.
        XCTAssertTrue(golden.cases.contains { $0.barWeightKg == 0 }, "no zero-bar case left")
        XCTAssertTrue(golden.cases.contains { $0.totalKg > 0 && $0.totalKg < $0.barWeightKg },
                      "no under-the-bar case left")
    }

    func testEveryCaseInTheGolden() {
        for expected in golden.cases {
            let gym = GymPreferences(barWeightKg: expected.barWeightKg, platesKg: expected.platesKg)
            let actual = Plates.loading(totalKg: expected.totalKg, under: gym)
            let load = "\(expected.totalKg) kg on a \(expected.barWeightKg) kg bar, plates \(expected.platesKg)"

            switch expected.answer {
            case "loaded":
                let side = (expected.perSide ?? []).map { Plates.Plate(weightKg: $0.kg, count: $0.count) }
                XCTAssertEqual(actual, .loaded(side), "per side at \(load)")
            case "bare":
                XCTAssertEqual(actual, .bare, "at \(load)")
            case "underBar":
                XCTAssertEqual(actual, .underBar, "at \(load)")
            case "unloadable":
                XCTAssertEqual(actual, .unloadable(below: expected.belowKg, above: expected.aboveKg),
                               "at \(load)")
            case "none":
                XCTAssertEqual(actual, Plates.Loading.none, "at \(load)")
            default:
                // A sixth answer is a rule this language has not been taught, and reading past it
                // would report agreement this suite never checked.
                XCTFail("the golden answers \"\(expected.answer)\" at \(load) and this suite has no case for it")
            }
        }
    }

    // THE SENTENCES, which the golden does not pin and this room owes anyway: every answer the type
    // can hold has a line, and the two the wave got wrong are lines a lifter has never read.
    func testEveryAnswerReadsAsALine() {
        XCTAssertEqual(Plates.readout(totalKg: 105, under: standard), "20 + 25 + 15 + 2.5 per side")
        // A repeated plate is counted rather than repeated, which is the design's `25·2`.
        XCTAssertEqual(Plates.readout(totalKg: 140, under: standard), "20 + 25·2 + 10 per side")
        XCTAssertEqual(Plates.readout(totalKg: 20, under: standard), "20 · bar only")
        XCTAssertEqual(Plates.readout(totalKg: 15, under: standard), "15 · lighter than the 20 bar")
        XCTAssertEqual(Plates.readout(totalKg: 102.5, under: standard.toggling(1.25)),
                       "102.5 won’t load with these plates — 100 or 105")
        XCTAssertNil(Plates.readout(totalKg: 60, under: standard.with(barWeightKg: 0)))
    }

    // THE WHOLE POINT. A gym with no 1.25s cannot make 102.5, and the readout says which two loads it
    // can — rather than a button quietly refusing to offer the weight.
    func testAWeightThisGymCannotLoadIsNamedWithItsNeighbours() {
        let noFines = standard.toggling(1.25)
        XCTAssertFalse(noFines.owning(1.25))
        XCTAssertEqual(Plates.loading(totalKg: 102.5, under: noFines), .unloadable(below: 100, above: 105))
        XCTAssertEqual(Plates.readout(totalKg: 102.5, under: standard),
                       "20 + 25 + 15 + 1.25 per side",
                       "the same weight loads fine for a gym that owns the 1.25s")
    }

    // GREEDY WOULD LIE HERE. A gym owning only 25s and 20s loads 40 a side as 20 + 20; greedy takes
    // the 25, cannot place the last 15 and reports a weight the lifter is standing under.
    func testAGymOfTwoPlatesLoadsWhatGreedyWouldCallImpossible() {
        let sparse = GymPreferences(platesKg: [25, 20])
        XCTAssertEqual(Plates.loading(totalKg: 100, under: sparse),
                       .loaded([Plates.Plate(weightKg: 20, count: 2)]))
        XCTAssertEqual(Plates.readout(totalKg: 100, under: sparse), "20 + 20·2 per side")
    }

    // An odd remainder cannot be split between two sides, however fine the plates are.
    func testAnOddRemainderIsNotLoadable() {
        XCTAssertEqual(Plates.loading(totalKg: 21.25, under: standard), .unloadable(below: 20, above: 22.5))
    }

    // A gym that owns no plates at all still owns a bar, and the bar is the only load there is.
    func testAGymWithNoPlatesHasOneLoadableWeight() {
        let bareGym = GymPreferences(platesKg: [])
        XCTAssertEqual(bareGym.platesKg, [])
        XCTAssertEqual(Plates.loading(totalKg: 20, under: bareGym), .bare)
        XCTAssertEqual(Plates.readout(totalKg: 60, under: bareGym), "60 won’t load with these plates — 20")
    }

    // NOT A LOAD AT ALL, and none of these reach the golden: a weight is rehydrated from storage on
    // this surface, so it is not always a number a lifter typed, and nothing here may draw a line
    // about a bar that is not there or a number that is not one.
    func testNothingTrueToSayDrawsNoLine() {
        for load in [0, -20, Double.nan, .infinity, -.infinity] {
            XCTAssertEqual(Plates.loading(totalKg: load, under: standard), Plates.Loading.none, "at \(load)")
            XCTAssertNil(Plates.readout(totalKg: load, under: standard), "at \(load)")
        }
    }

    // A 45 lb bar is 20.41 kg on the wire and the arithmetic has to survive it: nothing rounds the
    // bar into a nicer number, and the readout stays honest about a load it cannot make.
    func testALbGymsBarSurvivesInKilograms() {
        let lbGym = GymPreferences(units: .lb, barWeightKg: 20.41, platesKg: [20.41, 11.34])
        XCTAssertEqual(Plates.loading(totalKg: 61.23, under: lbGym),
                       .loaded([Plates.Plate(weightKg: 20.41, count: 1)]))
        XCTAssertEqual(Plates.loading(totalKg: 61, under: lbGym),
                       .unloadable(below: 43.09, above: 61.23))
    }

    // THE CAP IS THE ONLY BOUND LEFT, and it has to be enough on its own: half of it plus one plate is
    // the widest walk any inventory can ask for, so the finest legal plate at the heaviest legal load
    // must still answer. This file used to bail on a step count instead and drew NOTHING for a load
    // the other two surfaces read out — silence that no golden case could see.
    func testTheHeaviestLoadOnTheFinestPlatesStillAnswers() {
        let fine = GymPreferences(platesKg: [25, 0.01])
        XCTAssertEqual(Plates.readout(totalKg: 400, under: fine), "20 + 25·7 + 0.01·1500 per side")
        XCTAssertNotEqual(Plates.loading(totalKg: Plates.capKg, under: fine), Plates.Loading.none)
        XCTAssertEqual(Plates.loading(totalKg: Plates.capKg + 0.01, under: fine), Plates.Loading.none)
    }
}
