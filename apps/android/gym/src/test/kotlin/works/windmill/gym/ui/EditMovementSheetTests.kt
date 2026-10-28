package works.windmill.gym.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.Exercise

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class EditMovementSheetTests {
    @get:Rule val compose = createComposeRule()

    @Test fun theMenuOffersOnlyTheApprovedThreeChoicesAndSavesTheSelectedValue() {
        val saved = mutableListOf<Pair<String, Int>>()
        compose.setContent {
            var equipment by remember { mutableStateOf("cable") }
            var count by remember { mutableIntStateOf(1) }
            GymMaterial {
                Column {
                    EditMovementSheet(Exercise("custom", "Press", equipment = "cable"), "Press", equipment, count, null,
                        onName = {}, onEquipment = { equipment = it; count = if (it == "dumbbell") 2 else 1 },
                        onSave = { saved += equipment to count })
                }
            }
        }
        compose.onNodeWithText("Other").assertIsDisplayed()
        compose.onNodeWithText("Save").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Equipment").performClick()
        compose.onNodeWithText("Barbell").assertIsDisplayed()
        compose.onNodeWithText("Dumbbells").assertIsDisplayed().performClick()
        for (text in listOf("One", "Two", "Machine", "Cable", "Bodyweight", "Dumbbells lifted"))
            compose.onAllNodesWithText(text).assertCountEquals(0)
        compose.onNodeWithText("Save").assertIsEnabled().performClick()
        assertEquals(listOf("dumbbell" to 2), saved)
    }

    @Test fun invalidAndBusyFormsCannotSaveAndTheWholeRefusalIsVisible() {
        val writes = mutableListOf<String>()
        val refusal = "That movement changed on another device. Close and reopen it before saving."
        compose.setContent {
            GymMaterial {
                Column {
                    EditMovementSheet(Exercise("custom", "Press"), " ", "other", 1, refusal,
                        onName = {}, onEquipment = {}, onSave = { writes += "saved" })
                }
            }
        }
        compose.onNodeWithText(refusal).assertIsDisplayed()
        compose.onNodeWithText("Save").assertIsNotEnabled()
        assertEquals(emptyList<String>(), writes)
    }

    @Test fun savingDisablesBothFieldsAndTheSubmitAction() {
        compose.setContent {
            GymMaterial {
                Column {
                    EditMovementSheet(Exercise("custom", "Press"), "New press", "other", 1, null,
                        onName = {}, onEquipment = {}, onSave = {}, saving = true)
                }
            }
        }
        compose.onNodeWithContentDescription("Movement name").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Equipment").assertIsNotEnabled()
        compose.onNodeWithText("Saving…").assertIsNotEnabled()
        compose.onAllNodesWithText("The new name shows in your routines and history. Search still finds the old name.").assertCountEquals(0)
    }
}
