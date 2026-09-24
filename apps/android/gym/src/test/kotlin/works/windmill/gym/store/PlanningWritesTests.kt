package works.windmill.gym.store

import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
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
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PlanningWritesTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun account(id: String?) = Account(
        api = WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }),
        user = id?.let { User(id = it, email = "$it@example.com", name = it) },
    )

    private fun TestScope.store(logs: Map<String, TrainingSyncing> = emptyMap()) = TrainingStore(
        queue = SetQueue(File(tmp.root, "queue.json")),
        deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
        localLog = LocalLog(File(tmp.root, "local.json")),
        localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
        localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
        scope = backgroundScope,
        sync = { logs[it.user?.id] },
    )

    @Test
    fun originalRevisionSurvivesCacheRefreshAndAStaleRefusalPreservesTheDraft() = runTest {
        val original = Routine("rt_a", "Push", 0, revision = 4, entries = listOf(
            RoutineEntry(1, "bench-press", List(3) { SetTarget(8, 60.0) }, restSeconds = 90)))
        val advanced = original.copy(name = "Push elsewhere", revision = 5)
        val calls = mutableListOf<RoutineWrite>()
        val server = FakeTraining().apply { written[original.id] = original }
        val boundary = object : TrainingSyncing by server {
            override suspend fun replaceRoutine(id: String, write: RoutineWrite): Routine {
                calls += write
                throw WindmillApiException.Refused(409, Refusal(message = "routine changed", code = "revision-conflict"))
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        val draft = RoutineDraft.of(store.routine(original.id)!!)
        server.written[original.id] = advanced
        store.connect(account("a"))
        assertFalse(draft.changed)
        val changed = draft.named("My push")
        assertEquals(GymResult.Failed(WriteFailure.Refused("routine changed")), store.saveRoutine(changed))
        assertEquals(listOf(RoutineWrite(original.id, "My push", 0, draft.write, expectedRevision = 4)), calls)
        assertEquals(advanced, server.written[original.id])
        assertEquals(RoutineDraft.of(original).named("My push"), changed)
    }

    @Test
    fun restoredLegacyAccountEditCannotOverwriteWithoutItsOriginalRevision() = runTest {
        val server = FakeTraining().apply { written["rt_a"] = Routine("rt_a", "Push", entries = listOf(RoutineEntry(exerciseId = "bench-press"))) }
        val store = store(mapOf("a" to server))
        store.connect(account("a"))
        val draft = Json.decodeFromString<RoutineDraft>("""{"id":"rt_a","name":"Edited","entries":[{"exerciseId":"bench-press"}]}""")
        val before = server.written.toMap()
        assertEquals(GymResult.Failed(WriteFailure.Refused("reopen this routine before saving — its original revision is missing")), store.saveRoutine(draft))
        assertEquals(before, server.written)
        assertFalse(server.calls.contains("replaceRoutine"))
    }

    @Test
    fun newRoutineRetriesKeepOneIdentityAndRefuseChangedAcceptedPayloads() = runTest {
        val server = FakeTraining()
        var loseReply = true
        val boundary = object : TrainingSyncing by server {
            override suspend fun createRoutine(write: RoutineWrite): Routine {
                val made = server.createRoutine(write)
                if (loseReply) throw CancellationException("activity reclaimed")
                return made
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        val draft = RoutineDraft(name = "Push", creationId = "rt_once").adding("bench-press")
        try { store.saveRoutine(draft); fail("must cancel") } catch (_: CancellationException) { }
        val restored = Json.decodeFromString<RoutineDraft>(Json.encodeToString(RoutineDraft.serializer(), draft))
        loseReply = false
        assertTrue(store.saveRoutine(restored.named("Edited after interruption")) is GymResult.Failed)
        val expected = Routine(RoutineWrite("rt_once", "Push", 0, draft.write))
        assertEquals(GymResult.Ok(expected), store.saveRoutine(restored))
        assertEquals(mapOf("rt_once" to expected), server.written)
        assertEquals(listOf(expected), store.routines)
    }

    @Test
    fun oneOfflineMovementIdentityHasOneShelfRowAndOneCatalogRow() = runTest {
        val store = store()
        store.connect(account(null))
        val expected = Exercise("ex_once", "Zercher", pattern = Exercise.unclassified, equipment = "barbell", custom = true)
        assertEquals(GymResult.Ok(expected), store.create("Zercher", "barbell", "ex_once"))
        assertEquals(GymResult.Ok(expected), store.create("Zercher", "barbell", "ex_once"))
        assertEquals(listOf(expected), LocalLog(File(tmp.root, "local.json")).exercises)
        assertEquals(listOf(expected), store.catalog.filter { it.id == "ex_once" })
        assertTrue(store.create("Different", "dumbbell", "ex_once") is GymResult.Failed)
        assertEquals(listOf(expected), LocalLog(File(tmp.root, "local.json")).exercises)
    }

    @Test
    fun anAcceptedMovementWithLostReplyCannotSilentlyAcceptEditedRetryDetails() = runTest {
        val server = FakeTraining()
        var loseReply = true
        val boundary = object : TrainingSyncing by server {
            override suspend fun createExercise(write: ExerciseWrite): Exercise {
                val made = server.createExercise(write)
                if (loseReply) throw CancellationException("activity reclaimed")
                return made
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        try { store.create("Zercher", "barbell", "ex_once"); fail("must cancel") } catch (_: CancellationException) { }
        loseReply = false
        assertTrue(store.create("Zercher carry", "dumbbell", "ex_once") is GymResult.Failed)
        val expected = Exercise("ex_once", "Zercher", pattern = Exercise.unclassified, equipment = "barbell", custom = true)
        assertEquals(GymResult.Ok(expected), store.create("Zercher", "barbell", "ex_once"))
        assertEquals(listOf(expected), server.catalog.filter { it.id == "ex_once" })
        assertEquals(listOf(expected), store.catalog.filter { it.id == "ex_once" })
    }

    @Test
    fun aLostMovementReplyReplaysOneIdThroughTheLocalShelf() = runTest {
        val server = FakeTraining()
        val boundary = object : TrainingSyncing by server {
            override suspend fun createExercise(write: ExerciseWrite): Exercise {
                server.createExercise(write)
                throw IOException("reply lost")
            }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        val expected = Exercise("ex_once", "Zercher", pattern = Exercise.unclassified, equipment = "barbell", custom = true)
        assertEquals(GymResult.Ok(expected), store.create("Zercher", "barbell", "ex_once"))
        assertEquals(GymResult.Ok(expected), store.create("Zercher", "barbell", "ex_once"))
        assertEquals(listOf(expected), server.catalog.filter { it.id == "ex_once" })
        assertEquals(listOf(expected), LocalLog(File(tmp.root, "local.json"), "a").exercises)
        assertEquals(listOf(expected), store.catalog.filter { it.id == "ex_once" })
    }

    @Test
    fun suspendedMovementAndRoutineCompletionsNeverEnterTheNextAccount() = runTest {
        for (lostReply in listOf(false, true)) {
            val serverA = FakeTraining()
            val serverB = FakeTraining()
            val movementGate = CompletableDeferred<Unit>()
            val routineGate = CompletableDeferred<Unit>()
            val boundary = object : TrainingSyncing by serverA {
                override suspend fun createExercise(write: ExerciseWrite): Exercise {
                    val made = serverA.createExercise(write)
                    movementGate.await()
                    if (lostReply) throw IOException("reply lost")
                    return made
                }
                override suspend fun createRoutine(write: RoutineWrite): Routine {
                    val made = serverA.createRoutine(write)
                    routineGate.await()
                    if (lostReply) throw IOException("reply lost")
                    return made
                }
            }
            val store = store(mapOf("a" to boundary, "b" to serverB))
            store.connect(account("a"))
            val movement = async { store.create("Only A", "barbell", "ex_a") }
            val routine = async { store.saveRoutine(RoutineDraft(name = "Only A", creationId = "rt_a").adding("bench-press")) }
            runCurrent()
            store.connect(account("b"))
            val beforeCatalog = store.catalog
            val beforeProgram = store.routines
            movementGate.complete(Unit)
            routineGate.complete(Unit)
            assertEquals(GymResult.Failed(WriteFailure.Refused("the account changed while creating")), movement.await())
            assertEquals(GymResult.Failed(WriteFailure.Refused("the account changed while saving")), routine.await())
            assertEquals(beforeCatalog, store.catalog)
            assertEquals(beforeProgram, store.routines)
            assertEquals(emptyList<Exercise>(), LocalLog(File(tmp.root, "local.json"), "b").exercises)
            assertEquals(emptyList<Routine>(), LocalLog(File(tmp.root, "local.json"), "b").routines)
            assertTrue(serverB.written.isEmpty())
        }
    }
    @Test
    fun detailReloadRefreshesTheNextEditWithoutReplacingTheOpenDraftSnapshot() = runTest {
        val original = Routine("rt_a", "Push", revision = 4, entries = listOf(RoutineEntry(exerciseId = "bench-press")))
        val server = FakeTraining().apply { written[original.id] = original }
        val store = store(mapOf("a" to server))
        store.connect(account("a"))
        val openDraft = RoutineDraft.of(store.routine(original.id)!!).named("My draft")
        val current = original.copy(name = "Server edit", revision = 5)
        server.written[original.id] = current
        val history = (store.routineHistory(original.id) as GymResult.Ok).value
        assertEquals(current.copy(history = history), store.routine(original.id))
        assertEquals(RoutineDraft.of(original).named("My draft"), openDraft)
        val reopened = RoutineDraft.of(store.routine(original.id)!!)
        assertEquals(RoutineWrite(current, expectedRevision = 5), reopened.original)
        assertFalse(reopened.changed)
    }

    @Test
    fun aDetailReloadFromThePreviousAccountCannotRefreshTheNewAccountsCache() = runTest {
        val original = Routine("rt_a", "Only A", entries = listOf(RoutineEntry(exerciseId = "bench-press")))
        val serverA = FakeTraining().apply { written[original.id] = original }
        val serverB = FakeTraining()
        val gate = CompletableDeferred<Unit>()
        val boundary = object : TrainingSyncing by serverA {
            override suspend fun routine(id: String): Routine? {
                val read = serverA.routine(id)
                gate.await()
                return read
            }
        }
        val store = store(mapOf("a" to boundary, "b" to serverB))
        store.connect(account("a"))
        val read = async { store.routineHistory(original.id) }
        runCurrent()
        store.connect(account("b"))
        gate.complete(Unit)
        assertEquals(GymResult.Failed(WriteFailure.Refused("the account changed while reading")), read.await())
        assertEquals(emptyList<Routine>(), store.routines)
    }

}
