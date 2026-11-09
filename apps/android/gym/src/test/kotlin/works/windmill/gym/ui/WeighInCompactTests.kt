package works.windmill.gym.ui

import android.content.Context
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.test.core.app.ApplicationProvider
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.R
import works.windmill.gym.presentation.WeighIn
import works.windmill.gym.presentation.Bodyweight

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WeighInCompactTests {
    @get:Rule val compose = createComposeRule()

    @OptIn(ExperimentalMaterial3Api::class)
    @Test fun theCompactFormFitsItsApprovedHeightAndErrorsGrowWithTheirSupportingSentence() {
        val day = LocalDate.now()
        compose.setContent { GymMaterial { Column {
            BottomSheetDefaults.DragHandle()
            WeighInSheet(WeighIn(day.toString(), 82.4), null, System.currentTimeMillis(), false, null, { _, _ -> }, null, onClose = {})
        } } }
        val normal = compose.onNodeWithTag("weigh-in-form").getBoundsInRoot().height + 48.dp
        // 06.1N's approved sheet: handle, head, Weight, Date and Save weight above the keyboard.
        assertEquals(350f, normal.value, 4f)
        compose.onNodeWithContentDescription(string(R.string.gym_bodyweight_weight_field)).performTextReplacement("400.01")
        val error = compose.onNodeWithTag("weigh-in-form").getBoundsInRoot().height + 48.dp
        // No board draws the refusal; this measured height, one supporting line taller, is the approved one.
        assertEquals(377f, error.value, 4f)
        compose.onNodeWithText(string(R.string.gym_bodyweight_save)).assertIsDisplayed().assertIsNotEnabled()
    }
}

private fun string(@StringRes id: Int, vararg args: Any): String = ApplicationProvider.getApplicationContext<Context>().getString(id, *args)
