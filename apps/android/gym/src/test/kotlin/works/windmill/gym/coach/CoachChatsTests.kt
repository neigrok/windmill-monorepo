package works.windmill.gym.coach

import works.windmill.gym.spelled
import works.windmill.platform.i18n.text
import works.windmill.platform.i18n.Words
import works.windmill.gym.R
import android.graphics.Bitmap
import android.os.Looper
import android.graphics.Color
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.agent.TurnConnectionLost
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnTransport
import works.windmill.gym.coach.onboarding.CoachOnboardingSeat
import works.windmill.gym.coach.onboarding.CoachRoutineImports
import works.windmill.gym.coach.turn.CoachTurnFault
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.domain.coach.OpenTurnOnce
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.TrainingSeat
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.storage.AtomicDocument
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.EngineClock
import works.windmill.sync.engine.EngineError
import works.windmill.sync.engine.Reply
import works.windmill.sync.engine.SessionTokens
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.SyncTransport
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// The room's chats on a real engine and a scripted server: a draft becomes a turn and returns when the server refuses it, a transcript reads from the records, a repeated share opens one turn, and an earlier version's archive leaves nothing but what the composer still needs.
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CoachChatsTests {
    @get:Rule val folder = TemporaryFolder()

    private val createRoutine = """{"id":"rt_00000009","name":"Day 1","position":0,"entries":[{"exerciseId":"bench-press"}]}"""

    private fun script(vararg frames: String) = ScriptedTurns(frames.flatMap { Json.parse(it).arr() })

    private val answersOneCreate get() = script("""[
        {"event":"text","data":{"delta":"On it."}},
        {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"create_routine","input":$createRoutine}]}},
        {"await":"results","batch":1},
        {"event":"text","data":{"delta":" Done."}},
        {"event":"done","data":{"state":"completed"}}]""")

    private val holdsOpen get() = script("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")

    private fun answers(text: String) = script("""[{"event":"text","data":{"delta":"$text"}},{"event":"done","data":{"state":"completed"}}]""")

    // Virtual time, one dispatcher: the test advances it, and closing the room ends its work.
    private fun TestScope.work() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)

    private fun TestScope.room(server: TurnTransport, file: File = File(folder.newFolder(), LocalCoach.fileName), telling: TellingRecorder = TellingRecorder()) =
        EngineRoomFixture(folder.newFolder(), work(), telemetry = telling, localCoach = LocalCoach(file), coachServer = server)

    private fun EngineRoomFixture.thread(chat: String): String = checkNotNull(store.coach.chat(chat)?.conversation) 

    private fun EngineRoomFixture.messages(): List<CoachMessage> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachMessage, read.drawn(CoachMessage.type))
    }

    private fun EngineRoomFixture.threads(): List<CoachThread> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachThread, read.drawn(CoachThread.type))
    }

    @Test fun aSentDraftBecomesATurnAndTheTranscriptReadsWhatItsRecordsHold() = runTest {
        room(answersOneCreate).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Make me a routine"))
            assertTrue(coach.send(chat, "Make me a routine"))
            assertTrue(coach.isAsking(chat))
            assertEquals(listOf("Make me a routine"), coach.exchanges(chat).map { it.question })
            assertTrue(coach.exchanges(chat).single().sending)
            advanceUntilIdle()
            room.store.conversations.read()
            val exchange = coach.exchanges(chat).single()
            val reply = checkNotNull(exchange.answer)
            assertEquals("Make me a routine", exchange.question)
            assertFalse(exchange.sending)
            assertEquals("On it. Done.", reply.text)
            assertEquals(MessageState.completed, reply.state)
            assertFalse(reply.truncated)
            assertTrue(reply.onThisPhone)
            assertEquals(AbilityCall.Outcome.Ok, reply.calls.single { it.name == "create_routine" }.outcome)
            assertEquals(listOf("list_sessions", "list_notes", "list_exercises", "list_routines", "create_routine"), reply.calls.map { it.name })
            assertEquals(reply.calls.mapNotNull { works.windmill.gym.coach.turn.TurnPhone.catalog().ability(it.name)?.phrase }.joinToString(" · "), reply.stepLine)
            assertEquals(CoachReceipt(ReadTally(), listOf(RecordRef(Gym.Types.routine, RecordID("rt_00000009")))), reply.receipt)
            assertEquals(listOf(CreatedRoutine("rt_00000009", "Day 1", movements = 1)), reply.routines)
            assertEquals("a real turn's context reads are the phone's own", "Read nothing from your log", reply.readLine.spelled())
            assertEquals("the program it read before making Day 1 did not hold Day 1", listOf("Read your recent workouts" to null, "Read your notes" to null, "Read your movement list" to null, "Read your program" to null, "Created a routine" to "Day 1"),
                room.store.conversations.withDetails(reply.id, reply.calls).map { it.title.spelled() to it.detail.spelled() })
            assertEquals(CoachDraft(), coach.draft(chat))
            assertFalse(coach.isAsking(chat))
            assertEquals(room.threads().single().id.record.string, room.thread(chat))
        }
    }

    @Test fun aRunningAnswerReadsAsItStandsAndStopEndsItThroughTheRecord() = runTest {
        room(holdsOpen).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceUntilIdle()
            room.store.conversations.read()
            val running = checkNotNull(coach.exchanges(chat).single().answer)
            assertEquals(MessageState.running, running.state)
            assertTrue(running.onThisPhone)
            assertEquals("Reading", running.text)
            assertTrue(coach.isAsking(chat))
            coach.stop()
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(MessageState.stopped, coach.exchanges(chat).single().answer?.state)
            assertFalse(coach.isAsking(chat))
        }
    }

    private fun jpeg(): ByteArray {
        val bitmap = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
    }

    private suspend fun EngineRoomFixture.withDraftPhoto(chat: String, text: String): Pair<CoachAttachment, ByteArray> {
        val bytes = jpeg()
        val photo = CoachAttachment("photo-origin", "image/jpeg", 40, 30, bytes.size.toLong())
        store.coach.importPhoto(chat) { photo to bytes }
        store.coach.saveDraft(chat, CoachDraft(text, photo))
        return photo to bytes
    }

    @Test fun aRefusalBeforeTheStreamTakesTheTurnBackAndReturnsTheQuestionAndItsPhoto() = runTest {
        val server = script("[]").apply { refuseOpen = TurnRefusal(429, "subject_exhausted", null) }
        val file = File(folder.newFolder(), LocalCoach.fileName)
        room(server, file).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            val (photo, bytes) = room.withDraftPhoto(chat, "Ask this")
            advanceUntilIdle()
            assertTrue(coach.send(chat, "Ask this", photo))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Allowance("subject_exhausted"), coach.refusal(chat))
            assertEquals(CoachDraft("Ask this", photo), coach.draft(chat))
            assertEquals(CoachDraft("Ask this", photo), LocalCoach(file).draft(LocalCoach(file).anonymousOwner(), chat))
            assertArrayEquals(bytes, coach.photo(photo.id))
            assertNull(coach.chat(chat)?.conversation)
            assertEquals(emptyList<CoachThread>(), room.threads())
            assertEquals(emptyList<CoachMessage>(), room.messages())
            assertEquals(emptyList<CoachExchange>(), coach.exchanges(chat))
            assertEquals("the turn's own copy went with it", emptySet<String>(), room.coachTurns?.pictures?.held())
        }
    }

    @Test fun aSentPictureReadsAsHeldOnThisPhoneAndItsDraftCopyGoes() = runTest {
        room(answers("Fine")).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            val (photo, bytes) = room.withDraftPhoto(chat, "Look")
            advanceUntilIdle()
            assertTrue(coach.send(chat, "Look", photo))
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(listOf(SentPicture(photo.copy(mediaType = "image/jpeg"), onThisPhone = true)), coach.exchanges(chat).single().pictures)
            assertEquals(CoachDraft(), coach.draft(chat))
            assertArrayEquals("the original stays with the turn's files", bytes, coach.photo(photo.id))
        }
    }

    @Test fun aSendThePhoneItselfRefusesKeepsTheDraftAndWritesNothing() = runTest {
        room(script("[]")).use { room ->
            val coach = room.store.coach
            room.select("account-1")
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Too soon"))
            assertTrue(coach.send(chat, "Too soon"))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.LogArriving, coach.refusal(chat))
            assertEquals(CoachDraft("Too soon"), coach.draft(chat))
            assertNull(coach.chat(chat)?.conversation)
            assertEquals(emptyList<CoachMessage>(), room.messages())
            val other = coach.freshChat()
            assertNull("a refusal that is no cap stays on the chat that met it", coach.refusal(other))
        }
    }

    @Test fun aSecondQuestionContinuesTheThreadTheFirstOpened() = runTest {
        val server = answers("First answer")
        room(server).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "First"))
            advanceUntilIdle()
            val thread = room.thread(chat)
            server.rewind()
            assertTrue(coach.send(chat, "Second"))
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(thread, room.thread(chat))
            assertEquals(1, room.threads().size)
            assertEquals(listOf("First", "Second"), coach.exchanges(chat).map { it.question })
            assertEquals(listOf("First answer", "First answer"), coach.exchanges(chat).map { it.answer?.text })
        }
    }

    // 08.40 at a finish share: the chat it opened stands empty over the kept question, which the next Send asks.
    @Test fun aShareBeforeTheFirstPullIsRefusedAndOnlyItsQuestionStaysForTheNextSend() = runTest {
        val server = answers("Looks strong.")
        room(server).use { room ->
            val coach = room.store.coach
            room.select("account-1")
            val request = "share-request"
            val chat = coach.freshChat("Check my last workout.", id = request)
            assertTrue(coach.send(chat, "Check my last workout.", once = request))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.LogArriving, coach.refusal(chat))
            assertEquals(CoachDraft("Check my last workout."), coach.draft(chat))
            assertEquals(emptyList<CoachExchange>(), coach.exchanges(chat))
            assertNull(coach.chat(chat)?.conversation)
            assertEquals(emptyList<TurnOpen>(), server.opened)
            room.sync(EngineRoomFixture.server())
            assertTrue(coach.send(chat, "Check my last workout."))
            advanceUntilIdle()
            assertEquals(listOf("Check my last workout."), server.opened.map { it.question })
            assertNull(coach.refusal(chat))
        }
    }

    @Test fun aRepeatedShareOpensOneTurnAndADeathBeforeItsMappingFindsTheFirstAgain() = runTest {
        val server = answers("Looks strong")
        val file = File(folder.newFolder(), LocalCoach.fileName)
        room(server, file).use { room ->
            val coach = room.store.coach
            val request = "thr_share00000001"
            val chat = coach.freshChat("Check my last workout.", id = request)
            assertTrue(coach.send(chat, "Check my last workout.", once = request))
            advanceUntilIdle()
            val thread = room.thread(chat)
            assertEquals(listOf(thread), room.threads().map { it.id.record.string })
            assertEquals(CoachDraft(), coach.draft(chat))
            assertTrue("the chat already holds its turn", coach.send(chat, "Check my last workout.", once = request))
            advanceUntilIdle()
            assertEquals(1, room.threads().size)
            assertEquals(1, server.opened.size)

            // The process died after the turn committed and before the chat held its thread: the chat knows nothing, and the row answers.
            val lost = "thr_lostmapping01"
            val lostChat = coach.freshChat("Check my last workout.", id = lost)
            server.rewind()
            val first = checkNotNull(room.coachTurns?.send("Check my last workout.", null, null, anonymous = true, once = lost))
            advanceUntilIdle()
            assertNull(coach.chat(lostChat)?.conversation)
            assertEquals(2, room.threads().size)
            assertEquals(2, server.opened.size)
            assertTrue(coach.send(lostChat, "Check my last workout.", once = lost))
            advanceUntilIdle()
            assertEquals(first.thread.record.string, room.thread(lostChat))
            assertEquals(2, room.threads().size)
            assertEquals("the second asking drove no second turn", 2, server.opened.size)
            assertEquals(CoachDraft(), coach.draft(lostChat))
            assertEquals(lost, room.engine.read(ScopeRef(Gym.scope)) { it.device(OpenTurnOnce.key) }?.member("once")?.str())
        }
    }

    @Test fun aShareTheServerWithdrewOpensAgain() = runTest {
        val server = answers("Looks strong").apply { refuseOpen = TurnRefusal(503, "coach-vendor-error", null) }
        room(server).use { room ->
            val coach = room.store.coach
            val request = "thr_withdrawn0001"
            val chat = coach.freshChat("Check my last workout.", id = request)
            assertTrue(coach.send(chat, "Check my last workout.", once = request))
            advanceUntilIdle()
            assertEquals(CoachDraft("Check my last workout."), coach.draft(chat))
            assertNull(coach.chat(chat)?.conversation)
            server.refuseOpen = null
            assertTrue(coach.send(chat, "Check my last workout.", once = request))
            advanceUntilIdle()
            assertEquals(1, room.threads().size)
            assertNotNull(coach.chat(chat)?.conversation)
        }
    }

    // The engine flips to the next account before the seat hears of it: a question asked under the first stays its own.
    @Test fun aQuestionAskedAsTheReplicaChangesOpensOnNoOtherAccount() = runTest {
        val server = answers("Private answer")
        room(server).use { room ->
            val coach = room.store.coach
            room.select("account-1")
            room.sync(EngineRoomFixture.server())
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Alice's question"))
            assertTrue(room.engine.signOut("keep").member("complete").bool())
            assertTrue(room.engine.signIn("account-2", mapOf("gym" to true), serverSchema = SyncSchema.registry.version).member("complete").bool())
            room.selected = "account-2"
            room.sync(EngineRoomFixture.server())
            assertTrue(coach.send(chat, "Alice's question"))
            advanceUntilIdle()
            assertEquals(emptyList<CoachMessage>(), room.messages())
            assertEquals(emptyList<CoachThread>(), room.threads())
            assertEquals(emptyList<TurnOpen>(), server.opened)
            assertTrue(coach.accountChanging)
            assertNull(coach.fault(chat))
            assertEquals(CoachDraft("Alice's question"), coach.draft(chat))
            assertNull(coach.chat(chat)?.conversation)
        }
    }

    // A sign-out with a turn running or a send refused: what the room said goes with the seat it said it to.
    @Test fun whatTheRoomSaidGoesWithItsSeat() = runTest {
        room(holdsOpen).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            assertTrue(coach.send(coach.freshChat(), "First"))
            advanceUntilIdle()
            val second = coach.freshChat()
            coach.saveDraft(second, CoachDraft("Second"))
            assertTrue(coach.send(second, "Second"))
            advanceUntilIdle()
            assertEquals(CoachTurnFault.busy, coach.fault(second))

            room.select(null)
            advanceUntilIdle()
            assertNull(coach.fault(second))
            assertFalse(coach.accountChanging)
            assertFalse(coach.sendHeld)
            assertNull(coach.failed(second))
        }
    }

    // StateFlow says nothing of a value it already holds, so the next seat's Offline is its own news.
    @Test fun theSameRefusalUnderTheNextSeatIsSaid() = runTest {
        room(answers("Hi")).use { room ->
            val coach = room.store.coach
            val runtime = SyncRuntime(room.engine, object : SyncTransport {
                override suspend fun hello(token: String?) = Reply.Unreachable
                override suspend fun push(request: Json, token: String) = Reply.Unreachable
                override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
                override suspend fun openLive(token: String) = Reply.Unreachable
            }, object : SessionTokens {
                override fun token(account: String) = null
                override fun save(account: String, token: String) = Unit
                override fun delete(account: String) = Unit
                override fun accounts() = emptySet<String>()
            }, "test")
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            runtime.connectivity(false)
            withContext(Dispatchers.Default) { withTimeout(30_000) { room.engine.status.state.first { !it.online } } }
            val aliceChat = coach.freshChat()
            assertTrue(coach.send(aliceChat, "Q"))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Offline, coach.refusal(aliceChat))

            room.select(null)
            advanceUntilIdle()
            withContext(Dispatchers.Default) { withTimeout(30_000) { room.engine.status.state.first { !it.online } } }
            val anonChat = coach.freshChat()
            assertNull(coach.refusal(anonChat))
            assertTrue(coach.send(anonChat, "Q2"))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Offline, coach.refusal(anonChat))
            runtime.close()
        }
    }

    // A send the last seat left on its way answers after the seat has gone: its sentence stays with that seat, and Send with this one.
    @Test fun anAnswerToAnEarlierSeatsSendStandsOnNoOtherSeat() = runTest {
        room(answers("Hi")).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            val turns = checkNotNull(room.coachTurns)
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "First"))
            advanceUntilIdle()
            room.select(null)
            advanceUntilIdle()

            assertNull(turns.send("Racing", null, null, anonymous = false, on = "a-replica-gone"))
            advanceUntilIdle()
            assertEquals(CoachTurnFault.accountChanging, turns.fault.value)
            assertFalse(coach.accountChanging)
            assertFalse(coach.sendHeld)
            assertNull(coach.fault(chat))
        }
    }

    // A photo gone from chat A is chat A's line: a chat opened from History asked nothing, and A says it again on the way back.
    @Test fun aStoreFailureStaysOnTheChatThatMetIt() = runTest {
        room(script("[]")).use { room ->
            val coach = room.store.coach
            val first = coach.freshChat()
            val second = coach.freshChat()
            coach.selectChat(first)
            assertTrue(coach.send(first, "With a picture that is gone", CoachAttachment("photo0001", "image/jpeg", 2, 2, 3)))
            advanceUntilIdle()
            assertEquals(CoachTurnFault.pictureUnavailable.said, coach.failed(first))
            assertNull(coach.failed(second))

            coach.selectChat(second)
            advanceUntilIdle()
            assertNull(coach.failed(second))
            coach.selectChat(first)
            assertEquals(CoachTurnFault.pictureUnavailable.said, coach.failed(first))
        }
    }

    // A stop that went unheard is the band of the chat that stopped, past the turn that met it. Being busy is the one turn, and stands on every chat. A second chat told it is busy leaves the turn's end with the chat that asked.
    @Test fun aFaultStaysOnTheChatThatMetItAndBusyStandsOnEach() = runTest {
        val server = object : TurnTransport by script("""[{"event":"text","data":{"delta":"Par"}},{"await":"stop"}]""") {
            override suspend fun stop(turnId: String, seat: TurnSeat) { throw TurnConnectionLost(null) }
        }
        room(server).use { room ->
            val coach = room.store.coach
            val first = coach.freshChat()
            val second = coach.freshChat()
            assertTrue(coach.send(first, "Question"))
            advanceTimeBy(1_000)
            assertTrue(coach.send(second, "Another"))
            advanceTimeBy(1_000)
            assertEquals(CoachTurnFault.busy, coach.fault(first))
            assertEquals(CoachTurnFault.busy, coach.fault(second))

            coach.stop()
            advanceUntilIdle()
            assertEquals(CoachTurnFault.stoppedOffline, coach.fault(first))
            assertNull(coach.fault(second))
            assertNull(coach.fault("a-chat-opened-from-history"))
        }
    }

    // Chat A was refused. Chat B's send never reached a server, so B says its own failure and A's refusal stays with A; B's own refusal, the same one, is B's.
    @Test fun aRefusalStaysOnTheChatThatMetIt() = runTest {
        val server = answers("Hi")
        server.refuseOpen = TurnRefusal(503, "coach-busy", null)
        room(server).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            val first = coach.freshChat()
            assertTrue(coach.send(first, "Question"))
            advanceUntilIdle()
            val said = CoachTurnRefusal.Unanswered
            assertEquals(said, coach.refusal(first))

            val second = coach.freshChat()
            assertNull(coach.refusal(second))
            assertTrue(coach.send(second, "Another", CoachAttachment("attachment-missing", "image/jpeg", 8, 8, 3)))
            advanceUntilIdle()
            assertEquals(CoachTurnFault.pictureUnavailable.said, coach.failed(second))
            assertNull(coach.refusal(second))
            assertEquals(said, coach.refusal(first))

            assertTrue(coach.send(second, "Another"))
            advanceUntilIdle()
            assertEquals(said, coach.refusal(second))
            assertNull(coach.refusal(first))
        }
    }

    private class Unreachable : SyncTransport {
        override suspend fun hello(token: String?) = Reply.Unreachable
        override suspend fun push(request: Json, token: String) = Reply.Unreachable
        override suspend fun pull(request: Json, token: String?) = Reply.Unreachable
        override suspend fun openLive(token: String) = Reply.Unreachable
    }

    private class HeldTokens : SessionTokens {
        val values = mutableMapOf<String, String>()
        override fun token(account: String) = values[account]
        override fun save(account: String, token: String) { values[account] = token }
        override fun delete(account: String) { values.remove(account) }
        override fun accounts() = values.keys.toSet()
    }

    // A sign-in that lost its hello stays pending for its retry and asks nothing: the seat in hand is settled, and Send is the lifter's.
    @Test fun aSignInThatLostItsHelloHoldsNothingBack() = runTest {
        val server = answers("Hi")
        room(server).use { room ->
            room.store.connect(room.account(null))
            val coach = room.store.coach
            val tokens = HeldTokens()
            SyncRuntime(room.engine, Unreachable(), tokens, "test", activityAllowed = { false }).use { runtime ->
                assertEquals(EngineError.Code.unreachable, (runCatching { runtime.signIn("alice", "token-alice") }.exceptionOrNull() as EngineError).code)
            }
            assertEquals(Json.of("alice"), room.engine.snapshot().member("meta")["pendingSignIn"]?.get("account"))
            assertFalse(room.engine.signInAsking())
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceUntilIdle()
            assertFalse(coach.accountChanging)
            assertFalse(coach.sendHeld)
            assertEquals(listOf("Question"), server.opened.map { it.question })
        }
    }

    // A sign-in asking its decision holds Send; when it ends with no seat change, Send comes back on its own: nothing taps, retries or sweeps.
    @Test fun sendHeldByASignInsDecisionComesBackWhenTheDecisionEnds() = runTest {
        val server = answers("Hi")
        room(server).use { room ->
            room.store.connect(room.account(null))
            room.coachTurns?.start()
            advanceUntilIdle()
            val coach = room.store.coach
            assertTrue(coach.send(coach.freshChat(), "First"))
            advanceUntilIdle()
            val tokens = HeldTokens().apply { save("alice", "token-alice") }
            assertFalse(room.engine.signIn("alice", mapOf("gym" to true)).member("complete").bool())
            assertTrue(room.engine.signInAsking())

            val waiting = coach.freshChat()
            coach.saveDraft(waiting, CoachDraft("Second"))
            assertTrue(coach.send(waiting, "Second"))
            advanceUntilIdle()
            assertTrue(coach.accountChanging)
            assertTrue(coach.sendHeld)
            assertEquals(CoachDraft("Second"), coach.draft(waiting))

            SyncRuntime(room.engine, Unreachable(), tokens, "test", activityAllowed = { false }).use { runtime ->
                assertFalse(runtime.abandonSignIn("alice", "token-alice"))
            }
            advanceUntilIdle()
            assertFalse(room.engine.signInAsking())
            assertFalse(coach.accountChanging)
            assertFalse(coach.sendHeld)
        }
    }

    // Every send the room takes up ends in one `gym_ask_outcome`, the ones this phone holds back among them.
    @Test fun aSendThePhoneHoldsBackEndsInItsOneOutcome() = runTest {
        val telling = TellingRecorder()
        val file = File(folder.newFolder(), LocalCoach.fileName)
        room(holdsOpen, file, telling).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            assertTrue(coach.send(coach.freshChat(), "First"))
            advanceUntilIdle()
            assertEquals(emptyList<Map<String, String>>(), telling.named("gym_ask_outcome"))

            val second = coach.freshChat()
            coach.saveDraft(second, CoachDraft("Second"))
            assertTrue(coach.send(second, "Second"))
            advanceUntilIdle()
            assertEquals(CoachTurnFault.busy, coach.fault(second))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "refused")), telling.named("gym_ask_outcome"))

            val photo = CoachAttachment("photo-never-written", "image/jpeg", 1, 1, 1)
            val third = coach.freshChat()
            assertTrue(coach.send(third, "Third", photo))
            advanceUntilIdle()
            assertEquals(CoachTurnFault.pictureUnavailable.said, coach.failed(third))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "refused"), mapOf("screen" to "coach", "outcome" to "failed")), telling.named("gym_ask_outcome"))
        }
    }

    @Test fun aPastedLoneSurrogateSendsWithItsReplacementAndNothingThrows() = runTest {
        val server = answers("Noted")
        val telling = TellingRecorder()
        room(server, telling = telling).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Bench \uD83D press \uDE00 and \uD83D\uDE00"))
            assertTrue(coach.send(chat, "Bench \uD83D press \uDE00 and \uD83D\uDE00"))
            advanceUntilIdle()
            assertEquals(listOf("Bench \uFFFD press \uFFFD and \uD83D\uDE00"), server.opened.map { it.question })
            assertEquals(listOf("Bench \uFFFD press \uFFFD and \uD83D\uDE00"), room.threads().map { it.title })
            assertNull(coach.fault(chat))
            assertFalse(coach.accountChanging)
            assertEquals(emptyList<Map<String, String>>(), telling.failures)
        }
    }

    @Test fun aQuestionPastItsBoundSaysHowFarAsItIsTypedAndWithinItSaysNothing() = runTest {
        room(answers("Noted")).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("x".repeat(9_400)))
            assertEquals(CoachTurnRefusal.TooLong(1_400), coach.tooLong(chat))
            coach.saveDraft(chat, CoachDraft("é".repeat(4_001)))
            assertEquals(CoachTurnRefusal.TooLong(2), coach.tooLong(chat))
            coach.saveDraft(chat, CoachDraft("  " + "x".repeat(8_000) + "  "))
            assertNull(coach.tooLong(chat))
        }
    }

    @Test fun aConversationWhoseThreadWentStaysGoneWhenThisPhoneCannotClearItsDraft() = runTest {
        var failing = false
        val telling = TellingRecorder()
        val disk = LocalCoach(File(folder.newFolder(), LocalCoach.fileName)) { file, text ->
            if (failing) throw IOException("private local content")
            works.windmill.platform.storage.AtomicDocument.write(file, text)
        }
        EngineRoomFixture(folder.newFolder(), work(), telemetry = telling, localCoach = disk, coachServer = answers("Fine")).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceUntilIdle()
            failing = true
            assertEquals(GymResult.Ok(Unit), coach.deleteThread(chat))
            assertEquals(emptyList<CoachThread>(), room.threads())
            assertNull(coach.chat(chat))
            assertEquals(listOf(mapOf("operation" to "gym.deleteThread")), telling.failures)
            assertEquals(listOf(mapOf("screen" to "threads", "action" to "delete", "outcome" to "ok")), telling.named("gym_action").filter { it["action"] == "delete" })
        }
    }

    @Test fun anOverLengthQuestionIsNoSendAndAnEmptyOneNeither() = runTest {
        room(script("[]")).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertFalse(coach.send(chat, "é".repeat(4_001)))
            assertFalse(coach.send(chat, "   "))
            assertNull(CoachTurnRefusal.TooLong.of("é".repeat(4_000)))
            assertEquals(CoachTurnRefusal.TooLong(2), CoachTurnRefusal.TooLong.of("é".repeat(4_001)))
            advanceUntilIdle()
            assertEquals(emptyList<CoachMessage>(), room.messages())
        }
    }

    @Test fun historyListsTheEngineThreadsBesideChatsThatHoldADraftAndDeleteTakesThemWhole() = runTest {
        val server = answers("Rest more")
        room(server).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            assertNull(conversations.rows)
            val asked = coach.freshChat()
            assertTrue(coach.send(asked, "Am I overtraining?"))
            advanceUntilIdle()
            val drafted = coach.freshChat()
            coach.saveDraft(drafted, CoachDraft("Half a thought"))
            coach.freshChat()
            conversations.watchHistory(true)
            conversations.read()
            assertEquals(listOf(
                ConversationRow(drafted, Words.Plain("Half a thought"), coach.chat(drafted)!!.updatedAtMs),
                ConversationRow(asked, Words.Plain("Am I overtraining?"), room.messages().maxOf { it.at.ms }, answerPreview = "Rest more"),
            ).sortedByDescending { it.askedAtMs }, coach.history)
            assertTrue(coach.hasConversations)

            assertTrue(coach.deleteThread(asked) is works.windmill.gym.store.GymResult.Ok)
            advanceUntilIdle()
            assertEquals(emptyList<CoachThread>(), room.threads())
            assertEquals(emptyList<CoachMessage>(), room.messages())
            assertEquals(listOf(drafted), coach.history.map { it.id })
            assertTrue(coach.deleteThread(drafted) is works.windmill.gym.store.GymResult.Ok)
            assertEquals(emptyList<ConversationRow>(), coach.history)
            assertEquals(CoachDraft(), coach.draft(drafted))
        }
    }

    // Spaces alone hold nothing: they make no row and date none, and a picture beside them is the row's own, under its one name.
    @Test fun aDraftOfOnlySpacesMakesNoRowInHistoryAndDatesNone() = runTest {
        room(answers("Rest more")).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            val conversations = room.store.conversations
            conversations.watchHistory(true)
            conversations.read()

            val spaces = coach.freshChat()
            for (text in listOf(" ", "   ", "\n\t ")) {
                coach.saveDraft(spaces, CoachDraft(text))
                assertEquals(emptyList<ConversationRow>(), coach.history)
                assertFalse(coach.hasConversations)
            }

            val (photo, _) = room.withDraftPhoto(spaces, " ")
            assertEquals(listOf(ConversationRow(spaces, Words.Plain("Photo"), coach.chat(spaces)!!.updatedAtMs)),
                coach.history.map { it.copy(named = Words.Plain(it.named.spelled()!!)) })
            coach.saveDraft(spaces, CoachDraft(" ", photo))
            assertEquals("Photo", coach.history.single().named.spelled())
            coach.saveDraft(spaces, CoachDraft())

            val asked = coach.freshChat()
            assertTrue(coach.send(asked, "Am I overtraining?"))
            advanceUntilIdle()
            conversations.read()
            val saidAt = room.messages().maxOf { it.at.ms }
            room.now += 60_000
            coach.saveDraft(asked, CoachDraft(" "))
            assertEquals(listOf(ConversationRow(asked, Words.Plain("Am I overtraining?"), saidAt, answerPreview = "Rest more")), coach.history)
            coach.saveDraft(asked, CoachDraft("A real thought"))
            assertEquals(listOf(ConversationRow(asked, Words.Plain("Am I overtraining?"), coach.chat(asked)!!.updatedAtMs, answerPreview = "Rest more")), coach.history)
        }
    }

    @Test fun aRunningTurnReadsAsAnsweringAndItsConversationStays() = runTest {
        room(holdsOpen).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceUntilIdle()
            room.store.conversations.watchHistory(true)
            room.store.conversations.read()
            assertEquals(listOf(true), coach.history.map { it.answering })
            val other = coach.freshChat()
            assertEquals(ConversationRow(chat, Words.Plain("Question"), 0, answering = true), coach.pendingChat(other))
            assertNull(coach.pendingChat(chat))
            assertEquals("Coach is answering another message. Try again when it finishes.",
                ((coach.deleteThread(chat) as works.windmill.gym.store.GymResult.Failed).why as works.windmill.gym.store.WriteFailure.Refused).words.spelled())
            assertEquals(1, room.threads().size)
            coach.stop()
            advanceUntilIdle()
        }
    }

    @Test fun anEarlierVersionsArchiveKeepsDraftsAndRetainedAnswersAndDropsEverythingElse() = runTest {
        val directory = folder.newFolder()
        val file = File(directory, LocalCoach.fileName)
        val photos = File(directory, "coach-photos")
        val attachment = """{"id":"draftphoto01","mediaType":"image/png","width":1,"height":1,"bytes":3}"""
        val response = """{"requestId":"answered-1","resultId":"result-1","status":"completed","expiresAtMs":9,"routines":[{"name":"Day 1","entries":[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":60.0}]}]}],"allowance":{"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"used":"0","reserved":"0","remaining":"1"},"message":"Here is a plan"}"""
        file.writeText("""{"anonymousId":"anonymous:phone",
            "selected":{"alice":"gone-chat","anonymous:phone":"answered-chat"},
            "chats":{"alice":{"gone-chat":{"id":"gone-chat","createdAtMs":1,"updatedAtMs":2,"exchanges":[{"question":"Private old question"}]},"drafted-chat":{"id":"drafted-chat","createdAtMs":1,"updatedAtMs":2}}},
            "pending":{"alice":{"req":{"thread":"gone-chat","question":"Private old question","requestId":"req"}}},
            "snapshots":{"alice":{"req":{"id":"g","requestId":"req","question":"Private old question","status":"running"}}},
            "confirmations":{"alice":{"req":{"thread":"gone-chat","generation":{"id":"g","requestId":"req","question":"Private old question","status":"completed"}}}},
            "choices":{"alice":{"gone-chat":{"req":{"days":["three"]}}}},
            "drafts":{"alice":{"drafted-chat":{"text":"Keep me","photo":$attachment,"setup":true}}},
            "keptDrafts":{"alice":{"kept-chat":[{"id":"kept-1","draft":{"text":"Kept too"}}]}},
            "onboarding":{"anonymous:phone":{"answered-1":{"owner":"anonymous:phone","chat":"answered-chat","replica":"r","requestId":"answered-1","body":"{\"requestId\":\"answered-1\",\"mode\":\"conversation\",\"text\":\"Plan me\",\"context\":[]}","createdAtMs":5,"response":$response}}}
        }""")
        val coach = LocalCoach(file)
        val alicePhotos = coach.photoFile("alice", "draftphoto01").parentFile!!
        alicePhotos.mkdirs()
        File(alicePhotos, "draftphoto01").writeBytes(byteArrayOf(1, 2, 3))
        File(alicePhotos, "oldexchangephoto").writeBytes(byteArrayOf(9))
        File(photos, "feedfacefeedface").mkdirs()
        File(photos, "feedfacefeedface/owner-gone").writeBytes(byteArrayOf(9))

        assertEquals(setOf("drafted-chat", "kept-chat"), coach.chats("alice").map { it.id }.toSet())
        assertEquals(CoachDraft("Keep me", CoachAttachment("draftphoto01", "image/png", 1, 1, 3)), coach.draft("alice", "drafted-chat"))
        assertEquals(listOf(KeptCoachDraft("kept-1", CoachDraft("Kept too"))), coach.keptDrafts("alice", "kept-chat"))
        assertNull("a selected chat that kept nothing goes with it", coach.selected("alice"))
        assertEquals("answered-chat", coach.selected("anonymous:phone"))
        assertEquals("Plan me", coach.retained("anonymous:phone", "answered-chat").single().question)
        assertEquals(setOf("anonymous:phone", "alice"), setOf("anonymous:phone", "alice").filter { coach.chats(it).isNotEmpty() }.toSet())

        coach.settle()
        val written = file.readText()
        assertFalse(written.contains("Private old question"))
        listOf("\"chats\"", "\"pending\"", "\"snapshots\"", "\"confirmations\"", "\"choices\"").forEach { assertFalse(it, written.contains(it)) }
        assertArrayEquals(byteArrayOf(1, 2, 3), File(alicePhotos, "draftphoto01").readBytes())
        assertFalse(File(alicePhotos, "oldexchangephoto").exists())
        assertFalse(File(photos, "feedfacefeedface").exists())

        val reopened = LocalCoach(file)
        assertEquals(coach.chats("alice"), reopened.chats("alice"))
        assertEquals(coach.draft("alice", "drafted-chat"), reopened.draft("alice", "drafted-chat"))
        assertEquals("anonymous:phone", reopened.anonymousOwner())
    }

    // The clear the turn's record asked for did not reach the disk, then the turn was withdrawn: the question stands in the field and on the disk, saved.
    @Test fun aWithdrawalAfterAnUnwrittenClearReturnsTheQuestionToTheField() = runTest {
        val file = File(folder.newFolder(), LocalCoach.fileName)
        var failNext = false
        val disk = LocalCoach(file) { target, text ->
            if (failNext) { failNext = false; throw IOException("disk full, once") }
            AtomicDocument.write(target, text)
        }
        val server = answers("Hi")
        EngineRoomFixture(folder.newFolder(), work(), localCoach = disk, coachServer = server).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Refused question"))
            server.refuseOpen = TurnRefusal(429, "coach-rate-limited", null)
            failNext = true
            assertTrue(coach.send(chat, "Refused question"))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.RateLimited, coach.refusal(chat))
            assertEquals(CoachDraft("Refused question"), coach.draft(chat))
            assertTrue(coach.draftSaved(chat))
            assertEquals(CoachDraft("Refused question"), LocalCoach(file).draft("alice", chat))
        }
    }

    // Neither write reached the disk: the field holds the question, unsaved, and the disk still holds what it held, which is the question.
    @Test fun aWithdrawalTheDiskWillNotTakeKeepsTheQuestionInBothPlaces() = runTest {
        val file = File(folder.newFolder(), LocalCoach.fileName)
        var failing = false
        val disk = LocalCoach(file) { target, text ->
            if (failing) throw IOException("disk full")
            AtomicDocument.write(target, text)
        }
        val telling = TellingRecorder()
        val server = answers("Hi")
        EngineRoomFixture(folder.newFolder(), work(), telemetry = telling, localCoach = disk, coachServer = server).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Refused question"))
            server.refuseOpen = TurnRefusal(429, "coach-rate-limited", null)
            failing = true
            assertTrue(coach.send(chat, "Refused question"))
            advanceUntilIdle()
            assertEquals(CoachDraft("Refused question"), coach.draft(chat))
            assertFalse(coach.draftSaved(chat))
            assertEquals(CoachDraft("Refused question"), LocalCoach(file).draft("alice", chat))
            assertEquals(listOf(mapOf("operation" to "gym.saveConversation"), mapOf("operation" to "gym.saveDraft")), telling.failures)

            failing = false
            coach.saveDraft(chat, CoachDraft("Refused question"))
            assertTrue(coach.draftSaved(chat))
        }
    }

    // A read can publish the question's record while its chat is still being written, a revision's read on another thread: the room draws one question.
    @Test fun aQuestionItsRecordHoldsIsDrawnOnceWhileItsChatIsWritten() = runTest {
        var written: (() -> Unit)? = null
        val disk = LocalCoach(File(folder.newFolder(), LocalCoach.fileName)) { target, text ->
            AtomicDocument.write(target, text)
            written?.invoke()
        }
        val server = answers("One")
        EngineRoomFixture(folder.newFolder(), work(), localCoach = disk, coachServer = server, readDispatcher = Dispatchers.Unconfined).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "First"))
            advanceUntilIdle()
            server.rewind()
            var drawn: List<Pair<String, Boolean>>? = null
            written = {
                written = null
                runBlocking { room.store.conversations.read() }
                drawn = coach.exchanges(chat).map { it.question to it.sending }
            }
            assertTrue(coach.send(chat, "Second"))
            advanceUntilIdle()
            assertEquals(listOf("First" to false, "Second" to false), drawn)
        }
    }

    // A notice never names a moment gone by: a cap stands until the moment it named, on every chat, and then says nothing. A cap that named none stands.
    @Test fun aCapNoticeGoesOnceTheMomentItNamedHasPassed() = runTest {
        for ((code, said) in listOf("free_month_exhausted" to CoachTurnRefusal.FreeMonthExhausted(1_800_000_600_000), "free_day_exhausted" to CoachTurnRefusal.Allowance("free_day_exhausted", 1_800_000_600_000))) {
            val server = script("[]").apply { refuseOpen = TurnRefusal(429, code, 1_800_000_600_000) }
            room(server).use { room ->
                val coach = room.store.coach
                val chat = coach.freshChat()
                val other = coach.freshChat()
                assertTrue(coach.send(chat, "Question"))
                advanceUntilIdle()
                assertEquals(said, coach.refusal(chat))
                assertEquals(said, coach.refusal(other))
                room.now = 1_800_000_599_000
                assertEquals(said, coach.refusal(chat))
                room.now = 1_800_000_600_000
                assertNull(coach.refusal(chat))
                assertNull(coach.refusal(other))
            }
        }
        val noMoment = script("[]").apply { refuseOpen = TurnRefusal(429, "subject_exhausted", null) }
        room(noMoment).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceUntilIdle()
            room.now += 86_400_000
            assertEquals(CoachTurnRefusal.Allowance("subject_exhausted"), coach.refusal(chat))
        }
    }

    // A retained answer's save leaves the main thread, and what the room reads next holds it: the drafts are gone from the answer, and the routines stand. The engine asks its clock inside every commit, so the clock says who asked.
    @Test fun aRetainedSaveCommitsOffTheMainThreadAndTheRoomReadsItAfter() {
        val onMain = CopyOnWriteArrayList<Boolean>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        val clock = object : EngineClock { override fun now(): Long { onMain += Looper.myLooper() == Looper.getMainLooper(); return 1_800_000_000_000L } }
        val file = File(folder.newFolder(), LocalCoach.fileName)
        val engine = Engine.memory(SyncSchema.registry, null, clock = clock, rewriteDeviceValue = EngineTraining.rewriteDeviceValue)
        val replica = engine.activeReplica()
        val snapshot = engine.snapshot()
        engine.close()
        file.writeText("""{"anonymousId":"anonymous:phone","selected":{"anonymous:phone":"c"},"onboarding":{"anonymous:phone":{"r":{"owner":"anonymous:phone","chat":"c","replica":"$replica","requestId":"r","body":"{\"text\":\"Q\"}","createdAtMs":5,
            "response":{"requestId":"r","resultId":"result-1","status":"completed","routines":[{"name":"Day 1","entries":[{"exerciseId":"bench-press","sets":[]}]}],"message":"m"}}}}}""")
        EngineRoomFixture(folder.newFolder(), scope, snapshot = snapshot, localCoach = LocalCoach(file), coachStorage = Dispatchers.IO, readDispatcher = Dispatchers.Default,
            createEngine = { held, _ -> Engine.memory(SyncSchema.registry, held, clock = clock, rewriteDeviceValue = EngineTraining.rewriteDeviceValue) },
            coachImports = { live -> CoachRoutineImports(live, { CoachOnboardingSeat("anonymous:phone", replica) }, scope) }).use { room ->
            val coach = room.store.coach
            assertEquals("c", coach.selectedChatId)
            runBlocking { room.store.conversations.read() }
            assertEquals(listOf("Day 1"), coach.exchanges("c").single().retained?.drafts?.map { it.name })
            onMain.clear()
            var outcome: DraftOutcome? = null
            scope.launch { outcome = coach.saveRetainedDrafts("c", "r") }
            val deadline = System.currentTimeMillis() + 20_000
            while (outcome == null && System.currentTimeMillis() < deadline) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(5) }
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(onMain.isNotEmpty())
            assertEquals(DraftOutcome.Saved, outcome)
            assertEquals(0, onMain.count { it })
            assertEquals(emptyList<CoachRoutineDraft>(), coach.exchanges("c").single().retained?.drafts)
            assertEquals(listOf("Day 1"), coach.exchanges("c").single().answer?.routines?.map { it.name })
            assertEquals(listOf("Day 1"), room.store.routines.all.map { it.name })
        }
        scope.cancel()
    }

    // A refused answer says the balance is gone only where its own allowance read says so, and a file holding no read says nothing of the balance. The line outlives the settle that rewrites the file.
    @Test fun aRetainedRefusalSaysSpentOnlyWhereItsOwnReadSaysSo() = runTest {
        val gone = "You have used all of your AI allowance."
        val unavailable = "Coach’s AI allowance is unavailable right now."
        fun read(remaining: String, reserved: String) = ""","allowance":{"code":"subject_exhausted","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"limit":"0.250000000","used":"0.250000000","reserved":"$reserved","remaining":"$remaining"}"""
        for ((allowance, said) in listOf(
            read("0.000000000", "0.000000000") to gone,
            read("0.010000000", "0.000000000") to unavailable,
            read("0.000000000", "0.010000000") to unavailable,
            ""","allowance":{"remaining":"0.000000000"}""" to unavailable,
            "" to unavailable,
        )) {
            val file = File(folder.newFolder(), LocalCoach.fileName)
            file.writeText("""{"anonymousId":"anonymous:phone","selected":{"anonymous:phone":"c"},"chats":{},"onboarding":{"anonymous:phone":{"r":{"owner":"anonymous:phone","chat":"c","replica":"x","requestId":"r","body":"{\"text\":\"Again\"}","createdAtMs":1,
                "response":{"requestId":"r","resultId":"z","status":"failed","expiresAtMs":9,"routines":[]$allowance,"errorCode":"subject_exhausted","message":""}}}}}""")
            room(answers("Hi"), file).use { room ->
                val coach = room.store.coach
                assertEquals("c", coach.selectedChatId)
                room.store.conversations.read()
                assertEquals(allowance, said, coach.exchanges("c").single().retained?.words.spelled())
            }
            LocalCoach(file).settle()
            room(answers("Hi"), file).use { room ->
                assertEquals("c", room.store.coach.selectedChatId)
                room.store.conversations.read()
                assertEquals(allowance, said, room.store.coach.exchanges("c").single().retained?.words.spelled())
            }
        }
    }

    private val retainedResponse = """{"requestId":"answered-1","resultId":"result-1","status":"completed","expiresAtMs":9,"routines":[],"allowance":{"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"used":"0","reserved":"0","remaining":"1"},"message":"Here is a plan"}"""

    // One retained answer with a body this build cannot read costs that answer: History, the transcript and the good answer beside it stand, and one failure says nothing of what it held.
    @Test fun anUnreadableRetainedAnswerCostsThatAnswerAndTheRoomStands() = runTest {
        val file = File(folder.newFolder(), LocalCoach.fileName)
        file.writeText("""{"anonymousId":"anonymous:phone","selected":{"anonymous:phone":"answered-chat"},"chats":{},"onboarding":{"anonymous:phone":{
            "bad-1":{"owner":"anonymous:phone","chat":"answered-chat","replica":"r","requestId":"bad-1","body":"partial{ private words","createdAtMs":5,"response":${retainedResponse.replace("answered-1", "bad-1")}},
            "bad-2":{"owner":"anonymous:phone","chat":"lost-chat","replica":"r","requestId":"bad-2","body":"partial{","createdAtMs":6},
            "answered-1":{"owner":"anonymous:phone","chat":"answered-chat","replica":"r","requestId":"answered-1","body":"{\"requestId\":\"answered-1\",\"mode\":\"conversation\",\"text\":\"Plan me\"}","createdAtMs":7,"response":$retainedResponse}}}}""")
        val telling = TellingRecorder()
        room(answers("Hi"), file, telling).use { room ->
            val coach = room.store.coach
            room.store.connect(room.account(null))
            room.store.conversations.watchHistory(true)
            assertEquals("answered-chat", coach.selectedChatId)
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(listOf(ConversationRow("answered-chat", Words.Plain("Plan me"), coach.chat("answered-chat")!!.updatedAtMs, answerPreview = "Here is a plan")), coach.history)
            assertEquals(listOf("Plan me"), coach.exchanges("answered-chat").map { it.question })
            assertEquals(listOf(mapOf("operation" to "gym.restoreConversation")), telling.failures)
        }
    }

    // A file this build cannot read holds nothing of the engine's conversations: each opens, reads and deletes, the file stays as it was, and it is reported once.
    @Test fun aBrokenArchiveLeavesTheEnginesConversationsOpenAndDeletable() = runTest {
        val directory = folder.newFolder()
        val seeded = File(folder.newFolder(), LocalCoach.fileName)
        val seed = room(answers("Hi"), seeded).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            assertTrue(room.store.coach.send(room.store.coach.freshChat(), "Question"))
            advanceUntilIdle()
            room.engine.snapshot()
        }
        val file = File(folder.newFolder(), LocalCoach.fileName).apply { writeText("""{"chats":""") }
        val telling = TellingRecorder()
        EngineRoomFixture(directory, work(), snapshot = seed, telemetry = telling, localCoach = LocalCoach(file), coachServer = answers("Hi")).use { room ->
            room.selected = "alice"
            room.store.connect(room.account("alice"))
            val coach = room.store.coach
            room.store.conversations.watchHistory(true)
            assertNull(coach.selectedChatId)
            advanceUntilIdle()
            room.store.conversations.read()
            val thread = coach.history.single().id
            assertEquals(listOf("Question"), coach.history.map { it.named.spelled() })

            coach.selectChat(thread)
            room.store.conversations.read()
            assertEquals(LocalChat(thread, checkNotNull(coach.chat(thread)).createdAtMs, conversation = thread), coach.chat(thread))
            assertEquals(thread, coach.selectedChatId)
            assertEquals(listOf("Question"), coach.exchanges(thread).map { it.question })
            assertNull(coach.failed(thread))

            assertEquals(GymResult.Ok(Unit), coach.deleteThread(thread))
            advanceUntilIdle()
            assertEquals(emptyList<CoachThread>(), room.threads())
            assertEquals(emptyList<ConversationRow>(), coach.history)
            assertEquals(listOf(mapOf("operation" to "gym.restoreConversation")), telling.failures)
            assertEquals("""{"chats":""", file.readText())
        }
    }

    // A seat this phone may not write answers a delete instead of throwing past the screen that asked.
    @Test fun aDeleteOnASeatThatMayNotWriteAnswersAndTellsOnce() = runTest {
        val telling = TellingRecorder()
        var writes = true
        val disk = LocalCoach(File(folder.newFolder(), LocalCoach.fileName), writesAllowed = { writes })
        EngineRoomFixture(folder.newFolder(), work(), telemetry = telling, localCoach = disk, coachServer = answers("Hi")).use { room ->
            val coach = room.store.coach
            assertTrue(coach.send(coach.freshChat(), "Question"))
            advanceUntilIdle()
            val chat = checkNotNull(coach.selectedChatId)
            writes = false
            assertEquals(GymResult.Failed(WriteFailure.Refused(TrainingSeat.accountChange)), coach.deleteThread(chat))
            advanceUntilIdle()
            assertEquals(listOf(mapOf("screen" to "threads", "action" to "delete", "outcome" to "refused")), telling.named("gym_action").filter { it["action"] == "delete" })
            assertEquals(emptyList<Map<String, String>>(), telling.failures)
            assertEquals(listOf("Question"), room.threads().map { it.title })
        }
    }

    // Each kind an earlier version kept reaches History: a chat holding only a kept draft opens on it.
    @Test fun aChatHoldingOnlyAKeptDraftHasItsRowAndOpens() = runTest {
        val file = File(folder.newFolder(), LocalCoach.fileName)
        file.writeText("""{"chats":{"alice":{"kept-chat":{"id":"kept-chat","createdAtMs":1,"exchanges":[{"question":"old"}]}}},
            "keptDrafts":{"alice":{"kept-chat":[{"id":"kept-1","draft":{"text":"Kept too"}}]}}}""")
        room(answers("Hi"), file).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            room.store.conversations.watchHistory(true)
            room.store.conversations.read()
            val chat = checkNotNull(coach.chat("kept-chat"))
            assertEquals(listOf(ConversationRow("kept-chat", Words.Plain("Kept too"), chat.updatedAtMs)), coach.history)
            coach.selectChat("kept-chat")
            assertEquals(listOf(KeptCoachDraft("kept-1", CoachDraft("Kept too"))), coach.keptDrafts("kept-chat"))
            assertEquals("kept-chat", coach.selectedChatId)
        }
    }

    // A file with drafts and none of the keys that mark an earlier version: the chat is there to list and to send from.
    @Test fun aDraftInAFileWithNoEarlierKeysListsAndSends() = runTest {
        val file = File(folder.newFolder(), LocalCoach.fileName)
        file.writeText("""{"anonymousId":"anonymous:phone","selected":{"alice":"drafted"},"drafts":{"alice":{"drafted":{"text":"Keep me"}}}}""")
        val server = answers("Hi")
        room(server, file).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            advanceUntilIdle()
            val coach = room.store.coach
            room.store.conversations.watchHistory(true)
            room.store.conversations.read()
            assertEquals(listOf("drafted"), coach.history.map { it.id })
            assertEquals("drafted", coach.selectedChatId)
            assertTrue(coach.send("drafted", "Keep me"))
            advanceUntilIdle()
            assertEquals(listOf("Keep me"), server.opened.map { it.question })
            assertEquals(listOf("Keep me"), coach.exchanges("drafted").map { it.question })
        }
    }

    @Test fun aRetainedAnswerReadsAsAnExchangeAndItsDraftsSaveOnceOnTheReplicaItWasHadOn() = runTest {
        val directory = folder.newFolder()
        val file = File(directory, LocalCoach.fileName)
        val roomFolder = folder.newFolder()
        var seat: works.windmill.gym.coach.onboarding.CoachOnboardingSeat? = null
        val probe = EngineRoomFixture(roomFolder, work())
        val replica = probe.engine.activeReplica()
        val snapshot = probe.engine.snapshot()
        probe.close()
        val response = """{"requestId":"answered-1","resultId":"result-1","status":"completed","expiresAtMs":9,"routines":[{"name":"Day 1","entries":[{"exerciseId":"bench-press","sets":[{"reps":5,"weightKg":60.0}]}]}],"allowance":{"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"used":"0","reserved":"0","remaining":"1"},"message":"Here is a plan"}"""
        file.writeText("""{"anonymousId":"anonymous:phone","selected":{"anonymous:phone":"answered-chat"},"chats":{},
            "onboarding":{"anonymous:phone":{"answered-1":{"owner":"anonymous:phone","chat":"answered-chat","replica":"$replica","requestId":"answered-1","body":"{\"text\":\"Plan me\"}","createdAtMs":5,"response":$response},
            "refused-1":{"owner":"anonymous:phone","chat":"answered-chat","replica":"$replica","requestId":"refused-1","body":"{\"text\":\"Plan again\"}","createdAtMs":6,"refusalCode":"account_required"}}}}""")
        val scope = work()
        val imports = { engine: works.windmill.sync.engine.Engine -> works.windmill.gym.coach.onboarding.CoachRoutineImports(engine, { seat }, scope) }
        EngineRoomFixture(roomFolder, scope, snapshot = snapshot, localCoach = LocalCoach(file), coachImports = imports).use { room ->
            seat = works.windmill.gym.coach.onboarding.CoachOnboardingSeat("anonymous:phone", replica)
            val coach = room.store.coach
            assertEquals("answered-chat", coach.selectedChatId)
            room.store.conversations.read()
            val (answered, refused) = coach.exchanges("answered-chat")
            assertEquals("Plan me", answered.question)
            assertEquals("Here is a plan", answered.answer?.text)
            assertEquals(listOf("Day 1"), answered.retained?.drafts?.map { it.name })
            assertEquals(emptyList<CreatedRoutine>(), answered.answer?.routines)
            assertEquals("Plan again", refused.question)
            assertNull(refused.answer)
            assertEquals(true, refused.retained?.accountRequired)

            assertEquals(DraftOutcome.Saved, coach.saveRetainedDrafts("answered-chat", "answered-1"))
            advanceUntilIdle()
            val saved = coach.exchanges("answered-chat").first()
            assertEquals(emptyList<CoachRoutineDraft>(), saved.retained?.drafts)
            assertEquals(listOf("Day 1"), saved.answer?.routines?.map { it.name })
            assertEquals(DraftOutcome.Saved, coach.saveRetainedDrafts("answered-chat", "answered-1"))
            assertEquals(DraftOutcome.Closed(R.string.gym_coach_draft_gone), coach.saveRetainedDrafts("answered-chat", "gone"))
        }
    }
}
