package works.windmill.gym.ui

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.store.FixOutcome

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FixSheetKeypadTests {
    @get:Rule
    val compose = createComposeRule()

    private fun sheet(): () -> SetFix? {
        val set = TrainingSet(
            id = "set_1", exerciseId = "bench-press", setNumber = 2,
            weightKg = 82.5, reps = 5, kind = SetKind.Working, completedAtMs = 0,
        )

        var saved: SetFix? = null
        compose.setContent {
            FixSheet(
                set = set,
                movement = "Bench Press",
                setNumber = 2,
                routine = null,
                onSave = { saved = it; FixOutcome.Corrected(it.corrected(set)) },
                onDelete = {},
            )
        }
        return { saved }
    }

    @Test
    fun testTappingTheWeightNumeralRaisesTheKeypadAndTypesTheLoad() {
        val saved = sheet()

        compose.onNodeWithText("82.5").performClick()
        compose.onNodeWithText("Weight").assertIsDisplayed()
        compose.onNodeWithText("7").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("Set weight").performClick()

        compose.onNodeWithText("70").assertIsDisplayed()
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(70.0, saved()!!.weightKg)
            assertNull("a fix names only what it changes, so nothing else is on the wire",
                saved()!!.reps)
        }
    }

    @Test
    fun testTappingTheRepCountRaisesTheKeypadInRepsMode() {
        val saved = sheet()

        compose.onNodeWithText("5").performClick()
        compose.onNodeWithText("Reps").assertIsDisplayed()
        compose.onNodeWithText("reps").assertIsDisplayed()
        compose.onNodeWithText("8").performClick()
        compose.onNodeWithText("Set reps").performClick()

        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle {
            assertEquals(8, saved()!!.reps)
            assertNull("the weight did not move, so it is not in the fix", saved()!!.weightKg)
        }
    }

    @Test
    fun testCancellingThePadLeavesTheSetAloneAndGivesTheSheetBack() {
        val saved = sheet()

        compose.onNodeWithText("82.5").performClick()
        compose.onNodeWithText("1").performClick()
        compose.onNodeWithText("Cancel").performClick()

        compose.onNodeWithText("Fix set").assertIsDisplayed()
        compose.onNodeWithText("82.5").assertIsDisplayed()
        compose.runOnIdle { assertNull(saved()) }
    }

    @Test
    fun testBothGlyphKeysAreNamedAndStillDoTheirWork() {
        sheet()

        compose.onNodeWithText("82.5").performClick()
        val sign = compose.onNodeWithContentDescription("Flip the sign — band-assisted").fetchSemanticsNode()
        assertEquals(listOf("Flip the sign — band-assisted"), sign.config[SemanticsProperties.ContentDescription])

        compose.onNodeWithContentDescription("Flip the sign — band-assisted").performClick()
        compose.onNodeWithText("−82.5").assertIsDisplayed()

        val delete = compose.onNodeWithContentDescription("Delete").fetchSemanticsNode()
        assertEquals(listOf("Delete"), delete.config[SemanticsProperties.ContentDescription])

        compose.onNodeWithContentDescription("Delete").performClick()
        compose.onNodeWithText("−82.").assertIsDisplayed()
    }

    @Test
    fun testTheOtherElevenKeysCarryNoNameAtAll() {
        sheet()

        compose.onNodeWithText("82.5").performClick()
        KeypadEntry.keys.filter { it != "±" }.forEach { key ->
            val node = compose.onNodeWithText(key).fetchSemanticsNode()
            assertNull("$key names itself", node.config.getOrNull(SemanticsProperties.ContentDescription))
        }
        compose.onAllNodesWithContentDescription("Flip the sign — band-assisted").assertCountEquals(1)
        compose.onAllNodesWithContentDescription("Delete").assertCountEquals(1)
    }

    @Test
    fun testThePadAtTheRackKeepsTheLoggersBand() {
        sheet()

        compose.onNodeWithText("5").performClick()
        compose.onNodeWithText("1").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("Whole reps, 1 to 99.").assertIsDisplayed()
    }
}
