package works.windmill.gym.domain

// Rest is COMPUTED from the instant the set landed, never counted down. The reading counts UP
// throughout — time since the last set, the one reading every surface prints — and a target only adds
// facts beside it: the bar, its name in the label, and the chime. A routine line's `restSeconds`
// outranks the global dial, and the label says so where it does — the timer is the one place on the
// phone that fact is drawn; with no target there is no bar and no sound, and `fraction` is null.

object Rest {
    // The bytes every surface appends when the routine's own line is what the clock runs against.
    const val fromRoutine = " · from the routine"

    data class Target(val seconds: Int, val fromRoutine: Boolean)

    fun target(planEntry: PlanEntry?, preferences: GymPreferences): Target? {
        planEntry?.restSeconds?.let { return Target(it, fromRoutine = true) }
        return preferences.restSeconds?.let { Target(it, fromRoutine = false) }
    }

    class Line(target: Target?, startedAtMs: Long, now: Long) {
        val label: String
        val time: String
        val overrun: Boolean
        val fraction: Float?

        init {
            val elapsed = (now - startedAtMs) / 1000
            time = Readout.clock(elapsed * 1000)
            if (target == null || target.seconds <= 0) {
                overrun = false
                label = "resting"
                fraction = null
            } else {
                overrun = elapsed >= target.seconds
                label = (if (overrun) "rest done · target " else "resting · target ") +
                    Readout.clock(target.seconds * 1000L) +
                    (if (target.fromRoutine) fromRoutine else "")
                // Clamped at both ends: a clock corrected backwards mid-rest draws an empty bar.
                fraction = (elapsed.toFloat() / target.seconds).coerceIn(0f, 1f)
            }
        }
    }
}
