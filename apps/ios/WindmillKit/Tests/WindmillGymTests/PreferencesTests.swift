import XCTest
@testable import WindmillGym

// The settings document, both ways over the wire, and the one promise it makes: kilograms are the
// only thing stored. A lifter who never opens the screen is served defaults that beep at nobody.

final class PreferencesTests: XCTestCase {
    // §2's defaults, and the one that matters most is the absence: rest is OFF until asked for.
    func testTheDefaultsServeALifterWhoNeverOpensTheScreen() {
        let defaults = GymPreferences.defaults
        XCTAssertEqual(defaults.units, .kg)
        XCTAssertNil(defaults.restSeconds)
        XCTAssertTrue(defaults.restSound)
        XCTAssertTrue(defaults.confirmHaptic)
        XCTAssertFalse(defaults.confirmSound)
    }

    // A rest target that is off is OMITTED, never sent as null or as a zero: absence is the only way
    // the wire spells "no timer", and a zero would be a fifteen-second refusal.
    func testAnOffTimerIsOmittedFromTheDocument() throws {
        let written = try String(decoding: JSONEncoder().encode(GymPreferences.defaults), as: UTF8.self)
        XCTAssertFalse(written.contains("restSeconds"))
        XCTAssertTrue(written.contains("\"units\":\"kg\""))

        let dialled = try String(decoding: JSONEncoder().encode(GymPreferences.defaults.resting(90)),
                                 as: UTF8.self)
        XCTAssertTrue(dialled.contains("\"restSeconds\":90"))
    }

    // NOTHING ABOUT EQUIPMENT TRAVELS ANY MORE, and this is where that is pinned rather than assumed.
    // The bar weight and the plate set left the product on 2026-08-13, so a document carrying them is
    // a document from an older build — it opens on the defaults and takes nothing of theirs with it.
    func testEquipmentIsGoneFromTheDocumentInBothDirections() throws {
        let written = try String(decoding: JSONEncoder().encode(GymPreferences.defaults), as: UTF8.self)
        XCTAssertFalse(written.contains("platesKg"))
        XCTAssertFalse(written.contains("barWeightKg"))

        let older = Data(#"{"units":"lb","barWeightKg":15,"platesKg":[25,20]}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(GymPreferences.self, from: older),
                       GymPreferences.defaults.with(units: .lb))
    }

    // The whole document travels in both directions, and what comes back is what went out.
    func testTheDocumentRoundTrips() throws {
        let held = GymPreferences(units: .lb, restSeconds: 180, restSound: false,
                                  confirmHaptic: false, confirmSound: true)
        let read = try JSONDecoder().decode(GymPreferences.self,
                                            from: try JSONEncoder().encode(held))
        XCTAssertEqual(read, held)
    }

    // A read defaults rather than throws, field by field: a document from a build that stored fewer
    // fields, or a unit this one has never heard of, opens the room instead of taking it down.
    func testAThinOrUnknownDocumentReadsAsTheDefaults() throws {
        let thin = Data(#"{"restSound":false}"#.utf8)
        let read = try JSONDecoder().decode(GymPreferences.self, from: thin)
        XCTAssertEqual(read, GymPreferences.defaults.with(restSound: false))

        let strange = Data(#"{"units":"stone","restSound":"loudly"}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(GymPreferences.self, from: strange),
                       GymPreferences.defaults)
    }

    // Clamped the same way the store bounds it, so a dial reads the same before a reply as after one.
    func testTheRestTargetIsBoundedToTheBandTheWireWillTake() {
        XCTAssertEqual(GymPreferences(restSeconds: 5).restSeconds, 15)
        XCTAssertEqual(GymPreferences(restSeconds: 4000).restSeconds, 900)
        XCTAssertEqual(GymPreferences(restSeconds: 120).restSeconds, 120)
    }

    // Every write is the WHOLE document, so a row that changes one value has to leave the rest where
    // it stood — and `resting(nil)` has to be able to say "off", which an optional argument could not.
    func testOneRowChangesAndTheRestOfTheDocumentDoesNotMove() {
        let held = GymPreferences.defaults.resting(120).with(confirmSound: true)
        let quiet = held.with(restSound: false)
        XCTAssertEqual(quiet.restSeconds, 120)
        XCTAssertTrue(quiet.confirmSound)
        XCTAssertFalse(quiet.restSound)
        XCTAssertNil(held.resting(nil).restSeconds)
    }

    // THE RULE THIS WAVE MAY NOT BREAK. Units are a display answer; kilograms are what is stored, and
    // there is no conversion constant anywhere in gym's Swift to store anything else with.
    func testUnitsReachNoNumber() {
        let inPounds = GymPreferences.defaults.resting(90).with(units: .lb)
        XCTAssertEqual(inPounds.restSeconds, 90)
        XCTAssertEqual(Readout.weight(102.5), "102.5")
    }
}
