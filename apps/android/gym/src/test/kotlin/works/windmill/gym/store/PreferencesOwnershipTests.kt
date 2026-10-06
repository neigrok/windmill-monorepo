package works.windmill.gym.store

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.McpKey
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.TrainingSyncing

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PreferencesOwnershipTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun aPreferenceSavedUnderOneAccountNeverBecomesTheNextOwnersDocumentOrOwedWrite() = runTest {
        val a = GymPreferences(confirmSound = true)
        val b = GymPreferences(confirmHaptic = false)
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("b"); other.pull(server)
            assertNull(other.store.savePreferences(b))
            other.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertNull(room.store.savePreferences(a))
            room.select("b"); room.pull(server); room.store.refreshEngine()
            assertEquals(b, room.store.preferences)
            assertEquals(b, room.training.settings())
            assertEquals("only the first account owes the log its document",
                listOf("a" to "prefs"), room.outbox().map { owed ->
                    owed.member("lineage").str() to owed.member("intent").member("d").arr().single().member("t").str()
                })
            room.select("a")
            assertEquals(a, room.store.preferences)
            assertEquals(a, room.training.settings())
        }
    }

    @Test
    fun theLatestPreferenceIntentIsTheDocumentTheAccountHolds() = runTest {
        val old = GymPreferences(confirmSound = true)
        val latest = GymPreferences(confirmHaptic = false)
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertNull(room.store.savePreferences(old))
            assertNull(room.store.savePreferences(latest))
            assertEquals(latest, room.store.preferences)
            room.sync(server); room.store.refreshEngine()
            assertEquals(latest, room.store.preferences)
            assertEquals(latest, room.training.settings())
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server); other.store.refreshEngine()
            assertEquals(latest, other.store.preferences)
        }
    }

    @Test
    fun theLatestConnectedLogRefreshWinsOverAnOlderFirstRead() = runTest {
        val old = McpKey("key_old", "Old tool", 1_000)
        val latest = McpKey("key_new", "Current tool", 2_000)
        val release = CompletableDeferred<Unit>()
        var reads = 0
        val server = FakeGymRest()
        val boundary = object : TrainingSyncing by server {
            override suspend fun mcpKeys(): List<McpKey> {
                if (++reads == 1) { release.await(); return listOf(old) }
                return listOf(latest)
            }
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = boundary).use { room ->
            room.select("a")
            val first = async { room.store.readConnectedLog() }
            runCurrent()
            val expected = ConnectedLog.state(emptyList(), listOf(latest))
            assertEquals(expected, room.store.refreshConnectedLog())
            release.complete(Unit); first.await()
            assertEquals(expected, room.store.connectedLog)
            assertEquals(expected, room.store.readConnectedLog())
            assertEquals(2, reads)
        }
    }
}
