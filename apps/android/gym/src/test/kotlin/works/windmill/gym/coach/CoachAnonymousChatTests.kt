package works.windmill.gym.coach

import java.io.File
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
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
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnTransport
import works.windmill.gym.coach.onboarding.CoachOnboardingSeat
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.ScriptedInstallation
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.coach.turn.TurnPhoneInstallation
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationApi
import works.windmill.platform.ai.AiInstallationResponse
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

// A signed-out phone's chats on the one path every seat takes: its refusals keep the question, its bound installation keeps its chats, and a dead process never asks again.
@OptIn(ExperimentalCoroutinesApi::class)
class CoachAnonymousChatTests {
    @get:Rule val temporary = TemporaryFolder()

    private fun script(frames: String) = ScriptedTurns(Json.parse(frames).arr())

    private fun answers(text: String) = script("""[{"event":"text","data":{"delta":"$text"}},{"event":"done","data":{"state":"completed"}}]""")

    private val holdsOpen get() = script("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")

    // Virtual time, one dispatcher: the test advances it, and closing the room ends its work.
    private fun TestScope.work() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)

    private fun TestScope.room(server: TurnTransport, disk: LocalCoach = LocalCoach(File(temporary.newFolder(), LocalCoach.fileName)), directory: File = temporary.newFolder(),
        snapshot: Json? = null, telling: Telemetry = Telemetry.None, installation: AiInstallation? = null, access: suspend () -> AnonymousCoachAccess = { AnonymousCoachAccess.Available }) =
        EngineRoomFixture(directory, work(), snapshot = snapshot, telemetry = telling, localCoach = disk, coachServer = server, coachInstallation = installation, coachAccess = access)

    private fun EngineRoomFixture.messages(): List<CoachMessage> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachMessage, read.drawn(CoachMessage.type))
    }

    private fun EngineRoomFixture.threads(): List<CoachThread> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachThread, read.drawn(CoachThread.type))
    }

    @Test fun aLateRefusalReturnsTheQuestionToItsOwnChatAndLeavesTheNewerChatAlone() = runTest {
        val release = CompletableDeferred<Unit>()
        val server = script("[]").apply { refuseOpen = TurnRefusal(401, "invalid_installation", null) }
        val late = object : TurnTransport by server {
            override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow {
                release.await()
                emitAll(server.open(open, seat))
            }
        }
        val file = File(temporary.newFolder(), LocalCoach.fileName)
        room(late, LocalCoach(file)).use { room ->
            val coach = room.store.coach
            coach.refreshAnonymousAccess()
            advanceUntilIdle()
            assertEquals(AnonymousCoachAccess.Available, coach.anonymousAccess)
            val original = coach.freshChat()
            assertTrue(coach.send(original, "Make Push A harder"))
            advanceUntilIdle()
            assertTrue(coach.isAsking(original))
            assertEquals(CoachDraft(), coach.draft(original))
            val other = coach.freshChat("Another chat's input")
            release.complete(Unit)
            advanceUntilIdle()
            assertEquals(other, coach.selectedChatId)
            assertEquals(CoachDraft("Another chat's input"), coach.draft(other))
            assertEquals(CoachDraft("Make Push A harder"), coach.draft(original))
            assertEquals(CoachTurnRefusal.Installation("invalid_installation"), coach.refusal(original))
            assertNull(coach.refusal(other))
            assertFalse(coach.isAsking(original))
            assertNull(coach.chat(original)?.conversation)
            assertEquals(emptyList<CoachMessage>(), room.messages())
            assertEquals(1, server.opened.size)
            coach.keepPosition(original, 91, false)
            val restored = LocalCoach(file)
            val phone = restored.anonymousOwner()
            assertEquals(CoachDraft("Make Push A harder"), restored.draft(phone, original))
            assertEquals(CoachDraft("Another chat's input"), restored.draft(phone, other))
            assertEquals(91, restored.chat(phone, original)?.scroll)
            assertEquals(other, restored.selected(phone))
        }
    }

    @Test fun boundInstallationKeepsItsChatsAndCannotOpenATurnOrIssueAReplacement() = runTest {
        var issued = 0
        val scripted = ScriptedInstallation()
        val identity = TurnPhoneInstallation.onMemory(object : AiInstallationApi by scripted {
            override suspend fun issue(): AiInstallationResponse = scripted.issue().also { issued++ }
        })
        identity.forAnonymousSend()
        identity.markBound()
        val server = script("[]")
        val disk = LocalCoach(File(temporary.newFolder(), LocalCoach.fileName))
        room(server, disk, installation = identity, access = { anonymousCoachAccess(identity, { CoachOnboardingSeat(disk.anonymousOwner(), "replica") }, Telemetry.None) }).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat("Earlier input")
            coach.refreshAnonymousAccess()
            advanceUntilIdle()
            assertEquals(AnonymousCoachAccess.Bound, coach.anonymousAccess)
            assertTrue(coach.send(chat, "New input"))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Installation("device_bound"), coach.refusal(chat))
            assertEquals(CoachDraft("Earlier input"), coach.draft(chat))
            assertEquals(listOf(chat), coach.history.map { it.id })
            assertTrue(coach.hasConversations)
            assertEquals(emptyList<TurnOpen>(), server.opened)
            assertEquals(emptyList<CoachMessage>(), room.messages())
            assertEquals(1, issued)
        }
    }

    @Test fun everyCapKeepsTheQuestionInItsChatAcrossAReopenAndStandsOverEveryChatUntilThen() = runTest {
        data class Cap(val code: String, val refusal: CoachTurnRefusal, val sentence: String, val named: String)
        for ((code, refusal, sentence, named) in listOf(
            Cap("subject_exhausted", CoachTurnRefusal.Allowance("subject_exhausted", spent = true), "You have used all of your AI allowance.", "allowance"),
            Cap("free_day_exhausted", CoachTurnRefusal.Allowance("free_day_exhausted"), "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.", "allowance"),
            Cap("free_month_exhausted", CoachTurnRefusal.FreeMonthExhausted(null), "Coach is paused for everyone this month.", "allowance"),
            Cap("concurrency_exhausted", CoachTurnRefusal.Allowance("concurrency_exhausted"), "Another AI request is still in progress. Try again when it finishes.", "allowance"),
            Cap("funding_required", CoachTurnRefusal.Allowance("funding_required"), "Your plan has no funded AI allowance for this period.", "allowance"),
            Cap(TurnRefusal.rateLimited, CoachTurnRefusal.RateLimited, "You can ask again later.", "daily"),
        )) {
            val telling = TellingRecorder()
            val server = script("[]").apply { refuseOpen = TurnRefusal(429, code, null, spent = code == "subject_exhausted") }
            val file = File(temporary.newFolder(), LocalCoach.fileName)
            val directory = temporary.newFolder()
            val (chat, other, snapshot) = room(server, LocalCoach(file), directory, telling = telling).use { room ->
                val coach = room.store.coach
                val chat = coach.freshChat()
                assertTrue(coach.send(chat, "Retained input"))
                advanceUntilIdle()
                val other = coach.freshChat("Other draft")
                assertEquals(refusal, coach.refusal(chat))
                assertEquals(refusal, coach.refusal(other))
                assertEquals(sentence, coach.refusal(chat)?.sentence)
                assertEquals(CoachDraft("Retained input"), coach.draft(chat))
                assertEquals(emptyList<CoachThread>(), room.threads())
                assertEquals(emptyList<Map<String, String>>(), telling.failures)
                assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "capped", "cap" to named)), telling.named("gym_ask_outcome").map { it - "duration_ms" })
                Triple(chat, other, room.engine.snapshot())
            }
            room(script("[]"), LocalCoach(file), directory, snapshot).use { reopened ->
                val coach = reopened.store.coach
                assertEquals(CoachDraft("Retained input"), coach.draft(chat))
                assertEquals(CoachDraft("Other draft"), coach.draft(other))
                assertEquals(other, coach.selectedChatId)
                assertNull(coach.refusal(chat))
            }
        }
    }

    @Test fun aRetainedAnswersPhotoStaysUntilNoRetainedAnswerNamesIt() = runTest {
        val file = File(temporary.newFolder(), LocalCoach.fileName)
        val photo = CoachAttachment("image001", "image/png", 1, 1, 3)
        val owner = "anonymous:phone"
        fun retained(chat: String, request: String) = """"$request":{"owner":"$owner","chat":"$chat","replica":"replica","requestId":"$request","body":"{\"text\":\"\"}","createdAtMs":5,
            "attachment":{"id":"image001","mediaType":"image/png","width":1,"height":1,"bytes":3},
            "response":{"requestId":"$request","resultId":"result-$chat","status":"completed","expiresAtMs":9,"routines":[],"allowance":{"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"used":"0","reserved":"0","remaining":"1"},"message":"Read the photo."}}"""
        file.writeText("""{"anonymousId":"$owner","selected":{"$owner":"original"},
            "localChats":{"$owner":{"original":{"id":"original","createdAtMs":1},"another":{"id":"another","createdAtMs":2}}},
            "onboarding":{"$owner":{${retained("original", "request-a")},${retained("another", "request-b")}}}}""")
        val local = LocalCoach(file)
        local.savePhoto(owner, photo.id, byteArrayOf(1, 2, 3))
        room(script("[]"), local).use { room ->
            val coach = room.store.coach
            assertEquals("original", coach.selectedChatId)
            room.store.conversations.read()
            val answered = coach.exchanges("original").single()
            assertEquals(listOf(SentPicture(photo, onThisPhone = true)), answered.pictures)
            assertEquals("Read the photo.", answered.answer?.text)
            coach.saveDraft("original", CoachDraft(photo = photo))
            coach.saveDraft("original", CoachDraft())
            assertEquals(CoachDraft(), coach.draft("original"))
            assertEquals(byteArrayOf(1, 2, 3).toList(), local.photoFile(owner, photo.id).readBytes().toList())
            local.clear(owner, "original")
            assertEquals(emptyList<Any>(), local.retained(owner, "original"))
            assertTrue(local.photoFile(owner, photo.id).isFile)
            assertEquals(photo, local.retained(owner, "another").single().attachment)
            local.clear(owner, "another")
            assertFalse(local.photoFile(owner, photo.id).exists())
        }
    }

    @Test fun aNewQuestionAfterAFailedTurnOpensTheNextTurnAndTheEarlierOneStaysAsItEnded() = runTest {
        val server = script("""[
            {"event":"error","data":{"code":"coach-vendor-error"}},
            {"event":"text","data":{"delta":"Answer"}},
            {"event":"done","data":{"state":"completed"}}]""")
        room(server).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "First question"))
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(MessageState.failed, coach.exchanges(chat).single().answer?.state)
            assertEquals("Coach couldn’t finish. Ask again.", Ask.ending(MessageState.failed, truncated = false, wordsArrived = false))
            coach.saveDraft(chat, CoachDraft("Second question"))
            assertTrue(coach.send(chat, "Second question"))
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(listOf("First question", "Second question"), server.opened.map { it.question })
            assertEquals(CoachDraft(), coach.draft(chat))
            assertEquals(listOf("First question" to MessageState.failed, "Second question" to MessageState.completed), coach.exchanges(chat).map { it.question to it.answer?.state })
            assertEquals("Answer", coach.exchanges(chat).last().answer?.text)
            assertEquals(1, room.threads().size)
            assertNull(coach.refusal(chat))
        }
    }

    @Test fun aNewQuestionAfterARestartOpensItsOwnTurnAndTheOldOneNeverReplays() = runTest {
        val directory = temporary.newFolder()
        val file = File(temporary.newFolder(), LocalCoach.fileName)
        val first = holdsOpen
        val (snapshot, chat, clock) = room(first, LocalCoach(file), directory).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "First question"))
            advanceUntilIdle()
            Triple(room.engine.snapshot(), chat, room.now)
        }
        assertEquals(listOf("First question"), first.opened.map { it.question })
        val telling = TellingRecorder()
        val server = answers("Answer")
        room(server, LocalCoach(file), directory, snapshot, telling).use { restarted ->
            restarted.now = clock + 60_000
            val coach = restarted.store.coach
            assertEquals(chat, coach.selectedChatId)
            checkNotNull(restarted.coachTurns).start()
            advanceUntilIdle()
            assertEquals(emptyList<TurnOpen>(), server.opened)
            coach.saveDraft(chat, CoachDraft("Second question"))
            assertTrue(coach.send(chat, "Second question"))
            advanceUntilIdle()
            restarted.store.conversations.read()
            assertEquals(listOf("Second question"), server.opened.map { it.question })
            assertEquals(1, telling.named("gym_ask_started").size)
            assertEquals(CoachDraft(), coach.draft(chat))
            assertEquals(listOf("First question" to MessageState.interrupted, "Second question" to MessageState.completed), coach.exchanges(chat).map { it.question to it.answer?.state })
            assertEquals(1, restarted.threads().size)
        }
    }

    @Test fun aQuestionLeftRunningByADeadProcessLeavesTheComposerEmptySoSendCannotAskItAgain() = runTest {
        val directory = temporary.newFolder()
        val file = File(temporary.newFolder(), LocalCoach.fileName)
        val server = holdsOpen
        val (snapshot, chat) = room(server, LocalCoach(file), directory).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            coach.saveDraft(chat, CoachDraft("Make Push A harder "))
            assertTrue(coach.send(chat, "Make Push A harder "))
            advanceUntilIdle()
            room.engine.snapshot() to chat
        }
        room(server, LocalCoach(file), directory, snapshot).use { restarted ->
            val coach = restarted.store.coach
            assertEquals(chat, coach.selectedChatId)
            checkNotNull(restarted.coachTurns).start()
            advanceUntilIdle()
            restarted.store.conversations.read()
            assertEquals(CoachDraft(), coach.draft(chat))
            assertEquals(CoachDraft(), LocalCoach(file).let { it.draft(it.anonymousOwner(), chat) })
            assertEquals(listOf("Make Push A harder" to MessageState.interrupted), coach.exchanges(chat).map { it.question to it.answer?.state })
            assertEquals(1, server.opened.size)
        }
    }

    @Test fun trailingWhitespaceIsTrimmedBeforeTheLimitAndTheRequest() = runTest {
        val server = answers("Answer")
        room(server).use { room ->
            val coach = room.store.coach
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "x".repeat(7_990) + " ".repeat(20)))
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(listOf("x".repeat(7_990)), server.opened.map { it.question })
            assertEquals("x".repeat(7_990) to "Answer", coach.exchanges(chat).single().let { it.question to it.answer?.text })
        }
    }
}
