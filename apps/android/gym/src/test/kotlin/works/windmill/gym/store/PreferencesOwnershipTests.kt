package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PreferencesOwnershipTests {
    @get:Rule val tmp = TemporaryFolder()
    private fun account(id: String) = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User(id, "$id@example.com"))

    @Test
    fun aLatePreferenceReplyCannotChangeTheNextOwnersDocumentOrOwedBit() = runTest {
        val file = File(tmp.root, "prefs")
        val a = GymPreferences(confirmSound = true)
        val b = GymPreferences(confirmHaptic = false)
        val preferences = LocalPreferences(file).apply { adopt("b"); landed(b) }
        val serverA = FakeTraining()
        val serverB = FakeTraining().apply { settings = b }
        val release = CompletableDeferred<Unit>()
        val boundary = object : TrainingSyncing by serverA {
            override suspend fun savePreferences(document: GymPreferences): GymPreferences { release.await(); return document }
        }
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), LocalLog(File(tmp.root, "log")),
            preferences, LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
            sync = { if (it.user?.id == "a") boundary else serverB })
        store.connect(account("a"))
        val save = async { store.savePreferences(a) }
        runCurrent()
        val switch = async { store.connect(account("b")) }
        runCurrent()
        release.complete(Unit)
        switch.await()
        assertEquals(WriteFailure.Refused("The account changed. Open this again."), save.await())
        assertEquals(b, store.preferences)
        assertEquals(b, preferences.document)
        assertFalse(preferences.owed)
        val disk = LocalPreferences(file)
        disk.adopt("a"); assertEquals(a, disk.document); assertTrue(disk.owed)
        disk.adopt("b"); assertEquals(b, disk.document); assertFalse(disk.owed)
    }

    @Test
    fun aNewPreferenceIntentWaitsForReplayAndItsOlderReplyCannotSettleTheNewDocument() = runTest {
        val file = File(tmp.root, "prefs")
        val old = GymPreferences(confirmSound = true)
        val latest = GymPreferences(confirmHaptic = false)
        val preferences = LocalPreferences(file).apply { adopt("a"); save(old) }
        val server = FakeTraining()
        val release = CompletableDeferred<Unit>()
        val writes = mutableListOf<GymPreferences>()
        val boundary = object : TrainingSyncing by server {
            override suspend fun savePreferences(document: GymPreferences): GymPreferences {
                writes += document
                if (document == old) release.await()
                server.settings = document
                return document
            }
        }
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), LocalLog(File(tmp.root, "log")),
            preferences, LocalBodyweight(File(tmp.root, "weight")), backgroundScope, sync = { boundary })
        val connect = async { store.connect(account("a")) }
        runCurrent()
        assertEquals(listOf(old), writes)
        val save = async { store.savePreferences(latest) }
        runCurrent()
        assertEquals(listOf(old), writes)
        assertEquals(latest, store.preferences)
        assertTrue(preferences.owed)
        release.complete(Unit)
        connect.await(); assertNull(save.await())
        assertEquals(listOf(old, latest), writes)
        assertEquals(latest, server.settings)
        assertEquals(latest, store.preferences)
        assertFalse(preferences.owed)
        val disk = LocalPreferences(file).apply { adopt("a") }
        assertEquals(latest, disk.document)
        assertFalse(disk.owed)
    }

    @Test
    fun theLatestConnectedLogRefreshWinsOverAnOlderFirstRead() = runTest {
        val old = McpKey("key_old", "Old tool", 1_000)
        val latest = McpKey("key_new", "Current tool", 2_000)
        val release = CompletableDeferred<Unit>()
        var reads = 0
        val server = FakeTraining()
        val boundary = object : TrainingSyncing by server {
            override suspend fun mcpKeys(): List<McpKey> {
                if (++reads == 1) { release.await(); return listOf(old) }
                return listOf(latest)
            }
        }
        val store = TrainingStore(SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "device")), LocalLog(File(tmp.root, "log")),
            LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope, sync = { boundary })
        store.connect(account("a"))
        val first = async { store.readConnectedLog() }
        runCurrent()
        val expected = ConnectedLog.state(emptyList(), listOf(latest))
        assertEquals(expected, store.refreshConnectedLog())
        release.complete(Unit); first.await()
        assertEquals(expected, store.connectedLog)
        assertEquals(expected, store.readConnectedLog())
        assertEquals(2, reads)
    }
}
