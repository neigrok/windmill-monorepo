package works.windmill.gym.store

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.*
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry

class RoutinePlanAdapterTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun stagingAndDiscardLeaveTheWholeReplicaUnchanged() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val base = room.store.routines.catalog.single { it.id == "bench-press" }
            val before = room.engine.snapshot()
            val made = Exercise("ex_staged", "Shrug", equipment = "dumbbell", custom = true, loadCount = 2)
            val draft = RoutineDraft(name = "Push", creationId = "routine_staged")
                .staging(RoutineMovement(base, base.copy(name = "Close-grip press", equipment = "other", loadCount = 1)),
                    TargetEntry.Reading.Scheme(listOf(SetTarget(8, -12.5))))
                .staging(RoutineMovement(null, made), TargetEntry.Reading.Scheme(listOf(SetTarget(10, 24.0))))
            val restored = WindmillJson.decodeFromString(RoutineDraft.serializer(), WindmillJson.encodeToString(draft))
            assertEquals(draft, restored)
            assertEquals(before, room.engine.snapshot())
            assertEquals(listOf(made.id), restored.removing(base.id).entries.map { it.exerciseId })
            assertEquals(listOf(RoutineMovement(null, made)), restored.removing(base.id).movements)
            assertEquals(before, room.engine.snapshot())
        }
    }

    @Test fun onePlanCreatesMetadataAndTargetsAndRetriesTheSameIdentity() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val base = room.store.routines.catalog.single { it.id == "bench-press" }
            val renamed = base.copy(name = "Close-grip press", equipment = "other", loadCount = 1)
            val made = Exercise("ex_staged", "Shrug", equipment = "dumbbell", custom = true, loadCount = 2)
            val draft = RoutineDraft(name = "Push", creationId = "routine_staged")
                .staging(RoutineMovement(base, renamed), TargetEntry.Reading.Scheme(listOf(SetTarget(8, -12.5))))
                .staging(RoutineMovement(null, made), TargetEntry.Reading.Scheme(listOf(SetTarget(10, 24.0))))
            val expected = Routine("routine_staged", "Push", entries = listOf(
                RoutineEntry(1, "bench-press", listOf(SetTarget(8, -12.5))),
                RoutineEntry(2, "ex_staged", listOf(SetTarget(10, 24.0))),
            ))
            assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(draft))
            assertEquals(listOf(expected), room.training.program())
            assertEquals(renamed.copy(aliases = listOf(base.name)), room.training.catalogue().single { it.id == base.id })
            assertEquals(made.copy(stepKg = 2.0), room.training.catalogue().single { it.id == made.id })
            val outbox = room.outbox()
            assertEquals(1, outbox.size)
            assertEquals(listOf("exercise", "exerciseName", "routine"), outbox.single().member("intent").member("d").arr()
                .map { it.member("t").str() }.sorted())
            val restored = WindmillJson.decodeFromString(RoutineDraft.serializer(), WindmillJson.encodeToString(draft))
            assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(restored))
            assertEquals(outbox, room.outbox())
            assertEquals(listOf(expected), room.store.routines.all)
            assertEquals(renamed.copy(aliases = listOf(base.name)), room.store.routines.catalog.single { it.id == base.id })
        }
    }

    @Test fun removedNewMovementNeverJoinsTheOnlySave() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val made = Exercise("ex_removed", "Never saved", equipment = "other", custom = true)
            val draft = RoutineDraft(name = "Push", creationId = "routine_kept").adding("bench-press")
                .staging(RoutineMovement(null, made), TargetEntry.Reading.Open).removing(made.id)
            val expected = Routine("routine_kept", "Push", entries = listOf(RoutineEntry(1, "bench-press")))
            assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(draft))
            assertEquals(listOf(expected), room.training.program())
            assertEquals(emptyList<Exercise>(), room.training.catalogue().filter { it.id == made.id })
            assertEquals(emptyList<RoutineMovement>(), draft.movements)
        }
    }

    @Test fun storageFailureRetainsTheWholeDraftAndReportsOnlyTheSaveBoundary() = runTest {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select("a")
            val made = Exercise("ex_retry", "Retry shrug", equipment = "dumbbell", custom = true, loadCount = 2)
            val draft = RoutineDraft(name = "Retry push", creationId = "routine_retry")
                .staging(RoutineMovement(null, made), TargetEntry.Reading.Scheme(listOf(SetTarget(10, 24.0))))
            val before = room.engine.snapshot()
            events.clear(); failures.clear()
            room.engine.failNextCommit()
            assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Failed)
            assertEquals(before, room.engine.snapshot())
            assertEquals(listOf("gym.saveRoutine"), failures)
            assertEquals(listOf("gym_action" to mapOf("screen" to "routine_editor", "action" to "save", "outcome" to "failed")), events)
            val expected = Routine("routine_retry", "Retry push", entries = listOf(RoutineEntry(1, made.id, listOf(SetTarget(10, 24.0)))))
            assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(draft))
            assertEquals(1, room.outbox().size)
            assertEquals(listOf(expected), room.training.program())
            assertEquals(listOf(RoutineMovement(null, made)), draft.movements)
        }
    }

    @Test fun staleMetadataRefusesTheWholeRoutineAndKeepsItsStagedCreation() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val base = room.store.routines.catalog.single { it.id == "bench-press" }
            val made = Exercise("ex_stale", "Retained draft", equipment = "other", custom = true)
            val draft = RoutineDraft(name = "Push", creationId = "routine_stale")
                .staging(RoutineMovement(base, base.copy(name = "My press")), TargetEntry.Reading.Open)
                .staging(RoutineMovement(null, made), TargetEntry.Reading.Open)
            room.training.editExercise(base.id, "Another press", base = base)
            val before = room.engine.snapshot()
            assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Failed)
            assertEquals(before, room.engine.snapshot())
            assertEquals(emptyList<Routine>(), room.training.program())
            assertEquals(emptyList<Exercise>(), room.training.catalogue().filter { it.id == made.id })
            assertEquals(listOf("bench-press", "ex_stale"), draft.entries.map { it.exerciseId })
            assertEquals(listOf("My press", "Retained draft"), draft.movements.map { it.current.name })
        }
    }

    @Test fun fullRestMetadataSurvivesBaseCurrentSerializationAndIdempotentRetry() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val opened = room.training.createRoutine(RoutineWrite("routine_rest", "Rested", 0, listOf(
                RoutineEntryWrite("bench-press", listOf(SetTarget(8, 75.0)), restSeconds = 90),
                RoutineEntryWrite("barbell-row", restSeconds = 120),
            )))
            assertEquals(listOf(90, 120), opened.entries.map { it.restSeconds })
            val draft = RoutineDraft.of(opened, room.store.routines.catalog).named("Rested push")
                .targeting("bench-press", listOf(SetTarget(6, 80.0)))
            val restored = WindmillJson.decodeFromString(RoutineDraft.serializer(), WindmillJson.encodeToString(draft))
            assertEquals(draft, restored)
            assertEquals(listOf(90, 120), restored.original!!.entries.map { it.restSeconds })
            assertEquals(listOf(90, 120), restored.write.map { it.restSeconds })
            val expected = opened.copy(name = "Rested push", entries = opened.entries.map {
                if (it.exerciseId == "bench-press") it.copy(sets = listOf(SetTarget(6, 80.0))) else it
            })
            assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(restored))
            val saved = room.engine.snapshot()
            assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(restored))
            assertEquals(saved, room.engine.snapshot())
            assertEquals(listOf(expected), room.training.program())
        }
    }

    @Test fun oldReplicaAdmissionCannotWriteIntoTheNextOwner() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val replica = room.engine.activeReplica()
            val draft = RoutineDraft(name = "Only A", creationId = "routine_a").adding("bench-press")
            room.select("b")
            val before = room.engine.snapshot()
            val result = runCatching { room.training.saveRoutinePlan(draft, replica, expectedAnonymous = false) }
            assertEquals("account-changed", (result.exceptionOrNull() as TrainingRefused).code)
            assertEquals(before, room.engine.snapshot())
            assertEquals(emptyList<Routine>(), room.training.program())
        }
    }

    @Test fun oneSavePreservesLegacyMetadataWhileAcceptingZeroAndFiniteExtremeTargets() = runTest {
        for ((equipment, count) in listOf("dumbbell" to 1, "cable" to 1, "kettlebell" to 1, "bodyweight" to 1)) {
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
                room.select(null)
                var base = room.training.createExercise(ExerciseWrite("ex_legacy", "Legacy", Exercise.unclassified, equipment))
                if (base.loadCount != count) {
                    room.training.editExercise(base.id, base.name, equipment, count, base)
                    base = room.training.catalogue().single { it.id == base.id }
                }
                val targets = listOf(SetTarget(8, 0.0), SetTarget(8, -501.0), SetTarget(8, 501.0),
                    SetTarget(1, Double.MAX_VALUE), SetTarget(1, -Double.MAX_VALUE), SetTarget(8, null))
                val movement = RoutineMovement(base, base).named("Renamed legacy").equipped("other")
                assertEquals(base.copy(name = "Renamed legacy"), movement.current)
                val draft = RoutineDraft(name = "Legacy routine", creationId = "routine_legacy")
                    .staging(movement, TargetEntry.Reading.Scheme(targets))
                val staged = room.engine.snapshot()
                val restored = WindmillJson.decodeFromString(RoutineDraft.serializer(), WindmillJson.encodeToString(draft))
                assertEquals(draft, restored)
                assertEquals(staged, room.engine.snapshot())
                val expected = Routine("routine_legacy", "Legacy routine", entries = listOf(RoutineEntry(1, base.id, targets)))
                assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(restored))
                assertEquals(listOf(expected), room.training.program())
                assertEquals(base.copy(name = "Renamed legacy", aliases = listOf(base.name)), room.training.catalogue().single { it.id == base.id })
                val saved = room.engine.snapshot()
                assertEquals(GymResult.Ok(expected), room.store.routines.saveRoutine(restored))
                assertEquals(saved, room.engine.snapshot())
            }
        }
    }

    @Test fun aNonfiniteStagedLoadCannotPartiallyCreateMetadataOrRoutine() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            for (load in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
                val movement = Exercise("ex_invalid", "Unsaved", equipment = "other", custom = true)
                val draft = RoutineDraft(name = "Unsaved", creationId = "routine_invalid",
                    entries = listOf(RoutineEntry(1, movement.id, listOf(SetTarget(8, load)))),
                    movements = listOf(RoutineMovement(null, movement)))
                val before = room.engine.snapshot()
                assertTrue(room.store.routines.saveRoutine(draft) is GymResult.Failed)
                assertEquals(before, room.engine.snapshot())
                assertEquals(emptyList<Routine>(), room.training.program())
                assertEquals(emptyList<Exercise>(), room.training.catalogue().filter { it.id == movement.id })
            }
        }
    }
}
