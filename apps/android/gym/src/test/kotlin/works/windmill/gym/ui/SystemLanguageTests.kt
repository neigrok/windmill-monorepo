package works.windmill.gym.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// The room speaks English on a phone set to any language: its counts keep English plural forms and ASCII digits.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SystemLanguageTests {
    @get:Rule val compose = createComposeRule()

    private fun readsEnglish() {
        var sets by mutableIntStateOf(1)
        compose.setContent {
            GymMaterial {
                GymScreen("Routines", onBack = {}, backTo = "The log") {}
                WorkoutDiscardDialog(sets, onDiscard = {}, onCancel = {})
            }
        }
        compose.onNodeWithContentDescription("Back to The log").assertExists()
        for ((count, sentence) in listOf(
            1 to "This deletes the workout and its 1 set. You can’t undo this.",
            2 to "This deletes the workout and its 2 sets. You can’t undo this.",
            21 to "This deletes the workout and its 21 sets. You can’t undo this.",
            0 to "This deletes the workout and its 0 sets. You can’t undo this.",
        )) {
            sets = count
            compose.onNodeWithText(sentence).assertExists()
        }
        compose.onNodeWithText("Discard this workout?").assertExists()
    }

    @Test @Config(qualifiers = "ar-w412dp-h915dp-xhdpi") fun anArabicPhoneReadsEnglish() = readsEnglish()

    @Test @Config(qualifiers = "ru-w412dp-h915dp-xhdpi") fun aRussianPhoneReadsEnglish() = readsEnglish()

    @Test @Config(qualifiers = "de-w412dp-h915dp-xhdpi") fun aGermanPhoneReadsEnglish() = readsEnglish()
}
