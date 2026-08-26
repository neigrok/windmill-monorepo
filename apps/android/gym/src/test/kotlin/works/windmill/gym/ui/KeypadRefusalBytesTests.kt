package works.windmill.gym.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// C3: the rack's keypad refuses for the same four reasons the routine target's typed fields do, and
// says them in the same bytes. Only the band differs, because a set that was PERFORMED is bounded at
// 99 reps while a plan may name 100.
class KeypadRefusalBytesTests {
    private fun pad(text: String) = KeypadEntry.Pad(text = text, seeded = false)

    private fun said(text: String, mode: KeypadEntry.Mode) =
        KeypadEntry.read(pad(text), mode, keeping = 0.0)

    @Test
    fun testTheFourRefusalsAreThePinnedBytes() {
        assertEquals("One decimal point only.", said("10,2,5", KeypadEntry.Mode.Weight).message)
        assertEquals("That is not a number yet.", said("7-2", KeypadEntry.Mode.Weight).message)
        assertEquals("Over 500 kg — check the number.", said("5000", KeypadEntry.Mode.Weight).message)
        assertEquals("Whole reps, 1 to 99.", said("100", KeypadEntry.Mode.Reps).message)
    }

    @Test
    fun testTheLoggersBandIsTheOneTheKeypadSays() {
        assertEquals("Whole reps, 1 to 99.", said("0", KeypadEntry.Mode.Reps).message)
        assertEquals("Whole reps, 1 to 99.", said("7,5", KeypadEntry.Mode.Reps).message)
        assertNull(said("100", KeypadEntry.Mode.Reps).value)
        assertEquals(99.0, said("99", KeypadEntry.Mode.Reps).value!!, 0.0)
    }

    // The one sentence that is NOT a refusal of what was typed: an empty buffer names the number
    // Cancel would keep, which the target sheet has no equivalent of.
    @Test
    fun testAnEmptyBufferStillNamesWhatCancelWouldKeep() {
        assertEquals(
            "Enter a number, or cancel to keep 102.5",
            KeypadEntry.read(KeypadEntry.Pad(opening = ""), KeypadEntry.Mode.Weight, keeping = 102.5).message,
        )
    }
}
