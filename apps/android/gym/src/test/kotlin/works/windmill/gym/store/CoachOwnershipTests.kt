package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.*
import works.windmill.gym.net.FakeTraining
import works.windmill.gym.net.TrainingSyncing
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class CoachOwnershipTests {
    @get:Rule val tmp = TemporaryFolder()
    private fun account(id: String) = Account(WindmillApi("https://windmill.works".toHttpUrl(), credential = { null }), User(id, "$id@example.com"))
    private fun TestScope.store(logs: Map<String, TrainingSyncing>) = TrainingStore(
        SetQueue(File(tmp.root, "queue")), DeviceCopy(File(tmp.root, "catalog")), LocalLog(File(tmp.root, "log")),
        LocalPreferences(File(tmp.root, "prefs")), LocalBodyweight(File(tmp.root, "weight")), backgroundScope,
        now = { 1_800_000_000_000 + testScheduler.currentTime }, sync = { logs[it.user?.id] })

    @Test
    fun aLateAnswerAndThreadReadCannotAppearInTheNextAccount() = runTest {
        val release = CompletableDeferred<Unit>()
        val server = FakeTraining()
        val old = AskThread("thread-a", "A's question", turns = listOf(AskTurn("coach", "Private answer")))
        val boundary = object : TrainingSyncing by server {
            override suspend fun ask(question: AskQuestion): AskAnswer { release.await(); return AskAnswer("Private answer", ReadTally(3, 1, 1)) }
            override suspend fun thread(id: String): AskThread { release.await(); return old }
            override suspend fun threads(): List<AskThread> { release.await(); return listOf(old) }
        }
        val store = store(mapOf("a" to boundary, "b" to FakeTraining()))
        store.connect(account("a"))
        val answer = async { store.ask("thread-a", "Question") }
        val detail = async { store.thread("thread-a") }
        val list = async { store.readThreads() }
        runCurrent()
        store.connect(account("b"))
        release.complete(Unit)
        assertEquals(AskOutcome.Refused("The account changed. Open this again."), answer.await())
        assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), detail.await())
        assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), list.await())
        assertEquals(emptyList<AskThread>(), store.allThreads)
    }

    @Test
    fun aStaleDecisionReadbackCannotReportItsVerdictAfterTheOwnerChanges() = runTest {
        for ((verb, code) in listOf(true to "proposal-superseded", false to "proposal-settled")) {
            val release = CompletableDeferred<Unit>()
            var holdRead = false
            val server = FakeTraining().apply {
                refuseApply = WindmillApiException.Refused(409, Refusal(message = "A's changed routine", code = code))
                refuseDismiss = refuseApply
            }
            val boundary = object : TrainingSyncing by server {
                override suspend fun routines(): List<Routine> { val answer = server.routines(); if (holdRead) release.await(); return answer }
            }
            val store = store(mapOf("a" to boundary, "b" to FakeTraining()))
            store.connect(account("a"))
            holdRead = true
            val result = async { if (verb) store.applyProposal("proposal-a") else store.dismissProposal("proposal-a") }
            runCurrent()
            store.connect(account("b"))
            release.complete(Unit)
            assertEquals(ProposalOutcome.Failed(WriteFailure.Refused("The account changed. Open this again.")), result.await())
            assertEquals(emptyMap<String, Proposal>(), store.settledProposals)
            assertEquals(emptyList<Routine>(), store.allRoutines)
        }
    }

    @Test
    fun notesReadSaveAndDeleteKeepOneAuthoritativeOrderAcrossHeldDeletion() = runTest {
        val first = Note("note-a", 1, "First", "Original")
        val second = Note("note-b", 2, "Second", "Keep")
        val third = Note("note-c", 3, "Third", "Last")
        val server = FakeTraining().apply { notebook += listOf(first, second, third) }
        val release = CompletableDeferred<Unit>()
        val boundary = object : TrainingSyncing by server {
            override suspend fun notes(): List<Note> { val answer = server.notes(); release.await(); return answer }
        }
        val store = store(mapOf("a" to boundary))
        store.connect(account("a"))
        val read = async { store.readNotes() }
        runCurrent()
        val save = async { store.saveNote(first.id, NoteWrite("First", "Accepted edit")) }
        runCurrent()
        assertFalse(save.isCompleted)
        release.complete(Unit)
        read.await()
        val saved = (save.await() as GymResult.Ok).value
        store.withhold(Deletion.Note(second.id))
        assertTrue(store.reorderNotes(listOf(third.id, third.id)) is GymResult.Failed)
        assertTrue(store.reorderNotes(listOf(third.id, first.id)) is GymResult.Ok)
        assertEquals(listOf(third.copy(position = 0), saved.copy(position = 2)), store.notes)
        assertEquals(3, store.noteCount)
        store.keepWithheld()
        assertEquals(listOf(third.copy(position = 0), second.copy(position = 1), saved.copy(position = 2)), store.notes)
    }

    @Test
    fun aLateSavedNoteCannotWriteOrCloseTheNextOwnersNotebook() = runTest {
        val release = CompletableDeferred<Unit>()
        val server = FakeTraining()
        val boundary = object : TrainingSyncing by server {
            override suspend fun writeNote(id: String, write: NoteWrite): Note { val answer = server.writeNote(id, write); release.await(); return answer }
        }
        val fresh = Note("note-b", 1, "B", "B's note")
        val store = store(mapOf("a" to boundary, "b" to FakeTraining().apply { notebook += fresh }))
        store.connect(account("a"))
        val save = async { store.saveNote("note-a", NoteWrite("A", "A's note")) }
        runCurrent()
        store.connect(account("b"))
        release.complete(Unit)
        assertEquals(GymResult.Failed(WriteFailure.Refused("The account changed. Open this again.")), save.await())
        store.readNotes()
        assertEquals(listOf(fresh), store.notes)
    }
}
