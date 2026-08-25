package works.windmill.gym.domain

// Rest is COMPUTED from the instant the set landed, never counted down. The reading counts UP
// throughout — time since the last set, the one reading every surface prints — and a target only adds
// facts beside it: the bar, its name in the label, and the chime. A routine line's `restSeconds`
// outranks the global dial; with no target there is no bar and no sound, and `fraction` is null.

object Rest {
    fun target(planEntry: PlanEntry?, preferences: GymPreferences): Int? =
        planEntry?.restSeconds ?: preferences.restSeconds

    class Line(targetSeconds: Int?, startedAtMs: Long, now: Long) {
        val label: String
        val time: String
        val overrun: Boolean
        val fraction: Float?

        init {
            val elapsed = (now - startedAtMs) / 1000
            time = Readout.clock(elapsed * 1000)
            if (targetSeconds == null || targetSeconds <= 0) {
                overrun = false
                label = "resting"
                fraction = null
            } else {
                overrun = elapsed >= targetSeconds
                label = (if (overrun) "rest done · target " else "resting · target ") +
                    Readout.clock(targetSeconds * 1000L)
                // Clamped at both ends: a clock corrected backwards mid-rest draws an empty bar.
                fraction = (elapsed.toFloat() / targetSeconds).coerceIn(0f, 1f)
            }
        }
    }
}
