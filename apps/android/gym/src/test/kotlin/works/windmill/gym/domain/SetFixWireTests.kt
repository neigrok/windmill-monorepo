package works.windmill.gym.domain

import kotlinx.serialization.serializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.net.WindmillJson

// A fix names ONLY what it changes, because the log has no concurrency guard on a set: a sheet that
// sent its whole state would silently clobber a note another device wrote while it stood open.
//
// Two of the five fields carry a clear, and the two clears are different shapes: `note: ""` clears a
// note and `note: null` is a type error the log refuses, while `rpe: null` IS the clear. That is why
// this type carries `rpeNamed` beside `rpe` and writes its own wire object — the encoder's
// absent-is-null rule cannot say both things.
//
// The effort fields' own bytes are pinned here beside it — the bound, the counter, and the seat that
// means nothing was said. Every one of those is a byte assertion and not a shape assertion, because
// a rewording is the drift they exist to fail the build over.
class SetFixWireTests {
    private val stored = TrainingSet(
        id = "set_1",
        exerciseId = "bench-press",
        weightKg = 82.5,
        reps = 5,
        kind = SetKind.Working,
        rpe = 8.0,
        note = "felt heavy",
        completedAtMs = 1_000,
    )

    // Encoded the way `WindmillApi.encode` encodes it — reflectively, off the runtime class — so a
    // serializer the plugin fails to hand back would fail here rather than on a phone.
    private fun body(fix: SetFix): String =
        WindmillJson.encodeToString(serializer(SetFix::class.java), fix)

    @Test
    fun aSheetOpenedAndClosedWithNothingTouchedSendsAnEmptyObject() {
        val fix = SetFix(stored, weightKg = 82.5, reps = 5, kind = SetKind.Working,
                         rpe = 8.0, note = "felt heavy")

        assertEquals("{}", body(fix))
        assertFalse(fix.moves(stored))
        assertEquals(stored, fix.corrected(stored))
    }

    @Test
    fun onlyTheFieldThatMovedIsOnTheWire() {
        val fix = SetFix(stored, weightKg = 85.0, reps = 5, kind = SetKind.Working,
                         rpe = 8.0, note = "felt heavy")

        assertEquals("""{"weightKg":85.0}""", body(fix))
        assertEquals(85.0, fix.corrected(stored).weightKg, 0.0)
        assertEquals("nothing else moved", "felt heavy", fix.corrected(stored).note)
        assertEquals(8.0, fix.corrected(stored).rpe)
    }

    @Test
    fun clearingANoteSendsAnEmptyStringAndNeverANull() {
        val fix = SetFix(stored, weightKg = 82.5, reps = 5, kind = SetKind.Working,
                         rpe = 8.0, note = "")

        assertEquals("""{"note":""}""", body(fix))
        assertFalse("a null there is a type error the log refuses",
            body(fix).contains("null"))
        assertEquals("", fix.corrected(stored).note)
    }

    @Test
    fun clearingAnRpeSendsAnExplicitNullBecauseThatIsWhatClearsIt() {
        val fix = SetFix(stored, weightKg = 82.5, reps = 5, kind = SetKind.Working,
                         rpe = null, note = "felt heavy")

        assertEquals("""{"rpe":null}""", body(fix))
        assertNull(fix.corrected(stored).rpe)

        val untouched = SetFix(stored, weightKg = 82.5, reps = 5, kind = SetKind.Working,
                               rpe = 8.0, note = "felt heavy")
        assertFalse("and not naming it at all leaves what is stored",
            body(untouched).contains("rpe"))
        assertEquals(8.0, untouched.corrected(stored).rpe)
    }

    @Test
    fun everyFieldAtOnceGoesInOneObjectAndTheKindTravelsAsItsWireWord() {
        val fix = SetFix(stored, weightKg = 100.0, reps = 3, kind = SetKind.Drop,
                         rpe = 9.5, note = "back-off")

        assertEquals(
            """{"weightKg":100.0,"reps":3,"kind":"drop","note":"back-off","rpe":9.5}""",
            body(fix),
        )
        assertEquals(
            stored.copy(weightKg = 100.0, reps = 3, kind = SetKind.Drop, rpe = 9.5, note = "back-off"),
            fix.corrected(stored),
        )
    }

    // A weight that moves less than the ladder's own grid did not move.
    @Test
    fun theWeightIsReadOnTheLaddersGridAndNotOffRawDoubles() {
        val drifted = SetFix(stored, weightKg = 82.5000001, reps = 5, kind = SetKind.Working,
                             rpe = 8.0, note = "felt heavy")
        assertEquals("{}", body(drifted))
    }

    // The claim replay is the one place a whole row travels: the shelf's copy must land on the
    // account entire, so an rpe the lifter cleared on this device is named rather than omitted.
    @Test
    fun theClaimsReplayRestatesTheWholeStoredRowRatherThanADiff() {
        val fix = SetFix(stored.copy(rpe = null, note = ""))

        assertEquals("""{"weightKg":82.5,"reps":5,"kind":"working","note":"","rpe":null}""", body(fix))
        assertTrue(fix.rpeNamed)
    }

