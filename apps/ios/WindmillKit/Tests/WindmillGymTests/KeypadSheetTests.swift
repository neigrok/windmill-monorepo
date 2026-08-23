import XCTest
@testable import WindmillGym

final class KeypadEntryTests: XCTestCase {
    private func pad(_ text: String) -> KeypadEntry.Pad {
        KeypadEntry.Pad(opening: "0").pressing("0", in: .weight).backspaced.typing(text)
    }

    func testTheFirstDigitReplacesTheSeededNumberAndTheNextOneAppends() {
        let opened = KeypadEntry.Pad(opening: "102.5")
        XCTAssertEqual(opened.echo, "102.5")
        XCTAssertEqual(opened.pressing("9", in: .weight).text, "9")
        XCTAssertEqual(opened.pressing("9", in: .weight).pressing("5", in: .weight).text, "95")
    }

    func testTheSignAndTheBackspaceEditTheSeededNumberRatherThanReplacingIt() {
        let opened = KeypadEntry.Pad(opening: "20")
        XCTAssertEqual(opened.pressing("±", in: .weight).text, "-20")
        XCTAssertEqual(opened.pressing("±", in: .weight).echo, "\u{2212}20")
        XCTAssertEqual(opened.pressing("±", in: .weight).pressing("±", in: .weight).text, "20")
        XCTAssertEqual(opened.backspaced.text, "2")
    }

    func testTheCommaAndTheSignAreInertInRepsModeAndTheKeysDoNotMove() {
        XCTAssertEqual(KeypadEntry.keys.count, 12)
        XCTAssertFalse(KeypadEntry.isLive(",", in: .reps))
        XCTAssertFalse(KeypadEntry.isLive("±", in: .reps))
        XCTAssertTrue(KeypadEntry.isLive(",", in: .weight))
        XCTAssertEqual(KeypadEntry.Pad(opening: "5").pressing("±", in: .reps).text, "5")
    }

    func testABufferAtItsLimitRefusesTheKeyRatherThanDroppingOne() {
        let full = pad("12345678")
        XCTAssertEqual(full.text.count, KeypadEntry.maxBuffer)
        XCTAssertEqual(full.pressing("9", in: .weight).text, "12345678")
        XCTAssertEqual(full.pressing("±", in: .weight).text, "12345678", "and the sign needs room too")
    }

    func testAnEmptyBufferNamesTheNumberCancelWouldKeep() {
        let reading = KeypadEntry.read(KeypadEntry.Pad(opening: ""), as: .weight, keeping: 102.5)
        XCTAssertFalse(reading.isValid)
        XCTAssertEqual(reading.message, "Enter a number, or cancel to keep 102.5")
        XCTAssertEqual(KeypadEntry.Pad(opening: "").echo, "—")
    }

    func testACommaAndAPointBothReadAsADecimal() {
        XCTAssertEqual(KeypadEntry.read(pad("72,5"), as: .weight, keeping: 0).value, 72.5)
        XCTAssertEqual(KeypadEntry.read(pad("72.5"), as: .weight, keeping: 0).value, 72.5)
        XCTAssertEqual(KeypadEntry.read(pad("72,5"), as: .weight, keeping: 0).message, KeypadEntry.weightHint)
    }

    func testASecondDecimalPointNamesTheProblemAndTeachesTheFormat() {
        let reading = KeypadEntry.read(pad("10,2,5"), as: .weight, keeping: 0)
        XCTAssertNil(reading.value)
        XCTAssertEqual(reading.message, "One decimal point only — 72,5 or 72.5")
    }

    func testANegativeWeightIsAValidLoad() {
        XCTAssertEqual(KeypadEntry.read(pad("-20"), as: .weight, keeping: 0).value, -20)
    }

    func testThePadOpenedOnABandAssistedLoadReadsItBackRatherThanRefusingIt() {
        let opened = KeypadEntry.Pad(opening: Readout.weight(-20))

        XCTAssertEqual(Readout.weight(-20), "\u{2212}20", "the readout is typographic, and that is right")
        XCTAssertEqual(opened.text, "-20", "the buffer is ASCII, so the number can be read back")
        XCTAssertEqual(opened.echo, "\u{2212}20", "and the echo spells it the way the screen does")

        let reading = KeypadEntry.read(opened, as: .weight, keeping: -20)
        XCTAssertEqual(reading.value, -20)
        XCTAssertEqual(reading.message, KeypadEntry.weightHint)

        XCTAssertEqual(opened.pressing("±", in: .weight).text, "20", "and ± repairs rather than doubling the sign")
        XCTAssertEqual(KeypadEntry.read(KeypadEntry.Pad(opening: Readout.weight(82.5)),
                                        as: .weight, keeping: 0).value, 82.5)
    }

    func testAWeightOverTheCeilingIsQuestionedRatherThanCommitted() {
        let reading = KeypadEntry.read(pad("5000"), as: .weight, keeping: 0)
        XCTAssertNil(reading.value)
        XCTAssertEqual(reading.message, "Over 500 kg — check the number")
        XCTAssertEqual(KeypadEntry.read(pad("500"), as: .weight, keeping: 0).value, 500)
    }

    func testZeroRepsIsRefusedHereBecauseTheLogRefusesItThere() {
        let zero = KeypadEntry.read(pad("0"), as: .reps, keeping: 5)
        XCTAssertNil(zero.value)
        XCTAssertEqual(zero.message, "Whole reps, 1 to 99")
        XCTAssertEqual(KeypadEntry.read(pad("1"), as: .reps, keeping: 5).value, 1)
        XCTAssertEqual(KeypadEntry.read(pad("99"), as: .reps, keeping: 5).value, 99)
        XCTAssertNil(KeypadEntry.read(pad("100"), as: .reps, keeping: 5).value)
    }

    func testATypedWeightIsRoundedOnTheLaddersGrid() {
        XCTAssertEqual(KeypadEntry.read(pad("102,505"), as: .weight, keeping: 0).value, 102.51)
    }
}

private extension KeypadEntry.Pad {
    func typing(_ text: String) -> KeypadEntry.Pad {
        text.reduce(self) { pad, character in
            character == "-" ? pad.pressing("±", in: .weight) : pad.pressing(String(character), in: .weight)
        }
    }
}
