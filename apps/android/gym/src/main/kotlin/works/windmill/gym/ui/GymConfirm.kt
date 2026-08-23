package works.windmill.gym.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import works.windmill.gym.domain.GymPreferences

// The haptic goes through Compose's HapticFeedback, which needs no VIBRATE permission. The rest chime
// is an effect that sleeps until the instant it is due: no AlarmManager, no notification, no wake lock.
class GymConfirm(
    private val context: Context,
    private val haptic: HapticFeedback,
    private val preferences: GymPreferences,
) {
    fun setLogged() {
        if (preferences.confirmHaptic) haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        if (preferences.confirmSound) GymSound.setLogged(context)
    }

    fun restLanded() {
        if (preferences.restSound) GymSound.restLanded(context)
    }
}

@Composable
fun rememberGymConfirm(preferences: GymPreferences): GymConfirm {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    return remember(context, haptic, preferences) { GymConfirm(context, haptic, preferences) }
}
