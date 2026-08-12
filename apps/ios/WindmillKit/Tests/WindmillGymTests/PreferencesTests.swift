import XCTest
@testable import WindmillGym

// The settings document, both ways over the wire, and the one promise it makes: kilograms are the
// only thing stored. A lifter who never opens the screen is served defaults that beep at nobody.

final class PreferencesTests: XCTestCase {
    // §2's defaults, and the one that matters most is the absence: rest is OFF until asked for.
    func testTheDefaultsServeALifterWhoNeverOpensTheScreen() {
        let defaults = GymPreferences.defaults
        XCTAssertEqual(defaults.units, .kg)
        XCTAssertEqual(defaults.barWeightKg, 20)
        XCTAssertEqual(defaults.platesKg, [25, 20, 15, 10, 5, 2.5, 1.25])
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

    // The whole document travels in both directions, and what comes back is what went out.
    func testTheDocumentRoundTrips() throws {
        let held = GymPreferences(units: .lb, barWeightKg: 20.41, platesKg: [20.41, 11.34],
                                  restSeconds: 180, restSound: false,
                                  confirmHaptic: false, confirmSound: true)
        let read = try JSONDecoder().decode(GymPreferences.self,
                                            from: try JSONEncoder().encode(held))
        XCTAssertEqual(read, held)
    }

    // A read defaults rather than throws, field by field: a document from a build that stored fewer
    // fields, or a unit this one has never heard of, opens the room instead of taking it down.
    func testAThinOrUnknownDocumentReadsAsTheDefaults() throws {
        let thin = Data(#"{"barWeightKg":15}"#.utf8)
        let read = try JSONDecoder().decode(GymPreferences.self, from: thin)
        XCTAssertEqual(read, GymPreferences.defaults.with(barWeightKg: 15))

        let strange = Data(#"{"units":"stone","platesKg":"all of them"}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(GymPreferences.self, from: strange),
                       GymPreferences.defaults)
    }

    // An empty plate set is a REAL answer — this gym owns no plates — and must survive the trip as
    // itself rather than falling back to the full set.
    func testAGymThatOwnsNoPlatesSaysSoAndKeepsSayingIt() throws {
        let bare = GymPreferences(platesKg: [])
        let read = try JSONDecoder().decode(GymPreferences.self, from: try JSONEncoder().encode(bare))
        XCTAssertEqual(read.platesKg, [])
    }

    // Normalised the same way the store answers, so the chips read the same before a reply as after
    // one: heaviest first, one of each, and nothing outside the band the wire will take.
    func testPlatesAreSortedDedupedAndBounded() {
        XCTAssertEqual(GymPreferences(platesKg: [2.5, 25, 2.5, 10]).platesKg, [25, 10, 2.5])
        XCTAssertEqual(GymPreferences(platesKg: [25, 0, -5, 200, 100]).platesKg, [100, 25])
        XCTAssertEqual(GymPreferences(barWeightKg: 250).barWeightKg, 100)
        XCTAssertEqual(GymPreferences(barWeightKg: -1).barWeightKg, 0)
        XCTAssertEqual(GymPreferences(restSeconds: 5).restSeconds, 15)
        XCTAssertEqual(GymPreferences(restSeconds: 4000).restSeconds, 900)
    }

    // THE THIRTEENTH KIND IS REFUSED, NOT DROPPED. The log holds twelve kinds of plate and says so
    // out loud (`domain/Preferences`, `too-many-plates`); the screen asks this before it turns a chip
    // on, so a gym at the ceiling is TOLD rather than quietly losing the 0.5 it owns off the end of a
    // list — which would take that plate out of the logger's readout as well.
    func testTheThirteenthKindOfPlateIsRefusedRatherThanDroppedInSilence() {
        let full = GymPreferences(platesKg: [50, 45, 40, 35, 30, 25, 20, 15, 10, 2.5, 1.25, 0.5])
        XCTAssertEqual(full.platesKg.count, GymPreferences.maxPlateKinds)
        XCTAssertFalse(full.hasRoomFor(5))
        XCTAssertTrue(full.hasRoomFor(0.5), "one already owned fits — turning it off only frees room")
        XCTAssertTrue(full.toggling(0.5).hasRoomFor(5))
        XCTAssertTrue(GymPreferences.defaults.hasRoomFor(0.5))
        // The constructor goes on clamping, because a document that never came from a chip must not
        // take the room down — but that path now catches files and never taps.
        XCTAssertEqual(GymPreferences(platesKg: full.platesKg + [5]).platesKg.count,
                       GymPreferences.maxPlateKinds)
    }

    // A chip is toggled off and back on, and the rest of the document does not move — every write is
    // the whole document, so the four values nobody touched have to survive the round.
    func testTogglingAPlateChangesNothingElse() {
        let held = GymPreferences.defaults.resting(120).with(confirmSound: true)
        let without = held.toggling(1.25)
        XCTAssertFalse(without.owning(1.25))
        XCTAssertEqual(without.restSeconds, 120)
        XCTAssertTrue(without.confirmSound)
        XCTAssertEqual(without.toggling(1.25), held, "back on is back where it started")
    }

    // THE RULE THIS WAVE MAY NOT BREAK. Units are a display answer; kilograms are what is stored, and
    // there is no conversion constant anywhere in gym's Swift to store anything else with.
    func testUnitsReachNoNumber() {
        let inPounds = GymPreferences.defaults.with(units: .lb)
        XCTAssertEqual(inPounds.barWeightKg, GymPreferences.defaults.barWeightKg)
        XCTAssertEqual(inPounds.platesKg, GymPreferences.defaults.platesKg)
        XCTAssertEqual(Plates.readout(totalKg: 105, under: inPounds),
                       Plates.readout(totalKg: 105, under: .defaults))
        XCTAssertEqual(Readout.weight(102.5), "102.5")
    }
}
