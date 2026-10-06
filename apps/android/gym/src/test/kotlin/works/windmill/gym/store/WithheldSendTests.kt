package works.windmill.gym.store

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.AskThread
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.TrainingSyncing

// A conversation delete the log has not answered yet: the door is held open so the store can be
// asked what it says about a delete already committed to.
private class HeldDelete(private val inner: FakeGymRest) : TrainingSyncing by inner {
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()

    override suspend fun deleteThread(id: String) {
        entered.complete(Unit)
        release.await()
        inner.deleteThread(id)
    }
}

// The undo window is the lifter's; the send is not. Once `settleWithheld` has committed a delete to
// the wire there is no taking it back, so the slot must be empty from that moment — a `keepWithheld`
// that answered true there would report a keep the log has already lost. A conversation is the
// delete that still crosses a wire; every training delete commits to the replica in one step.
class WithheldSendTests {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun testUndoAnswersFalseOnceTheDeleteIsOnTheWireAndTheConversationGoesAnyway() = runTest {
        val fake = FakeGymRest()
        fake.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val held = HeldDelete(fake)
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = held).use { room ->
            room.select("u1")

            room.store.withhold(Deletion.Thread("thr_1"))
            assertNotNull("the lifter's own window, before anything is told", room.store.holding)

            val settling = backgroundScope.launch { room.store.settleWithheld("thr_1") }
            held.entered.await()
            runCurrent()

            assertFalse("the row stops being the lifter's the moment the delete is committed to",
                room.store.withheld.single().takeable)
            assertNull("which is the key the room's transient hangs on, so the Undo goes down with it",
                room.store.holding)
            assertNull("and Undo cannot report a keep the log has already lost", room.store.keepWithheld())

            held.release.complete(Unit)
            settling.join()
            assertEquals(listOf("deleteThread"), fake.calls)
            assertEquals("the conversation is gone from the log", emptySet<String>(), fake.conversations.keys)
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
        }
    }

    @Test
    fun testASettleCancelledMidFlightIsStillOwedAndTheNextOneSendsIt() = runTest {
        val fake = FakeGymRest()
        fake.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val held = HeldDelete(fake)
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = held).use { room ->
            room.select("u1")

            room.store.withhold(Deletion.Thread("thr_1"))
            val settling = backgroundScope.launch { room.store.settleWithheld("thr_1") }
            held.entered.await()
            runCurrent()
            settling.cancel()
            runCurrent()

            assertTrue("the row is still owed, so a settle over the same row re-sends it",
                room.store.withheld.isNotEmpty())
            assertNull("and it is nobody's to take back any more", room.store.keepWithheld())

            held.release.complete(Unit)
            assertNull(room.store.settleWithheld("thr_1"))
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertEquals("the conversation is gone from the log", emptySet<String>(), fake.conversations.keys)
        }
    }
}
