package works.windmill.gym.store

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PlanningWritesTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun originalRevisionSurvivesCacheRefreshAndAStaleRefusalPreservesTheDraft() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertTrue(other.store.saveRoutine(RoutineDraft(name = "Push", creationId = "routine_a")
                .adding("bench-press", List(3) { SetTarget(8, 60.0) })) is GymResult.Ok)
            other.sync(server)
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
                room.select("a"); room.pull(server); room.store.refreshEngine()
                val original = room.store.routine("routine_a")!!
                val draft = RoutineDraft.of(original)
                assertTrue(other.store.saveRoutine(RoutineDraft.of(other.store.routine("routine_a")!!).named("Push elsewhere"))
                    is GymResult.Ok)
                other.sync(server)
                room.pull(server); room.store.refreshEngine()
                val advanced = room.store.routine("routine_a")!!
                assertEquals("Push elsewhere", advanced.name)
                assertFalse(draft.changed)
                val changed = draft.named("My push")
                assertEquals(GymResult.Failed(WriteFailure.Refused("That routine changed. Open it again.")),
                    room.store.saveRoutine(changed))
                assertEquals("nothing went out", emptyList<works.windmill.sync.core.Json>(), room.outbox())
                assertEquals(listOf(advanced), room.training.program())
                assertEquals(RoutineDraft.of(original).named("My push"), changed)
            }
        }
    }

    @Test
    fun restoredLegacyAccountEditCannotOverwriteWithoutItsOriginalRevision() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertTrue(room.store.saveRoutine(RoutineDraft(name = "Push", creationId = "routine_a").adding("bench-press"))
                is GymResult.Ok)
            room.sync(server); room.store.refreshEngine()
            val draft = Json.decodeFromString<RoutineDraft>("""{"id":"routine_a","name":"Edited","entries":[{"exerciseId":"bench-press"}]}""")
            val before = room.training.program()
            assertEquals(GymResult.Failed(WriteFailure.Refused("reopen this routine before saving — its original revision is missing")),
                room.store.saveRoutine(draft))
            assertEquals(before, room.training.program())
            assertEquals(emptyList<works.windmill.sync.core.Json>(), room.outbox())
        }
    }

    @Test
    fun newRoutineRetriesKeepOneIdentityAndRefuseChangedAcceptedPayloads() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val draft = RoutineDraft(name = "Push", creationId = "routine_once").adding("bench-press")
            val expected = Routine(RoutineWrite("routine_once", "Push", 0, draft.write))
            assertEquals(GymResult.Ok(expected), room.store.saveRoutine(draft))
            val restored = Json.decodeFromString<RoutineDraft>(Json.encodeToString(RoutineDraft.serializer(), draft))
            assertTrue(room.store.saveRoutine(restored.named("Edited after interruption")) is GymResult.Failed)
            assertEquals(GymResult.Ok(expected), room.store.saveRoutine(restored))
            assertEquals(listOf(expected), room.training.program())
            assertEquals(listOf(expected), room.store.routines)
        }
    }

    @Test
    fun oneSignedOutMovementIdentityHasOneCatalogRow() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val expected = Exercise("ex_once", "Zercher", pattern = Exercise.unclassified, equipment = "barbell",
                stepKg = 2.5, custom = true)
            assertEquals(GymResult.Ok(expected), room.store.create("Zercher", "barbell", "ex_once"))
            assertEquals(GymResult.Ok(expected), room.store.create("Zercher", "barbell", "ex_once"))
            assertEquals(listOf(expected), room.training.catalogue().filter { it.id == "ex_once" })
            assertEquals(listOf(expected), room.store.catalog.filter { it.id == "ex_once" })
            assertTrue(room.store.create("Different", "dumbbell", "ex_once") is GymResult.Failed)
            assertEquals(listOf(expected), room.training.catalogue().filter { it.id == "ex_once" })
        }
    }

    @Test
    fun anAcceptedMovementCannotSilentlyAcceptEditedRetryDetails() = runTest {
        val server = EngineRoomFixture.server()
        val expected = Exercise("ex_once", "Zercher", pattern = Exercise.unclassified, equipment = "barbell",
            stepKg = 2.5, custom = true)
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertEquals(GymResult.Ok(expected), room.store.create("Zercher", "barbell", "ex_once"))
            assertEquals(GymResult.Failed(WriteFailure.Refused("already saved as Zercher (barbell) — choose it from the movement list")),
                room.store.create("Zercher carry", "dumbbell", "ex_once"))
            assertEquals(GymResult.Ok(expected), room.store.create("Zercher", "barbell", "ex_once"))
            assertEquals(listOf(expected), room.store.catalog.filter { it.id == "ex_once" })
            room.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertEquals(listOf(expected), other.training.catalogue().filter { it.id == "ex_once" })
        }
    }

    @Test
    fun anOfflineMovementReplaysOneIdToTheLog() = runTest {
        val server = EngineRoomFixture.server()
        val expected = Exercise("ex_once", "Zercher", pattern = Exercise.unclassified, equipment = "barbell",
            stepKg = 2.5, custom = true)
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertEquals(GymResult.Ok(expected), room.store.create("Zercher", "barbell", "ex_once"))
            assertEquals(GymResult.Ok(expected), room.store.create("Zercher", "barbell", "ex_once"))
            assertEquals("one intent is owed for one identity", listOf("ex_once"), room.outbox().flatMap { owed ->
                owed.member("intent")["d"]?.arr().orEmpty().filter { it.member("t").str() == "exercise" }.map { it.member("id").str() }
            })
            assertEquals(listOf(expected), room.store.catalog.filter { it.id == "ex_once" })
            room.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertEquals(listOf(expected), other.training.catalogue().filter { it.id == "ex_once" })
        }
    }

    @Test
    fun movementAndRoutineWritesNeverEnterTheNextAccount() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertTrue(room.store.create("Only A", "barbell", "ex_a") is GymResult.Ok)
            assertTrue(room.store.saveRoutine(RoutineDraft(name = "Only A", creationId = "routine_a").adding("bench-press"))
                is GymResult.Ok)
            room.select("b")
            assertEquals(emptyList<Exercise>(), room.store.catalog.filter { it.id == "ex_a" })
            assertEquals(emptyList<Routine>(), room.store.routines)
            assertEquals(emptyList<Exercise>(), room.training.catalogue().filter { it.id == "ex_a" })
            assertEquals(emptyList<Routine>(), room.training.program())
            room.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("b"); other.pull(server)
            assertEquals(emptyList<Exercise>(), other.training.catalogue().filter { it.id == "ex_a" })
            assertEquals(emptyList<Routine>(), other.training.program())
        }
    }
}
