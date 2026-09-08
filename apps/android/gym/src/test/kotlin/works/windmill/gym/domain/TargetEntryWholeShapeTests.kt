package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.domain.TargetEntry.Field
import works.windmill.gym.domain.TargetEntry.Reading
import works.windmill.gym.domain.TargetEntry.TypedSet

// C12: a typed sets or reps field is read the way a typed weight is — normalise the comma, refuse a
// second point, refuse what is not a number, refuse a typed zero, refuse a number that is not
// whole, then refuse the band. Two of those used to collapse into `That is not a number yet.`,
// which told a lifter who typed `3.5` reps that 3.5 is not a number.
class TargetEntryWholeShapeTests {
    private fun read(sets: String, reps: String = "", weight: String = ""): Reading =
        TargetEntry.reading(sets, listOf(TypedSet(reps, weight)))

    @Test
    fun testANumberThatIsNotWholeIsRefusedByItsBandAndNotCalledANonNumber() {
        assertEquals(Reading.Refused(0, Field.Reps, "Whole reps, 1 to 100."), read("1", "3.5"))
        assertEquals(Reading.Refused(null, Field.Sets, "Sets, 1 to 20."), read("2.5"))
        assertEquals("and the band still refuses what is whole and out of it",
                     Reading.Refused(0, Field.Reps, "Whole reps, 1 to 100."), read("1", "101"))
    }

    @Test
    fun testACommaIsADecimalPointInEveryFieldAndNotAFault() {
        assertEquals("comma or point: 3,5 reps is 3.5 reps, refused as a fraction",
                     Reading.Refused(0, Field.Reps, "Whole reps, 1 to 100."), read("1", "3,5"))
        assertEquals(Reading.Refused(null, Field.Sets, "Sets, 1 to 20."), read("2,5"))
    }

    @Test
    fun testASecondPointIsItsOwnRefusalInAWholeFieldToo() {
        assertEquals(Reading.Refused(0, Field.Reps, "One decimal point only."), read("1", "3.5.1"))
        assertEquals(Reading.Refused(null, Field.Sets, "One decimal point only."), read("2,5,1"))
    }

    @Test
    fun testWhatIsNotANumberAtAllStillSaysSo() {
        assertEquals(Reading.Refused(null, Field.Sets, "That is not a number yet."), read("three"))
        assertEquals(Reading.Refused(0, Field.Reps, "That is not a number yet."), read("1", "five"))
        assertEquals("a lone sign is not a number yet either",
                     Reading.Refused(null, Field.Sets, "That is not a number yet."), read("-"))
    }

    @Test
    fun testATypedZeroKeepsItsOwnSentenceThroughTheNewShape() {
        assertEquals(Reading.Refused(null, Field.Sets, "A zero target is no target — clear the field instead."), read("0"))
        assertEquals(Reading.Refused(null, Field.Sets, "A zero target is no target — clear the field instead."), read("0,0"))
        assertEquals(Reading.Refused(0, Field.Reps, "A zero target is no target — clear the field instead."), read("1", "0.0"))
    }

    @Test
    fun testAWholeNumberTypedWithATrailingPointStillReadsAsThatNumber() {
        assertEquals(Reading.Scheme(List(3) { SetTarget(5) }),
                     TargetEntry.reading("3.", List(3) { TypedSet("5,", "") }))
    }
}
