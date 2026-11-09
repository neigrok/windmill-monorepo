package works.windmill.gym.presentation

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.plain
import works.windmill.gym.domain.sync.Prefill
import works.windmill.platform.i18n.Words

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WorkoutNotificationTests {
    @Test fun theClockSpansTheWorkoutWhileTheCounterBelongsToTheSelectedMovement() {
        val key = WorkoutKey("owner", "session")
        val session = Session("session", 10_000, plan = PlanSnapshot("Push A", listOf(
            PlanEntry("bench-press", List(3) { SetTarget(8, 60.0) }),
        )))
        val state = WorkoutState(rack = WorkoutRack("bench-press", 60.0, 8, 0, false, 1))
        val first = TrainingSet("first", "bench-press", weightKg = 60.0, reps = 8, completedAtMs = 20_000)
        val latest = TrainingSet("latest", "barbell-row", weightKg = 30.0, reps = 8, completedAtMs = 40_000)
        val empty = WorkoutNotification(key, session, Words.Plain("Bench Press"), emptyList(), state, true).spelled()
        assertEquals(WorkoutNotification(key, Words.Plain("Push A"), Words.Plain("Bench Press"), Words.Plain("60 kg × 8"), Words.Plain("set 1 of 3"),
            null, false, 10_000), empty)
        val expected = empty.copy(counted = Words.Plain("set 2 of 3"), sinceSetAtMs = 40_000)
        assertEquals(expected, WorkoutNotification(key, session, Words.Plain("Bench Press"), listOf(latest, first), state, true).spelled())
        assertEquals(expected, WorkoutNotification(key, session, Words.Plain("Bench Press"),
            listOf(first, latest.copy(weightKg = 35.0, reps = 6)), state, true).spelled())
        assertEquals(expected.copy(sinceSetAtMs = 20_000),
            WorkoutNotification(key, session, Words.Plain("Bench Press"), listOf(first), state, true).spelled())
        assertEquals(empty, WorkoutNotification(key, session, Words.Plain("Bench Press"), emptyList(), state, true).spelled())
    }

    @Test fun oldLocalControlsRestoreAnEditedRackAndChangedSetCountsRetireOnlyThatDraft() {
        val old = kotlinx.serialization.json.Json.decodeFromString(WorkoutState.serializer(),
            """{"rack":{"exerciseId":"bench","weightKg":82.5,"reps":8,"basisSetCount":0,"edited":true,"revision":1}}""")
        assertEquals(emptyMap<String, WorkoutRack>(), old.editedRacks)
        val row = old.redial("row", 0, Prefill(20.0, 5)).edit(67.5, 9)
        val back = row.redial("bench", 0, Prefill(60.0, 5))
        assertEquals(listOf(82.5, 8, true), back.rack!!.let { listOf(it.weightKg, it.reps, it.edited) })
        val changed = back.redial("bench", 1, Prefill(62.5, 6))
        assertEquals(listOf(62.5, 6, false), changed.rack!!.let { listOf(it.weightKg, it.reps, it.edited) })
        assertEquals(setOf("row"), changed.editedRacks.keys)
        assertEquals(67.5, changed.redial("row", 0, Prefill(20.0, 5)).rack!!.weightKg, 0.0)
    }

    @Test fun anExternalWorkoutUsesTheSharedTitleAndItsStartBeforeAnySet() {
        val key = WorkoutKey("owner", "external")
        val session = Session("external", 12_000)
        val state = WorkoutState(rack = WorkoutRack("bench-press", 60.0, 8, 0, false, 1))
        assertEquals(WorkoutNotification(key, Readout.freeWorkout.plain(), Words.Plain("Bench Press"), Words.Plain("60 kg × 8"), Words.Plain("set 1"),
            null, false, 12_000), WorkoutNotification(key, session, Words.Plain("Bench Press"), emptyList(), state, true).spelled())
    }
}

private fun WorkoutNotification.spelled() = copy(heading = heading.plain(), doing = doing.plain(), racked = racked.plain(), counted = counted.plain())
