package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.SetEffort
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet

// The two things a lifter can say about a set that are not the set. The sheet is seeded from what the
// LOG holds, so what it saves is a diff and not a restatement — the log has no concurrency guard on a
// set, and a sheet that sent its whole state would clobber a note written elsewhere while it stood.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FixSheetEffortTests {
    @get:Rule
    val compose = createComposeRule()

    private val plain = TrainingSet(
        id = "set_1", exerciseId = "bench-press", setNumber = 2,
        weightKg = 82.5, reps = 5, kind = SetKind.Working, completedAtMs = 0,
    )

    private fun sheet(set: TrainingSet = plain): () -> SetFix? {
        var saved: SetFix? = null
        compose.setContent {
            FixSheet(
                set = set,
                movement = "Bench Press",
                setNumber = 2,
                routine = null,
                onSave = { saved = it },
                onDelete = {},
            )
        }
        return { saved }
    }

    @Test
    fun theBandOffersSixToTenByHalvesAndAWayBackToNothing() {
        sheet()

        compose.onNodeWithText(SetEffort.rpeLabel).assertIsDisplayed()
        compose.onNodeWithText(SetEffort.rpeUnrated).assertIsDisplayed()
        SetEffort.rpeBand.forEach {
            compose.onNodeWithContentDescription(SetEffort.rpeReading(it)).assertExists()
        }
        compose.onNodeWithContentDescription(SetEffort.rpeReading(10.0))
            .performScrollTo().assertIsDisplayed()
    }

    @Test
    fun theNoteIsLabelledAndSaysWhoItIsForRatherThanPretendingCoachReadsIt() {
        sheet()

        compose.onNodeWithText(SetEffort.noteLabel).assertIsDisplayed()
        compose.onNodeWithText("A record for you — not an instruction to Coach.").assertIsDisplayed()
    }

    @Test
    fun pickingAnRpeAndTypingANoteSendsThoseTwoFieldsAndNothingElse() {
        val saved = sheet()

        compose.onNodeWithContentDescription(SetEffort.rpeReading(8.5)).performScrollTo().performClick()
        compose.onNodeWithText(SetEffort.noteLabel).performTextInput("left shoulder")
        compose.onNodeWithText("Save the fix").performClick()

        compose.runOnIdle {
            assertEquals(8.5, saved()!!.rpe)
            assertTrue(saved()!!.rpeNamed)
            assertEquals("left shoulder", saved()!!.note)
            assertNull("the numbers never moved", saved()!!.weightKg)
            assertNull(saved()!!.reps)
            assertNull(saved()!!.kind)
        }
    }

    @Test
    fun clearingANoteSendsAnEmptyStringAndClearingAnRpeNamesItAsNull() {
        val saved = sheet(plain.copy(rpe = 9.0, note = "felt heavy"))

        compose.onNodeWithText("felt heavy").performTextClearance()
        compose.onNodeWithText(SetEffort.rpeUnrated).performClick()
        compose.onNodeWithText("Save the fix").performClick()

        compose.runOnIdle {
            assertEquals("", saved()!!.note)
            assertTrue("named, and named as nothing", saved()!!.rpeNamed)
            assertNull(saved()!!.rpe)
        }
    }

    @Test
    fun aSheetOpenedOverAnAnnotatedSetAndSavedUntouchedSendsNothingAtAll() {
        val saved = sheet(plain.copy(rpe = 9.0, note = "felt heavy"))

        compose.onNodeWithText("Save the fix").performClick()

        compose.runOnIdle {
            assertEquals("an empty diff, which is what leaves another device's work alone",
                SetFix(), saved())
        }
    }

    // D10. A byte counter over its bound goes alarm wherever it is drawn, and it is drawn only in the
    // last fifth — the same two rules the note editor already keeps one screen away.
    @Test
    fun theByteCounterAppearsOnlyInTheLastFifthAndSaysTheOverageOutLoud() {
        sheet()

        compose.onNodeWithText("bytes", substring = true).assertDoesNotExist()

        compose.onNodeWithText(SetEffort.noteLabel).performTextInput("a".repeat(3_200))
        compose.onNodeWithText("3200 of 4000 bytes").assertExists()

        compose.onNodeWithText(SetEffort.noteLabel).performTextInput("b".repeat(801))
        compose.onNodeWithText("4001 of 4000 bytes").assertExists()
        compose.onNodeWithText(SetEffort.noteTooLong).assertExists()
    }

    // The log answers an overlong note with one generic sentence about the whole fix, so this is the
    // only reason a lifter will ever read — and it is said before anything is sent.
    @Test
    fun anOverlongNoteIsRefusedAtTheFieldAndTheSaveIsHeld() {
        val saved = sheet()

        compose.onNodeWithText(SetEffort.noteLabel)
            .performTextInput("🏋".repeat(1_001))

        compose.onNodeWithText(SetEffort.noteTooLong).assertIsDisplayed()
        compose.onNodeWithText("Save the fix").assertIsNotEnabled()
        compose.onNodeWithText("Save the fix").performClick()
        compose.runOnIdle { assertNull("and nothing was sent", saved()) }
    }
}
