package works.windmill.gym.store

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.TrainingSet
import works.windmill.sync.core.Json
import works.windmill.sync.modelserver.ModelServer

class DeletionsStoreTests {
    @get:Rule
    val tmp = TemporaryFolder()

    // A second phone signed into the same account reads what the log holds, or writes as somebody
    // elsewhere would.
    private suspend fun <T> TestScope.anotherPhone(server: ModelServer, now: Long, account: String = "alice",
                                                   act: suspend (EngineRoomFixture) -> T): T =
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { phone ->
            phone.now = now
            phone.select(account); phone.pull(server); phone.store.refreshEngine()
            act(phone).also { runCurrent() }
        }

    // What this phone still owes the log, one line per intent: a command by name, a record by type and id.
    private fun owed(room: EngineRoomFixture): List<String> = room.outbox().map { entry ->
        val intent = entry.member("intent")
        intent["cmd"]?.member("name")?.str()
            ?: intent.member("d").arr().joinToString { "${it.member("t").str()} ${it.member("id").str()}" }
    }

    // A refusal reaches the notices off the engine's own thread.
    private suspend fun noticed(room: EngineRoomFixture) =
        withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.notices("gym").notices.first { it.isNotEmpty() } } }

    @Test
    fun aSetDeleteQueuesImmediatelyAndUpdatesEveryRead() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.store.workout.logSet(weightKg = 90.0, reps = 3)
            room.now += 60_000
            room.store.workout.finish()
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val taken = room.training.session(opened.id)!!.sets.first()

            assertNull(room.store.deletions.delete(Deletion.Set(opened.id, taken)))
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertNull(room.store.deletions.keepWithheld())
            assertNull(room.store.deletions.delete(Deletion.Set(opened.id, taken)))
            assertEquals(listOf("set ${taken.id}"), owed(room))
            assertEquals("the set does not stand", listOf(90.0),
                room.training.session(opened.id)!!.sets.map { it.weightKg })
            assertEquals("and the screen that read the session before it went knows not to draw it",
                setOf(taken.id), room.store.held.deletedSets)
            assertEquals("the head re-read — the row lost a set, its tonnage and its top set",
                listOf(270.0), room.store.history.logged.map { it.tonnageKg })
            room.sync(server)
            assertEquals(listOf(90.0), anotherPhone(server, room.now) { phone ->
                phone.training.session(opened.id)!!.sets.map { it.weightKg } })
            runCurrent()
        }
    }

    @Test
    fun consecutiveDeletesQueueOneIntentEachWithoutUndo() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.startExternalWorkout()
            room.store.workout.choose("bench-press")
            room.store.workout.logSet(weightKg = 82.5, reps = 5)
            room.store.workout.logSet(weightKg = 60.0, reps = 12)
            room.now += 60_000
            room.store.workout.finish()
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val (first, second) = room.training.session(opened.id)!!.sets
            assertNull(room.store.deletions.delete(Deletion.Set(opened.id, first)))
            assertNull(room.store.deletions.delete(Deletion.Set(opened.id, second)))
            assertEquals(listOf("set ${first.id}", "set ${second.id}"), owed(room))
            assertEquals(emptySet<String>(), room.store.held.withheldIds)
            assertEquals(setOf(first.id, second.id), room.store.held.deletedSets)
            assertNull(room.store.deletions.keepWithheld())
            assertEquals(emptyList<TrainingSet>(), room.training.session(opened.id)!!.sets)
        }
    }

    @Test
    fun aSettledDeleteRemainsInItsAccountAcrossSignOut() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice")
            val opened = room.workout()
            val taken = room.training.session(opened.id)!!.sets.single()
            assertNull(room.store.deletions.delete(Deletion.Set(opened.id, taken)))
            room.select("bob")
            assertEquals(emptyList<WithheldDelete>(), room.store.held.withheld)
            assertNull(room.store.deletions.keepWithheld())
            assertEquals(emptyList<Any>(), room.training.details())
            room.select("alice")
            assertEquals(emptyList<TrainingSet>(), room.training.session(opened.id)!!.sets)
        }
    }

    @Test
    fun testADeleteTheLogCouldNotTakeIsSaidAndTheRowStands() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("alice"); room.pull(server)
            val opened = room.workout()
            runCurrent()
            room.sync(server); room.store.refreshEngine()
            val shown = (room.store.history.sessionDetail(opened.id) as GymResult.Ok).value
            val taken = shown.sets.single()

            assertNull(room.store.deletions.delete(Deletion.Set(opened.id, taken)))
            server.refuse(code = "invalid")
            room.sync(server); noticed(room); room.store.refreshEngine()

            assertEquals(listOf(taken.id to "That change could not be saved."), room.store.workout.refusals.map { it.id to it.reason })
            assertEquals(listOf(emptyMap<String, Json>()), room.engine.notices("gym").notices.value.map {
                it.content.deltas.single().lattice.fields.mapValues { field -> field.value.value }
            })
            assertEquals(emptySet<String>(), room.store.held.deletedSets)
            assertEquals(listOf(taken), room.training.session(opened.id)!!.sets)
            assertEquals("the retained screen draws the restored row", listOf(taken),
                room.store.history.retainedSession(shown).sets.filterNot { it.id in room.store.held.deletedSets || it.id in room.store.held.withheldIds })

            assertNull(room.store.deletions.delete(Deletion.Set(opened.id, taken)))
            room.store.refreshEngine()
            assertEquals("the previous refusal does not unmask a pending retry", setOf(taken.id), room.store.held.deletedSets)
            assertTrue(room.store.history.retainedSession(shown).sets.filterNot { it.id in room.store.held.deletedSets || it.id in room.store.held.withheldIds }.isEmpty())
            room.sync(server); room.store.refreshEngine()
            assertTrue(room.training.session(opened.id)!!.sets.isEmpty())
            assertEquals("an accepted delete stays hidden in older reads", setOf(taken.id), room.store.held.deletedSets)
            runCurrent()
        }
    }
}
