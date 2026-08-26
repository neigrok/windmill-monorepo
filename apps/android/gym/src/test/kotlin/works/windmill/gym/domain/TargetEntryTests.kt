package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TargetEntryTests {
    private fun read(sets: String, reps: String = "", weight: String = "") =
        TargetEntry.reading(sets, reps, weight)

    private fun said(sets: String, reps: String = "", weight: String = ""): String? =
        (read(sets, reps, weight) as? TargetEntry.Reading.Refused)?.said

    private fun field(sets: String, reps: String = "", weight: String = ""): TargetEntry.Field? =
        (read(sets, reps, weight) as? TargetEntry.Reading.Refused)?.field

    @Test
    fun testThreeFieldsNameATargetAndAnEmptySetsFieldNamesAnOpenLine() {
        assertEquals(
            TargetEntry.Reading.Targeted(sets = 3, reps = 5, weightKg = 82.5),
            read("3", "5", "82.5"),
        )
        assertEquals("clearing sets IS the escape hatch",
                     TargetEntry.Reading.Open, read("", "", ""))
    }

    @Test
    fun testAnEmptyFieldIsTheNullTheDomainAlreadyHad() {
        assertEquals("no rep target means max",
                     TargetEntry.Reading.Targeted(sets = 4, reps = null, weightKg = 100.0),
                     read("4", "", "100"))
        assertEquals("no load means last time",
                     TargetEntry.Reading.Targeted(sets = 4, reps = 8, weightKg = null),
                     read("4", "8", ""))
        assertEquals("and both at once is still a target",
                     TargetEntry.Reading.Targeted(sets = 1, reps = null, weightKg = null),
                     read("1", "", ""))
    }

    @Test
    fun testTheSixRefusalsAreSaidInTheirOwnWords() {
        assertEquals("One decimal point only.", said("3", "5", "82.5.0"))
        assertEquals("That is not a number yet.", said("3", "5", "eighty"))
        assertEquals("Over 500 kg — check the number.", said("3", "5", "501"))
        assertEquals("Whole reps, 1 to 100.", said("3", "101"))
        assertEquals("Sets, 1 to 20.", said("21"))
        assertEquals("A zero target is no target — clear the field instead.", said("0"))
        assertEquals("a typed zero is refused in every field",
                     "A zero target is no target — clear the field instead.", said("3", "0"))
        assertEquals("A zero target is no target — clear the field instead.", said("3", "5", "0"))
    }

    @Test
    fun testARefusalNamesTheFieldItBelongsUnderAndOnlyOneIsSaidAtATime() {
        assertEquals(TargetEntry.Field.Sets, field("21", "101", "501"))
        assertEquals("the second field is not mentioned while the first is still nonsense",
                     TargetEntry.Field.Reps, field("3", "101", "501"))
        assertEquals(TargetEntry.Field.Weight, field("3", "5", "501"))
    }

    @Test
    fun testTheBandsAreThePlansAndNotTheLoggers() {
        assertEquals(1..20, TargetEntry.setsBand)
        assertEquals("a plan may name a hundred reps; a logged set may not", 1..100, TargetEntry.repsBand)
        assertEquals(TargetEntry.Reading.Targeted(20, 100, null), read("20", "100"))
        assertEquals("Sets, 1 to 20.", said("-1"))
        assertEquals("Whole reps, 1 to 100.", said("3", "-2"))
    }

    @Test
    fun testCommaAndPointBothReadAsADecimalAndTheMinusSignIsEither() {
        assertEquals(TargetEntry.Reading.Targeted(3, 5, 82.5), read("3", "5", "82,5"))
        assertEquals(TargetEntry.Reading.Targeted(3, 5, 82.5), read("3", "5", "82.5"))
        assertEquals("band-assisted work is a negative load and the room writes it with U+2212",
                     TargetEntry.Reading.Targeted(3, 5, -20.0), read("3", "5", "−20"))
        assertEquals(TargetEntry.Reading.Targeted(3, 5, -20.0), read("3", "5", "-20"))
    }

    @Test
    fun testALoadIsRoundedTheWayEveryOtherWeightInTheRoomIs() {
        assertEquals("two decimals, as the log stores them",
                     TargetEntry.Reading.Targeted(3, 5, 82.51), read("3", "5", "82.514"))
        assertEquals(TargetEntry.Reading.Targeted(3, 5, 99.99), read("3", "5", "99.99"))
        assertEquals(TargetEntry.Reading.Targeted(3, 5, 500.0), read("3", "5", "500"))
    }

    @Test
    fun testClearingSetsIsRefusedWhileRepsOrWeightHoldAValue() {
        assertEquals(
            "Clear reps and weight first — an open line names neither.",
            TargetEntry.clearingSets(reps = "5", weight = ""),
        )
        assertEquals(
            "Clear reps and weight first — an open line names neither.",
            TargetEntry.clearingSets(reps = "", weight = "82.5"),
        )
        assertNull("with both cleared the line opens", TargetEntry.clearingSets(reps = "", weight = ""))
        assertNull(TargetEntry.clearingSets(reps = "  ", weight = " "))
    }

    // The open line's other way in: numbers typed against a sets field that is still empty. The
    // refusal is the STATE's, not a keystroke's — nothing typed is ever dropped without a word — and
    // the remedy is the opposite one, so it cannot wear the clear's sentence.
    @Test
    fun testANumberTypedAgainstAnEmptySetsFieldIsRefusedRatherThanDropped() {
        assertEquals("Name the sets first — an open line names neither.", said("", "8"))
        assertEquals("Name the sets first — an open line names neither.", said("", "", "82.5"))
        assertEquals("Name the sets first — an open line names neither.", said("", "8", "82.5"))
        assertEquals(TargetEntry.Field.Sets, field("", "8", "82.5"))
        assertEquals("the open line's shape is read before the fields are",
                     "Name the sets first — an open line names neither.", said("", "101"))
        assertEquals("and Open means all three are empty",
                     TargetEntry.Reading.Open, read("", " ", "  "))
    }

    @Test
    fun testThePlaceholdersSayWhatAnEmptyFieldMeans() {
        assertEquals("open", TargetEntry.setsPlaceholder)
        assertEquals("max", TargetEntry.repsPlaceholder)
        assertEquals("last time", TargetEntry.weightPlaceholder)
        assertEquals("comma or point, both read as a decimal", TargetEntry.decimalHint)
    }
}
