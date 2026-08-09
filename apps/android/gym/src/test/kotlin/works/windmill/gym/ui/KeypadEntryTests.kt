package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.Readout

// The pad's one promise: an invalid entry never silently reverts, and never silently commits. Every
// case below is a way a chalked thumb gets a number wrong, and what the sheet says back about it.

class KeypadEntryTests {
    // Typing a whole string into a pad, key by key, the way a thumb would — onto an unseeded
    // empty buffer.
    private fun pad(text: String): KeypadEntry.Pad =
        text.fold(KeypadEntry.Pad(opening = "0").pressing("0", KeypadEntry.Mode.Weight).backspaced) { pad, character ->
            if (character == '-') pad.pressing("±", KeypadEntry.Mode.Weight)
            else pad.pressing(character.toString(), KeypadEntry.Mode.Weight)
        }

    // The pad opens ON the number it was opened from, and the first digit starts a fresh one rather
    // than appending to a value nobody typed — 102.5 then a 9 is 9, not 102.59.
    @Test
    fun testTheFirstDigitReplacesTheSeededNumberAndTheNextOneAppends() {
        val opened = KeypadEntry.Pad(opening = "102.5")
        assertEquals("102.5", opened.echo)
        assertEquals("9", opened.pressing("9", KeypadEntry.Mode.Weight).text)
        assertEquals("95", opened.pressing("9", KeypadEntry.Mode.Weight).pressing("5", KeypadEntry.Mode.Weight).text)
    }

    // ± and ⌫ are corrections, not entry: they edit what is there, so the seeded number survives them.
    @Test
    fun testTheSignAndTheBackspaceEditTheSeededNumberRatherThanReplacingIt() {
        val opened = KeypadEntry.Pad(opening = "20")
        assertEquals("-20", opened.pressing("±", KeypadEntry.Mode.Weight).text)
        assertEquals("−20", opened.pressing("±", KeypadEntry.Mode.Weight).echo)
        assertEquals("20", opened.pressing("±", KeypadEntry.Mode.Weight).pressing("±", KeypadEntry.Mode.Weight).text)
        assertEquals("2", opened.backspaced.text)
    }

    // In reps mode the comma and the ± are stood DOWN, not removed: the geometry a chalked thumb
    // learned must not move between the two numbers.
    @Test
    fun testTheCommaAndTheSignAreInertInRepsModeAndTheKeysDoNotMove() {
        assertEquals(12, KeypadEntry.keys.size)
        assertFalse(KeypadEntry.isLive(",", KeypadEntry.Mode.Reps))
        assertFalse(KeypadEntry.isLive("±", KeypadEntry.Mode.Reps))
        assertTrue(KeypadEntry.isLive(",", KeypadEntry.Mode.Weight))
        assertEquals("5", KeypadEntry.Pad(opening = "5").pressing("±", KeypadEntry.Mode.Reps).text)
    }

    // A key that does not fit is refused whole — never eat the digit under the thumb to make room.
    @Test
    fun testABufferAtItsLimitRefusesTheKeyRatherThanDroppingOne() {
        val full = pad("12345678")
        assertEquals(KeypadEntry.maxBuffer, full.text.length)
        assertEquals("12345678", full.pressing("9", KeypadEntry.Mode.Weight).text)
        assertEquals("and the sign needs room too", "12345678", full.pressing("±", KeypadEntry.Mode.Weight).text)
    }

    @Test
    fun testAnEmptyBufferNamesTheNumberCancelWouldKeep() {
        val reading = KeypadEntry.read(KeypadEntry.Pad(opening = ""), KeypadEntry.Mode.Weight, keeping = 102.5)
        assertFalse(reading.isValid)
        assertEquals("Enter a number, or cancel to keep 102.5", reading.message)
        assertEquals("—", KeypadEntry.Pad(opening = "").echo)
    }