    @Test
    fun theNoteBoundIsCountedInBytesAndNotInCharacters() {
        val ascii = "a".repeat(SetEffort.noteMaxBytes)
        assertFalse(SetEffort.noteOverlong(ascii))
        assertTrue(SetEffort.noteOverlong(ascii + "a"))

        // Four bytes each: 1000 of them is exactly the bound, and 1001 is over it while `length`
        // still says 2002 — well under 4000 by the count a naive check would make.
        val emoji = "🏋".repeat(1_000)
        assertFalse(SetEffort.noteOverlong(emoji))
        assertTrue(SetEffort.noteOverlong(emoji + "🏋"))
        assertTrue("and a length check would have let it through",
            (emoji + "🏋").length < SetEffort.noteMaxBytes)
    }

    @Test
    fun whatTheSessionRowPrintsIsWhatTheLogCarriesAndNothingWhereItCarriesNeither() {
        assertEquals("RPE 8 · felt heavy", SetEffort.line(8.0, "felt heavy"))
        assertEquals("RPE 8.5", SetEffort.line(8.5, ""))
        assertEquals("felt heavy", SetEffort.line(null, "felt heavy"))
        assertNull(SetEffort.line(null, ""))
        assertNull("a note of nothing but spaces is not a note", SetEffort.line(null, "   "))
        assertEquals("nine and a half is 9.5, never 9.50", "RPE 9.5", SetEffort.rpeReading(9.5))
        assertEquals("RPE 10", SetEffort.rpeReading(10.0))
    }

    @Test
    fun theBandIsSixToTenByHalves() {
        assertEquals(
            listOf(6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0),
            SetEffort.rpeBand,
        )
    }

    // Said in the shape the notes bound already ships — `a note runs to 500 bytes` — rather than a
    // complaint about what was typed. It states the rule, so a lifter knows what to type instead.
    @Test
    fun anOverlongSetNoteIsRefusedWithTheRuleAndNotWithAComplaint() {
        assertEquals("A set note runs to 4000 bytes.", SetEffort.noteTooLong)
        assertEquals(4000, SetEffort.noteMaxBytes)
        assertFalse("it never scolds", SetEffort.noteTooLong.contains("too long"))
        assertTrue("and the bound it names is the bound it keeps",
            SetEffort.noteOverlong("a".repeat(SetEffort.noteMaxBytes + 1)))
        assertFalse(SetEffort.noteOverlong("a".repeat(SetEffort.noteMaxBytes)))
    }

    // D10. A byte counter over its bound goes alarm WHEREVER it is drawn — the note editor already
    // does it, and the set note is the same shape one screen away. One room may not draw two rules
    // for one shape.
    @Test
    fun theSetNoteCounterIsTheNoteEditorsCounterOneScreenAway() {
        assertNull("chrome only in the last fifth", SetEffort.noteCounter("a".repeat(3_199)))
        assertEquals("3200 of 4000 bytes", SetEffort.noteCounter("a".repeat(3_200)))
        assertEquals("4000 of 4000 bytes", SetEffort.noteCounter("a".repeat(4_000)))
        assertEquals("4001 of 4000 bytes", SetEffort.noteCounter("a".repeat(4_001)))

        assertEquals("the threshold is the last fifth of the bound, as the editor's is",
            SetEffort.noteMaxBytes * 4 / 5, SetEffort.noteCounterFrom)
        assertEquals("the editor's own counter, past its own bound", "501 of 500 bytes",
            Notes.counter("b".repeat(501)))
        assertEquals("and the same words one screen away", "4001 of 4000 bytes",
            SetEffort.noteCounter("b".repeat(4_001)))

        assertEquals("counted in bytes and not in characters — one emoji is four",
            "3200 of 4000 bytes", SetEffort.noteCounter("🏋".repeat(800)))
        assertTrue("and the counter and the refusal flip on the SAME byte",
            (3_995..4_005).all {
                (SetEffort.noteCounter("a".repeat(it))!!.startsWith("${it} of") &&
                    SetEffort.noteOverlong("a".repeat(it)) == (it > SetEffort.noteMaxBytes))
            })
    }

    // A bare em dash is read out by TalkBack as nothing at all, so the seat that means "nothing was
    // said" would be the one seat on the band with no label.
    @Test
    fun theUnratedSeatIsLabelledInWordsAndNeverWithABareDash() {
        assertEquals("Not rated", SetEffort.rpeUnrated)
        assertFalse("no dash of any width stands in for a label",
            SetEffort.rpeUnrated.any { it == '—' || it == '–' || it == '-' })
        assertEquals("and it is not one of the nine numerals",
            listOf(6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0), SetEffort.rpeBand)
        assertTrue(SetEffort.rpeBand.map { SetEffort.rpeNumeral(it) }.none { it == SetEffort.rpeUnrated })
    }
}
