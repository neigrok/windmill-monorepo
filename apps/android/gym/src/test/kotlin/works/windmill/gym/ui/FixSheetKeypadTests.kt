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

// C10: a correction at the rack is one-handed too. Tapping the weight numeral or the rep count raises
// the room's own keypad — the same one the logger raises — rather than making a lifter dial 40 kg off
// in 2.5 kg steps.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class FixSheetKeypadTests {
    @get:Rule
    val compose = createComposeRule()

    private val set = TrainingSet(
        id = "set_1",
        exerciseId = "bench-press",
        setNumber = 2,
        weightKg = 82.5,
        reps = 5,
        kind = SetKind.Working,
        completedAtMs = 0,
    )

    private fun sheet(): () -> SetFix? {
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
    fun testTappingTheWeightNumeralRaisesTheKeypadAndTypesTheLoad() {
        val saved = sheet()

        compose.onNodeWithText("82.5").performClick()
        compose.onNodeWithText("Weight").assertIsDisplayed()
        compose.onNodeWithText("7").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("Set").performClick()

        compose.onNodeWithText("70").assertIsDisplayed()
        compose.onNodeWithText("Save the fix").performClick()
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
        compose.onNodeWithText("whole reps").assertIsDisplayed()
        compose.onNodeWithText("8").performClick()
        compose.onNodeWithText("Set").performClick()

        compose.onNodeWithText("Save the fix").performClick()
        compose.runOnIdle {
            assertEquals(8, saved()!!.reps)
            assertNull("the weight did not move, so it is not in the fix", saved()!!.weightKg)
        }
    }

    // Cancel is the way out of the pad and back to the sheet, with the set as it was.
    @Test
    fun testCancellingThePadLeavesTheSetAloneAndGivesTheSheetBack() {
        val saved = sheet()

        compose.onNodeWithText("82.5").performClick()
        compose.onNodeWithText("1").performClick()
        compose.onNodeWithText("Cancel").performClick()

        compose.onNodeWithText("Fix this set").assertIsDisplayed()
        compose.onNodeWithText("82.5").assertIsDisplayed()
        compose.runOnIdle { assertNull(saved()) }
    }

    // C21 reaches the rack's pad too: the ten digits and the decimal separator read themselves out
    // loud, and the pad's two glyphs read as nothing, so each carries a name — ± in the same bytes the
    // target sheet's own ± control carries. A named key still works: the sign flips, the delete deletes.
    @Test
    fun testBothGlyphKeysAreNamedAndStillDoTheirWork() {
        sheet()

        compose.onNodeWithText("82.5").performClick()
        val sign = compose.onNodeWithContentDescription("Flip the sign").fetchSemanticsNode()
        assertEquals(listOf("Flip the sign"), sign.config[SemanticsProperties.ContentDescription])

        compose.onNodeWithContentDescription("Flip the sign").performClick()
        compose.onNodeWithText("−82.5").assertIsDisplayed()

        val delete = compose.onNodeWithContentDescription("Delete").fetchSemanticsNode()
        assertEquals(listOf("Delete"), delete.config[SemanticsProperties.ContentDescription])

        compose.onNodeWithContentDescription("Delete").performClick()
        compose.onNodeWithText("−82.").assertIsDisplayed()
    }

    // And only those two. The grid is twelve keys and the delete key sits in the action row: of the
    // thirteen, two are named, and a digit that says a word out loud is a worse pad than a silent one.
    @Test
    fun testTheOtherElevenKeysCarryNoNameAtAll() {
        sheet()

        compose.onNodeWithText("82.5").performClick()
        KeypadEntry.keys.filter { it != "±" }.forEach { key ->
            val node = compose.onNodeWithText(key).fetchSemanticsNode()
            assertNull("$key names itself", node.config.getOrNull(SemanticsProperties.ContentDescription))
        }
        compose.onAllNodesWithContentDescription("Flip the sign").assertCountEquals(1)
        compose.onAllNodesWithContentDescription("Delete").assertCountEquals(1)
    }

    // The pad refuses out of band with the LOGGER's sentence, not the plan's: 99 is what a performed
    // set may hold.
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
