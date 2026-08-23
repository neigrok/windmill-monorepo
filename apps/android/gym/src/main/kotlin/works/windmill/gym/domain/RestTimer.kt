package works.windmill.gym.domain

// Rest is COMPUTED from the instant the set landed, never counted down. A routine line's `restSeconds`
// outranks the global dial; with no target the clock counts up, makes no sound, and `fraction` is null.

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
            if (targetSeconds == null || targetSeconds <= 0) {
                overrun = false
                label = "resting"
                time = Readout.clock(elapsed * 1000)
                fraction = null
            } else {
                val left = targetSeconds - elapsed
                overrun = left < 0
                label = (if (overrun) "rest done · target " else "resting · target ") +
                    Readout.clock(targetSeconds * 1000L)
                time = if (overrun) "+" + Readout.clock(-left * 1000) else Readout.clock(left * 1000)
                // Clamped at both ends: a clock corrected backwards mid-rest draws an empty bar.
                fraction = (elapsed.toFloat() / targetSeconds).coerceIn(0f, 1f)
            }
        }
    }
}
