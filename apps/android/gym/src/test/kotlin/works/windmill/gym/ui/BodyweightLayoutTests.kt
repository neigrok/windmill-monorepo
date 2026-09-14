package works.windmill.gym.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.WeighIn
import works.windmill.platform.design.LocalWindmillDark

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w320dp-h640dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BodyweightLayoutTests {
    @get:Rule val compose = createComposeRule()

    @Test fun instrumentKeepsCorrectionActionsAboveAKeyboardSizedViewportAtDoubleText() = correctionAtDoubleText(true)
    @Test fun daylightKeepsCorrectionActionsAboveAKeyboardSizedViewportAtDoubleText() = correctionAtDoubleText(false)

    private fun correctionAtDoubleText(dark: Boolean) {
        val day = LocalDate.now().minusDays(2)
        val saved = mutableListOf<Pair<String, Double>>()
        var deletes = 0
        compose.setContent {
            CompositionLocalProvider(LocalWindmillDark provides dark,
                LocalDensity provides Density(density = 2f, fontScale = 2f)) {
                GymMaterial {
                    Box(Modifier.height(340.dp)) {
                        WeighInSheet(WeighIn(day.toString(), 82.4, 1_000), day, System.currentTimeMillis(), false, null,
                            onSave = { date, weight -> saved += date to weight }, onDelete = { deletes++ })
                    }
                }
            }
        }
        compose.onNodeWithContentDescription(weightField).performScrollTo().performTextReplacement("400,01")
        compose.onNodeWithText(Bodyweight.save).assertIsDisplayed().performClick()
        compose.onNodeWithText(Bodyweight.outOfRange).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription(weightField).performScrollTo().performTextReplacement("82,45")
        compose.onNodeWithText(Bodyweight.fullDay(day)).performScrollTo().assertIsDisplayed()
        for (label in listOf(Bodyweight.save, Bodyweight.deleteRow)) {
            val button = compose.onNodeWithText(label).assertIsDisplayed()
            assertTrue(button.getBoundsInRoot().height >= 56.dp)
            val layouts = mutableListOf<TextLayoutResult>()
            button.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!(layouts)
            val layout = layouts.single()
            assertFalse("$label exceeds its available height", layout.didOverflowHeight)
            for (line in 0 until layout.lineCount) {
                assertFalse("$label is ellipsized", layout.isLineEllipsized(line))
                val width = layout.getLineRight(line) - layout.getLineLeft(line)
                assertTrue("$label: line width $width exceeds ${layout.size.width}", width <= layout.size.width + 1)
            }
            assertEquals(label.length, layout.getLineEnd(layout.lineCount - 1))
        }
        compose.onNodeWithText(Bodyweight.save).performClick()
        compose.onNodeWithText(Bodyweight.deleteRow).performClick()
        compose.runOnIdle {
            assertEquals(listOf(day.toString() to 82.45), saved)
            assertEquals(1, deletes)
        }
    }
}
