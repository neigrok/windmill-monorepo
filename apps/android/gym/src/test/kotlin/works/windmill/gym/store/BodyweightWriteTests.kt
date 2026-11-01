package works.windmill.gym.store

import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.presentation.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class BodyweightWriteTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun transitionFenceBlocksQueuedHoldUndoAndReleaseWithoutLosingTheOffer() = runTest {
        var permitted = true
        EngineRoomFixture(tmp.newFolder(), backgroundScope, workoutAuthority = { permitted },
            writeAuthority = { permitted }).use { room ->
            room.select("a")
            val day = "2026-01-01"
            assertNull(room.store.bodyweight.weighIn(day, 82.0))
            val before = room.engine.snapshot()
            room.store.deletions.withhold(Deletion.Bodyweight(day))
            permitted = false
            runCurrent()
            assertEquals(before, room.engine.snapshot())
            assertTrue(room.store.held.withheld.isEmpty())
            permitted = true
            room.store.deletions.withhold(Deletion.Bodyweight(day))
            runCurrent()
            val offer = room.store.held.withheld.single()
            val held = room.engine.snapshot()
            permitted = false
            assertNull(room.store.deletions.keepWithheld())
            assertTrue(room.store.deletions.settleWithheld(offer.subjectId) is WriteFailure.Refused)
            assertEquals(held, room.engine.snapshot())
            assertEquals(listOf(offer), room.store.held.withheld)
            permitted = true
            assertEquals(offer, room.store.deletions.keepWithheld())
            assertEquals(listOf(day), room.training.weighins().map { it.dateLocal })
            assertTrue(room.store.held.withheld.isEmpty())
        }
    }

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
            assertNull(other.store.bodyweight.weighIn("2026-01-01", 82.0))
            other.sync(server)
            WeighIn("2026-01-01", 82.0, other.now)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertFalse(room.store.bodyweight.bodyweightRead)
            assertNull(room.store.bodyweight.weighIn("2026-01-02", 83.0))
            val saved = WeighIn("2026-01-02", 83.0, room.now)
            assertEquals(listOf(saved), room.store.bodyweight.drawn)
            room.pull(server); room.store.refreshEngine()
            assertEquals(listOf(older, saved), room.store.bodyweight.drawn)
            assertTrue(room.store.bodyweight.bodyweightRead)
        }
    }

    @Test
    fun aDeleteARewriteAndASecondDeleteLeaveTheDayDeletedHereAndOnTheLog() = runTest {
        val day = "2026-01-01"
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertNull(room.store.bodyweight.weighIn(day, 82.0))
            room.sync(server)
            room.store.deletions.withhold(Deletion.Bodyweight(day))
            runCurrent()
            assertNull(room.store.bodyweight.weighIn(day, 84.0))
            room.store.deletions.withhold(Deletion.Bodyweight(day))
            runCurrent()
            assertEquals(emptyList<WeighIn>(), room.store.bodyweight.drawn)
            room.sync(server); room.store.refreshEngine()
            assertEquals(emptyList<WeighIn>(), room.store.bodyweight.drawn)
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
            assertNull(room.store.bodyweight.weighIn("2026-01-01", 82.0))
            room.select("b")
            assertTrue(room.store.bodyweight.drawn.isEmpty())
            assertTrue(room.training.weighins().isEmpty())
            room.select("a")
            assertEquals(listOf("2026-01-01"), room.store.bodyweight.drawn.map { it.dateLocal })
        }
    }

    @Test
    fun anOfflineDeleteAndTheRewriteAfterItReachTheLogInOrder() = runTest {
        val day = "2026-01-01"
        val server = EngineRoomFixture.server()
        val expected = EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("a")
            assertNull(room.store.bodyweight.weighIn(day, 82.0))
            room.sync(server)
            room.store.deletions.withhold(Deletion.Bodyweight(day))
            runCurrent()
            assertNull(room.store.bodyweight.weighIn(day, 84.0))
            val expected = WeighIn(day, 84.0, room.now)
            assertEquals(listOf(expected), room.store.bodyweight.drawn)
            room.sync(server); room.store.refreshEngine()
            assertEquals(listOf(expected), room.store.bodyweight.drawn)
            expected
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            assertEquals(listOf(expected), other.training.weighins())
        }
    }
}
