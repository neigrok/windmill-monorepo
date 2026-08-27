package works.windmill.gym.ui

import android.content.Context
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import works.windmill.gym.domain.GymPreferences

// The room's haptic vocabulary, one sensation per KIND of act (ledger `1z`): a swipe that reveals
// ticks, a save confirms, a finish is the room's one closing note. Nothing buzzes on a scroll and
// nothing buzzes twice for one act — the set confirmation IS a save, and it spends the save's
// impact, which is the same sensation iOS spends there.
//
// Where the platform has no constant for a sensation the fallback is the nearest one it DOES have
// rather than a stronger one: an unknown constant is silence, and a long press is not a light tick.
// This goes through Compose's HapticFeedback, which needs no VIBRATE permission and already honours
// Android's own touch-feedback setting.
class GymHaptics(private val haptic: HapticFeedback) {
    fun revealed() = haptic.performHapticFeedback(light)

    fun saved() = haptic.performHapticFeedback(medium)

    fun finished() = haptic.performHapticFeedback(closing)

    companion object {
        val light: HapticFeedbackType
            get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
                HapticFeedbackType.GestureThresholdActivate else HapticFeedbackType.ContextClick

        val medium: HapticFeedbackType
            get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                HapticFeedbackType.Confirm else HapticFeedbackType.LongPress

        val closing: HapticFeedbackType
            get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                HapticFeedbackType.GestureEnd else HapticFeedbackType.LongPress
    }
}

@Composable
fun rememberGymHaptics(): GymHaptics {
    val haptic = LocalHapticFeedback.current
    return remember(haptic) { GymHaptics(haptic) }
}

// The set confirmation, which is the one act in this room with a preference of its own. The rest
// chime is an effect that sleeps until the instant it is due: no AlarmManager, no notification, no
// wake lock.
class GymConfirm(
    private val context: Context,
    private val haptics: GymHaptics,
    private val preferences: GymPreferences,
) {
    fun setLogged() {
        if (preferences.confirmHaptic) haptics.saved()
        if (preferences.confirmSound) GymSound.setLogged(context)
    }

    fun restLanded() {
        if (preferences.restSound) GymSound.restLanded(context)
    }
}

@Composable
fun rememberGymConfirm(preferences: GymPreferences): GymConfirm {
    val context = LocalContext.current
    val haptics = rememberGymHaptics()
    return remember(context, haptics, preferences) { GymConfirm(context, haptics, preferences) }
}
