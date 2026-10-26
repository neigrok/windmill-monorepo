package works.windmill.gym.ui

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback

// Value changes, gestures, non-set saves and finish cues honor Android's touch-feedback setting.
class GymHaptics(private val haptic: HapticFeedback) {
    fun ticked() = haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)

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
