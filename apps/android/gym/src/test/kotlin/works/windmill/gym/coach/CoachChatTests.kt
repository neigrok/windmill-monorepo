package works.windmill.gym.coach

import java.io.File
import java.io.IOException
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.spelled
import works.windmill.gym.string
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnTransport
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.text
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

// The chats a phone keeps beside the engine's records: each belongs to its owner, keeps its draft and place across a restart, and a turn's words reach only the seat that asked.
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CoachChatTests {
    @get:Rule val tmp = TemporaryFolder()

    private fun script(frames: String) = ScriptedTurns(Json.parse(frames).arr())

    private fun answers(text: String) = script("""[{"event":"text","data":{"delta":"$text"}},{"event":"done","data":{"state":"completed"}}]""")

    private val holdsOpen get() = script("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")

    // A server whose answer to the open waits for the test, so what it says arrives late.
    private class LateOpen(private val server: ScriptedTurns) : TurnTransport by server {
        val release = CompletableDeferred<Unit>()
        override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow {
            release.await()
            emitAll(server.open(open, seat))
        }
    }

    // Virtual time, one dispatcher: the test advances it, and closing the room ends its work.
    private fun TestScope.work() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)

    private fun TestScope.chats(disk: LocalCoach, telemetry: Telemetry = Telemetry.None, owner: () -> String? = { "alice" }) =
        CoachChats(owner, {}, null, null, disk, null, { AnonymousCoachAccess.Unavailable }, telemetry, work())

    private fun TestScope.room(server: TurnTransport, disk: LocalCoach = LocalCoach(File(tmp.newFolder(), LocalCoach.fileName)), telling: Telemetry = Telemetry.None,
        directory: File = tmp.newFolder(), snapshot: Json? = null) =
        EngineRoomFixture(directory, work(), snapshot = snapshot, telemetry = telling, localCoach = disk, coachServer = server)

    private fun EngineRoomFixture.messages(): List<CoachMessage> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachMessage, read.drawn(CoachMessage.type))
    }

    private fun EngineRoomFixture.threads(): List<CoachThread> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachThread, read.drawn(CoachThread.type))
    }

    @Test fun freshChatRetainsThePreviousDraftPhotoPositionAndSelectionAcrossRestart() = runTest {
        val file = File(tmp.root, "coach")
        val disk = LocalCoach(file)
        val store = chats(disk)
        val first = store.freshChat()
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        disk.savePhoto("alice", photo.id, byteArrayOf(1, 2, 3))
        store.saveDraft(first, CoachDraft("A meaningful draft", photo))
        store.keepPosition(first, 124, false)
        val second = store.freshChat()
        assertNotEquals(first, second)
        assertEquals(CoachDraft(), store.draft(second))
        assertEquals(listOf(first), store.history.map { it.id })
        store.selectChat(first)
        val restored = chats(LocalCoach(file))
        assertEquals(first, restored.selectedChatId)
        assertEquals(CoachDraft("A meaningful draft", photo), restored.draft(first))
        assertEquals(124, restored.chat(first)?.scroll)
        assertEquals(false, restored.chat(first)?.followEnd)
        assertArrayEquals(byteArrayOf(1, 2, 3), LocalCoach(file).photoFile("alice", photo.id).readBytes())
    }

    @Test fun aStableChatReopensOnlyItsOwnersExistingContentWithoutFreshOrHistoryEvents() = runTest {
        var owner: String? = "alice"
        val actions = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                if (name == "gym_action") properties["action"]?.let(actions::add)
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { error("Unexpected $operation") }
        }
        val file = File(tmp.root, "stable-chat")
        val store = chats(LocalCoach(file), telemetry) { owner }
        val id = store.freshChat("Original draft", id = "stable-share")
        store.keepPosition(id, 88, false)
        val original = store.chat(id)
        val other = store.freshChat("Other draft")
        val before = actions.toList()
        assertEquals(id, store.freshChat("Replacement must not overwrite", id))
        assertEquals(original, store.chat(id))
        assertEquals(CoachDraft("Original draft"), store.draft(id))
        assertEquals(CoachDraft("Other draft"), store.draft(other))
        assertEquals(id, store.selectedChatId)
        assertEquals(before, actions)
        val cold = chats(LocalCoach(file), telemetry) { owner }
        assertEquals(id, cold.selectedChatId)
        assertEquals(id, cold.freshChat("Ignored replacement", id))
        assertEquals(original, cold.chat(id))
        assertEquals(before, actions)
        owner = "bob"
        assertEquals(id, cold.freshChat("Bob draft", id))
        assertEquals(CoachDraft("Bob draft"), cold.draft(id))
        owner = "alice"
        assertEquals(CoachDraft("Original draft"), cold.draft(id))
        assertEquals(before + "fresh_entry", actions)
    }

    @Test fun aReplyArrivesInItsOriginWhileANewChatKeepsItsOwnDraft() = runTest {
        val release = CompletableDeferred<Unit>()
        val server = script("""[
            {"event":"text","data":{"delta":"First"}},
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"list_notes","input":{}}]}},
            {"await":"results","batch":1},
            {"event":"text","data":{"delta":" answer"}},
            {"event":"done","data":{"state":"completed"}}]""").apply { beforePost = { release.await() } }
        val file = File(tmp.newFolder(), LocalCoach.fileName)
        room(server, LocalCoach(file)).use { room ->
            val coach = room.store.coach
            val first = coach.freshChat()
            assertTrue(coach.send(first, "First question"))
            advanceUntilIdle()
            assertEquals(listOf("First question"), server.opened.map { it.question })
            val second = coach.freshChat()
            coach.saveDraft(second, CoachDraft("Second draft"))
            assertEquals(ConversationRow(first, Words.Plain("First question"), 0, answering = true), coach.pendingChat(second))
            assertTrue(coach.isAsking(first))
            release.complete(Unit)
            advanceUntilIdle()
            room.store.conversations.read()
            assertFalse(coach.isAsking(first))
            assertEquals(second, coach.selectedChatId)
            assertEquals(CoachDraft("Second draft"), coach.draft(second))
            assertEquals(emptyList<CoachExchange>(), coach.exchanges(second))
            assertEquals(room.threads().single().id.record.string, LocalCoach(file).chat(LocalCoach(file).anonymousOwner(), first)?.conversation)
            coach.selectChat(first)
            room.store.conversations.read()
            val answered = coach.exchanges(first).single()
            assertEquals("First question", answered.question)
            assertEquals("First answer", answered.answer?.text)
            assertEquals(MessageState.completed, answered.answer?.state)
        }
    }

    @Test fun eachOwnersChatsAndDraftsStayIsolatedAndThePhonesOwnerHoldsAcrossThem() = runTest {
        var owner: String? = null
        val file = File(tmp.root, "owners")
        val disk = LocalCoach(file)
        val store = chats(disk) { owner }
        val anonymous = store.freshChat()
        store.saveDraft(anonymous, CoachDraft("Anonymous draft"))
        val anonymousOwner = disk.anonymousOwner()
        owner = "alice"
        val alice = store.freshChat()
        store.saveDraft(alice, CoachDraft("Alice draft"))
        owner = "bob"
        assertEquals(emptyList<ConversationRow>(), store.history)
        assertEquals(CoachDraft(), store.draft(alice))
        assertNull(store.chat(anonymous))
        owner = null
        assertEquals(listOf(anonymous), store.history.map { it.id })
        assertEquals(anonymousOwner, LocalCoach(file).anonymousOwner())
        owner = "alice"
        assertEquals(listOf(alice), store.history.map { it.id })
        assertEquals(CoachDraft("Alice draft"), store.draft(alice))
    }

    @Test fun aChatsDraftAndItsConversationMergeIntoOneHistoryRow() = runTest {
        room(answers("Rest more")).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Am I overtraining?"))
            advanceUntilIdle()
            coach.saveDraft(chat, CoachDraft("Still typing"))
            room.store.conversations.watchHistory(true)
            room.store.conversations.read()
            assertEquals(listOf(ConversationRow(chat, Words.Plain("Am I overtraining?"), coach.chat(chat)!!.updatedAtMs, answerPreview = "Rest more")), coach.history)
            assertEquals(CoachDraft("Still typing"), coach.draft(chat))
        }
    }

    @Test fun aConversationsRowSurvivesARestartAndNeverAppearsForAnotherOwner() = runTest {
        val log = EngineRoomFixture.server()
        val directory = tmp.newFolder()
        val file = File(tmp.newFolder(), LocalCoach.fileName)
        val (snapshot, row) = room(answers("Completed answer"), LocalCoach(file), directory = directory).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            room.select("alice")
            room.sync(log)
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "First question"))
            advanceUntilIdle()
            conversations.watchHistory(true)
            conversations.read()
            val row = ConversationRow(chat, Words.Plain("First question"), room.messages().maxOf { it.at.ms }, answerPreview = "Completed answer")
            assertEquals(listOf(row), coach.history)
            room.select("bob")
            room.sync(log)
            conversations.read()
            assertEquals(emptyList<ConversationRow>(), coach.history)
            room.select(null)
            conversations.read()
            assertEquals(emptyList<ConversationRow>(), coach.history)
            room.select("alice")
            room.sync(log)
            conversations.read()
            assertEquals(listOf(row), coach.history)
            room.engine.snapshot() to row
        }
        room(script("[]"), LocalCoach(file), directory = directory, snapshot = snapshot).use { restarted ->
            restarted.selected = "alice"
            restarted.store.connect(restarted.account())
            restarted.store.conversations.watchHistory(true)
            restarted.store.conversations.read()
            assertEquals(listOf(row), restarted.store.coach.history)
        }
    }

    // No turn resumes per chat: the running one ended with the process, and the chat on screen is untouched by that.
    @Test fun aRestartEndsTheRunningTurnWithoutChangingTheSelectedDraft() = runTest {
        val directory = tmp.newFolder()
        val file = File(tmp.newFolder(), LocalCoach.fileName)
        val (snapshot, origin, selected) = room(holdsOpen, LocalCoach(file), directory = directory).use { room ->
            val coach = room.store.coach
            val origin = coach.freshChat()
            assertTrue(coach.send(origin, "Original question"))
            advanceUntilIdle()
            val selected = coach.freshChat()
            coach.saveDraft(selected, CoachDraft("Keep editing"))
            Triple(room.engine.snapshot(), origin, selected)
        }
        val server = script("[]")
        room(server, LocalCoach(file), directory = directory, snapshot = snapshot).use { restarted ->
            val coach = restarted.store.coach
            checkNotNull(restarted.coachTurns).start()
            advanceUntilIdle()
            assertEquals(emptyList<TurnOpen>(), server.opened)
            assertFalse(coach.isAsking(origin))
            assertEquals(selected, coach.selectedChatId)
            assertEquals(CoachDraft("Keep editing"), coach.draft(selected))
            coach.selectChat(origin)
            restarted.store.conversations.read()
            val ended = coach.exchanges(origin).single()
            assertEquals("Original question", ended.question)
            assertEquals(MessageState.interrupted, ended.answer?.state)
            assertEquals(CoachDraft(), coach.draft(origin))
        }
    }

    @Test fun aLateRefusalCannotRestoreADraftAfterItsOwnerWasErased() = runTest {
        val late = LateOpen(script("[]").apply { refuseOpen = TurnRefusal(429, "subject_exhausted", null) })
        val file = File(tmp.newFolder(), LocalCoach.fileName)
        val disk = LocalCoach(file)
        room(late, disk).use { room ->
            val coach = room.store.coach
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Alice question"))
            assertTrue(coach.send(chat, "Alice question"))
            advanceUntilIdle()
            assertEquals(CoachDraft(), coach.draft(chat))
            coach.eraseOwner("alice")
            disk.reopenVerifiedOwner("alice")
            val before = file.readText()
            late.release.complete(Unit)
            advanceUntilIdle()
            assertEquals(before, file.readText())
            assertEquals(emptyList<LocalChat>(), LocalCoach(file).chats("alice"))
            assertEquals(CoachDraft(), LocalCoach(file).draft("alice", chat))
            assertEquals(CoachDraft(), coach.draft(chat))
            assertNull(coach.chat(chat))
            assertEquals(emptyList<CoachThread>(), room.threads())
        }
    }

    @Test fun aThreadThisPhoneKeepsNothingBesideOpensAsAChatAndItsPlaceSurvivesARestart() = runTest {
        val directory = tmp.newFolder()
        val file = File(tmp.newFolder(), LocalCoach.fileName)
        val (snapshot, thread) = room(answers("Answer"), LocalCoach(file), directory = directory).use { room ->
            val turn = checkNotNull(checkNotNull(room.coachTurns).send("First question", null, null, anonymous = true))
            advanceUntilIdle()
            val thread = checkNotNull(turn.thread.record.string)
            val coach = room.store.coach
            coach.selectChat(thread)
            room.store.conversations.read()
            assertEquals(listOf("First question" to "Answer"), coach.exchanges(thread).map { it.question to it.answer?.text })
            coach.keepPosition(thread, 140, false)
            room.engine.snapshot() to thread
        }
        room(script("[]"), LocalCoach(file), directory = directory, snapshot = snapshot).use { restarted ->
            val coach = restarted.store.coach
            assertEquals(thread, coach.selectedChatId)
            assertEquals(thread, coach.chat(thread)?.conversation)
            assertEquals(140, coach.chat(thread)?.scroll)
            assertEquals(false, coach.chat(thread)?.followEnd)
            restarted.store.conversations.read()
            assertEquals(listOf("First question" to "Answer"), coach.exchanges(thread).map { it.question to it.answer?.text })
        }
    }

    @Test fun localDraftDeletionNeedsNoTurnHostAndAQueuedOwnerChangeRefusesIt() = runTest {
        var owner: String? = "alice"
        val store = chats(LocalCoach(File(tmp.root, "local-delete"))) { owner }
        val draft = store.freshChat("Draft to delete")
        assertEquals(GymResult.Ok(Unit), store.deleteThread(draft))
        assertNull(store.chat(draft))
        val retained = store.freshChat("Alice draft")
        val deletion = async(start = CoroutineStart.UNDISPATCHED) { store.deleteThread(retained) }
        owner = "bob"
        assertEquals("The account changed. Open this again.", ((deletion.await() as GymResult.Failed).why as WriteFailure.Refused).words.spelled())
        assertNull(store.chat(retained))
        owner = "alice"
        assertEquals(CoachDraft("Alice draft"), store.draft(retained))
    }

    @Test fun leavingTheScreenDoesNotCancelAnAdmittedDelete() = runTest {
        val telling = TellingRecorder()
        val file = File(tmp.newFolder(), LocalCoach.fileName)
        room(answers("Answer"), LocalCoach(file), telling).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Server question"))
            advanceUntilIdle()
            val screen = launch(start = CoroutineStart.UNDISPATCHED) { coach.deleteThread(chat) }
            screen.cancel()
            advanceUntilIdle()
            assertEquals(emptyList<CoachThread>(), room.threads())
            assertEquals(emptyList<CoachMessage>(), room.messages())
            assertNull(coach.chat(chat))
            assertEquals(emptyList<LocalChat>(), LocalCoach(file).chats(LocalCoach(file).anonymousOwner()))
            assertEquals(listOf(mapOf("screen" to "threads", "action" to "delete", "outcome" to "ok")), telling.named("gym_action").filter { it["action"] == "delete" })
            assertEquals(emptyList<Map<String, String>>(), telling.failures)
        }
    }

    @Test fun failedDraftPersistenceKeepsTheRecoverableTextAndReportsOneStaticBoundary() = runTest {
        var failWrites = false
        val telling = TellingRecorder()
        val disk = LocalCoach(File(tmp.root, "failed")) { file, text ->
            if (failWrites) throw IOException("private draft must not reach telemetry")
            AtomicDocument.write(file, text)
        }
        val store = chats(disk, telling)
        val id = store.freshChat()
        failWrites = true
        assertThrows(IOException::class.java) { store.saveDraft(id, CoachDraft("Recover me")) }
        assertEquals(CoachDraft("Recover me"), store.draft(id))
        assertEquals(listOf(mapOf("operation" to "gym.saveDraft")), telling.failures)
        failWrites = false
        store.saveDraft(id, CoachDraft("Recover me"))
        assertEquals(CoachDraft("Recover me"), LocalCoach(File(tmp.root, "failed")).draft("alice", id))
    }

    @Test fun aQueuedSendCannotOpenUnderTheNextAccount() = runTest {
        val server = script("[]")
        val log = EngineRoomFixture.server()
        room(server).use { room ->
            val coach = room.store.coach
            room.select("alice")
            room.sync(log)
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Alice private draft"))
            assertTrue(coach.send(chat, "Alice private draft"))
            room.select("bob")
            room.sync(log)
            advanceUntilIdle()
            assertEquals(emptyList<TurnOpen>(), server.opened)
            assertEquals(emptyList<CoachMessage>(), room.messages())
            assertNull(coach.chat(chat))
            assertEquals(CoachDraft(), coach.draft(chat))
            assertFalse(coach.isAsking(chat))
            room.select("alice")
            assertEquals(CoachDraft("Alice private draft"), coach.draft(chat))
            assertNull(coach.chat(chat)?.conversation)
            assertFalse(coach.isAsking(chat))
            assertEquals(emptyList<CoachMessage>(), room.messages())
        }
    }

    @Test fun aTurnLeftByASeatChangeNeverReachesTheNextAccountAndALaterStopGoesNowhere() = runTest {
        val server = holdsOpen
        val log = EngineRoomFixture.server()
        room(server).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            checkNotNull(room.coachTurns).start()
            room.select("alice")
            room.sync(log)
            advanceUntilIdle()
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Alice private question"))
            advanceUntilIdle()
            assertTrue(coach.isAsking(chat))
            room.select("bob")
            advanceUntilIdle()
            room.sync(log)
            conversations.watchHistory(true)
            conversations.read()
            assertFalse(coach.isAsking(chat))
            assertNull(coach.pendingChat(chat))
            assertEquals(emptyList<CoachExchange>(), coach.exchanges(chat))
            assertEquals(emptyList<ConversationRow>(), coach.history)
            assertNull(coach.refusal(chat))
            assertEquals(emptyList<CoachMessage>(), room.messages())
            assertEquals("the seat change told the server once", 1, server.stops)
            coach.stop()
            advanceUntilIdle()
            assertEquals(1, server.stops)
            room.select("alice")
            advanceUntilIdle()
            conversations.read()
            val left = coach.exchanges(chat).single()
            assertEquals("Alice private question", left.question)
            assertEquals(MessageState.interrupted, left.answer?.state)
        }
    }

    // The question is a message now, so a failed write of the chat beside it costs the phone its place and never the turn.
    @Test fun aFailedWriteOfTheChatsThreadReportsOnceAndKeepsTheAnswerAndItsOutcome() = runTest {
        var failNext = false
        val telling = TellingRecorder()
        val disk = LocalCoach(File(tmp.newFolder(), LocalCoach.fileName)) { file, text ->
            if (failNext) {
                failNext = false
                throw IOException("private local content")
            }
            AtomicDocument.write(file, text)
        }
        room(answers("Final answer"), disk, telling).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            failNext = true
            assertTrue(coach.send(chat, "Question"))
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(room.threads().single().id.record.string, coach.chat(chat)?.conversation)
            assertEquals(listOf("Question" to "Final answer"), coach.exchanges(chat).map { it.question to it.answer?.text })
            assertEquals(CoachDraft(), coach.draft(chat))
            assertEquals("Your conversation couldn’t be saved. Try again.", coach.failed(chat)?.let { string(it) })
            assertEquals(listOf(mapOf("operation" to "gym.saveConversation")), telling.failures)
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "answered")), telling.named("gym_ask_outcome").map { it - "duration_ms" })
        }
    }
}
