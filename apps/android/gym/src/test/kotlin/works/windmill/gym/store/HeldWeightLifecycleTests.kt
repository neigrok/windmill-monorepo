package works.windmill.gym.store

import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.platform.Account
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.schema.SyncSchema
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.engine.start
import works.windmill.sync.engine.nextPush

class HeldWeightLifecycleTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun undoRestoresTheWholeWeighInWithoutQueuingTheDelete() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.sync(EngineRoomFixture.server())
            val original = room.store.bodyweight.drawn.single()
            room.store.deletions.withhold(Deletion.Bodyweight(original.dateLocal))
            runCurrent()
            assertEquals(emptyList<Any>(), room.store.bodyweight.drawn)
            assertEquals(listOf(original), room.store.bodyweight.allWeighIns)
            assertEquals(listOf("held"), room.outbox().map { it.member("state").str() })
            assertNull(room.engine.nextPush())
            assertEquals(Deletion.Bodyweight(original.dateLocal), room.store.deletions.keepWithheld()?.deletion)
            assertEquals(listOf(original), room.store.bodyweight.drawn)
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
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.sync(EngineRoomFixture.server())
            events.clear()
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            room.now = room.store.held.withheld.single().untilMs
            assertNull(room.store.deletions.keepWithheld())
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
            assertNull(room.store.deletions.keepWithheld())
        }
    }

    @Test fun navigationKeepsTheDeadlineAndSuccessfulRewriteRetiresItsHold() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val hold = room.store.held.withheld.single()
            room.now += 3_000
            assertFalse(room.store.deletions.abandonWithheld())
            room.store.refreshEngine()
            assertEquals(hold, room.store.held.withheld.single())
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            assertEquals(hold, room.store.held.withheld.single())
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 82.0))
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertEquals(emptyList<Any>(), room.engine.undoOffers())
            room.now = hold.untilMs + 1
            assertEquals(emptyList<String>(), room.engine.releaseHeld())
            assertEquals(listOf(82.0), room.training.weighins().map { it.weightKg })
        }
    }

    @Test fun failedRewritePreservesTheOriginalUndoAndDeadline() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val hold = room.store.held.withheld.single()
            room.engine.failNextCommit()
            assertEquals(WriteFailure.NoAnswer, room.store.bodyweight.weighIn("2026-09-01", 82.0))
            assertEquals(hold, room.store.held.withheld.single())
            assertEquals(hold, room.store.deletions.keepWithheld())
            assertEquals(listOf(81.25), room.store.bodyweight.drawn.map { it.weightKg })
        }
    }

    @Test fun immediateRoutineSetAndNoteDeletesDoNotReleaseTheWeightReceipt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            assertTrue(room.store.notes.saveNote("note0001", NoteWrite("Tone", "blunt")) is GymResult.Ok)
            val workout = room.workout()
            val set = room.training.session(workout.id)!!.sets.single()
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.sync(EngineRoomFixture.server())
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val offer = room.engine.undoOffers().single()
            assertNull(room.store.deletions.delete(Deletion.Routine(routine.id, routine.name)))
            assertNull(room.store.deletions.delete(Deletion.Set(workout.id, set)))
            assertNull(room.store.deletions.delete(Deletion.Note("note0001")))
            assertEquals(listOf(offer), room.engine.undoOffers())
            assertNull(room.training.routine(routine.id))
            assertEquals(emptyList<Any>(), room.training.session(workout.id)!!.sets)
            assertEquals(emptyList<Any>(), room.training.notes())
            assertEquals(listOf("held", "ready", "ready", "ready"), room.outbox().map { it.member("state").str() })
            assertNotNull(room.store.deletions.keepWithheld())
            assertEquals(listOf(81.25), room.store.bodyweight.drawn.map { it.weightKg })
        }
    }

    @Test fun releaseAndRestartNeverRenewUndo() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.sync(EngineRoomFixture.server())
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val snapshot = room.engine.snapshot()
            assertEquals(1, room.engine.releaseHeld(all = true).size)
            room.store.refreshEngine()
            assertNull(room.store.deletions.holding)
            assertNull(room.store.deletions.keepWithheld())
            assertEquals(emptyList<Any>(), room.store.bodyweight.drawn)
            EngineRoomFixture(tmp.newFolder(), backgroundScope, snapshot = snapshot).use { restart ->
                restart.engine.start()
                assertEquals(emptyList<Any>(), restart.engine.undoOffers())
                assertEquals(listOf("ready"), restart.outbox().map { it.member("state").str() })
                assertNull(restart.store.deletions.holding)
                assertNull(restart.store.deletions.keepWithheld())
            }
        }
    }

    @Test fun releaseFailureRestoresOnlyItsReceiptWhileFailureAfterReleaseStaysUnconfirmed() = runTest {
        for (advanceFirst in listOf(false, true)) {
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
                room.select("u1")
                val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
                assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
                room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
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
                assertNotNull(room.store.deletions.keepWithheld())
                assertEquals(listOf(81.25), room.store.bodyweight.drawn.map { it.weightKg })
            }
        }
    }

    @Test fun accountChangeCannotUndoAnotherReplicasHeldDelete() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            room.select("u2")
            assertNull(room.store.deletions.keepWithheld())
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertEquals(emptyList<Any>(), room.store.bodyweight.drawn)
            room.select("u1")
            assertNull(room.store.deletions.keepWithheld())
            assertEquals(emptyList<Any>(), room.store.bodyweight.drawn)
            assertEquals(emptyList<Any>(), room.engine.undoOffers())
        }
    }
    @Test fun aFreshSameIdentityAccountKeepsTheExactEngineWeightReceiptAndRemainingDeadline() = runTest {
        for (owner in listOf(null, "u1")) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(owner)
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            val original = room.store.bodyweight.drawn.single()
            room.store.deletions.withhold(Deletion.Bodyweight(original.dateLocal))
            runCurrent()
            val hold = room.store.held.withheld.single()
            val outbox = room.outbox()
            room.now += 3_000
            room.store.connect(room.account())
            runCurrent()
            assertEquals(listOf(hold), room.store.held.withheld)
            assertEquals(hold, room.store.deletions.holding)
            assertEquals(listOf(original), room.store.bodyweight.allWeighIns)
            assertEquals(emptyList<Any>(), room.store.bodyweight.drawn)
            assertEquals(outbox, room.outbox())
            assertEquals(hold.untilMs, room.engine.undoOffers().single().releaseAt)
            assertEquals(hold, room.store.deletions.keepWithheld())
            assertEquals(listOf(original), room.store.bodyweight.drawn)
            assertEquals(emptyList<Any>(), room.engine.undoOffers())
        }
    }

    @Test fun aReconnectReadFailureStaysInsideTheReportedConnectionBoundary() = runTest {
        var failRead = false
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry, createEngine = { snapshot, clock ->
            Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock {
                override fun now(): Long {
                    if (failRead) { failRead = false; throw IllegalStateException("controlled clock read failure") }
                    return clock.now()
                }
            })
        }).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val held = room.store.held.withheld
            val before = room.outbox()
            failRead = true
            room.store.connect(room.account())
            runCurrent()
            assertEquals(listOf("gym.connect"), failures)
            assertEquals(held, room.store.held.withheld)
            assertEquals(before, room.outbox())
        }
    }

    @Test fun aFreshAccountCannotRenewAReleasedOrExpiredEngineOffer() = runTest {
        for (expire in listOf(false, true)) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val hold = room.store.held.withheld.single()
            if (expire) room.now = hold.untilMs else room.engine.releaseHeld(all = true)
            room.store.connect(room.account())
            runCurrent()
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertNull(room.store.deletions.holding)
            assertNull(room.store.deletions.keepWithheld())
            assertEquals(emptyList<Any>(), room.engine.undoOffers())
        }
    }

    @Test fun aChangedOriginOrIdentityRevisionCannotCarryTheWeightUndoReceipt() = runTest {
        for (changeOrigin in listOf(false, true)) EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val before = room.outbox()
            val account = room.account()
            val replacement = Account(if (changeOrigin) "https://other.example" else account.origin,
                account.user, identityRevision = if (changeOrigin) account.identityRevision else account.identityRevision + 1)
            room.store.connect(replacement)
            runCurrent()
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertNull(room.store.deletions.holding)
            assertNull(room.store.deletions.keepWithheld())
            assertEquals(before, room.outbox())
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
            val row = launch(start = CoroutineStart.UNDISPATCHED) { room.store.deletions.delete(Deletion.Set(workout.id, set)) }
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
                val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "PRIVATE_ROUTINE").adding("bench-press")) as GymResult.Ok).value
                val workout = room.workout()
                val set = room.training.session(workout.id)!!.sets.single()
                assertTrue(room.store.notes.saveNote("note0001", NoteWrite("PRIVATE_NOTE", "PRIVATE_BODY")) is GymResult.Ok)
                assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
                val replica = room.engine.activeReplica()
                events.clear()
                room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
                if (!anonymous) assertTrue(room.engine.signOut("keep").member("complete").bool())
                assertTrue(room.engine.signIn("bob", mapOf("gym" to false)).member("complete").bool())
                if (anonymous) assertEquals(replica, room.engine.activeReplica())
                val before = room.engine.snapshot()
                runCurrent()
                assertEquals(before, room.engine.snapshot())
                for (deletion in listOf(Deletion.Routine(routine.id, routine.name), Deletion.Note("note0001"), Deletion.Set(workout.id, set))) {
                    assertTrue(room.store.deletions.delete(deletion) is WriteFailure.Refused)
                    assertEquals(before, room.engine.snapshot())
                }
                assertTrue(room.store.bodyweight.weighIn("2026-09-01", 82.0) is WriteFailure.Refused)
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

    @Test fun aRefusedReleasedDeleteRestoresTheAuthoritativeRowAndKeepsItsNotice() = runTest {
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            val server = EngineRoomFixture.server()
            room.select("u1"); room.pull(server)
            assertNull(room.store.bodyweight.weighIn("2026-09-01", 81.25))
            room.sync(server); room.store.refreshEngine()
            val original = room.store.bodyweight.drawn
            room.store.deletions.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            assertEquals(emptyList<Any>(), room.store.bodyweight.drawn)
            server.refuse(code = "forbidden")
            room.sync(server)
            // The store reads refusals from the engine's notice view, which its observation thread fills after the sync.
            withContext(Dispatchers.IO) { withTimeout(10_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }
            room.store.refreshEngine()
            assertEquals(original, room.store.bodyweight.drawn)
            assertEquals(emptyList<Any>(), room.engine.undoOffers())
            assertEquals(listOf("That change could not be saved."), room.store.workout.refusals.map { it.reason })
            assertEquals(emptyList<String>(), failures)
        }
    }

}
