import XCTest
@testable import WindmillGym

// The line under the numeral has one job: be TRUE. It says what would go on the bar, and when this
// gym's plates cannot make the number it says that instead and names what can be made — because the
// ladder does not read the inventory (§1) and the buttons will keep offering the weight.

final class PlatesTests: XCTestCase {
    private let standard = GymPreferences.defaults

    // The design's own example, and the arithmetic it has to satisfy: 105 on a 20 kg bar is 42.5 a
    // side, which the standard set makes from a 25, a 15 and a 2.5.
    func testAStandardSquatReadsAsWhatGoesOnTheBar() {
        XCTAssertEqual(Plates.loading(totalKg: 105, under: standard),
                       .loaded([Plates.Plate(weightKg: 25, count: 1),
                                Plates.Plate(weightKg: 15, count: 1),
                                Plates.Plate(weightKg: 2.5, count: 1)]))
        XCTAssertEqual(Plates.readout(totalKg: 105, under: standard),
                       "20 + 25 + 15 + 2.5 per side")
    }

    // A repeated plate is counted rather than repeated, which is the design's `25·2`.
    func testARepeatedPlateIsCounted() {
        XCTAssertEqual(Plates.readout(totalKg: 140, under: standard), "20 + 25·2 + 10 per side")
    }

    func testTheBareBarSaysSo() {
        XCTAssertEqual(Plates.loading(totalKg: 20, under: standard), .bare)
        XCTAssertEqual(Plates.readout(totalKg: 20, under: standard), "20 · bar only")
    }

    // THE WHOLE POINT. A gym with no 1.25s cannot make 102.5, and the readout says which two loads it
    // can — rather than a button quietly refusing to offer the weight.
    func testAWeightThisGymCannotLoadIsNamedWithItsNeighbours() {
        let noFines = standard.toggling(1.25)
        XCTAssertFalse(noFines.owning(1.25))
        XCTAssertEqual(Plates.loading(totalKg: 102.5, under: noFines),
                       .impossible(under: 100, over: 105))
        XCTAssertEqual(Plates.readout(totalKg: 102.5, under: noFines),
                       "102.5 won’t load with these plates — 100 or 105")
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
        XCTAssertEqual(Plates.loading(totalKg: 21.25, under: standard),
                       .impossible(under: 20, over: 22.5))
    }

    // A gym that owns no plates at all still owns a bar, and the bar is the only load there is.
    func testAGymWithNoPlatesHasOneLoadableWeight() {
        let bareGym = GymPreferences(platesKg: [])
        XCTAssertEqual(bareGym.platesKg, [])
        XCTAssertEqual(Plates.loading(totalKg: 20, under: bareGym), .bare)
        XCTAssertEqual(Plates.loading(totalKg: 60, under: bareGym), .impossible(under: 20, over: nil))
        XCTAssertEqual(Plates.readout(totalKg: 60, under: bareGym),
                       "60 won’t load with these plates — 20")
    }

    // Under the bar there is nothing lighter to name, so only the load above is offered.
    func testALoadUnderTheBarNamesTheBar() {
        XCTAssertEqual(Plates.loading(totalKg: 15, under: standard), .impossible(under: nil, over: 20))
        XCTAssertEqual(Plates.readout(totalKg: 15, under: standard),
                       "15 won’t load with these plates — 20")
    }

    // NO BAR, NO SENTENCE. A lifter who set the bar to zero has said this is a machine or a pair of
    // dumbbells; there is nothing true to say about what goes on a bar that is not there. Same for
    // bodyweight at zero and band-assisted work below it, which are points on the number line.
    func testNoBarAndNoLoadDrawNoLine() {
        XCTAssertNil(Plates.loading(totalKg: 60, under: standard.with(barWeightKg: 0)))
        XCTAssertNil(Plates.readout(totalKg: 60, under: standard.with(barWeightKg: 0)))
        XCTAssertNil(Plates.readout(totalKg: 0, under: standard))
        XCTAssertNil(Plates.readout(totalKg: -20, under: standard))
        XCTAssertNil(Plates.readout(totalKg: .nan, under: standard))
        XCTAssertNil(Plates.readout(totalKg: .infinity, under: standard))
    }

    // A 45 lb bar is 20.41 kg on the wire and the arithmetic has to survive it: nothing rounds the
    // bar into a nicer number, and the readout stays honest about a load it cannot make.
    func testALbGymsBarSurvivesInKilograms() {
        let lbGym = GymPreferences(units: .lb, barWeightKg: 20.41, platesKg: [20.41, 11.34])
        XCTAssertEqual(Plates.loading(totalKg: 61.23, under: lbGym),
                       .loaded([Plates.Plate(weightKg: 20.41, count: 1)]))
        XCTAssertEqual(Plates.loading(totalKg: 61, under: lbGym),
                       .impossible(under: 43.09, over: 61.23))
    }

    // The finest plate is what the walk counts in, so a heavy load on a fine set is still a short
    // walk — and an inventory that would make it a long one draws no line rather than a wrong one.
    func testAnAbsurdInventoryDrawsNothingRatherThanGuessing() {
        XCTAssertNotNil(Plates.readout(totalKg: 400, under: GymPreferences(platesKg: [25, 1.25])))
        XCTAssertNil(Plates.readout(totalKg: 400, under: GymPreferences(platesKg: [25, 0.01])))
    }
}
