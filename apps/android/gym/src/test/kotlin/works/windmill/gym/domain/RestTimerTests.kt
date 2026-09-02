package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RestTests {
    private val dial = Rest.Target(180, fromRoutine = false)
    private val line = Rest.Target(60, fromRoutine = true)

    @Test
    fun testTheDialIsOffUntilTheLifterSetsIt() {
        assertNull(Rest.target(planEntry = null, preferences = GymPreferences()))
        assertEquals(Rest.Target(120, fromRoutine = false),
            Rest.target(planEntry = null, preferences = GymPreferences(restSeconds = 120)))
    }

    // And the target knows where it came from, so the timer can say so once.
    @Test
    fun testARoutinesOwnLineBeatsTheGlobalDial() {
        val entry = PlanEntry(exerciseId = "face-pull", sets = 3, reps = 15, restSeconds = 60)
        assertEquals(line, Rest.target(entry, GymPreferences(restSeconds = 180)))
        assertEquals(line, Rest.target(entry, GymPreferences()))
        val plain = PlanEntry(exerciseId = "face-pull", sets = 3, reps = 15)
        assertEquals(dial, Rest.target(plain, GymPreferences(restSeconds = 180)))
        assertNull(Rest.target(plain, GymPreferences()))
    }

    @Test
    fun testWithNoTargetTheClockCountsUpAgainstNothing() {
        val reading = Rest.Line(target = null, startedAtMs = 0, now = 91_000)
        assertEquals("resting", reading.label)
        assertEquals("1:31", reading.time)
        assertFalse("nothing to be over", reading.overrun)
    }

    @Test
    fun testRestingCountsUpTowardTheTargetAndNamesIt() {
        val reading = Rest.Line(dial, startedAtMs = 0, now = 49_000)
        assertEquals("resting · target 3:00", reading.label)
        assertEquals("the reading is time since the set, the same on every surface", "0:49", reading.time)
        assertFalse(reading.overrun)
    }

    // The bytes ` · from the routine` are the cross-surface unit: drawn on the timer, in both of its
    // states, only while the routine's own line is what the clock runs against — and nowhere else.
    @Test
    fun testTheTargetSaysItCameFromTheRoutineOnlyWhenItDid() {
        assertEquals(" · from the routine", Rest.fromRoutine)
        assertEquals("resting · target 1:00 · from the routine",
            Rest.Line(line, startedAtMs = 0, now = 20_000).label)
        assertEquals("rest done · target 1:00 · from the routine",
            Rest.Line(line, startedAtMs = 0, now = 61_000).label)
        assertEquals("the dial's target says nothing about a routine", "resting · target 3:00",
            Rest.Line(dial, startedAtMs = 0, now = 20_000).label)
        assertEquals("a routine line with no rest of its own falls to the dial, and says so by silence",
            "resting · target 3:00",
            Rest.Line(Rest.target(PlanEntry(exerciseId = "face-pull"), GymPreferences(restSeconds = 180)),
                startedAtMs = 0, now = 20_000).label)
    }

    @Test
    fun testPastTheTargetTheClockKeepsCountingUpAndSaysTheRestIsDone() {
        val reading = Rest.Line(dial, startedAtMs = 0, now = 187_000)
        assertEquals("rest done · target 3:00", reading.label)
        assertEquals("no flip to a plus sign: one reading throughout", "3:07", reading.time)
        assertTrue(reading.overrun)
        assertEquals("the target instant itself is done", true,
            Rest.Line(dial, startedAtMs = 0, now = 180_000).overrun)
    }

    @Test
    fun testAPocketedPhoneComesBackToTheRealElapsedTime() {
        val two = Rest.Target(120, fromRoutine = false)
        val reading = Rest.Line(two, startedAtMs = 1_000_000, now = 1_000_000 + 600_000)
        assertEquals("10:00", reading.time)
        assertTrue(reading.overrun)
        assertEquals("10:00", Rest.Line(null, startedAtMs = 1_000_000, now = 1_600_000).time)
    }

    @Test
    fun testTheHairlineFillsTowardTheTargetAndIsAbsentWithoutOne() {
        val two = Rest.Target(120, fromRoutine = false)
        assertNull("nothing to fill toward",
                   Rest.Line(target = null, startedAtMs = 0, now = 91_000).fraction)
        assertEquals(0.5f, Rest.Line(two, startedAtMs = 0, now = 60_000).fraction!!, 0.001f)
        assertEquals(1f, Rest.Line(two, startedAtMs = 0, now = 600_000).fraction!!, 0.001f)
        assertEquals(0f, Rest.Line(two, startedAtMs = 60_000, now = 0).fraction!!, 0.001f)
        assertNull(Rest.Line(Rest.Target(0, fromRoutine = false), startedAtMs = 0, now = 60_000).fraction)
    }

    @Test
    fun testTheDialSharesTheRoutineLinesOwnBand() {
        assertEquals(15, GymPreferences.minRestSeconds)
        assertEquals(900, GymPreferences.maxRestSeconds)
        assertEquals(900, GymPreferences(restSeconds = 3_600).normalized().restSeconds)
    }
}
