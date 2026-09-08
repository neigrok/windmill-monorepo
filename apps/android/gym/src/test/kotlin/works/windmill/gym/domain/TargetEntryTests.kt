package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.domain.TargetEntry.Field
import works.windmill.gym.domain.TargetEntry.Reading
import works.windmill.gym.domain.TargetEntry.TypedSet

class TargetEntryTests {
    // A straight ladder typed off the head: every row the same reps and weight.
    private fun straight(sets: String, reps: String = "", weight: String = ""): Reading =
        TargetEntry.reading(sets, List((sets.trim().toIntOrNull() ?: 0).coerceAtLeast(0)) { TypedSet(reps, weight) })

    private val lowerARamp = listOf(TypedSet("5", "60"), TypedSet("5", "80"), TypedSet("3", "90"),
                                    TypedSet("1", "100"), TypedSet("5", "80"))

    @Test
    fun testTheHeadNamesAStraightSchemeAndAnEmptySetsFieldNamesAnOpenLine() {
        assertEquals(Reading.Scheme(List(3) { SetTarget(5, 82.5) }), straight("3", "5", "82.5"))
        assertEquals("clearing sets IS the escape hatch", Reading.Open, straight("", "", ""))
    }

    @Test
    fun testTheLadderIsReadRowByRowIntoTheScheme() {
        assertEquals(
            Reading.Scheme(listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0),
                                  SetTarget(1, 100.0), SetTarget(5, 80.0))),
            TargetEntry.reading("5", lowerARamp))
    }

    @Test
    fun testAnEmptyRowFieldIsTheNullTheDomainAlreadyHad() {
        assertEquals("no rep target means max",
                     Reading.Scheme(List(4) { SetTarget(null, 100.0) }), straight("4", "", "100"))
        assertEquals("no load means last time",
                     Reading.Scheme(List(4) { SetTarget(8, null) }), straight("4", "8", ""))
        assertEquals("and both at once is still a target",
                     Reading.Scheme(listOf(SetTarget())), straight("1", "", ""))
        assertEquals("per row, not per column",
                     Reading.Scheme(listOf(SetTarget(5, 100.0), SetTarget(null, 100.0), SetTarget(5))),
                     TargetEntry.reading("3", listOf(TypedSet("5", "100"), TypedSet("", "100"), TypedSet("5", ""))))
    }

    @Test
    fun testABlankCountIsOpenWhateverTheRowsHoldAndTheRowsAreKept() {
        val rows = lowerARamp
        assertEquals(Reading.Open, TargetEntry.reading("", rows))
        assertEquals(Reading.Open, TargetEntry.reading("   ", rows))
        assertEquals("the rows are hidden, not thrown away", lowerARamp, rows)
        assertEquals("and retyping the count brings the same scheme back",
                     TargetEntry.reading("5", lowerARamp), TargetEntry.reading("5", rows))
    }

    @Test
    fun testTheCountResizesTheRowsItReads() {
        assertEquals("a shorter count reads the top rows",
                     Reading.Scheme(listOf(SetTarget(5, 60.0), SetTarget(5, 80.0))),
                     TargetEntry.reading("2", lowerARamp))
        assertEquals("a longer count copies the last row",
                     Reading.Scheme(listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0),
                                           SetTarget(1, 100.0), SetTarget(5, 80.0), SetTarget(5, 80.0))),
                     TargetEntry.reading("6", lowerARamp))
        assertEquals("a count with no rows is that many blank sets",
                     Reading.Scheme(List(3) { SetTarget() }), TargetEntry.reading("3", emptyList()))
    }

    @Test
    fun testTheSixRefusalsAreSaidInTheirOwnWordsUnderTheRowThatCarriesThem() {
        assertEquals(Reading.Refused(0, Field.Weight, "One decimal point only."), straight("3", "5", "82.5.0"))
        assertEquals(Reading.Refused(0, Field.Weight, "That is not a number yet."), straight("3", "5", "eighty"))
        assertEquals(Reading.Refused(0, Field.Weight, "Over 500 kg — check the number."), straight("3", "5", "501"))
        assertEquals(Reading.Refused(0, Field.Reps, "Whole reps, 1 to 100."), straight("3", "101"))
        assertEquals("the count's refusals stand under the head", Reading.Refused(null, Field.Sets, "Sets, 1 to 20."), straight("21"))
        assertEquals(Reading.Refused(null, Field.Sets, "A zero target is no target — clear the field instead."), straight("0"))
        assertEquals("a typed zero is refused in every field",
                     Reading.Refused(0, Field.Reps, "A zero target is no target — clear the field instead."), straight("3", "0"))
        assertEquals(Reading.Refused(0, Field.Weight, "A zero target is no target — clear the field instead."), straight("3", "5", "0"))
    }

    @Test
    fun testOneRefusalAtATimeTopmostFirstAndRepsBeforeLoadWithinARow() {
        assertEquals("the count outranks every row",
                     Reading.Refused(null, Field.Sets, "Sets, 1 to 20."),
                     TargetEntry.reading("21", listOf(TypedSet("101", "501"))))
        assertEquals("a row's reps before its load",
                     Reading.Refused(0, Field.Reps, "Whole reps, 1 to 100."),
                     TargetEntry.reading("1", listOf(TypedSet("101", "501"))))
        assertEquals(Reading.Refused(0, Field.Weight, "Over 500 kg — check the number."),
                     TargetEntry.reading("1", listOf(TypedSet("5", "501"))))
        assertEquals("row 3's fault is said under row 3, and row 4's waits its turn",
                     Reading.Refused(2, Field.Weight, "Over 500 kg — check the number."),
                     TargetEntry.reading("4", listOf(TypedSet("5", "60"), TypedSet("5", "80"),
                                                     TypedSet("3", "900"), TypedSet("abc", "100"))))
        assertEquals(Reading.Refused(3, Field.Reps, "That is not a number yet."),
                     TargetEntry.reading("4", listOf(TypedSet("5", "60"), TypedSet("5", "80"),
                                                     TypedSet("3", "90"), TypedSet("abc", "100"))))
    }

    @Test
    fun testTheBandsAreThePlansAndNotTheLoggers() {
        assertEquals(1..20, TargetEntry.setsBand)
        assertEquals("a plan may name a hundred reps; a logged set may not", 1..100, TargetEntry.repsBand)
        assertEquals(Reading.Scheme(List(20) { SetTarget(100) }), straight("20", "100"))
        assertEquals(Reading.Refused(null, Field.Sets, "Sets, 1 to 20."), straight("-1"))
        assertEquals(Reading.Refused(0, Field.Reps, "Whole reps, 1 to 100."), straight("3", "-2"))
    }

    @Test
    fun testCommaAndPointBothReadAsADecimalAndTheMinusSignIsEither() {
        assertEquals(Reading.Scheme(List(3) { SetTarget(5, 82.5) }), straight("3", "5", "82,5"))
        assertEquals(Reading.Scheme(List(3) { SetTarget(5, 82.5) }), straight("3", "5", "82.5"))
        assertEquals("band-assisted work is a negative load and the room writes it with U+2212",
                     Reading.Scheme(List(3) { SetTarget(5, -20.0) }), straight("3", "5", "−20"))
        assertEquals(Reading.Scheme(List(3) { SetTarget(5, -20.0) }), straight("3", "5", "-20"))
    }

    @Test
    fun testALoadIsRoundedTheWayEveryOtherWeightInTheRoomIs() {
        assertEquals("two decimals, as the log stores them",
                     Reading.Scheme(List(3) { SetTarget(5, 82.51) }), straight("3", "5", "82.514"))
        assertEquals(Reading.Scheme(List(3) { SetTarget(5, 99.99) }), straight("3", "5", "99.99"))
        assertEquals(Reading.Scheme(List(3) { SetTarget(5, 500.0) }), straight("3", "5", "500"))
    }

    @Test
    fun testTheHeadShowsWhatEveryRowSharesAndSaysVariesWhereTheyDiffer() {
        assertEquals("5", TargetEntry.sharedReps(List(3) { TypedSet("5", "60") }))
        assertEquals("60", TargetEntry.sharedWeight(List(3) { TypedSet("5", "60") }))
        assertEquals("", TargetEntry.sharedReps(lowerARamp))
        assertEquals("", TargetEntry.sharedWeight(lowerARamp))
        assertTrue(TargetEntry.repsVary(lowerARamp))
        assertTrue(TargetEntry.weightVaries(lowerARamp))
        assertFalse("every row blank is every row max, not varies", TargetEntry.repsVary(List(3) { TypedSet("", "60") }))
        assertEquals("", TargetEntry.sharedReps(List(3) { TypedSet("", "60") }))
        assertFalse(TargetEntry.weightVaries(emptyList()))
        assertEquals("whitespace is not a disagreement", "5", TargetEntry.sharedReps(listOf(TypedSet("5 "), TypedSet(" 5"))))
        assertEquals("varies", TargetEntry.varies)
    }

    @Test
    fun testTypingInTheHeadWritesEveryRow() {
        assertEquals(List(5) { TypedSet("5", lowerARamp[it].weight) },
                     TargetEntry.withReps(lowerARamp, "5"))
        assertEquals(List(5) { TypedSet(lowerARamp[it].reps, "80") }, TargetEntry.withWeight(lowerARamp, "80"))
        assertEquals("clearing the head clears every row", List(5) { TypedSet("", lowerARamp[it].weight) },
                     TargetEntry.withReps(lowerARamp, ""))
    }

    @Test
    fun testGrowingTheLadderCopiesTheTopSetAndShrinkingDropsFromTheEnd() {
        assertEquals(lowerARamp + TypedSet("5", "80"), TargetEntry.resized(lowerARamp, 6))
        assertEquals(lowerARamp.take(3), TargetEntry.resized(lowerARamp, 3))
        assertEquals("a count outside the band is clamped to it, never thrown",
                     lowerARamp.take(1), TargetEntry.resized(lowerARamp, 0))
        assertEquals(20, TargetEntry.resized(lowerARamp, 25).size)
        assertEquals("an empty ladder grows from blank rows", List(3) { TypedSet() }, TargetEntry.resized(emptyList(), 3))
    }

    @Test
    fun testMatchSetOneWritesTheFirstRowOverEveryRow() {
        assertEquals(List(5) { TypedSet("5", "60") }, TargetEntry.matchFirst(lowerARamp))
        assertEquals(emptyList<TypedSet>(), TargetEntry.matchFirst(emptyList()))
    }

    @Test
    fun testRampUpDrawsAStraightLineFromSetOneToTheTopSet() {
        val ends = listOf(TypedSet("5", "60"), TypedSet(), TypedSet(), TypedSet(), TypedSet("1", "100"))
        assertTrue(TargetEntry.canRamp(ends))
        assertEquals(listOf(TypedSet("5", "60"), TypedSet("4", "70"), TypedSet("3", "80"),
                            TypedSet("2", "90"), TypedSet("1", "100")),
                     TargetEntry.rampUp(ends))
    }

    @Test
    fun testThereIsNothingToRampWhileTheEndsAgreeOrDoNotReadAsSets() {
        val straight = List(3) { TypedSet("5", "60") }
        assertFalse(TargetEntry.canRamp(straight))
        assertEquals(straight, TargetEntry.rampUp(straight))
        assertFalse("two sets have nothing between them: a two-row ramp is a no-op",
                    TargetEntry.canRamp(listOf(TypedSet("5", "60"), TypedSet("1", "100"))))
        assertEquals(listOf(TypedSet("5", "60"), TypedSet("1", "100")),
                     TargetEntry.rampUp(listOf(TypedSet("5", "60"), TypedSet("1", "100"))))
        assertTrue("three is the least that ramps", TargetEntry.canRamp(listOf(TypedSet("5", "60"), TypedSet(), TypedSet("1", "100"))))
        val halfTyped = listOf(TypedSet("5", "60"), TypedSet(), TypedSet("1", "abc"))
        assertFalse(TargetEntry.canRamp(halfTyped))
        assertEquals("rows unchanged while the top row is not a set", halfTyped, TargetEntry.rampUp(halfTyped))
    }

    @Test
    fun testAColumnWhoseEndsAreNotBothNamedIsLeftAsItStands() {
        val loadsOnly = listOf(TypedSet("", "60"), TypedSet("", "70"), TypedSet("", "100"))
        assertTrue(TargetEntry.canRamp(loadsOnly))
        assertEquals(listOf(TypedSet("", "60"), TypedSet("", "80"), TypedSet("", "100")), TargetEntry.rampUp(loadsOnly))
    }

    @Test
    fun testTheRowsOfASchemeAreItsSetsAsText() {
        assertEquals(listOf(TypedSet("5", "60"), TypedSet("", "82.5"), TypedSet("8", ""), TypedSet("8", "−20")),
                     TargetEntry.rows(listOf(SetTarget(5, 60.0), SetTarget(null, 82.5), SetTarget(8), SetTarget(8, -20.0))))
    }

    @Test
    fun testTheCommitSaysWhatTheRowWillPrint() {
        assertEquals("open", TargetEntry.commit(Reading.Open))
        assertEquals("5 × 5 · 80", TargetEntry.commit(Reading.Scheme(List(5) { SetTarget(5, 80.0) })))
        assertEquals("5 sets", TargetEntry.commit(TargetEntry.reading("5", lowerARamp)))
        assertEquals("1 × 5 · 100", TargetEntry.commit(Reading.Scheme(listOf(SetTarget(5, 100.0)))))
        assertEquals("no tail while something is refused", null,
                     TargetEntry.commit(Reading.Refused(0, Field.Weight, TargetEntry.overWeight)))
        assertEquals("Set · 5 × 5 · 80", TargetEntry.commitLabel(Reading.Scheme(List(5) { SetTarget(5, 80.0) })))
        assertEquals("Set · open", TargetEntry.commitLabel(Reading.Open))
        assertEquals("Set", TargetEntry.commitLabel(Reading.Refused(null, Field.Sets, TargetEntry.outsideSets)))
    }

    // The sheet's rows outlive the count typed over them: `5 → 1 → 12` keeps the ramp, the count is
    // the shown prefix, and the reading — the commit — slices to it.
    @Test
    fun testTypingTheCountHidesRowsAndNeverThrowsThemAway() {
        val atOne = TargetEntry.grown(lowerARamp, 1)
        assertEquals(lowerARamp, atOne)
        assertEquals(listOf(TypedSet("5", "60")), TargetEntry.shown(atOne, "1"))
        assertEquals(Reading.Scheme(listOf(SetTarget(5, 60.0))), TargetEntry.reading("1", atOne))

        val atTwelve = TargetEntry.grown(atOne, 12)
        assertEquals(lowerARamp + List(7) { TypedSet("5", "80") }, atTwelve)
        assertEquals(atTwelve, TargetEntry.shown(atTwelve, "12"))
        assertEquals("the ramp came back whole",
                     listOf("60", "80", "90", "100", "80"), TargetEntry.shown(atTwelve, "5").map { it.weight })

        assertEquals("a count that does not read shows every row", atTwelve, TargetEntry.shown(atTwelve, "21"))
        assertEquals(atTwelve, TargetEntry.shown(atTwelve, "0"))
        assertEquals(atTwelve, TargetEntry.shown(atTwelve, ""))
    }

    // A refusal typed in the head is the head's: every shown row carries it. Typed in one row it is
    // that row's.
    @Test
    fun testARefusalIsTheHeadsWhenEveryShownRowCarriesIt() {
        val headTyped = TargetEntry.withReps(lowerARamp, "101")
        val refused = TargetEntry.reading("5", headTyped) as Reading.Refused
        assertEquals(Reading.Refused(0, Field.Reps, TargetEntry.outsideReps), refused)
        assertTrue(TargetEntry.inTheHead(refused, headTyped))

        val rowTyped = lowerARamp.mapIndexed { at, row -> if (at == 0) row.copy(reps = "101") else row }
        val rowRefused = TargetEntry.reading("5", rowTyped) as Reading.Refused
        assertEquals(Reading.Refused(0, Field.Reps, TargetEntry.outsideReps), rowRefused)
        assertFalse(TargetEntry.inTheHead(rowRefused, rowTyped))

        assertTrue("the count's is always the head's",
                   TargetEntry.inTheHead(Reading.Refused(null, Field.Sets, TargetEntry.outsideSets), lowerARamp))
        val loadTyped = TargetEntry.withWeight(lowerARamp, "501")
        assertTrue(TargetEntry.inTheHead(TargetEntry.reading("5", loadTyped) as Reading.Refused, loadTyped))
    }

    @Test
    fun testTheWordsArePinned() {
        assertEquals("open", TargetEntry.setsPlaceholder)
        assertEquals("max", TargetEntry.repsPlaceholder)
        assertEquals("last time", TargetEntry.weightPlaceholder)
        assertEquals("Every set", TargetEntry.everySet)
        assertEquals("Set by set", TargetEntry.setBySet)
        assertEquals("Add set", TargetEntry.addSet)
        assertEquals("Fill", TargetEntry.fill)
        assertEquals("Ramp up", TargetEntry.rampUp)
        assertEquals("Match set 1", TargetEntry.matchSetOne)
        assertEquals("Delete", TargetEntry.delete)
        assertEquals("Save today’s sets", TargetEntry.saveTodaysSets)
        assertEquals("You decide the numbers at the rack.", TargetEntry.openLine)
    }
}
