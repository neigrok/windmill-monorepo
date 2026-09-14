package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ProgressReadTests {
    @get:Rule val tmp = TemporaryFolder()
    private fun account(id: String) = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User(id, "$id@example.com", id))
    private fun TestScope.store(logs: Map<String, TrainingSyncing>) = TrainingStore(
        SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
        LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
        now = { testScheduler.currentTime }, sync = { logs[it.user?.id] })

    @Test
    fun completeReadIsSharedAndFailureNeverFallsBackToLegacySessionEstimate() = runTest {
        val server = FakeTraining().apply {
            stored["finished"] = Session("finished", 1, finishedAtMs = 2)
            sets["finished"] = mutableListOf(TrainingSet("set", "bench", weightKg = 80.0, reps = 8, completedAtMs = 1))
        }
        val store = store(mapOf("a" to server))
        store.connect(account("a"))
        val expected = StatsProgress.of(listOf(SessionDetail(server.stored.getValue("finished"), server.sets.getValue("finished"))), 0)
        assertEquals(GymResult.Ok(expected), store.loadProgress())
        assertEquals(GymResult.Ok(expected), store.loadProgress())
        assertEquals(1, server.calls.count { it == "progress" })
        assertEquals(expected, store.progress)
        server.online = false
        assertTrue(store.loadProgress(force = true) is GymResult.Failed)
        assertEquals(expected, store.progress)
        assertNotNull(store.progressFailure)
        assertEquals(1, store.logged.size)
    }

    @Test
    fun oldOwnerReplyCannotBecomeNewOwnersProjection() = runTest {
        val reply = CompletableDeferred<StatsProgress>()
        val a = object : TrainingSyncing by FakeTraining() { override suspend fun progress() = reply.await() }
        val b = FakeTraining()
        val store = store(mapOf("a" to a, "b" to b))
        store.connect(account("a"))
        val first = async { store.loadProgress() }
        runCurrent()
        val arrival = async { store.connect(account("b")) }
        runCurrent()
        reply.complete(StatsProgress(900, listOf(ProgressSession("private-a", 1, emptyList()))))
        assertTrue(first.await() is GymResult.Failed)
        arrival.await()
        assertEquals(StatsProgress(0, emptyList()), store.progress)
        assertNull(store.progressFailure)
    }

    @Test
    fun mutationDuringProgressReadRepeatsWholeReadAndHeldSessionSharesOneFilter() = runTest {
        val server = FakeTraining().apply {
            stored["finished"] = Session("finished", 1, finishedAtMs = 2)
            sets["finished"] = mutableListOf(TrainingSet("set", "bench", weightKg = 80.0, reps = 8, completedAtMs = 1))
        }
        val release = CompletableDeferred<Unit>()
        var reads = 0
        val boundary = object : TrainingSyncing by server {
            override suspend fun progress(): StatsProgress {
                val read = server.progress()
                reads += 1
                if (reads == 1) release.await()
                return read
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        val read = async { store.loadProgress() }
        runCurrent()
        assertTrue(store.fixSet("finished", "set", SetFix(weightKg = 90.0)) is FixOutcome.Corrected)
        release.complete(Unit)
        read.await()
        assertEquals(2, reads)
        val expected = StatsProgress.of(listOf(SessionDetail(server.stored.getValue("finished"), server.sets.getValue("finished"))), 0)
        assertEquals(expected, store.progress)
        store.withhold(Deletion.Session("finished"))
        assertEquals(StatsProgress(0, emptyList()), store.progress)
        store.keepWithheld()
        assertEquals(expected, store.progress)
    }
    @Test
    fun pendingOlderPageCannotAppendIntoNewOwnersRowsOrChangeItsEndState() = runTest {
        val server = FakeTraining().apply {
            repeat(50) { index -> stored["s$index"] = Session("s$index", (100 + index).toLong(), finishedAtMs = 200) }
        }
        val release = CompletableDeferred<List<SessionSummary>>()
        val a = object : TrainingSyncing by server {
            override suspend fun sessions(limit: Int, before: Long?, beforeId: String?): List<SessionSummary> {
                if (before != null) return release.await()
                return server.sessions(limit, before, beforeId)
            }
        }
        val b = FakeTraining().apply { stored["b"] = Session("b", 500, finishedAtMs = 600) }
        val store = store(mapOf("a" to a, "b" to b))
        store.connect(account("a"))
        assertEquals(Older.More, store.older)
        val older = async { store.loadOlder() }
        runCurrent()
        store.connect(account("b"))
        release.complete(listOf(SessionSummary(Session("old-a", 1, finishedAtMs = 2), emptyList())))
        older.await()
        assertEquals(listOf("b"), store.logged.map { it.id })
        assertEquals(Older.End, store.older)
    }

    @Test
    fun confirmedRenameSurvivesAnOlderCatalogReadAndInsertsAnUncachedMovement() = runTest {
        for (cached in listOf(true, false)) {
            val folder = tmp.newFolder()
            val movement = Exercise("private-bench", "Bench", "push", "barbell")
            val confirmed = movement.copy(name = "Bench Press")
            val cacheFile = File(folder, "catalog")
            DeviceCopy(cacheFile).hold("a", if (cached) listOf(movement) else emptyList())
            val release = CompletableDeferred<Unit>()
            val server = object : TrainingSyncing by FakeTraining() {
                override suspend fun exercises(): List<Exercise> { release.await(); return listOf(movement) }
                override suspend fun renameExercise(exerciseId: String, name: String): Exercise {
                    assertEquals("private-bench" to "Bench Press", exerciseId to name)
                    return confirmed
                }
            }
            val store = TrainingStore(SetQueue(File(folder, "queue")), DeviceCopy(cacheFile), LocalLog(File(folder, "log")),
                LocalPreferences(File(folder, "prefs")), LocalBodyweight(File(folder, "weight")), backgroundScope,
                now = { testScheduler.currentTime }, sync = { server })
            val connection = async { store.connect(account("a")) }
            runCurrent()
            assertEquals(GymResult.Ok(confirmed), store.rename(movement.id, "Bench Press"))
            assertEquals(listOf(confirmed), store.catalog.filter { it.id == movement.id })
            release.complete(Unit)
            connection.await()
            assertEquals(listOf(confirmed), store.catalog.filter { it.id == movement.id })
            assertEquals(store.catalog, DeviceCopy(cacheFile).movements("a"))
            assertEquals(emptyList<Exercise>(), DeviceCopy(cacheFile).movements("b"))
        }
    }

}
