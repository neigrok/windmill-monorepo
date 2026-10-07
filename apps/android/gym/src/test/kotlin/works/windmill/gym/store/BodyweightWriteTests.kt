package works.windmill.gym.store

import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class BodyweightWriteTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun aCorrectionUsesTheCommitMomentEvenWhenTheOldRecordedAtIsAhead() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            val day = "2026-01-01"
            val correctingAt = room.now
            room.now += 60_000
            assertEquals(WeighIn(day, 182.0, room.now), room.training.putBodyweight(day, 182.0))
            room.now = correctingAt
            assertEquals(WeighIn(day, 82.45, correctingAt), room.training.putBodyweight(day, 82.45))
        }
    }

    @Test
    fun aSaveBeforeTheFirstPullKeepsOlderAccountDatesComplete() = runTest {
        val server = EngineRoomFixture.server()
        val older = EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertNull(other.store.weighIn("2026-01-01", 82.0))
            other.sync(server)
            WeighIn("2026-01-01", 82.0, other.now)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertFalse(room.store.bodyweightRead)
            assertNull(room.store.weighIn("2026-01-02", 83.0))
            val saved = WeighIn("2026-01-02", 83.0, room.now)
            assertEquals(listOf(saved), room.store.bodyweight)
            room.pull(server); room.store.refreshEngine()
            assertEquals(listOf(older, saved), room.store.bodyweight)
            assertTrue(room.store.bodyweightRead)
        }
    }

    @Test
    fun aDeleteARewriteAndASecondDeleteLeaveTheDayDeletedHereAndOnTheLog() = runTest {
        val day = "2026-01-01"
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertNull(room.store.weighIn(day, 82.0))
            room.sync(server)
            room.store.deleteWeighIn(day)
            assertNull(room.store.weighIn(day, 84.0))
            room.store.deleteWeighIn(day)
            assertEquals(emptyList<WeighIn>(), room.store.bodyweight)
            room.sync(server); room.store.refreshEngine()
            assertEquals(emptyList<WeighIn>(), room.store.bodyweight)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertEquals(emptyList<WeighIn>(), other.training.weighins())
        }
    }

    @Test
    fun oneOwnersWeighInNeverPopulatesTheNextOwner() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertNull(room.store.weighIn("2026-01-01", 82.0))
            room.select("b")
            assertTrue(room.store.bodyweight.isEmpty())
            assertTrue(room.training.weighins().isEmpty())
            room.select("a")
            assertEquals(listOf("2026-01-01"), room.store.bodyweight.map { it.dateLocal })
        }
    }

    @Test
    fun anOfflineDeleteAndTheRewriteAfterItReachTheLogInOrder() = runTest {
        val day = "2026-01-01"
        val server = EngineRoomFixture.server()
        val expected = EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertNull(room.store.weighIn(day, 82.0))
            room.sync(server)
            room.store.deleteWeighIn(day)
            assertNull(room.store.weighIn(day, 84.0))
            val expected = WeighIn(day, 84.0, room.now)
            assertEquals(listOf(expected), room.store.bodyweight)
            room.sync(server); room.store.refreshEngine()
            assertEquals(listOf(expected), room.store.bodyweight)
            expected
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertEquals(listOf(expected), other.training.weighins())
        }
    }
}
