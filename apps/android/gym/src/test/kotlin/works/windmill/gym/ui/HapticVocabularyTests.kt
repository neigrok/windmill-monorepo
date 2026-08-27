package works.windmill.gym.ui

import android.os.Build
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.domain.GymPreferences

private class Felt : HapticFeedback {
    val sensations = mutableListOf<HapticFeedbackType>()
    override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
        sensations += hapticFeedbackType
    }
}

// Ledger `1z`: gym shipped exactly one haptic and the two phones disagreed about what it felt like.
// This is the vocabulary that replaces the disagreement — light on a swipe that reveals, medium on
// a save, a closing note on a finish — and the set confirmation is a SAVE, which is what makes it
// the same sensation iOS spends there.
//
// Nothing buzzes twice for one act: the set confirmation spends the save's impact and nothing else.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class HapticVocabularyTests {
    @Test
    fun theThreeSensationsAreDistinctWherePlatformHasThem() {
        val felt = Felt()
        val haptics = GymHaptics(felt)

        haptics.revealed()
        haptics.saved()
        haptics.finished()

        assertEquals(3, felt.sensations.size)
        assertEquals("a swipe that reveals ticks", HapticFeedbackType.GestureThresholdActivate,
            felt.sensations[0])
        assertEquals("a save confirms — the same impact iOS spends on a logged set",
            HapticFeedbackType.Confirm, felt.sensations[1])
        assertEquals("a finish is the room's closing note", HapticFeedbackType.GestureEnd,
            felt.sensations[2])
        assertEquals("and a long press is none of them any more", 3,
            felt.sensations.count { it != HapticFeedbackType.LongPress })
    }

    @Test
    fun aLoggedSetSpendsTheSavesImpactAndOnlyWhereThePreferenceIsOn() {
        val felt = Felt()
        GymConfirm(
            context = androidx.test.core.app.ApplicationProvider.getApplicationContext(),
            haptics = GymHaptics(felt),
            preferences = GymPreferences(confirmHaptic = true, confirmSound = false),
        ).setLogged()

        assertEquals(listOf(GymHaptics.medium), felt.sensations)
        assertNotEquals("which is no longer a long press", HapticFeedbackType.LongPress,
            felt.sensations.single())

        val quiet = Felt()
        GymConfirm(
            context = androidx.test.core.app.ApplicationProvider.getApplicationContext(),
            haptics = GymHaptics(quiet),
            preferences = GymPreferences(confirmHaptic = false, confirmSound = false),
        ).setLogged()
        assertEquals(emptyList<HapticFeedbackType>(), quiet.sensations)
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
