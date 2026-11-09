package works.windmill.gym.coach

import works.windmill.platform.i18n.text
import works.windmill.platform.i18n.Words
import works.windmill.gym.R
import androidx.test.core.app.ApplicationProvider
import androidx.annotation.StringRes
import android.content.Context
import org.robolectric.annotation.Config
import org.robolectric.RobolectricTestRunner
import org.junit.runner.RunWith
import java.io.File
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.presentation.Ids
import works.windmill.gym.presentation.ProposalSource
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.sync.core.Json

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ThreadTests {
    @get:Rule val folder = TemporaryFolder()

    private fun TestScope.room(server: ScriptedTurns) = EngineRoomFixture(folder.newFolder(), CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher),
        localCoach = LocalCoach(File(folder.newFolder(), LocalCoach.fileName)), coachServer = server)

    private fun answers(text: String) = ScriptedTurns(listOf(Json.objectOf("event" to Json.of("text"), "data" to Json.objectOf("delta" to Json.of(text))),
        Json.objectOf("event" to Json.of("done"), "data" to Json.objectOf("state" to Json.of("completed")))))

    @Test
    fun theTitleIsTheLiftersFirstMessageVerbatim() = runTest {
        val server = answers("Rest more")
        room(server).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            val asked = "bench STUCK at 82.5 💀 — what do you see??"
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "  $asked  "))
            advanceUntilIdle()
            server.rewind()
            assertTrue(coach.send(chat, "and my squat?"))
            advanceUntilIdle()
            conversations.watchHistory(true)
            conversations.read()
            assertEquals(listOf(asked), coach.history.map { it.named.spelled() })
            assertEquals(listOf(asked), conversations.threads.map { it.title })
        }
    }

    @Test
    fun aConversationsRowSaysItsNewestAnswerAndNeverRunsPastThePreviewBound() = runTest {
        val answer = "💪".repeat(241)
        room(answers(answer)).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Long?"))
            advanceUntilIdle()
            conversations.watchHistory(true)
            conversations.read()
            assertEquals(listOf("💪".repeat(240)), coach.history.map { it.answerPreview })
            assertEquals(listOf(false), coach.history.map { it.answering })
        }
    }

    @Test
    fun aConversationTheLogGaveNoInstantForIsDrawnWithoutADateRatherThanIn1970() {
        val august = 1_785_844_800_000L
        val row = { askedAtMs: Long -> ConversationRow("thr_1", Words.Plain("what's stalled?"), askedAtMs) }
        assertNull(row(0).day(august).spelled())
        assertEquals("Today", row(august).day(august).spelled())
        assertEquals("Yesterday", row(august).day(august + 86_400_000).spelled())
        assertEquals("Jul 14", row(august - 21L * 86_400_000).day(august).spelled())
    }

    @Test
    fun theHistoryScreenSpeaksInItsOwnWordsAndNeverOfAnythingUnread() {
        val everything = listOf(R.string.gym_coach_history, R.string.gym_coach_new_chat, R.string.gym_coach_conversation, R.string.gym_coach_threads_none).map(::string)
        assertEquals(listOf("History", "New chat", "Conversation", "No conversations yet.\nWhat you ask Coach on this phone is listed here."), everything)
        assertTrue("nothing on this screen speaks of unread anything",
            everything.none { it.contains("unread", ignoreCase = true) || it.contains("new message", ignoreCase = true) })
        assertTrue("no message of Coach's is named for an unread anything",
            R.string::class.java.fields.map { it.name }.filter { it.startsWith("gym_coach_") }.none { it.contains("unread", ignoreCase = true) })
    }

    // A delete is made on the list's row and its Undo says what it keeps.
    @Test
    fun nothingOnThisScreenLecturesAboutADeleteThatIsMadeSomewhereElse() {
        val everything = listOf(R.string.gym_coach_history, R.string.gym_coach_new_chat, R.string.gym_coach_conversation, R.string.gym_coach_threads_none).map(::string)
        assertTrue("no standing caption survives about deleting",
            everything.none { it.contains("Deleting", ignoreCase = true) })
        assertFalse("and nothing here claims finality the undo has made false",
            everything.any { it.contains("no undoing", ignoreCase = true) })
        assertTrue("the message that carried it is gone, not merely unused",
            R.string::class.java.fields.map { it.name }.filter { it.startsWith("gym_coach_") }.none { it.contains("delete_rule") })
    }

    @Test
    fun aMintedThreadIdIsOneTheLogWillTake() {
        val minted = Ids.thread()

        assertTrue(minted.startsWith("thr_"))
        assertTrue(minted.length in 8..64)
        assertTrue(minted.all { it.isLetterOrDigit() || it == '_' || it == '-' })
        assertTrue("a fresh id every time — a spent one would land in somebody's old evening",
            minted != Ids.thread())
    }

    @Test
    fun theDoorOntoAConversationIsDrawnOnlyWhereTheLogCarriesOne() {
        val fromAsk = ProposalSource(door = "ask", thread = "thr_1")
        val deleted = ProposalSource(door = "ask")
        val fromMcp = ProposalSource(door = "mcp", thread = "thr_1")

        assertEquals("thr_1", fromAsk.conversation)
        assertNull(deleted.conversation)
        assertNull("a thread id under another door is not a door this room opens", fromMcp.conversation)
        assertEquals("Coach", deleted.named.spelled())
    }
}

private fun Words?.spelled(): String? = this?.text(ApplicationProvider.getApplicationContext())

private fun string(@StringRes id: Int): String = ApplicationProvider.getApplicationContext<Context>().getString(id)
