package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Test

// C12: `whole()` reads a typed sets or reps field the way `load()` reads a typed weight — normalise
// the comma, refuse a second point, refuse what is not a number, refuse a typed zero, refuse a
// number that is not whole, then refuse the band. Two of those used to collapse into `That is not a
// number yet.`, which told a lifter who typed `3.5` reps that 3.5 is not a number.
class TargetEntryWholeShapeTests {
    private fun said(sets: String, reps: String = "", weight: String = ""): String? =
        (TargetEntry.reading(sets, reps, weight) as? TargetEntry.Reading.Refused)?.said

    private fun field(sets: String, reps: String = "", weight: String = ""): TargetEntry.Field? =
        (TargetEntry.reading(sets, reps, weight) as? TargetEntry.Reading.Refused)?.field

    @Test
    fun testANumberThatIsNotWholeIsRefusedByItsBandAndNotCalledANonNumber() {
        assertEquals("Whole reps, 1 to 100.", said("3", "3.5"))
        assertEquals(TargetEntry.Field.Reps, field("3", "3.5"))
        assertEquals("Sets, 1 to 20.", said("2.5"))
        assertEquals("and the band still refuses what is whole and out of it",
                     "Whole reps, 1 to 100.", said("3", "101"))
    }

    @Test
    fun testACommaIsADecimalPointInEveryFieldAndNotAFault() {
        assertEquals("comma or point: 3,5 reps is 3.5 reps, refused as a fraction",
                     "Whole reps, 1 to 100.", said("3", "3,5"))
        assertEquals("Sets, 1 to 20.", said("2,5"))
    }

    @Test
    fun testASecondPointIsItsOwnRefusalInAWholeFieldToo() {
        assertEquals("One decimal point only.", said("3", "3.5.1"))
        assertEquals(TargetEntry.Field.Reps, field("3", "3.5.1"))
        assertEquals("One decimal point only.", said("2,5,1"))
    }

    @Test
    fun testWhatIsNotANumberAtAllStillSaysSo() {
        assertEquals("That is not a number yet.", said("three"))
        assertEquals("That is not a number yet.", said("3", "five"))
        assertEquals("a lone sign is not a number yet either", "That is not a number yet.", said("-"))
    }

    @Test
    fun testATypedZeroKeepsItsOwnSentenceThroughTheNewShape() {
        assertEquals("A zero target is no target — clear the field instead.", said("0"))
        assertEquals("A zero target is no target — clear the field instead.", said("0,0"))
        assertEquals("A zero target is no target — clear the field instead.", said("3", "0.0"))
    }

    @Test
    fun testAWholeNumberTypedWithATrailingPointStillReadsAsThatNumber() {
        assertEquals(TargetEntry.Reading.Targeted(sets = 3, reps = 5, weightKg = null), TargetEntry.reading("3.", "5,", ""))
    }
}
