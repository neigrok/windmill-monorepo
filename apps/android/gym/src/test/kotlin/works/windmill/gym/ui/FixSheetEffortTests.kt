package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
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
import works.windmill.gym.store.FixOutcome
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsProperties

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FixSheetEffortTests {
    @get:Rule
    val compose = createComposeRule()

    private fun sheet(set: TrainingSet = TrainingSet(
        id = "set_1", exerciseId = "bench-press", setNumber = 2,
        weightKg = 82.5, reps = 5, kind = SetKind.Working, completedAtMs = 0,
    ), haptics: HapticFeedback? = null): () -> SetFix? {
        var saved: SetFix? = null
        compose.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides (haptics ?: LocalHapticFeedback.current)) {
                FixSheet(
                    set = set,
                    movement = "Bench Press",
                    setNumber = 2,
                    routine = null,
                    onSave = { saved = it; FixOutcome.Corrected(it.corrected(set)) },
                    onDelete = {},
                )
            }
        }
        return { saved }
    }

    @Test
    fun correctingAHistoricalWarmupKeepsItsKindAndDoesNotConfirmWithAHaptic() {
        val sensations = mutableListOf<HapticFeedbackType>()
        val saved = sheet(TrainingSet(id = "set_1", exerciseId = "bench-press", setNumber = 2,
            weightKg = 82.5, reps = 5, kind = SetKind.Warmup, completedAtMs = 0), object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
                sensations += hapticFeedbackType
            }
        })

        compose.onNodeWithText("Kind").assertDoesNotExist()
        compose.onNodeWithText("warmup").assertDoesNotExist()
        compose.onNodeWithText(SetEffort.noteLabel).performTextInput("left shoulder")
        compose.onNodeWithText("Save fix").performClick()

        compose.runOnIdle {
            assertEquals(SetFix(note = "left shoulder"), saved())
            assertEquals(emptyList<HapticFeedbackType>(), sensations)
        }
    }

    @Test
    fun theBandOffersSixToTenByHalvesAndAWayBackToNothing() {
        sheet()

        compose.onNodeWithText("Effort").assertIsDisplayed()
        compose.onNodeWithText(SetEffort.rpeUnrated).performClick()
        compose.onAllNodesWithText(SetEffort.rpeUnrated)[1].assertExists()
        SetEffort.rpeBand.forEach {
            compose.onNodeWithText(SetEffort.rpeReading(it)).assertExists()
        }
        compose.onNodeWithText(SetEffort.rpeReading(10.0))
            .performScrollTo().assertIsDisplayed()
    }

    @Test
    fun theNoteIsLabelledAndSaysWhoItIsForRatherThanPretendingCoachReadsIt() {
        sheet()

        compose.onNodeWithText(SetEffort.noteLabel).assertIsDisplayed()
        compose.onNodeWithText(SetEffort.noteLabel).assert(SemanticsMatcher.expectValue(
            SemanticsProperties.StateDescription, SetEffort.noteCaption))
    }

    @Test
    fun pickingAnRpeAndTypingANoteSendsThoseTwoFieldsAndNothingElse() {
        val saved = sheet()

        compose.onNodeWithText(SetEffort.rpeUnrated).performClick()
        compose.onNodeWithText(SetEffort.rpeReading(8.5)).performScrollTo().performClick()
        compose.onNodeWithText(SetEffort.noteLabel).performTextInput("left shoulder")
        compose.onNodeWithText("Save fix").performClick()

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
        val saved = sheet(TrainingSet(id = "set_1", exerciseId = "bench-press", setNumber = 2,
            weightKg = 82.5, reps = 5, kind = SetKind.Working, completedAtMs = 0, rpe = 9.0, note = "felt heavy"))

        compose.onNodeWithText("felt heavy").performTextClearance()
        compose.onNodeWithText(SetEffort.rpeReading(9.0)).performClick()
        compose.onNodeWithText(SetEffort.rpeUnrated).performClick()
        compose.onNodeWithText("Save fix").performClick()

        compose.runOnIdle {
            assertEquals("", saved()!!.note)
            assertTrue("named, and named as nothing", saved()!!.rpeNamed)
            assertNull(saved()!!.rpe)
        }
    }

    @Test
    fun aSheetOpenedOverAnAnnotatedSetAndSavedUntouchedSendsNothingAtAll() {
        val saved = sheet(TrainingSet(id = "set_1", exerciseId = "bench-press", setNumber = 2,
            weightKg = 82.5, reps = 5, kind = SetKind.Working, completedAtMs = 0, rpe = 9.0, note = "felt heavy"))

        compose.onNodeWithText("Save fix").performClick()

        compose.runOnIdle {
            assertEquals("an empty diff, which is what leaves another device's work alone",
                SetFix(), saved())
        }
    }

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

    @Test
    fun anOverlongNoteIsRefusedAtTheFieldAndTheSaveIsHeld() {
        val saved = sheet()

        compose.onNodeWithText(SetEffort.noteLabel)
            .performTextInput("🏋".repeat(1_001))

        compose.onNodeWithText(SetEffort.noteTooLong).assertIsDisplayed()
        compose.onNodeWithText("Save fix").assertIsNotEnabled()
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { assertNull("and nothing was sent", saved()) }
    }
}
