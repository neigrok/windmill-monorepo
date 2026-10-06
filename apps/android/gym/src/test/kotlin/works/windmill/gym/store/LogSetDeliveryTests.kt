package works.windmill.gym.store

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.Blocker
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.TrainingSet
import works.windmill.sync.modelserver.ModelServer
import works.windmill.sync.engine.Reply
import works.windmill.sync.engine.SessionTokens
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.SyncTransport
import works.windmill.sync.core.Json

// Log set holds nothing back: there is no way back after a log, so a set is committed to the
// account's replica the moment it is accepted, and a set that cannot reach the log is stranded at
// once rather than held on purpose.
class LogSetDeliveryTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private suspend fun EngineRoomFixture.enter(server: ModelServer): String {
        select("u1"); pull(server)
        val session = (store.start() as GymResult.Ok).value
        store.choose("bench-press")
        return session.id
    }

    private suspend fun TestScope.serverRow(server: ModelServer, sessionId: String) =
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("u1"); other.pull(server)
            other.training.session(sessionId)
        }

    @Test
    fun testTheLogSetButtonsAcceptanceIsOnTheLogWithoutWaiting() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            val server = EngineRoomFixture.server()
            val sessionId = room.enter(server)
            room.store.editRack(82.5, 5)
            val offer = requireNotNull(room.store.notification.value?.offer)

            val accepted = room.store.acceptSet(LogSetCommand(offer.key, offer.id))

            assertEquals(LogSetAcceptance.Accepted(offer.id), accepted)
            val logged = room.store.sets.single()
            assertEquals(TrainingSet(offer.id, "bench-press", weightKg = 82.5, reps = 5, completedAtMs = logged.completedAtMs), logged)
            assertEquals("the replica holds the set before any push", listOf(logged), room.training.session(sessionId)!!.sets)
            assertEquals(SaveState.OnThisDevice, room.store.saveState)
            room.sync(server); room.store.refreshEngine()
            assertEquals(SaveState.OnTheLog, room.store.saveState)
            assertEquals(listOf(offer.id), serverRow(server, sessionId)!!.sets.map { it.id })
        }
    }

    @Test
    fun testASetTheLogCannotTakeIsStrandedTheMomentItIsLogged() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.enter(EngineRoomFixture.server())
            val tokens = object : SessionTokens {
                override fun token(account: String) = "test"
                override fun save(account: String, token: String) {}
                override fun delete(account: String) {}
                override fun accounts() = setOf("u1")
            }
            val transport = object : SyncTransport {
                override suspend fun hello(token: String?) = Reply.Unreachable
                override suspend fun push(request: Json, token: String) = Reply.Unreachable
                override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
                override suspend fun openLive(token: String) = Reply.Unreachable
            }
            SyncRuntime(room.engine, transport, tokens, "test").use { runtime ->
                runtime.connectivity(false)
                withContext(Dispatchers.IO) { withTimeout(2_000) { room.engine.status.state.first { !it.online } } }
                room.store.logSet(weightKg = 82.5, reps = 5)

                assertEquals(listOf(82.5), room.store.sets.map { it.weightKg })
                assertEquals(1, room.store.strandedCount)
                assertEquals(SaveState.Blocked(Blocker.Offline), room.store.saveState)
            }
        }
    }

    // A correction made with no signal is in the replica at once, so a phone killed before the signal
    // comes back still owes it: the reopened phone sends the set and its correction together.
    @Test
    fun testAFixMadeOfflineSurvivesARestartAndReachesTheLog() = runTest {
        val directory = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val (sessionId, setId, snapshot) = EngineRoomFixture(directory, backgroundScope).use { room ->
            val sessionId = room.enter(server)
            room.store.logSet(weightKg = 82.5, reps = 5)
            val set = room.store.sets.single()
            assertTrue(room.store.fixSet(sessionId, set.id, SetFix(weightKg = 85.0)) is FixOutcome.Corrected)
            assertEquals(listOf(85.0), room.store.sets.map { it.weightKg })
            Triple(sessionId, set.id, room.engine.snapshot())
        }
        EngineRoomFixture(directory, backgroundScope, snapshot).use { reopened ->
            reopened.selected = "u1"
            reopened.store.connect(reopened.account("u1"))
            assertEquals(listOf(85.0), reopened.store.sets.map { it.weightKg })
            reopened.sync(server)
            assertEquals(listOf(setId to 85.0), serverRow(server, sessionId)!!.sets.map { it.id to it.weightKg })
        }
    }

    // A delete made with no signal leaves the phone at once and still takes the row off the log once
    // the phone reconnects, across a restart.
    @Test
    fun testADeleteMadeOfflineSurvivesARestartAndTakesTheRowOffTheLog() = runTest {
        val directory = tmp.newFolder()
        val server = EngineRoomFixture.server()
        val (sessionId, snapshot) = EngineRoomFixture(directory, backgroundScope).use { room ->
            val sessionId = room.enter(server)
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.sync(server)
            val first = room.store.sets.first()
            assertNull(room.store.deleteSet(sessionId, first.id))
            assertEquals(listOf(90.0), room.store.sets.map { it.weightKg })
            sessionId to room.engine.snapshot()
        }
        EngineRoomFixture(directory, backgroundScope, snapshot).use { reopened ->
            reopened.selected = "u1"
            reopened.store.connect(reopened.account("u1"))
            assertEquals(listOf(90.0), reopened.store.sets.map { it.weightKg })
            reopened.sync(server)
            assertEquals(listOf(90.0), serverRow(server, sessionId)!!.sets.map { it.weightKg })
        }
    }
}
