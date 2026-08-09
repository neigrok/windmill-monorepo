package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The rest timer answers from an instant, never from a counter — so a pocketed phone comes back to
// the truth. And being over the target is a fact, not a fault: the overrun counts up, and nothing
// here is allowed to read as an error.

class RestTests {
    // The routine's own line wins: a lifter who wrote three minutes against an accessory meant it.
    @Test
    fun testTheRoutinesOwnRestBeatsTheTableAndTheTableBeatsTheDefault() {
        val entry = PlanEntry(exerciseId = "face-pull", sets = 3, reps = 15, restSeconds = 180)
        assertEquals(180, Rest.target("face-pull", planEntry = entry))
        assertEquals(60, Rest.target("face-pull", planEntry = null))
        assertEquals(180, Rest.target("back-squat", planEntry = null))
    }

    // A movement the table has never heard of — including one the lifter minted this morning —
    // rests for two minutes rather than for nothing.
    @Test
    fun testAMovementNobodyHasWeighedRestsForTheDefault() {
        assertEquals(Rest.defaultSeconds, Rest.target("ex_31ab", planEntry = null))
        assertEquals(120, Rest.defaultSeconds)
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
    }
}
