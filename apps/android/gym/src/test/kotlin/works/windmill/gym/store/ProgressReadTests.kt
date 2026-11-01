package works.windmill.gym.store

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.RecordsView
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ProgressReadTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun completeReadIsSharedUntilAForcedReadReplacesIt() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            room.workout(80.0)
            runCurrent()
            val expected = StatsProgress.of(room.training.details(), room.engine.physNow(), complete = false)
            assertEquals(GymResult.Ok(expected), room.store.history.loadProgress())
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
                other.now = room.now + 600_000
                other.select("a")
                other.training.startSession(SessionStart("remote01", other.now - 10_000))
                other.training.appendSet("remote01", SetWrite("remoteset", "back-squat", 100.0, 5, other.now - 9_000))
                other.training.finishSession("remote01", other.now - 5_000)
                other.sync(server)
            }
            room.sync(server)
            assertEquals(2, room.training.details().size)
            assertEquals("a second read shares the first", GymResult.Ok(expected), room.store.history.loadProgress())
            assertEquals(expected, room.store.history.progress)
            val fresh = StatsProgress.of(room.training.details(), room.engine.physNow())
            assertEquals(GymResult.Ok(fresh), room.store.history.loadProgress(force = true))
            assertEquals(fresh, room.store.history.progress)
            assertNull(room.store.history.progressFailure)
        }
    }

    @Test
    fun oneOwnersProgressNeverBecomesTheNextOwnersProjection() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val session = room.workout(80.0)
            assertEquals(listOf(session.id), (room.store.history.loadProgress() as GymResult.Ok).value.sessions.map { it.sessionId })
            room.select("b")
            assertEquals(emptyList<ProgressSession>(), room.store.history.progress!!.sessions)
            assertNull(room.store.history.progressFailure)
        }
    }

    @Test
    fun aCorrectionReachesTheProgressReadAndAHeldSessionSharesOneFilter() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val session = room.workout(80.0)
            runCurrent()
            assertTrue(room.store.history.loadProgress() is GymResult.Ok)
            val set = room.training.session(session.id)!!.sets.single()
            assertTrue(room.store.workout.fixSet(session.id, set.id, SetFix(weightKg = 90.0)) is FixOutcome.Corrected)
            runCurrent()
            val read = room.store.history.progress!!
            val expected = StatsProgress.of(room.training.details(), read.asOf, complete = false)
            assertEquals(expected, read)
            assertEquals(listOf(90.0), read.sessions.flatMap { it.movements }.map { it.heaviest.weightKg })
            room.store.deletions.withhold(Deletion.Session(session.id))
            assertEquals(emptyList<ProgressSession>(), room.store.history.progress!!.sessions)
            room.store.deletions.keepWithheld()
            assertEquals(expected, room.store.history.progress)
        }
    }

    @Test
    fun anAcceptedEditReachesTheObservedCatalogueAndSurvivesTheNextRead() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertTrue(other.store.routines.create("Bench", "barbell", "private-bench") is GymResult.Ok)
            other.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a"); room.pull(server); room.store.refreshEngine()
            room.store.observeEngine()
            runCurrent()
            val renamed = room.store.history.edit("private-bench", "Bench Press")
            val confirmed = room.training.catalogue().single { it.id == "private-bench" }
            assertEquals(GymResult.Ok(confirmed), renamed)
            assertEquals("Bench Press", confirmed.name)
            val view = room.engine.records(ScopeRef.product("gym"), "exercise")
            withContext(Dispatchers.Default) {
                withTimeout(5_000) { view.state.first { state -> state is RecordsView.State.Loaded &&
                    state.snapshot.records.any { it.id.toString() == "private-bench" && it.values["name"] == Json.of("Bench Press") } } }
            }
            runCurrent()
            assertEquals(listOf(confirmed), room.store.routines.catalog.filter { it.id == "private-bench" })
            room.store.connect(room.account())
            assertEquals(listOf(confirmed), room.store.routines.catalog.filter { it.id == "private-bench" })
            room.sync(server); room.store.refreshEngine()
            assertEquals(listOf(confirmed), room.store.routines.catalog.filter { it.id == "private-bench" })
        }
    }
}
