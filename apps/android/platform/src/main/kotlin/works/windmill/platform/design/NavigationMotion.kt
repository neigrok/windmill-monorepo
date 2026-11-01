package works.windmill.platform.design

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp

// How one Android screen replaces another, after Material: one duration, the emphasized curves, the two
// transitions, and how far a back gesture shrinks what it is leaving. The brand's own cadence is
// `WindmillMotion` in Tokens.kt.
object NavigationMotion {
    const val durationMs = 300
    val emphasized = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val emphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val emphasizedAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)

    // The system reports how far a back swipe has come; Material eases it so the shrink arrives early
    // in the swipe and settles as the finger travels on.
    private val backEasing = CubicBezierEasing(0.1f, 0.1f, 0f, 1f)
    fun backProgress(swiped: Float): Float = backEasing.transform(swiped)
    const val backScale = 0.9f
    val backShift = 8.dp
    val backCorner = 28.dp
    val sharedAxisSlide = 30.dp

    // The outgoing screen fades in the first 90 ms, the incoming one in the rest; both travel the
    // whole 300 ms along the axis, forward to the left.
    fun sharedAxisX(forward: Boolean, slidePx: Int): ContentTransform {
        val sign = if (forward) 1 else -1
        val fadeOutMs = durationMs * 3 / 10
        return (slideInHorizontally(tween(durationMs, easing = emphasized)) { sign * slidePx } +
            fadeIn(tween(durationMs - fadeOutMs, delayMillis = fadeOutMs, easing = emphasizedDecelerate))) togetherWith
            (slideOutHorizontally(tween(durationMs, easing = emphasized)) { -sign * slidePx } +
                fadeOut(tween(fadeOutMs, easing = emphasizedAccelerate)))
    }

    fun fadeThrough(): ContentTransform {
        val fadeOutMs = durationMs * 3 / 10
        val incoming = tween<Float>(durationMs - fadeOutMs, delayMillis = fadeOutMs, easing = emphasizedDecelerate)
        return (fadeIn(incoming) + scaleIn(incoming, initialScale = 0.92f)) togetherWith
            fadeOut(tween(fadeOutMs, easing = emphasizedAccelerate))
    }
}

// False while the system's Remove animations is on, and then every transition is a cut. The setting
// is watched, so turning it on applies to the next gesture without leaving the app.
@Composable
fun animationsOn(): Boolean {
    val resolver = LocalContext.current.contentResolver
    fun read() = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
    var on by remember(resolver) { mutableStateOf(read()) }
    DisposableEffect(resolver) {
        val watcher = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { on = read() }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, watcher)
        onDispose { resolver.unregisterContentObserver(watcher) }
    }
    return on
}