    // A comma and a point both read as a decimal — one keyboard, two continents.
    @Test
    fun testACommaAndAPointBothReadAsADecimal() {
        assertEquals(72.5, KeypadEntry.read(pad("72,5"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
        assertEquals(72.5, KeypadEntry.read(pad("72.5"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
        assertEquals(KeypadEntry.weightHint, KeypadEntry.read(pad("72,5"), KeypadEntry.Mode.Weight, keeping = 0.0).message)
    }

    @Test
    fun testASecondDecimalPointNamesTheProblemAndTeachesTheFormat() {
        val reading = KeypadEntry.read(pad("10,2,5"), KeypadEntry.Mode.Weight, keeping = 0.0)
        assertNull(reading.value)
        assertEquals("One decimal point only — 72,5 or 72.5", reading.message)
    }

    // Band-assisted work is a normal point on the number line, so a negative weight commits.
    @Test
    fun testANegativeWeightIsAValidLoad() {
        assertEquals(-20.0, KeypadEntry.read(pad("-20"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
    }

    // The pad is opened on the PRODUCT'S OWN SPELLING of the number, and `Readout.weight` writes a
    // real U+2212 minus that the parser cannot read. Seeded raw, the sheet opened on a band-assisted
    // −20 in alarm ink, said "Not a number yet", greyed out Set, and answered ± with "-−20" — an
    // error on a gesture the lifter never made, on every set of that movement from then on.
    @Test
    fun testThePadOpenedOnABandAssistedLoadReadsItBackRatherThanRefusingIt() {
        val opened = KeypadEntry.Pad(opening = Readout.weight(-20.0))

        assertEquals("the readout is typographic, and that is right", "−20", Readout.weight(-20.0))
        assertEquals("the buffer is ASCII, so the number can be read back", "-20", opened.text)
        assertEquals("and the echo spells it the way the screen does", "−20", opened.echo)

        val reading = KeypadEntry.read(opened, KeypadEntry.Mode.Weight, keeping = -20.0)
        assertEquals(-20.0, reading.value!!, 0.0)
        assertEquals(KeypadEntry.weightHint, reading.message)

        assertEquals("and ± repairs rather than doubling the sign", "20",
                     opened.pressing("±", KeypadEntry.Mode.Weight).text)
        assertEquals(82.5, KeypadEntry.read(KeypadEntry.Pad(opening = Readout.weight(82.5)),
                                            KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
    }

    @Test
    fun testAWeightOverTheCeilingIsQuestionedRatherThanCommitted() {
        val reading = KeypadEntry.read(pad("5000"), KeypadEntry.Mode.Weight, keeping = 0.0)
        assertNull(reading.value)
        assertEquals("Over 500 kg — check the number", reading.message)
        assertEquals(500.0, KeypadEntry.read(pad("500"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
    }

    // 1 and not 0: the server refuses reps < 1, so a pad that took a zero would hand back a number
    // the log could only refuse — the one entry that looked legal here and died at the wire.
    @Test
    fun testZeroRepsIsRefusedHereBecauseTheLogRefusesItThere() {
        val zero = KeypadEntry.read(pad("0"), KeypadEntry.Mode.Reps, keeping = 5.0)
        assertNull(zero.value)
        assertEquals("Whole reps, 1 to 99", zero.message)
        assertEquals(1.0, KeypadEntry.read(pad("1"), KeypadEntry.Mode.Reps, keeping = 5.0).value!!, 0.0)
        assertEquals(99.0, KeypadEntry.read(pad("99"), KeypadEntry.Mode.Reps, keeping = 5.0).value!!, 0.0)
        assertNull(KeypadEntry.read(pad("100"), KeypadEntry.Mode.Reps, keeping = 5.0).value)
    }

    // A typed weight lands on the ladder's grid, so the pad and the step buttons cannot produce two
    // different numbers for the same load.
    @Test
    fun testATypedWeightIsRoundedOnTheLaddersGrid() {
        assertEquals(102.51, KeypadEntry.read(pad("102,505"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
    }
}
