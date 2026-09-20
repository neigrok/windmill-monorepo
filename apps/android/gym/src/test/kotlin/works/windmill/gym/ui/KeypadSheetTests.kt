package works.windmill.gym.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class KeypadSheetTests {
    @get:Rule val compose = createComposeRule()

    @Test
    fun repsRefusalKeepsTheBufferAndDisabledKeysUntilItIsRepaired() {
        val commits = mutableListOf<Double>()
        compose.setContent { KeypadSheet(KeypadEntry.Mode.Reps, 8.0, onCommit = { commits += it }) }
        compose.onNodeWithContentDescription(KeypadEntry.signName).assertIsNotEnabled()
        compose.onNodeWithText(".").assertIsNotEnabled()
        compose.onNodeWithText("1").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("0").performClick()
        compose.onNodeWithText("100").assertIsDisplayed()
        compose.onNodeWithText(KeypadEntry.outsideReps).assertIsDisplayed()
        compose.onNodeWithText("Set reps").assertIsNotEnabled().performClick()
        compose.runOnIdle { assertEquals(emptyList<Double>(), commits) }
        compose.onNodeWithContentDescription(KeypadEntry.deleteName).performClick()
        compose.onNodeWithText("Set reps").performClick()
        compose.runOnIdle { assertEquals(listOf(10.0), commits) }
    }

    @Test
    fun restorationKeepsFirstDigitReplacementAndTheFullRefusedBuffer() {
        val commits = mutableListOf<Double>()
        val restorer = StateRestorationTester(compose)
        restorer.setContent { KeypadSheet(KeypadEntry.Mode.Weight, 82.5, onCommit = { commits += it }) }
        restorer.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("5").performClick()
        compose.onNodeWithText("2").performClick()
        compose.onNodeWithText("0").performClick()
        restorer.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("520").assertIsDisplayed()
        compose.onNodeWithText("Set weight").assertIsNotEnabled()
        compose.onNodeWithContentDescription(KeypadEntry.deleteName).performClick()
        compose.onNodeWithText(".").performClick()
        compose.onNodeWithText("5").performClick()
        compose.onNodeWithText("Set weight").performClick()
        compose.runOnIdle { assertEquals(listOf(52.5), commits) }
    }
}
