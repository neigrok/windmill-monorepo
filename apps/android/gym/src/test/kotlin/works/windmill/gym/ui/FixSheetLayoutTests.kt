package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.SetFix
import works.windmill.gym.presentation.TrainingSet
import works.windmill.gym.store.FixOutcome

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FixSheetLayoutTests {
    @get:Rule val compose = createComposeRule()

    @Test
    fun noteAndActionsRemainReachableWithLargeTextAndKeyboardHeight() {
        val set = TrainingSet(id = "set_7", exerciseId = "bench-press", setNumber = 7,
            weightKg = -102.5, reps = 99, completedAtMs = 0)
        val saved = mutableListOf<SetFix>()
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                Box(Modifier.height(340.dp)) {
                    FixSheet(set, "Long movement name with several words", 7, "Push A",
                        onSave = { saved += it; FixOutcome.Corrected(it.corrected(set)) }, onDelete = {})
                }
            }
        }
        compose.onNodeWithText("Set note").performScrollTo().performTextInput("Controlled tempo\n".repeat(12))
        compose.onNodeWithText("Save fix").assertIsDisplayed()
        val button = compose.onNodeWithText("Save fix").getBoundsInRoot()
        assertTrue(button.height >= 64.dp)
        compose.onNodeWithText("Save fix").performClick()
        compose.onNodeWithText("Delete set").assertIsDisplayed()
        compose.onNodeWithText("Push A keeps its planned targets.").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(SetFix(note = "Controlled tempo\n".repeat(12))), saved) }
    }

    @Test
    fun signedLoadAndItsRefusalRemainEditableWithLargeTextAndKeyboardHeight() {
        val saved = mutableListOf<SetFix>()
        val set = TrainingSet(id = "set_7", exerciseId = "chin-up", setNumber = 7,
            weightKg = -102.5, reps = 8, completedAtMs = 0)
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                Box(Modifier.height(340.dp)) {
                    GymMaterial { FixSheet(set, "Chin Up", 7, null,
                        onSave = { saved += it; FixOutcome.Corrected(it.corrected(set)) }, onDelete = {}) }
                }
            }
        }
        val field = compose.onNodeWithContentDescription("Load, kg")
        field.performScrollTo().performClick().performTextReplacement("-499.99")
        field.assertTextEquals("−499.99")
        val layouts = mutableListOf<TextLayoutResult>()
        field.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
        assertFalse(layouts.single().hasVisualOverflow)
        field.performTextReplacement("-1e999")
        compose.onNodeWithText("Save fix").performClick()
        compose.onNodeWithText("That is not a number yet.").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<SetFix>(), saved) }
        field.performScrollTo().performTextReplacement("-499.99")
        compose.onNodeWithText("Save fix").performClick()
        compose.runOnIdle { assertEquals(listOf(SetFix(weightKg = -499.99)), saved) }
    }
    @Test
    fun withTheKeyboardUpSaveFixStandsBelowTheScrollingFieldsAndDeleteScrollsWithThem() {
        val set = TrainingSet(id = "set_7", exerciseId = "bench-press", setNumber = 7, weightKg = 80.0, reps = 5, completedAtMs = 0)
        lateinit var view: android.view.View
        compose.setContent {
            view = androidx.compose.ui.platform.LocalView.current
            Box(Modifier.height(340.dp)) {
                FixSheet(set, "Bench Press", 7, "Push A", onSave = { FixOutcome.Corrected(it.corrected(set)) }, onDelete = {})
            }
        }
        val keyboard = android.view.WindowInsets.Builder()
            .setInsets(android.view.WindowInsets.Type.ime(), android.graphics.Insets.of(0, 0, 0, 600))
            .setVisible(android.view.WindowInsets.Type.ime(), true).build()
        compose.runOnIdle { view.dispatchApplyWindowInsets(keyboard) }
        compose.onNodeWithText("Save fix").assertIsDisplayed()
        val save = compose.onNodeWithText("Save fix").getBoundsInRoot()
        assertTrue("the whole button stands inside the sheet: $save", save.bottom <= 340.dp)
        compose.onNodeWithText("Delete set").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Save fix").assertIsDisplayed()
    }

    @Test fun deleteUsesTheMaterialErrorRoleInBothAppearancesAndKeepsItsTouchHeight() {
        val dark = mutableStateOf(true)
        val set = TrainingSet("set_1", "bench-press", weightKg = 75.0, reps = 8, completedAtMs = 0)
        compose.setContent {
            CompositionLocalProvider(LocalWindmillDark provides dark.value) {
                GymMaterial { FixSheet(set, "Bench Press", 1, null,
                    onSave = { FixOutcome.Corrected(set) }, onDelete = {}) }
            }
        }
        for (isDark in listOf(true, false)) {
            compose.runOnIdle { dark.value = isDark }
            val button = compose.onNodeWithText("Delete set")
            assertTrue(button.getBoundsInRoot().height >= 48.dp)
            val layouts = mutableListOf<TextLayoutResult>()
            compose.onNodeWithText("Delete set", useUnmergedTree = true)
                .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertEquals(if (isDark) GymSkin.Instrument.error else GymSkin.Daylight.error,
                layouts.single().layoutInput.style.color)
        }
    }

    @Test fun equipmentUnitsDescribeTheEditedLoadWithoutChangingItsValue() {
        val equipment = mutableStateOf("barbell")
        val set = TrainingSet("set_1", "movement", weightKg = -12.5, reps = 8, completedAtMs = 0)
        compose.setContent {
            GymMaterial { FixSheet(set, "Movement", 1, null,
                onSave = { FixOutcome.Corrected(set) }, onDelete = {},
                exercise = Exercise("movement", "Movement", equipment = equipment.value)) }
        }
        for ((kind, unit) in listOf("barbell" to "kg total", "dumbbell" to "kg each", "bodyweight" to "kg added", "machine" to "kg", "legacy-cable" to "kg")) {
            compose.runOnIdle { equipment.value = kind }
            compose.onNodeWithContentDescription("Load, $unit").assertTextEquals("−12.5")
        }
    }

}
