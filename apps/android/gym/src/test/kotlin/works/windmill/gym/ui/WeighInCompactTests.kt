package works.windmill.gym.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.presentation.WeighIn

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WeighInCompactTests {
    @get:Rule val compose = createComposeRule()

    @Test fun theCompactFormFitsItsApprovedHeightAndErrorsGrowWithTheirSupportingSentence() {
        val day = LocalDate.now()
        compose.setContent { GymMaterial { Column {
            WeighInHandle()
            WeighInSheet(WeighIn(day.toString(), 82.4), null, System.currentTimeMillis(), false, null, { _, _ -> }, null)
        } } }
        val normal = compose.onNodeWithTag("weigh-in-form").getBoundsInRoot().height + 24.dp
        assertEquals(314f, normal.value, 4f)
        compose.onNodeWithContentDescription(weightField).performTextReplacement("400.01")
        val error = compose.onNodeWithTag("weigh-in-form").getBoundsInRoot().height + 24.dp
        assertEquals(340f, error.value, 4f)
        compose.onNodeWithText("Save weight").assertIsDisplayed().assertIsNotEnabled()
    }
}
