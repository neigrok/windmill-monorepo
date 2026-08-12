package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The rest timer answers from an instant, never from a counter — so a pocketed phone comes back to
// the truth. And being over the target is a fact, not a fault: the overrun counts up, and nothing
// here is allowed to read as an error.
//
// SINCE W4 THE TARGET IS THE LIFTER'S, and its default is off. What used to answer here was a
// per-movement table with a two-minute floor under it, which meant every lifter was handed a
// countdown and a chime nobody had asked for.

class RestTests {
    @Test
    fun testTheDialIsOffUntilTheLifterSetsIt() {
        assertNull(Rest.target(planEntry = null, preferences = GymPreferences()))
        assertEquals(120, Rest.target(planEntry = null, preferences = GymPreferences(restSeconds = 120)))
    }

    // The one thing that outranks the dial, and a lifter stands behind both doors that author it:
    // an agent CREATING a routine writes the number, and an agent changing one only proposes it —
    // the tap on the diff is what moves it. Three minutes against an accessory was meant, for that
    // movement. W4 leaves that field alone — nothing writes it and no screen edits it.
    @Test
    fun testARoutinesOwnLineBeatsTheGlobalDial() {
        val entry = PlanEntry(exerciseId = "face-pull", sets = 3, reps = 15, restSeconds = 60)
        assertEquals(60, Rest.target(entry, GymPreferences(restSeconds = 180)))
        assertEquals(60, Rest.target(entry, GymPreferences()))
        // A line without one falls through to the dial rather than to a number this file chose.
        val plain = PlanEntry(exerciseId = "face-pull", sets = 3, reps = 15)
        assertEquals(180, Rest.target(plain, GymPreferences(restSeconds = 180)))
        assertNull(Rest.target(plain, GymPreferences()))
    }

    // Off is not a missing clock. Time since the last set is a fact a lifter can act on; a
    // countdown is an instruction and an alarm — so with no target it counts UP, quietly, against
    // nothing, and passes no line to make a sound at.
    @Test
    fun testWithNoTargetTheClockCountsUpAgainstNothing() {
        val line = Rest.Line(targetSeconds = null, startedAtMs = 0, now = 91_000)
        assertEquals("resting", line.label)
        assertEquals("1:31", line.time)
        assertFalse("nothing to be over", line.overrun)
    }

    @Test
    fun testRestingCountsDownToTheTargetAndNamesIt() {
        val line = Rest.Line(targetSeconds = 180, startedAtMs = 0, now = 49_000)
        assertEquals("resting · target 3:00", line.label)
        assertEquals("2:11", line.time)
        assertFalse(line.overrun)
    }

    // Past the target the clock turns around and counts UP with a plus. It does not stop, it does
    // not alarm, and it does not tell the lifter to go — being over is not an error.
    @Test
    fun testPastTheTargetTheClockCountsUpAndSaysTheRestIsDone() {
        val line = Rest.Line(targetSeconds = 180, startedAtMs = 0, now = 187_000)
        assertEquals("rest done · target 3:00", line.label)
        assertEquals("+0:07", line.time)
        assertTrue(line.overrun)
    }

    // The value is computed from the instant the set landed, so a phone asleep for ten minutes comes
    // back showing ten minutes rather than however long the app was awake for.
    @Test
    fun testAPocketedPhoneComesBackToTheRealElapsedTime() {
        val line = Rest.Line(targetSeconds = 120, startedAtMs = 1_000_000, now = 1_000_000 + 600_000)
        assertEquals("+8:00", line.time)
        assertTrue(line.overrun)
        assertEquals("10:00", Rest.Line(null, startedAtMs = 1_000_000, now = 1_600_000).time)
    }

    // §K DRAWS THE REST AS A HAIRLINE, so the line has to say how full that bar is — and with the
    // dial off there is nothing to be full OF. A null fraction is what stops the logger drawing a
    // track against a target nobody set, which would be a countdown by another shape.
    @Test
    fun testTheHairlineFillsTowardTheTargetAndIsAbsentWithoutOne() {
        assertNull("nothing to fill toward",
                   Rest.Line(targetSeconds = null, startedAtMs = 0, now = 91_000).fraction)
        assertEquals(0.5f, Rest.Line(targetSeconds = 120, startedAtMs = 0, now = 60_000).fraction!!, 0.001f)
        // Full is the whole of what "past the target" means to a bar, and a clock corrected
        // backwards mid-rest draws an empty one rather than a negative width.
        assertEquals(1f, Rest.Line(targetSeconds = 120, startedAtMs = 0, now = 600_000).fraction!!, 0.001f)
        assertEquals(0f, Rest.Line(targetSeconds = 120, startedAtMs = 60_000, now = 0).fraction!!, 0.001f)
        // A target of zero is not a target: it would divide the bar by nothing.
        assertNull(Rest.Line(targetSeconds = 0, startedAtMs = 0, now = 60_000).fraction)
    }

    // The dial and a routine's line are bounded by the same band, so the global setting can never
    // ask for a wait a routine entry would be refused for.
    @Test
    fun testTheDialSharesTheRoutineLinesOwnBand() {
        assertEquals(15, GymPreferences.minRestSeconds)
        assertEquals(900, GymPreferences.maxRestSeconds)
        assertEquals(900, GymPreferences(restSeconds = 3_600).normalized().restSeconds)
    }
}
