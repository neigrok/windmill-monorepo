package works.windmill.gym.coach

import android.graphics.Bitmap
import android.graphics.Color
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
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
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.gym.coach.turn.CoachTurnFault
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.OpenTurnOnce
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
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

    private fun TestScope.room(server: ScriptedTurns, file: File = File(folder.newFolder(), LocalCoach.fileName), telling: TellingRecorder = TellingRecorder()) =
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
            val created = reply.calls.single { it.name == "create_routine" }
            assertEquals(AbilityCall.Outcome.Ok, created.outcome)
            assertEquals(listOf(RecordRef(Gym.Types.routine, RecordID("rt_00000009"))), created.created)
            assertEquals(listOf("list_sessions", "list_notes", "list_exercises", "list_routines", "create_routine"), reply.calls.map { it.name })
            assertEquals(reply.calls.map { works.windmill.gym.coach.turn.TurnPhone.catalog().ability(it.name)?.phrase }, reply.steps)
            assertEquals(CoachReceipt(ReadTally(), truncated = false, created = listOf(RecordRef(Gym.Types.routine, RecordID("rt_00000009")))), reply.receipt)
            assertEquals(listOf(CreatedRoutine("rt_00000009", "Day 1", movements = 1)), reply.routines)
            assertEquals(listOf("Read your recent workouts" to null, "Read your notes" to null, "Read your movement list" to null, "Read your program" to "Day 1", "Created a routine" to "Day 1"),
                reply.calls.map { it.title to it.detail })
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
            assertEquals(CoachTurnFault.accountChanging, coach.fault)
            assertEquals(CoachDraft("Alice's question"), coach.draft(chat))
            assertNull(coach.chat(chat)?.conversation)
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
            assertTrue(Ask.sendable("é".repeat(4_000)))
            assertFalse(Ask.sendable("é".repeat(4_001)))
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
                ConversationRow(drafted, "Half a thought", coach.chat(drafted)!!.updatedAtMs),
                ConversationRow(asked, "Am I overtraining?", room.messages().maxOf { it.at.ms }, answerPreview = "Rest more"),
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
            assertEquals(ConversationRow(chat, "Question", 0, answering = true), coach.pendingChat(other))
            assertNull(coach.pendingChat(chat))
            assertEquals(works.windmill.gym.store.GymResult.Failed(works.windmill.gym.store.WriteFailure.Refused("Coach is answering another message. Try again when it finishes.")), coach.deleteThread(chat))
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
        assertEquals("Plan me", coach.retained("anonymous:phone", "answered-chat").single().request().text)
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
            assertEquals(DraftOutcome.Closed(Ask.draftGone), coach.saveRetainedDrafts("answered-chat", "gone"))
        }
    }
}
