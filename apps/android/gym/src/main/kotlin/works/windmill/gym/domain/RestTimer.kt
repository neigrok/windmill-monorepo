package works.windmill.gym.domain

// THE REST TIMER — a target the lifter chose, and a value that is COMPUTED rather than counted. It
// reads the instant the set landed, never a remaining number it decrements, so a pocketed phone, a
// locked screen and a relaunch all come back to the truth instead of to however long the app stayed
// awake. The Kotlin statement of web/src/products/gym/logger/rest.js.
//
// THE TARGET IS THE LIFTER'S DIAL AND NOT A TABLE. Until W4 this file carried a per-movement table —
// squats 3:00, face pulls 1:00 — and a two-minute default under it, which meant every lifter was
// given a countdown nobody had asked for and a chime at the end of it. §I draws one global dial
// whose first position is OFF and whose default IS off, so the table had to go: a setting called
// off that still counted down to a number this file chose would be the dishonest kind of toggle
// this wave exists to refuse.
//
// A ROUTINE'S OWN LINE STILL WINS, and it is the only thing that outranks the dial. `restSeconds`
// on a plan entry reaches a routine through two doors and a lifter stands behind both: an agent
// CREATING a routine writes it directly (`create_routine`), and an agent changing one only proposes
// — the number moves when the lifter taps Apply on the diff, never when the agent sends it. So
// three minutes against an accessory was meant, for that movement. W4 leaves the field alone:
// nothing here writes it and no screen edits it.
//
// WITH NO TARGET THE CLOCK STILL RUNS, and that is not the same as a timer. Time since the last set
// is a fact the lifter can read and act on; a countdown is an instruction and an alarm. So `off`
// counts up quietly, says nothing when it passes anything, and never makes a sound.
//
// Being over a target is a fact, not a fault: the overrun counts UP, in the accent, calm and quietly
// present. Nothing in this file may reach for alarm ink, and nothing here moves the lifter on.

object Rest {
    fun target(planEntry: PlanEntry?, preferences: GymPreferences): Int? =
        planEntry?.restSeconds ?: preferences.restSeconds

    class Line(targetSeconds: Int?, startedAtMs: Long, now: Long) {
        val label: String
        val time: String
        val overrun: Boolean

        init {
            val elapsed = (now - startedAtMs) / 1000
            if (targetSeconds == null) {
                overrun = false
                label = "resting"
                time = Readout.clock(elapsed * 1000)
            } else {
                val left = targetSeconds - elapsed
                overrun = left < 0
                label = (if (overrun) "rest done · target " else "resting · target ") +
                    Readout.clock(targetSeconds * 1000L)
                time = if (overrun) "+" + Readout.clock(-left * 1000) else Readout.clock(left * 1000)
            }
        }
    }
}
