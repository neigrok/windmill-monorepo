package works.windmill.gym.domain

// THE REST TIMER — a target per movement, and a value that is COMPUTED rather than counted. It reads
// the instant the set landed, never a remaining number it decrements, so a pocketed phone, a locked
// screen and a relaunch all come back to the truth instead of to however long the app stayed awake.
// The Kotlin statement of web/src/products/gym/logger/rest.js.
//
// Being over the target is not an error and must never look like one: the overrun counts UP, in
// the accent, calm and quietly present. Nothing in this file may reach for alarm ink, and nothing here
// moves the lifter on — the rest landing is a fact, not an instruction.

object Rest {
    const val defaultSeconds = 120

    // The design's own table. The accessories agree with the default on purpose: they are written
    // out so the rule reads as a decision rather than as an omission, and a movement the table has
    // never heard of — including one the lifter minted this morning — rests for two minutes.
    private val seconds = mapOf(
        "back-squat" to 180,
        "bench-press" to 180,
        "overhead-press" to 180,
        "romanian-deadlift" to 120,
        "chin-up" to 120,
        "barbell-row" to 120,
        "dip" to 120,
        "face-pull" to 60,
    )

    // The routine's own line wins: a lifter who wrote three minutes against an accessory meant it,
    // and the table is only the answer for a movement nobody has said anything about.
    fun target(exerciseId: String, planEntry: PlanEntry?): Int =
        planEntry?.restSeconds ?: seconds[exerciseId] ?: defaultSeconds

    class Line(targetSeconds: Int, startedAtMs: Long, now: Long) {
        val label: String
        val time: String
        val overrun: Boolean

        init {
            val left = targetSeconds - (now - startedAtMs) / 1000
            overrun = left < 0
            label = (if (overrun) "rest done · target " else "resting · target ") +
                Readout.clock(targetSeconds * 1000L)
            time = if (overrun) "+" + Readout.clock(-left * 1000) else Readout.clock(left * 1000)
        }
    }
}
