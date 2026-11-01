package works.windmill.gym.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
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
import works.windmill.gym.presentation.SetEffort
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.TrainingSet
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
        weightKg = 82.5, reps = 5, completedAtMs = 0,
    ), haptics: HapticFeedback? = null): () -> SetFix? {
        var saved: SetFix? = null
        compose.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides (haptics ?: LocalHapticFeedback.current)) {
                FixSheet(
                    set = set,
                    movement = "Bench Press",
                    position = 2,
                    routine = null,
                    onSave = { saved = it; FixOutcome.Corrected(it.corrected(set)) },
                    onDelete = {},
                )
            }
        }
        return { saved }
    }

    @Test
    fun correctingAHistoricalSetHasNoConfirmationHaptic() {
        val sensations = mutableListOf<HapticFeedbackType>()
        val saved = sheet(TrainingSet(id = "set_1", exerciseId = "bench-press", setNumber = 2,
            weightKg = 82.5, reps = 5, completedAtMs = 0), object : HapticFeedback {
            override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
                sensations += hapticFeedbackType
            }
        })

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
        }
    }

    @Test
    fun clearingANoteSendsAnEmptyStringAndClearingAnRpeNamesItAsNull() {
        val saved = sheet(TrainingSet(id = "set_1", exerciseId = "bench-press", setNumber = 2,
            weightKg = 82.5, reps = 5, completedAtMs = 0, rpe = 9.0, note = "felt heavy"))

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
            weightKg = 82.5, reps = 5, completedAtMs = 0, rpe = 9.0, note = "felt heavy"))

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
    @Test fun theFilledNoteKeepsItsEmptyLabelAndRestoresExactDraftBytesWithEffort() {
        val restoration = StateRestorationTester(compose)
        val set = TrainingSet("set_1", "bench-press", weightKg = 75.0, reps = 8, completedAtMs = 0)
        val notes = mutableListOf<SetFix>()
        restoration.setContent { GymMaterial {
            FixSheet(set, "Bench Press", 1, null,
                onSave = { notes += it; FixOutcome.Corrected(it.corrected(set)) }, onDelete = {})
        } }
        compose.onNodeWithText("Set note").assertIsDisplayed()
        compose.onNodeWithText("Add a note").assertIsDisplayed()
        val raw = "  slow 🏋\nnext set  "
        compose.onNodeWithText("Set note").performTextInput(raw)
        compose.onNodeWithText("Add a note").assertDoesNotExist()
        compose.onNodeWithText("Not rated").performClick()
        compose.onNodeWithText("RPE 8.5").performScrollTo().performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText(raw).assertExists()
        compose.onNodeWithText("RPE 8.5").assertExists()
        compose.onNodeWithText("Set note").assert(SemanticsMatcher.expectValue(
            SemanticsProperties.StateDescription, SetEffort.noteCaption))
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(note = raw, rpe = 8.5, rpeNamed = true)), notes) }
    }

}
