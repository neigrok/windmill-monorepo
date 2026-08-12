package works.windmill.gym.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import works.windmill.gym.domain.GymPreferences

// HOW A LOGGED SET SAYS SO, and the one place §I's two confirmation toggles are obeyed. The screen
// already confirms visually — the row appears, the button says the weight back at 64dp — so what
// this adds is the confirmation a lifter gets without looking: a tap in the hand, and the chime
// when the rest lands while the phone is in a pocket.
//
// THIS PLATFORM HAS A HAPTIC, which is why the default is haptic on and sound off. It goes through
// Compose's own HapticFeedback and therefore through View.performHapticFeedback, which needs no
// VIBRATE permission — the app asks for INTERNET and nothing else, and a training log has no
// business holding a permission it can do without. The cost is that it obeys Android's system
// touch-feedback switch, which is the honest arrangement: the phone's owner outranks us, and the
// settings row says so where it is drawn rather than promising a buzz the OS has turned off.
//
// THE REST CHIME IS SCHEDULED AND NOT WATCHED FOR — the effect that calls it sleeps until the
// instant the rest is due rather than polling a clock while the screen draws. What it is NOT is an
// alarm booked with the system: nothing here reaches AlarmManager, posts a notification or takes a
// wake lock, so whatever ends the app ends the chime. The room does hold the screen awake for the
// length of a workout, which is the only promise the settings row makes about it.
class GymConfirm(
    private val context: Context,
    private val haptic: HapticFeedback,
    private val preferences: GymPreferences,
) {
    fun setLogged() {
        if (preferences.confirmHaptic) haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        if (preferences.confirmSound) GymSound.setLogged(context)
    }

    // The rest landing has one voice and it is the sound: a haptic in a pocket is a rumour, and a
    // phone on a bench three feet away cannot deliver one at all.
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
