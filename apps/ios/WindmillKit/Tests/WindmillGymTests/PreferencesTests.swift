import XCTest
@testable import WindmillGym

final class PreferencesTests: XCTestCase {
    func testTheDefaultsServeALifterWhoNeverOpensTheScreen() {
        let defaults = GymPreferences.defaults
        XCTAssertEqual(defaults.units, .kg)
        XCTAssertNil(defaults.restSeconds)
        XCTAssertNil(defaults.restSound)
        XCTAssertTrue(defaults.confirmHaptic)
        XCTAssertFalse(defaults.confirmSound)
    }

    func testARestFieldThisPhoneNeverSetIsOmittedFromTheDocument() throws {
        let written = try String(decoding: JSONEncoder().encode(GymPreferences.defaults), as: UTF8.self)
        XCTAssertFalse(written.contains("restSeconds"))
        XCTAssertFalse(written.contains("restSound"))
        XCTAssertTrue(written.contains("\"units\":\"kg\""))
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

    // The web's rest dial lives in this document; the phone carries it through as written, whatever
    // the web wrote, so a settings tap here never resets a rest set there.
    func testTheWebsRestDialPassesThrough() throws {
        let fromTheWeb = Data(#"{"units":"kg","restSeconds":5,"restSound":false,"confirmHaptic":true,"confirmSound":false}"#.utf8)
        let read = try JSONDecoder().decode(GymPreferences.self, from: fromTheWeb)
        XCTAssertEqual(read.restSeconds, 5)
        XCTAssertEqual(read.restSound, false)

        let tapped = read.with(units: .lb, confirmSound: true)
        let sent = try String(decoding: JSONEncoder().encode(tapped), as: UTF8.self)
        XCTAssertTrue(sent.contains("\"restSeconds\":5"))
        XCTAssertTrue(sent.contains("\"restSound\":false"))
        XCTAssertEqual(GymPreferences(restSeconds: 4000).restSeconds, 4000, "no band is applied here")
    }

    func testAThinOrUnknownDocumentReadsAsTheDefaults() throws {
        let thin = Data(#"{"restSound":false}"#.utf8)
        let read = try JSONDecoder().decode(GymPreferences.self, from: thin)
        XCTAssertEqual(read, GymPreferences(restSound: false))

        let strange = Data(#"{"units":"stone","restSound":"loudly"}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(GymPreferences.self, from: strange),
                       GymPreferences.defaults)
    }

    func testOneRowChangesAndTheRestOfTheDocumentDoesNotMove() {
        let held = GymPreferences(restSeconds: 120, restSound: false).with(confirmSound: true)
        let quiet = held.with(confirmHaptic: false)
        XCTAssertEqual(quiet.restSeconds, 120)
        XCTAssertEqual(quiet.restSound, false)
        XCTAssertTrue(quiet.confirmSound)
        XCTAssertFalse(quiet.confirmHaptic)
    }

    func testUnitsReachNoNumber() {
        let inPounds = GymPreferences(restSeconds: 90).with(units: .lb)
        XCTAssertEqual(inPounds.restSeconds, 90)
        XCTAssertEqual(Readout.weight(102.5), "102.5")
    }
}
