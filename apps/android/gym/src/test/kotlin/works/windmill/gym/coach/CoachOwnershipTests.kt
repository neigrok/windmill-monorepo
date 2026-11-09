package works.windmill.gym.coach

import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlin.coroutines.ContinuationInterceptor
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Runnable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
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
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.FixedZone
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.sync.ProposeRoutine
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.store.Deletion
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.store.ProposalOutcome
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.presentation.SetTarget
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WriteFailure
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.text
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.gym.domain.sync.Exercise as SyncExercise
import works.windmill.gym.domain.sync.Proposal as SyncProposal
import works.windmill.gym.domain.sync.Routine as SyncRoutine
import works.windmill.gym.domain.sync.RoutineEntry as SyncEntry
import works.windmill.gym.domain.sync.SetTarget as SyncTarget

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CoachOwnershipTests {
    @get:Rule val tmp = TemporaryFolder()

    // Virtual time, one dispatcher: the test advances it, and closing the room ends its work.
    private fun TestScope.work() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)

    private fun answers(text: String) = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"$text"}},{"event":"done","data":{"state":"completed"}}]""").arr())

    @Test
    fun aLateConversationReadCannotAppearInTheNextAccount() = runTest {
        val delegate = StandardTestDispatcher(testScheduler)
        var holdNext = false
        var held: Pair<CoroutineContext, Runnable>? = null
        val reads = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) {
                if (holdNext) { holdNext = false; held = context to block } else delegate.dispatch(context, block)
            }
        }
        val disk = LocalCoach(File(tmp.newFolder(), LocalCoach.fileName))
        EngineRoomFixture(tmp.newFolder(), work(), readDispatcher = reads, localCoach = disk, coachServer = answers("Private answer")).use { room ->
            val conversations = room.store.conversations
            val coach = room.store.coach
            room.select("a")
            room.sync(EngineRoomFixture.server())
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Private question"))
            advanceUntilIdle()
            conversations.watchHistory(true)
            conversations.read()
            assertEquals(1, conversations.threads.size)
            assertEquals(listOf("Private answer"), coach.exchanges(chat).map { it.answer?.text })
            holdNext = true
            val reading = async(start = CoroutineStart.UNDISPATCHED) { conversations.read() }
            assertNotNull(held)
            room.select("b")
            val (context, block) = checkNotNull(held)
            delegate.dispatch(context, block)
            reading.await()
            assertEquals(emptyList<CoachThread>(), conversations.threads)
            assertEquals(emptyList<ConversationRow>(), conversations.rows)
            assertEquals(emptyList<CoachExchange>(), coach.exchanges(chat))
            assertEquals(emptyList<ConversationRow>(), coach.history)
            assertEquals(emptyList<LocalChat>(), disk.chats("b"))
            assertEquals(listOf(chat), disk.chats("a").map { it.id })
        }
    }

    @Test
    fun aDraftBelongsToItsOwnerAcrossASignInAndOneOwnersEraseLeavesTheOther() = runTest {
        val file = File(tmp.root, "two-owners")
        val disk = LocalCoach(file)
        var owner: String? = "a"
        val store = CoachChats({ owner }, {}, null, null, disk, null, { AnonymousCoachAccess.Unavailable }, Telemetry.None, backgroundScope, StandardTestDispatcher(testScheduler))
        store.saveDraft("thread-a", CoachDraft("A's words"))
        owner = "b"; store.forgetSeat()
        assertEquals(CoachDraft(), store.draft("thread-a"))
        assertNull(store.chat("thread-a"))
        store.saveDraft("thread-a", CoachDraft("B's words"))
        assertEquals(CoachDraft("B's words"), store.draft("thread-a"))
        store.eraseOwner("a")
        assertEquals(CoachDraft("B's words"), store.draft("thread-a"))
        assertEquals(CoachDraft("B's words"), LocalCoach(file).draft("b", "thread-a"))
        assertEquals(CoachDraft(), LocalCoach(file).draft("a", "thread-a"))
        assertEquals(emptyList<LocalChat>(), LocalCoach(file).chats("a"))
    }

    @Test
    fun aPhotoThatOutlivesItsOwnerStaysWithTheOwnerItBeganIn() = runTest {
        val disk = LocalCoach(File(tmp.root, "late-photo"))
        var owner: String? = "a"
        val store = CoachChats({ owner }, {}, null, null, disk, null, { AnonymousCoachAccess.Unavailable }, Telemetry.None, backgroundScope, StandardTestDispatcher(testScheduler))
        val chat = store.freshChat("Caption", id = "thread-a")
        val prepared = CompletableDeferred<Pair<CoachAttachment, ByteArray>>()
        val importing = async(start = CoroutineStart.UNDISPATCHED) { store.importPhoto(chat) { prepared.await() } }
        runCurrent()
        owner = "b"; store.forgetSeat()
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
        prepared.complete(photo to byteArrayOf(1, 2, 3))
        importing.await()
        assertEquals(CoachDraft("Caption", photo), disk.draft("a", chat))
        assertEquals(CoachDraft(), disk.draft("b", chat))
        assertEquals(CoachDraft(), store.draft(chat))
        assertFalse(disk.photoFile("b", photo.id).exists())
        assertEquals(emptyList<LocalChat>(), disk.chats("b"))
        owner = "a"; store.forgetSeat()
        assertEquals(CoachDraft("Caption", photo), store.draft(chat))
    }

    @Test
    fun aTurnOpenedAsTheOwnerChangesStaysWithTheOwnerItWasAskedUnder() = runTest {
        val telling = TellingRecorder()
        val disk = LocalCoach(File(tmp.newFolder(), LocalCoach.fileName))
        EngineRoomFixture(tmp.newFolder(), work(), telemetry = telling, coachServer = answers("Private answer")).use { room ->
            room.select("a")
            room.sync(EngineRoomFixture.server())
            var owner: String? = "a"
            val store = CoachChats({ owner }, {}, room.store.conversations, room.coachTurns, disk, null, { AnonymousCoachAccess.Unavailable }, telling, room.scope,
                room.scope.coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)
            val chat = store.freshChat(id = "thread-a")
            store.saveDraft(chat, CoachDraft("Question"))
            telling.onEvent = { name, _ -> if (name == "gym_ask_started") { owner = "b"; store.forgetSeat() } }
            assertTrue(store.send(chat, "Question"))
            advanceUntilIdle()
            assertNotNull(disk.chat("a", chat)?.conversation)
            assertEquals(CoachDraft(), disk.draft("a", chat))
            assertEquals(emptyList<LocalChat>(), disk.chats("b"))
            assertEquals(emptyList<CoachExchange>(), store.exchanges(chat))
            assertEquals(CoachDraft(), store.draft(chat))
        }
    }

    // The server's verdict reaches A's replica, and the owner changes before the store reports it.
    @Test
    fun aStaleDecisionVerdictCannotReportItselfAfterTheOwnerChanges() = runTest {
        for ((applying, code) in listOf(true to "proposal-superseded", false to "proposal-settled")) {
            EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = FakeGymRest()).use { room ->
                val server = EngineRoomFixture.server()
                room.select("a")
                val routine = (room.store.routines.saveRoutine(RoutineDraft(name = "A's routine")
                    .adding("bench-press", listOf(SetTarget(5, 80.0))).capturingMovements(room.store.routines.catalog)) as GymResult.Ok).value
                room.sync(server)
                val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
                assertTrue(runner.run(ProposeRoutine(Id("proposal1", SyncProposal), Id(routine.id, SyncRoutine), routine.name,
                    listOf(SyncEntry(Id("bench-press", SyncExercise), listOf(SyncTarget(6, 82.5)))), "Progress")) is Outcome.Committed)
                room.sync(server)
                room.store.refreshEngine()
                val result = async { if (applying) room.store.routines.applyProposal("proposal1") else room.store.routines.dismissProposal("proposal1") }
                runCurrent()
                server.refuse(code = code)
                room.sync(server)
                assertEquals(listOf(code), room.notices().map { it.member("code").str() })
                room.select("b")
                advanceTimeBy(25); runCurrent()
                assertEquals("The account changed. Open this again.", ((result.await() as ProposalOutcome.Failed).why as WriteFailure.Refused).words.spelled())
                assertEquals(emptyMap<String, Proposal>(), room.store.routines.settledProposals)
                assertEquals(emptyList<Routine>(), room.store.routines.all)
            }
        }
    }

    @Test
    fun notesReadSaveAndDeleteKeepOneAuthoritativeOrderAfterImmediateDeletion() = runTest {
        val server = EngineRoomFixture.server()
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { other ->
            other.select("a"); other.pull(server)
            for ((id, title, body) in listOf(Triple("note000a", "First", "Original"), Triple("note000b", "Second", "Keep"),
                    Triple("note000c", "Third", "Last"))) assertTrue(other.store.notes.saveNote(id, NoteWrite(title, body)) is GymResult.Ok)
            other.sync(server)
        }
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = FakeGymRest()).use { room ->
            room.select("a"); room.pull(server)
            val store = room.store
            val (first, second, third) = (store.notes.readNotes() as GymResult.Ok).value
            val saved = (store.notes.saveNote(first.id, NoteWrite("First", "Accepted edit")) as GymResult.Ok).value
            assertNull(store.deletions.delete(Deletion.Note(second.id)))
            assertTrue(store.notes.reorderNotes(first.id, listOf(third.id, third.id)) is GymResult.Failed)
            assertTrue(store.notes.reorderNotes(first.id, listOf(third.id, first.id)) is GymResult.Ok)
            assertEquals(listOf(third.copy(position = 0), saved.copy(position = 1)), store.notes.all)
            assertEquals(2, store.notes.noteCount)
            assertNull(store.deletions.keepWithheld())
            assertEquals(listOf(third.copy(position = 0), saved.copy(position = 1)), store.notes.all)
        }
    }
}

private fun Words?.spelled(): String? = this?.text(ApplicationProvider.getApplicationContext())
