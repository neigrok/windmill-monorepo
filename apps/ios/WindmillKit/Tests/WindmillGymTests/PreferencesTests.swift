import XCTest
@testable import WindmillGym

final class PreferencesTests: XCTestCase {
    func testTheDefaultsServeALifterWhoNeverOpensTheScreen() {
        let defaults = GymPreferences.defaults
        XCTAssertEqual(defaults.units, .kg)
        XCTAssertNil(defaults.restSeconds)
        XCTAssertTrue(defaults.restSound)
        XCTAssertTrue(defaults.confirmHaptic)
        XCTAssertFalse(defaults.confirmSound)
    }

    func testAnOffTimerIsOmittedFromTheDocument() throws {
        let written = try String(decoding: JSONEncoder().encode(GymPreferences.defaults), as: UTF8.self)
        XCTAssertFalse(written.contains("restSeconds"))
        XCTAssertTrue(written.contains("\"units\":\"kg\""))

        let dialled = try String(decoding: JSONEncoder().encode(GymPreferences.defaults.resting(90)),
                                 as: UTF8.self)
        XCTAssertTrue(dialled.contains("\"restSeconds\":90"))
    }

    func testEquipmentIsGoneFromTheDocumentInBothDirections() throws {
        let written = try String(decoding: JSONEncoder().encode(GymPreferences.defaults), as: UTF8.self)
        XCTAssertFalse(written.contains("platesKg"))
        XCTAssertFalse(written.contains("barWeightKg"))

        let older = Data(#"{"units":"lb","barWeightKg":15,"platesKg":[25,20]}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(GymPreferences.self, from: older),
                       GymPreferences.defaults.with(units: .lb))
    }

    func testTheDocumentRoundTrips() throws {
        let held = GymPreferences(units: .lb, restSeconds: 180, restSound: false,
                                  confirmHaptic: false, confirmSound: true)
        let read = try JSONDecoder().decode(GymPreferences.self,
                                            from: try JSONEncoder().encode(held))
        XCTAssertEqual(read, held)
    }

    func testAThinOrUnknownDocumentReadsAsTheDefaults() throws {
        let thin = Data(#"{"restSound":false}"#.utf8)
        let read = try JSONDecoder().decode(GymPreferences.self, from: thin)
        XCTAssertEqual(read, GymPreferences.defaults.with(restSound: false))

        let strange = Data(#"{"units":"stone","restSound":"loudly"}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(GymPreferences.self, from: strange),
                       GymPreferences.defaults)
    }

    func testTheRestTargetIsBoundedToTheBandTheWireWillTake() {
        XCTAssertEqual(GymPreferences(restSeconds: 5).restSeconds, 15)
        XCTAssertEqual(GymPreferences(restSeconds: 4000).restSeconds, 900)
        XCTAssertEqual(GymPreferences(restSeconds: 120).restSeconds, 120)
    }

    func testOneRowChangesAndTheRestOfTheDocumentDoesNotMove() {
        let held = GymPreferences.defaults.resting(120).with(confirmSound: true)
        let quiet = held.with(restSound: false)
        XCTAssertEqual(quiet.restSeconds, 120)
        XCTAssertTrue(quiet.confirmSound)
        XCTAssertFalse(quiet.restSound)
        XCTAssertNil(held.resting(nil).restSeconds)
    }

    func testUnitsReachNoNumber() {
        let inPounds = GymPreferences.defaults.resting(90).with(units: .lb)
        XCTAssertEqual(inPounds.restSeconds, 90)
        XCTAssertEqual(Readout.weight(102.5), "102.5")
    }
}
