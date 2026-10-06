package works.windmill.gym.store

import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*

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
            val expected = StatsProgress.of(room.training.details(), room.engine.physNow())
            assertEquals(GymResult.Ok(expected), room.store.loadProgress())
            EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
                other.now = room.now + 600_000
                other.select("a")
                other.training.startSession(SessionStart("remote01", other.now - 10_000))
                other.training.appendSet("remote01", SetWrite("remoteset", "back-squat", 100.0, 5, SetKind.Working, other.now - 9_000))
                other.training.finishSession("remote01", other.now - 5_000)
                other.sync(server)
            }
            room.sync(server)
            assertEquals(2, room.training.details().size)
            assertEquals("a second read shares the first", GymResult.Ok(expected), room.store.loadProgress())
            assertEquals(expected, room.store.progress)
            val fresh = StatsProgress.of(room.training.details(), room.engine.physNow())
            assertEquals(GymResult.Ok(fresh), room.store.loadProgress(force = true))
            assertEquals(fresh, room.store.progress)
            assertNull(room.store.progressFailure)
        }
    }

    @Test
    fun oneOwnersProgressNeverBecomesTheNextOwnersProjection() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val session = room.workout(80.0)
            assertEquals(listOf(session.id), (room.store.loadProgress() as GymResult.Ok).value.sessions.map { it.sessionId })
            room.select("b")
            assertEquals(emptyList<ProgressSession>(), room.store.progress!!.sessions)
            assertNull(room.store.progressFailure)
        }
    }

    @Test
    fun aCorrectionReachesTheProgressReadAndAHeldSessionSharesOneFilter() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val session = room.workout(80.0)
            runCurrent()
            assertTrue(room.store.loadProgress() is GymResult.Ok)
            val set = room.training.session(session.id)!!.sets.single()
            assertTrue(room.store.fixSet(session.id, set.id, SetFix(weightKg = 90.0)) is FixOutcome.Corrected)
            runCurrent()
            val read = room.store.progress!!
            val expected = StatsProgress.of(room.training.details(), read.asOf)
            assertEquals(expected, read)
            assertEquals(listOf(90.0), read.sessions.flatMap { it.movements }.map { it.heaviest.weightKg })
            room.store.withhold(Deletion.Session(session.id))
            assertEquals(StatsProgress(read.asOf, emptyList()), room.store.progress)
            room.store.keepWithheld()
            assertEquals(expected, room.store.progress)
        }
    }

    @Test
    fun aConfirmedRenameIsTheCatalogsAndSurvivesTheNextRead() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertTrue(other.store.create("Bench", "barbell", "private-bench") is GymResult.Ok)
            other.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a"); room.pull(server); room.store.refreshEngine()
            val renamed = room.store.rename("private-bench", "Bench Press")
            val confirmed = room.training.catalogue().single { it.id == "private-bench" }
            assertEquals(GymResult.Ok(confirmed), renamed)
            assertEquals("Bench Press", confirmed.name)
            assertEquals(listOf(confirmed), room.store.catalog.filter { it.id == "private-bench" })
            room.store.connect(room.account())
            assertEquals(listOf(confirmed), room.store.catalog.filter { it.id == "private-bench" })
            room.sync(server); room.store.refreshEngine()
            assertEquals(listOf(confirmed), room.store.catalog.filter { it.id == "private-bench" })
        }
    }
}
