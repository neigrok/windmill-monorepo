package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.Readout

class KeypadEntryTests {
    private fun pad(text: String): KeypadEntry.Pad =
        text.fold(KeypadEntry.Pad(opening = "0").pressing("0", KeypadEntry.Mode.Weight).backspaced) { pad, character ->
            if (character == '-') pad.pressing("±", KeypadEntry.Mode.Weight)
            else pad.pressing(character.toString(), KeypadEntry.Mode.Weight)
        }

    @Test
    fun testTheFirstDigitReplacesTheSeededNumberAndTheNextOneAppends() {
        val opened = KeypadEntry.Pad(opening = "102.5")
        assertEquals("102.5", opened.echo)
        assertEquals("9", opened.pressing("9", KeypadEntry.Mode.Weight).text)
        assertEquals("95", opened.pressing("9", KeypadEntry.Mode.Weight).pressing("5", KeypadEntry.Mode.Weight).text)
    }

    @Test
    fun testTheSignAndTheBackspaceEditTheSeededNumberRatherThanReplacingIt() {
        val opened = KeypadEntry.Pad(opening = "20")
        assertEquals("-20", opened.pressing("±", KeypadEntry.Mode.Weight).text)
        assertEquals("−20", opened.pressing("±", KeypadEntry.Mode.Weight).echo)
        assertEquals("20", opened.pressing("±", KeypadEntry.Mode.Weight).pressing("±", KeypadEntry.Mode.Weight).text)
        assertEquals("2", opened.backspaced.text)
    }

    @Test
    fun testTheCommaAndTheSignAreInertInRepsModeAndTheKeysDoNotMove() {
        assertEquals(12, KeypadEntry.keys.size)
        assertFalse(KeypadEntry.isLive(",", KeypadEntry.Mode.Reps))
        assertFalse(KeypadEntry.isLive("±", KeypadEntry.Mode.Reps))
        assertTrue(KeypadEntry.isLive(",", KeypadEntry.Mode.Weight))
        assertEquals("5", KeypadEntry.Pad(opening = "5").pressing("±", KeypadEntry.Mode.Reps).text)
    }

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

    @Test
    fun testACommaAndAPointBothReadAsADecimal() {
        assertEquals(72.5, KeypadEntry.read(pad("72,5"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
        assertEquals(72.5, KeypadEntry.read(pad("72.5"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
        assertEquals("and the row under a valid weight carries the unit and nothing else", "kg",
                     KeypadEntry.read(pad("72,5"), KeypadEntry.Mode.Weight, keeping = 0.0).message)
        assertEquals("kg", KeypadEntry.weightHint)
    }

    @Test
    fun testASecondDecimalPointNamesTheProblemAndTeachesTheFormat() {
        val reading = KeypadEntry.read(pad("10,2,5"), KeypadEntry.Mode.Weight, keeping = 0.0)
        assertNull(reading.value)
        assertEquals(KeypadEntry.onePoint, reading.message)
    }

    @Test
    fun testANegativeWeightIsAValidLoad() {
        assertEquals(-20.0, KeypadEntry.read(pad("-20"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
    }

    @Test
    fun testThePadOpenedOnABandAssistedLoadReadsItBackRatherThanRefusingIt() {
        val opened = KeypadEntry.Pad(opening = Readout.weight(-20.0))

        assertEquals("the readout is typographic, and that is right", "−20", Readout.weight(-20.0))
        assertEquals("the buffer is ASCII, so the number can be read back", "-20", opened.text)
        assertEquals("and the echo spells it the way the screen does", "−20", opened.echo)

        val reading = KeypadEntry.read(opened, KeypadEntry.Mode.Weight, keeping = -20.0)
        assertEquals(-20.0, reading.value!!, 0.0)
        assertEquals(KeypadEntry.weightHint, reading.message)
        assertEquals("the sign key is where band-assisted is said, now that no hint says it",
                     "Flip the sign — band-assisted", KeypadEntry.signName)

        assertEquals("and ± repairs rather than doubling the sign", "20",
                     opened.pressing("±", KeypadEntry.Mode.Weight).text)
        assertEquals(82.5, KeypadEntry.read(KeypadEntry.Pad(opening = Readout.weight(82.5)),
                                            KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
    }

    @Test
    fun testAWeightOverTheCeilingIsQuestionedRatherThanCommitted() {
        val reading = KeypadEntry.read(pad("5000"), KeypadEntry.Mode.Weight, keeping = 0.0)
        assertNull(reading.value)
        assertEquals(KeypadEntry.overWeight, reading.message)
        assertEquals(500.0, KeypadEntry.read(pad("500"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
    }

    @Test
    fun testZeroRepsIsRefusedHereBecauseTheLogRefusesItThere() {
        val zero = KeypadEntry.read(pad("0"), KeypadEntry.Mode.Reps, keeping = 5.0)
        assertNull(zero.value)
        assertEquals(KeypadEntry.outsideReps, zero.message)
        assertEquals(1.0, KeypadEntry.read(pad("1"), KeypadEntry.Mode.Reps, keeping = 5.0).value!!, 0.0)
        assertEquals(99.0, KeypadEntry.read(pad("99"), KeypadEntry.Mode.Reps, keeping = 5.0).value!!, 0.0)
        assertNull(KeypadEntry.read(pad("100"), KeypadEntry.Mode.Reps, keeping = 5.0).value)
    }

    @Test
    fun testATypedWeightIsRoundedOnTheLaddersGrid() {
        assertEquals(102.51, KeypadEntry.read(pad("102,505"), KeypadEntry.Mode.Weight, keeping = 0.0).value!!, 0.0)
    }
}
