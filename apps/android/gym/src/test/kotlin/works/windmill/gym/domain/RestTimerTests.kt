package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RestTests {
    @Test
    fun testTheDialIsOffUntilTheLifterSetsIt() {
        assertNull(Rest.target(planEntry = null, preferences = GymPreferences()))
        assertEquals(120, Rest.target(planEntry = null, preferences = GymPreferences(restSeconds = 120)))
    }

    @Test
    fun testARoutinesOwnLineBeatsTheGlobalDial() {
        val entry = PlanEntry(exerciseId = "face-pull", sets = 3, reps = 15, restSeconds = 60)
        assertEquals(60, Rest.target(entry, GymPreferences(restSeconds = 180)))
        assertEquals(60, Rest.target(entry, GymPreferences()))
        val plain = PlanEntry(exerciseId = "face-pull", sets = 3, reps = 15)
        assertEquals(180, Rest.target(plain, GymPreferences(restSeconds = 180)))
        assertNull(Rest.target(plain, GymPreferences()))
    }

    @Test
    fun testWithNoTargetTheClockCountsUpAgainstNothing() {
        val line = Rest.Line(targetSeconds = null, startedAtMs = 0, now = 91_000)
        assertEquals("resting", line.label)
        assertEquals("1:31", line.time)
        assertFalse("nothing to be over", line.overrun)
    }

    @Test
    fun testRestingCountsUpTowardTheTargetAndNamesIt() {
        val line = Rest.Line(targetSeconds = 180, startedAtMs = 0, now = 49_000)
        assertEquals("resting · target 3:00", line.label)
        assertEquals("the reading is time since the set, the same on every surface", "0:49", line.time)
        assertFalse(line.overrun)
    }

    @Test
    fun testPastTheTargetTheClockKeepsCountingUpAndSaysTheRestIsDone() {
        val line = Rest.Line(targetSeconds = 180, startedAtMs = 0, now = 187_000)
        assertEquals("rest done · target 3:00", line.label)
        assertEquals("no flip to a plus sign: one reading throughout", "3:07", line.time)
        assertTrue(line.overrun)
        assertEquals("the target instant itself is done", true,
            Rest.Line(targetSeconds = 180, startedAtMs = 0, now = 180_000).overrun)
    }

    @Test
    fun testAPocketedPhoneComesBackToTheRealElapsedTime() {
        val line = Rest.Line(targetSeconds = 120, startedAtMs = 1_000_000, now = 1_000_000 + 600_000)
        assertEquals("10:00", line.time)
        assertTrue(line.overrun)
        assertEquals("10:00", Rest.Line(null, startedAtMs = 1_000_000, now = 1_600_000).time)
    }

    @Test
    fun testTheHairlineFillsTowardTheTargetAndIsAbsentWithoutOne() {
        assertNull("nothing to fill toward",
                   Rest.Line(targetSeconds = null, startedAtMs = 0, now = 91_000).fraction)
        assertEquals(0.5f, Rest.Line(targetSeconds = 120, startedAtMs = 0, now = 60_000).fraction!!, 0.001f)
        assertEquals(1f, Rest.Line(targetSeconds = 120, startedAtMs = 0, now = 600_000).fraction!!, 0.001f)
        assertEquals(0f, Rest.Line(targetSeconds = 120, startedAtMs = 60_000, now = 0).fraction!!, 0.001f)
        assertNull(Rest.Line(targetSeconds = 0, startedAtMs = 0, now = 60_000).fraction)
    }

    @Test
    fun testTheDialSharesTheRoutineLinesOwnBand() {
        assertEquals(15, GymPreferences.minRestSeconds)
        assertEquals(900, GymPreferences.maxRestSeconds)
        assertEquals(900, GymPreferences(restSeconds = 3_600).normalized().restSeconds)
    }
}
