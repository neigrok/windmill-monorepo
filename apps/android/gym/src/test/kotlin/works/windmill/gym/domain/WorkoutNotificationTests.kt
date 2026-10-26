package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class WorkoutNotificationTests {
    @Test fun theClockSpansTheWorkoutWhileTheCounterBelongsToTheSelectedMovement() {
        val key = WorkoutKey("owner", "session")
        val session = Session("session", 10_000, plan = PlanSnapshot("Push A", listOf(
            PlanEntry("bench-press", List(3) { SetTarget(8, 60.0) }),
        )))
        val state = WorkoutState(rack = WorkoutRack("bench-press", 60.0, 8, 0, false, 1))
        val first = TrainingSet("first", "bench-press", weightKg = 60.0, reps = 8, completedAtMs = 20_000)
        val latest = TrainingSet("latest", "barbell-row", weightKg = 30.0, reps = 8, completedAtMs = 40_000)
        val empty = WorkoutNotification(key, session, "Bench Press", emptyList(), state, true)
        assertEquals(WorkoutNotification(key, "Push A", "Bench Press", "60 kg × 8", "set 1 of 3",
            null, false, 10_000), empty)
        val expected = empty.copy(counter = "set 2 of 3", sinceSetAtMs = 40_000)
        assertEquals(expected, WorkoutNotification(key, session, "Bench Press", listOf(latest, first), state, true))
        assertEquals(expected, WorkoutNotification(key, session, "Bench Press",
            listOf(first, latest.copy(weightKg = 35.0, reps = 6)), state, true))
        assertEquals(expected.copy(sinceSetAtMs = 20_000),
            WorkoutNotification(key, session, "Bench Press", listOf(first), state, true))
        assertEquals(empty, WorkoutNotification(key, session, "Bench Press", emptyList(), state, true))
    }

    @Test fun anExternalWorkoutUsesTheSharedTitleAndItsStartBeforeAnySet() {
        val key = WorkoutKey("owner", "external")
        val session = Session("external", 12_000)
        val state = WorkoutState(rack = WorkoutRack("bench-press", 60.0, 8, 0, false, 1))
        assertEquals(WorkoutNotification(key, Readout.noRoutine, "Bench Press", "60 kg × 8", "set 1",
            null, false, 12_000), WorkoutNotification(key, session, "Bench Press", emptyList(), state, true))
    }
}
