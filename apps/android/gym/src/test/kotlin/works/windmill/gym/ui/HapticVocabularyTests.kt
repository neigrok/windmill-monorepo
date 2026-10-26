package works.windmill.gym.ui

import android.os.Build
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class Felt : HapticFeedback {
    val sensations = mutableListOf<HapticFeedbackType>()
    override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
        sensations += hapticFeedbackType
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class HapticVocabularyTests {
    @Test
    fun acceptedChangesAndTheThreeGesturesUseTheNamedPlatformSensations() {
        val felt = Felt()
        val haptics = GymHaptics(felt)

        haptics.ticked()
        haptics.revealed()
        haptics.saved()
        haptics.finished()

        assertEquals(listOf(HapticFeedbackType.TextHandleMove, HapticFeedbackType.GestureThresholdActivate,
            HapticFeedbackType.Confirm, HapticFeedbackType.GestureEnd), felt.sensations)
    }

    // The extended constants land at API 30 and 34. Below those the fallback is the nearest
    // sensation the platform DOES have, never a stronger one and never an unknown constant, which
    // would be silence.
    @Test
    fun theFallbacksAreNamedRatherThanLeftToAnUnknownConstant() {
        assertEquals(Build.VERSION_CODES.UPSIDE_DOWN_CAKE, 34)
        assertEquals(Build.VERSION_CODES.R, 30)
        assertEquals(HapticFeedbackType.GestureThresholdActivate, GymHaptics.light)
        assertEquals(HapticFeedbackType.Confirm, GymHaptics.medium)
        assertEquals(HapticFeedbackType.GestureEnd, GymHaptics.closing)
    }

    @Config(sdk = [28])
    @Test
    fun onAnOlderPlatformEverySensationIsOneItActuallyHas() {
        assertEquals("a light tick it has had since API 23", HapticFeedbackType.ContextClick,
            GymHaptics.light)
        assertEquals(HapticFeedbackType.LongPress, GymHaptics.medium)
        assertEquals(HapticFeedbackType.LongPress, GymHaptics.closing)
    }
}
