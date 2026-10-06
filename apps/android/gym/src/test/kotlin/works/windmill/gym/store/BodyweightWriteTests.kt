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
            assertFalse(room.store.bodyweightLoading)
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
}
