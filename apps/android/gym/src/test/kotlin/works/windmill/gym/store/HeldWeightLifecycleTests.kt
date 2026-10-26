package works.windmill.gym.store

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.RoutineDraft
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.engine.start
import works.windmill.sync.engine.nextPush

class HeldWeightLifecycleTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun undoRestoresTheWholeWeighInWithoutQueuingTheDelete() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.sync(EngineRoomFixture.server())
            val original = room.store.bodyweight.single()
            room.store.withhold(Deletion.Bodyweight(original.dateLocal))
            runCurrent()
            assertEquals(emptyList<Any>(), room.store.bodyweight)
            assertEquals(listOf(original), room.store.allWeighIns)
            assertEquals(listOf("held"), room.outbox().map { it.member("state").str() })
            assertNull(room.engine.nextPush())
            assertEquals(Deletion.Bodyweight(original.dateLocal), room.store.keepWithheld()?.deletion)
            assertEquals(listOf(original), room.store.bodyweight)
            assertEquals(emptyList<Json>(), room.outbox())
            assertNull(room.engine.nextPush())
        }
    }

    @Test fun expiryClosesUndoBeforeTheRuntimeReleasesTheDeleteOnce() = runTest {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail(operation) }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select("u1")
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.sync(EngineRoomFixture.server())
            events.clear()
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            room.now = room.store.withheld.single().untilMs
            assertNull(room.store.keepWithheld())
            assertEquals(listOf("held"), room.outbox().map { it.member("state").str() })
            assertNull(room.engine.nextPush())
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "held"),
                "gym_action" to mapOf("screen" to "bodyweight", "action" to "undo", "outcome" to "closed"),
                "gym_action" to mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "closed"),
            ), events)
            assertEquals(1, room.engine.releaseHeld().size)
            assertEquals(emptyList<String>(), room.engine.releaseHeld())
            assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
            assertEquals(1, room.engine.nextPush()!!.member("intents").arr().size)
            assertNull(room.store.keepWithheld())
        }
    }

    @Test fun navigationKeepsTheDeadlineAndSuccessfulRewriteRetiresItsHold() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val hold = room.store.withheld.single()
            room.now += 3_000
            assertFalse(room.store.abandonWithheld())
            room.store.refreshEngine()
            assertEquals(hold, room.store.withheld.single())
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            assertEquals(hold, room.store.withheld.single())
            assertNull(room.store.weighIn("2026-09-01", 82.0))
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertEquals(emptyList<Any>(), room.engine.undoOffers())
            room.now = hold.untilMs + 1
            assertEquals(emptyList<String>(), room.engine.releaseHeld())
            assertEquals(listOf(82.0), room.training.weighins().map { it.weightKg })
        }
    }

    @Test fun failedRewritePreservesTheOriginalUndoAndDeadline() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val hold = room.store.withheld.single()
            room.engine.failNextCommit()
            assertEquals(WriteFailure.NoAnswer, room.store.weighIn("2026-09-01", 82.0))
            assertEquals(hold, room.store.withheld.single())
            assertEquals(hold, room.store.keepWithheld())
            assertEquals(listOf(81.25), room.store.bodyweight.map { it.weightKg })
        }
    }

    @Test fun immediateRoutineSetAndNoteDeletesDoNotReleaseTheWeightReceipt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            assertTrue(room.store.saveNote("note0001", NoteWrite("Tone", "blunt")) is GymResult.Ok)
            val workout = room.workout()
            val set = room.training.session(workout.id)!!.sets.single()
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.sync(EngineRoomFixture.server())
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val offer = room.engine.undoOffers().single()
            assertNull(room.store.delete(Deletion.Routine(routine.id, routine.name)))
            assertNull(room.store.delete(Deletion.Set(workout.id, set)))
            assertNull(room.store.delete(Deletion.Note("note0001")))
            assertEquals(listOf(offer), room.engine.undoOffers())
            assertNull(room.training.routine(routine.id))
            assertEquals(emptyList<Any>(), room.training.session(workout.id)!!.sets)
            assertEquals(emptyList<Any>(), room.training.notes())
            assertEquals(listOf("held", "ready", "ready", "ready"), room.outbox().map { it.member("state").str() })
            assertNotNull(room.store.keepWithheld())
            assertEquals(listOf(81.25), room.store.bodyweight.map { it.weightKg })
        }
    }

    @Test fun releaseAndRestartNeverRenewUndo() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.sync(EngineRoomFixture.server())
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val snapshot = room.engine.snapshot()
            assertEquals(1, room.engine.releaseHeld(all = true).size)
            room.store.refreshEngine()
            assertNull(room.store.holding)
            assertNull(room.store.keepWithheld())
            assertEquals(emptyList<Any>(), room.store.bodyweight)
            EngineRoomFixture(tmp.newFolder(), backgroundScope, snapshot = snapshot).use { restart ->
                restart.engine.start()
                assertEquals(emptyList<Any>(), restart.engine.undoOffers())
                assertEquals(listOf("ready"), restart.outbox().map { it.member("state").str() })
                assertNull(restart.store.holding)
                assertNull(restart.store.keepWithheld())
            }
        }
    }

    @Test fun releaseFailureRestoresOnlyItsReceiptWhileFailureAfterReleaseStaysUnconfirmed() = runTest {
        for (advanceFirst in listOf(false, true)) {
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
                room.select("u1")
                val routine = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
                assertNull(room.store.weighIn("2026-09-01", 81.25))
                room.store.withhold(Deletion.Bodyweight("2026-09-01"))
                runCurrent()
                val originalOffer = room.engine.undoOffers().single()
                val failed = IllegalStateException("controlled release failure")
                val training = EngineTraining(room.engine, releaseIntent = { id ->
                    if (advanceFirst) room.engine.release(id)
                    throw failed
                })
                val result = runCatching { training.deleteRoutine(routine.id) }.exceptionOrNull()
                if (advanceFirst) {
                    assertTrue(result is TrainingDeleteUnconfirmed)
                    assertEquals(WriteFailure.UnconfirmedDelete, WriteFailure(result!!))
                    assertNull(room.training.routine(routine.id))
                } else {
                    assertEquals(failed.javaClass, result?.javaClass)
                    assertEquals(failed.message, result?.message)
                    assertEquals(routine, room.training.routine(routine.id))
                }
                assertEquals(listOf(originalOffer), room.engine.undoOffers())
                assertNotNull(room.store.keepWithheld())
                assertEquals(listOf(81.25), room.store.bodyweight.map { it.weightKg })
            }
        }
    }

    @Test fun accountChangeCannotUndoAnotherReplicasHeldDelete() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            room.select("u2")
            assertNull(room.store.keepWithheld())
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertEquals(emptyList<Any>(), room.store.bodyweight)
            room.select("u1")
            assertNull(room.store.keepWithheld())
            assertEquals(emptyList<Any>(), room.store.bodyweight)
            assertEquals(emptyList<Any>(), room.engine.undoOffers())
        }
    }
    @Test fun aDisposedRowCannotCancelItsSettledDeleteOrLoseItsResultEvent() = runTest {
        var holdReads = false
        val reads = mutableListOf<Runnable>()
        val dispatcher = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                if (holdReads) reads += block else block.run()
            }
        }
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail(operation) }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry, readDispatcher = dispatcher).use { room ->
            room.select("alice")
            val workout = room.workout()
            room.sync(EngineRoomFixture.server())
            room.store.refreshEngine()
            val set = room.training.session(workout.id)!!.sets.single()
            events.clear()
            holdReads = true
            val row = launch(start = CoroutineStart.UNDISPATCHED) { room.store.delete(Deletion.Set(workout.id, set)) }
            assertEquals(1, reads.size)
            assertEquals(listOf("ready"), room.outbox().map { it.member("state").str() })
            assertEquals(emptyList<Any>(), events)
            row.cancel()
            holdReads = false
            reads.toList().forEach(Runnable::run)
            runCurrent()
            assertTrue(row.isCancelled)
            assertEquals(emptyList<Any>(), room.training.session(workout.id)!!.sets)
            assertEquals(listOf("gym_action" to mapOf("screen" to "session", "action" to "delete", "outcome" to "ok")), events)
        }
    }

    @Test fun delayedDeletesAndRewritesCannotCrossAReplicaOrAnonymousAdoptionBoundary() = runTest {
        for (anonymous in listOf(false, true)) {
            val events = mutableListOf<Pair<String, Map<String, String>>>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) { events += name to properties }
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail(operation) }
            }
            EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
                room.select(if (anonymous) null else "alice")
                val routine = (room.store.saveRoutine(RoutineDraft(name = "PRIVATE_ROUTINE").adding("bench-press")) as GymResult.Ok).value
                val workout = room.workout()
                val set = room.training.session(workout.id)!!.sets.single()
                assertTrue(room.store.saveNote("note0001", NoteWrite("PRIVATE_NOTE", "PRIVATE_BODY")) is GymResult.Ok)
                assertNull(room.store.weighIn("2026-09-01", 81.25))
                val replica = room.engine.activeReplica()
                events.clear()
                room.store.withhold(Deletion.Bodyweight("2026-09-01"))
                if (!anonymous) assertTrue(room.engine.signOut("keep").member("complete").bool())
                assertTrue(room.engine.signIn("bob", mapOf("gym" to false)).member("complete").bool())
                if (anonymous) assertEquals(replica, room.engine.activeReplica())
                val before = room.engine.snapshot()
                runCurrent()
                assertEquals(before, room.engine.snapshot())
                for (deletion in listOf(Deletion.Routine(routine.id, routine.name), Deletion.Note("note0001"), Deletion.Set(workout.id, set))) {
                    assertTrue(room.store.delete(deletion) is WriteFailure.Refused)
                    assertEquals(before, room.engine.snapshot())
                }
                assertTrue(room.store.weighIn("2026-09-01", 82.0) is WriteFailure.Refused)
                assertEquals(before, room.engine.snapshot())
                val importRefusal = runCatching {
                    room.training.imports.replaceAndRetry(workout.id, SavedWorkout(workout, emptyList(), listOf(set.id)),
                        expectedReplica = replica, expectedAnonymous = anonymous)
                }.exceptionOrNull()
                assertEquals("account-changed", (importRefusal as? TrainingRefused)?.code)
                assertEquals(before, room.engine.snapshot())
                assertTrue(events.all { it.first == "gym_action" && it.second["outcome"] == "refused" })
                assertTrue(events.none { it.second.values.any { value -> value.contains("PRIVATE") } })
            }
        }
    }

}
