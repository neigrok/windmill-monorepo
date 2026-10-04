package works.windmill.gym.ui.onboarding

import android.graphics.Bitmap
import android.graphics.Canvas
import android.provider.Settings
import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.activity.ComponentActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OnboardingGlimpseTests {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var contentView: View
    private val lamp = Color(0xFFE0B972).toArgb()
    private var originalAnimatorScale: String? = null

    @Before
    fun preserveAnimatorScale() {
        originalAnimatorScale = Settings.Global.getString(compose.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
        Settings.Global.putFloat(compose.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    }

    @After
    fun restoreAnimatorScale() {
        Settings.Global.putString(compose.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalAnimatorScale)
        compose.mainClock.autoAdvance = true
    }

    private fun caretPixel(): Int {
        val bounds = compose.onNodeWithTag("journal_picture").fetchSemanticsNode().boundsInRoot
        var pixel = 0
        compose.runOnIdle {
            val bitmap = Bitmap.createBitmap(contentView.width, contentView.height, Bitmap.Config.ARGB_8888)
            contentView.draw(Canvas(bitmap))
            pixel = bitmap.getPixel(
                (bounds.left + bounds.width * 204f / 354f).toInt(),
                (bounds.top + bounds.height * 180f / 340f).toInt(),
            )
            bitmap.recycle()
        }
        return pixel
    }

    @Test
    fun reducedMotionKeepsAVisibleCaretWithNormalAndZeroAnimatorScale() {
        compose.setContent {
            contentView = LocalView.current
            Box(Modifier.size(354.dp, 340.dp).testTag("journal_picture")) {
                OnboardingGlimpse(2, active = true, reducedMotion = true, Modifier.fillMaxSize())
            }
        }
        compose.mainClock.autoAdvance = false
        for (scale in listOf(1f, 0f)) {
            compose.runOnIdle {
                Settings.Global.putFloat(compose.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, scale)
            }
            assertEquals(lamp, caretPixel())
            repeat(4) {
                compose.mainClock.advanceTimeBy(530)
                assertEquals(lamp, caretPixel())
            }
        }
    }

    @Test
    fun reducingMotionDuringTheHiddenBlinkRestoresTheCaretAndCancelsFurtherBlinks() {
        val reduced = mutableStateOf(false)
        compose.setContent {
            contentView = LocalView.current
            Box(Modifier.size(354.dp, 340.dp).testTag("journal_picture")) {
                OnboardingGlimpse(2, active = true, reducedMotion = reduced.value, Modifier.fillMaxSize())
            }
        }
        compose.mainClock.autoAdvance = false
        compose.mainClock.advanceTimeBy(530)
        assertNotEquals(lamp, caretPixel())
        compose.runOnIdle { reduced.value = true }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(lamp, caretPixel())
        repeat(4) {
            compose.mainClock.advanceTimeBy(530)
            assertEquals(lamp, caretPixel())
        }
        compose.runOnIdle { reduced.value = false }
        compose.mainClock.advanceTimeByFrame()
        assertEquals(lamp, caretPixel())
        compose.mainClock.advanceTimeBy(530)
        compose.mainClock.advanceTimeByFrame()
        assertNotEquals(lamp, caretPixel())
    }
}
