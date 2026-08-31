package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.AskThread
import works.windmill.gym.domain.Ids
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.Session
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi

// One window over FOUR verbs, and the property the whole gesture wave stands on: withheld means NOT
// SENT. A server-only delete — a conversation — is as unsent as a set until its own clock runs out,
// so an Undo can never arrive after the wire.
//
// And the window is a LIST. A second delete never settles the first: behind a swipe two rows go in a
// second, and settling the first would send it while its own Undo was still on screen.
class WithheldWindowTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private var clockMs = 1_000L

    @Before
    fun setUp() {
        clockMs = 1_000
    }

    private fun TestScope.storeOver(server: FakeTraining) = TrainingStore(
        queue = SetQueue(File(tmp.root, "queue.json")) { clockMs },
        deviceCopy = DeviceCopy(File(tmp.root, "catalog.json")),
        localLog = LocalLog(File(tmp.root, "local.json")),
        localPreferences = LocalPreferences(File(tmp.root, "prefs.json")),
        localBodyweight = LocalBodyweight(File(tmp.root, "bodyweight.json")),
        scope = backgroundScope,
        now = { clockMs },
        mintSession = { "ses_1" },
        mintSet = Ids::set,
        undoWindowMs = SetQueue.undoWindowMs,
        sync = { if (it.isSignedIn) server else null },
    )

    private fun account() = Account(
        api = WindmillApi(baseUrl = "https://windmill.works".toHttpUrl(), credential = { null }),
        user = User(id = "u1", email = "sam@example.com", name = "Sam"),
    )

    private fun loggedSet(id: String = "set_1", weightKg: Double = 81.5, reps: Int = 5) =
        TrainingSet(id = id, exerciseId = "bench-press", weightKg = weightKg, reps = reps,
                    completedAtMs = 1_000)

    private suspend fun TestScope.seated(server: FakeTraining): TrainingStore {
        val store = storeOver(server)
        store.connect(account())
        return store
    }

    // The transient's bytes are a cross-surface contract, not this room's to invent: web, iOS and
    // Android say the same sentence about the same act, and every one of them ends in a full stop.
    @Test
    fun theTransientNamesWhichThingLeftAndCountsWhereItCannotName() {
        val set = TrainingSet(id = "set_1", exerciseId = "bench-press", weightKg = 81.5, reps = 5,
                              completedAtMs = 1_000)
        assertEquals("81.5 kg × 5 is out of the log.", Deletion.Set("ses_1", set).line)
        assertEquals("Push A deleted.", Deletion.Routine("rt_1", "Push A").line)
        assertEquals("Session deleted.", Deletion.Session("ses_1").line)
        assertEquals("Conversation deleted.", Deletion.Thread("thr_1").line)
        assertEquals("Note deleted.", Deletion.Note("nte_1").line)
        assertEquals("Weigh-in deleted.", Deletion.Bodyweight("2026-08-30").line)
        assertEquals("The window closed — that delete already went.", Withheld.alreadyGone)

        val held = listOf(
            WithheldDelete(Deletion.Thread("thr_1"), untilMs = 10_000),
            WithheldDelete(Deletion.Session("ses_1"), untilMs = 10_000),
        )
        assertEquals("Session deleted.", Withheld.line(held.take(2).drop(1)))
        assertEquals("2 deleted.", Withheld.line(held))
        assertNull(Withheld.line(emptyList()))
        assertNull("a delete already on the wire offers no way back, so it says nothing",
            Withheld.line(held.map { it.copy(sent = true) }))
    }

    // Said at the MOMENT of the act. It used to stand as a caption three screens deep inside the
    // conversation, where nobody is standing when they swipe a row on the list.
    @Test
    fun theConversationDeleteCarriesWhatItKeepsOnTheTransientItself() {
        assertEquals("your routine keeps what you applied", Deletion.Thread("thr_1").detail)
        // Two lines, and the second is the shorter half: a transient in the reach band gets one line
        // and two at most, and the detail is what moves to keep it there.
        val said = Withheld.line(listOf(WithheldDelete(Deletion.Thread("thr_1"), untilMs = 10_000)))!!
        assertEquals("Conversation deleted.\nyour routine keeps what you applied", said)
        assertEquals(2, said.lines().size)
        assertNull("and no other verb invents one",
            Deletion.Session("ses_1").detail ?: Deletion.Routine("rt_1", "Push A").detail
                ?: Deletion.Set("ses_1", loggedSet()).detail ?: Deletion.Note("nte_1").detail
                ?: Deletion.Bodyweight("2026-08-30").detail)
    }

    // The shelf is the one delete here with no copy anywhere else — the store says so itself — and
    // the only place that fact used to be said was the armed label of the two-tap this cut removed.
    // So it rides in the LINE: the lifter is no longer standing on the settings screen when it lands.
    @Test
    fun theShelfDiscardSaysThatThisPhoneWasTheOnlyPlaceItEverExisted() {
        assertEquals("Unclaimed training deleted — it was only on this phone.", Deletion.Unattributed.line)
        assertEquals("one shelf, one window: the id is a constant because the shelf has none",
            "unattributed", Deletion.Unattributed.subjectId)
        assertEquals("Unclaimed training deleted — it was only on this phone.",
            Withheld.line(listOf(WithheldDelete(Deletion.Unattributed, untilMs = 10_000))))
    }

    // A verb whose delete lands on THIS DEVICE and owes the log a claim has no terminal refusal, so
    // there is nothing to say after the window. Inventing a sentence would pin words no path reaches.
    @Test
    fun onlyTheVerbsTheLogCanRefuseCarryASentenceForAfterTheWindow() {
        assertEquals("that set is still on the log", Deletion.Set("ses_1", loggedSet()).stillThere)
        assertEquals("Push A is still in your program", Deletion.Routine("rt_1", "Push A").stillThere)
        assertEquals("that conversation is still here", Deletion.Thread("thr_1").stillThere)
        assertEquals("that session is still on the log", Deletion.Session("ses_1").stillThere)
        assertEquals("that note is still here", Deletion.Note("nte_1").stillThere)
        assertNull(Deletion.Bodyweight("2026-08-30").stillThere)
        assertNull(Deletion.Unattributed.stillThere)
    }

    // `2 deleted.` is a lie the moment the window also holds a set that was ADDED. Both live in the
    // same transient on this surface, so both are counted, and the count says which it is.
    @Test
    fun theCountSaysDeletedOnlyWhileEveryHeldThingIsADelete() {
        val two = listOf(
            WithheldDelete(Deletion.Thread("thr_1"), untilMs = 10_000),
            WithheldDelete(Deletion.Session("ses_1"), untilMs = 10_000),
        )

        assertEquals("2 deleted.", Withheld.line(two))
        assertEquals("2 to take back.", Withheld.line(two.take(1), justLogged = loggedSet()))
        assertEquals("3 to take back.", Withheld.line(two, justLogged = loggedSet()))
        assertEquals("one held thing is NAMED, never counted",
            "Session deleted.", Withheld.line(two.drop(1)))
        assertEquals("81.5 kg × 5 logged.", Withheld.line(emptyList(), justLogged = loggedSet()))
        assertEquals("81.5 kg × 5 is out of the log.",
            Withheld.line(listOf(WithheldDelete(Deletion.Set("ses_1", loggedSet()), untilMs = 10_000))))
        assertNull(Withheld.line(emptyList()))
    }

    // D9: naming one of several would say the wrong thing about the rest — including the detail,
    // which belongs to one act and not to a count.
    @Test
    fun aCountNamesNothingAndCarriesNoDetail() {
        val held = listOf(
            WithheldDelete(Deletion.Thread("thr_1"), untilMs = 10_000),
            WithheldDelete(Deletion.Thread("thr_2"), untilMs = 10_000),
        )

        val said = Withheld.line(held)!!
        assertEquals("2 deleted.", said)
        assertFalse("no detail rides a count", said.contains("routine’s history"))
        assertFalse("and no subject is named", said.contains("Conversation"))

        val mixed = Withheld.line(held.take(1), justLogged = loggedSet())!!
        assertEquals("2 to take back.", mixed)
        assertFalse(mixed.contains("Conversation"))
        assertFalse(mixed.contains("81.5"))
    }

    // D1's list, re-read: the subject first, then what happened to it, and a full stop on every one.
    @Test
    fun everyTransientSentenceNamesItsSubjectFirstAndEndsInAFullStop() {
        val said = listOf(
            Deletion.Set("ses_1", loggedSet()).line,
            Deletion.Routine("rt_1", "Push A").line,
            Deletion.Session("ses_1").line,
            Deletion.Thread("thr_1").line,
            Withheld.logged(loggedSet()),
            Withheld.line(listOf(WithheldDelete(Deletion.Thread("t"), 1), WithheldDelete(Deletion.Thread("u"), 1)))!!,
            Withheld.alreadyGone,
        )

        assertEquals(
            listOf(
                "81.5 kg × 5 is out of the log.",
                "Push A deleted.",
                "Session deleted.",
                "Conversation deleted.",
                "81.5 kg × 5 logged.",
                "2 deleted.",
                "The window closed — that delete already went.",
            ),
            said,
        )
        assertTrue("every one of them ends in a full stop", said.all { it.endsWith(".") })
        assertEquals("Undo", Withheld.undo)
    }

    @Test
    fun testAConversationIsNotOnTheWireUntilItsOwnWindowCloses() = runTest {
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = seated(server)

        store.withhold(Deletion.Thread("thr_1"))
        // Right up to the last millisecond of the window, with every dispatch it could have taken.
        advanceTimeBy(SetQueue.undoWindowMs - 1)
        runCurrent()

        assertEquals("the row is off every list that reads it", setOf("thr_1"), store.withheldIds)
        assertTrue("and the log has not been asked anything",
            "deleteThread" !in server.calls)
        assertTrue("it is still there to come back to", "thr_1" in server.conversations)

        assertNotNull("so Undo is a local act", store.keepWithheld())
        assertEquals(emptySet<String>(), store.withheldIds)
        advanceTimeBy(SetQueue.undoWindowMs * 2)
        runCurrent()
        assertTrue("and the clock that would have sent it finds nothing owed",
            "deleteThread" !in server.calls)
        assertTrue("thr_1" in server.conversations)
    }

    @Test
    fun testTheWindowClosingOnItsOwnSendsTheConversationAndNothingElse() = runTest {
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = seated(server)

        store.withhold(Deletion.Thread("thr_1"))
        advanceTimeBy(SetQueue.undoWindowMs - 1)
        runCurrent()
        assertTrue("a millisecond before the window closes, nothing has gone",
            "thr_1" in server.conversations)

        advanceTimeBy(2)
        runCurrent()
        assertTrue("thr_1" !in server.conversations)
        assertEquals("and the window retires itself", emptyList<WithheldDelete>(), store.withheld)
        assertNull("with nothing to say — the ordinary settle is silent", store.deleteRefused)
    }

    @Test
    fun testTwoDeletesInTheSameSecondBothCarryTheirOwnClockAndBothRestore() = runTest {
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "one")
        server.conversations["thr_2"] = AskThread(id = "thr_2", title = "two")
        val store = seated(server)

        store.withhold(Deletion.Thread("thr_1"))
        store.withhold(Deletion.Thread("thr_2"))

        assertEquals(setOf("thr_1", "thr_2"), store.withheldIds)
        assertEquals("nothing was settled by the second", listOf<String>(),
            server.calls.filter { it == "deleteThread" })
        assertEquals("two held can only be counted — naming one would say the wrong thing " +
            "about the other",
            "2 deleted.", Withheld.line(store.withheld))

        assertEquals("Undo takes the newest first",
            Deletion.Thread("thr_2"), store.keepWithheld()?.deletion)
        assertEquals("and the one left is named again — with what its delete keeps, which a count " +
            "could not have carried",
            "Conversation deleted.\nyour routine keeps what you applied",
            Withheld.line(store.withheld))
        assertEquals(Deletion.Thread("thr_1"), store.keepWithheld()?.deletion)

        advanceTimeBy(SetQueue.undoWindowMs * 2)
        runCurrent()
        assertEquals("both conversations survive", setOf("thr_1", "thr_2"), server.conversations.keys)
    }

    @Test
    fun testARoutineIsOffTheProgramWhileItsWindowIsOpenAndComesBackWhole() = runTest {
        val server = FakeTraining()
        val store = seated(server)
        val routine = (store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press"))
            as GymResult.Ok).value

        store.withhold(Deletion.Routine(routine.id, routine.name))

        assertEquals("off every screen that reads the program", emptyList<String>(),
            store.routines.map { it.id })
        assertNull(store.routine(routine.id))
        assertTrue("and the log still holds it", routine.id in server.written)
        assertEquals("Push A deleted.", Withheld.line(store.withheld))

        assertNotNull(store.keepWithheld())
        assertEquals("back whole, because nothing was ever sent",
            listOf(routine), store.routines)

        store.withhold(Deletion.Routine(routine.id, routine.name))
        advanceTimeBy(SetQueue.undoWindowMs + 1)
        runCurrent()
        assertTrue("and the window closing is what finally tells the log",
            routine.id !in server.written)
        assertEquals(emptyList<String>(), store.routines.map { it.id })
    }

    @Test
    fun testASessionWithheldIsOffTheLogAndItsSetsSurviveAnUndo() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = seated(server)
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        clockMs += 60_000
        store.flushPendingSets(force = true)
        store.finish()

        store.withhold(Deletion.Session("ses_1"))

        assertEquals("the row is off the log", emptyList<String>(), store.recent.map { it.id })
        assertTrue("and the workout is still on the account", "ses_1" in server.stored)
        assertEquals("Session deleted.", Withheld.line(store.withheld))

        assertNotNull(store.keepWithheld())
        assertEquals(listOf("ses_1"), store.recent.map { it.id })
        assertEquals(listOf(82.5), server.sets.getValue("ses_1").map { it.weightKg })
    }

    // D11. The window lives only while the room is on screen in a live process. Leaving it — the app
    // going to the background, the room going away for good, or the process dying — ABANDONS
    // everything the room alone was holding: the rows come back, nothing goes on the wire, and
    // nothing is said afterwards, because nothing happened. Settling on the way out instead would
    // make `swipe · switch apps · come back` an unrecoverable delete reached by two ordinary
    // actions, which is precisely what the withheld window exists to prevent.
    @Test
    fun testLeavingTheRoomAbandonsWhatItHeldAndTellsTheLogNothing() = runTest {
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        val store = seated(server)
        val routine = (store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press"))
            as GymResult.Ok).value

        store.withhold(Deletion.Thread("thr_1"))
        store.withhold(Deletion.Routine(routine.id, routine.name))
        advanceTimeBy(1_000)
        runCurrent()

        assertTrue("the room was holding something, so the transient goes down with it",
            store.abandonWithheld())
        assertEquals("nothing is held any more", emptyList<WithheldDelete>(), store.withheld)
        assertEquals("the routine is back on the program",
            listOf(routine.id), store.routines.map { it.id })
        assertNull("and nothing is offered to take back — the delete never happened",
            Withheld.line(store.withheld))

        advanceTimeBy(SetQueue.undoWindowMs * 2)
        runCurrent()
        assertTrue("the clocks went down with the window", "deleteThread" !in server.calls)
        assertTrue("thr_1" in server.conversations)
        assertTrue(routine.id in server.written)
        assertNull("and nothing is said on the next open", store.deleteRefused)
        assertEquals("a second leaving has nothing left to let go of", false, store.abandonWithheld())
    }

    // D13. There is no exception. A set's delete was exempted from the abandon on the belief that it
    // rode the on-disk queue as it does on iOS; on this surface it sits in the very same in-memory
    // list as every other verb, with no queue, no disk and no retry behind it. The exemption left it
    // strictly worse off than the deletes that abandon: it fired from a backgrounded app, timed out
    // ten seconds later against a host nothing had reached, and was dropped whatever the send
    // answered — a delete lost in silence, reached by `swipe · press Home`. So it abandons with the
    // rest: the row comes back, nothing is on the wire, nothing is said.
    @Test
    fun testASetsDeleteIsAbandonedWithEverythingElseBecauseNothingHereOutlivesTheRoom() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = seated(server)
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 90.0, reps = 3)
        clockMs += 60_000
        store.flushPendingSets(force = true)
        store.finish()
        val taken = server.sets.getValue("ses_1").first()

        store.withhold(Deletion.Set("ses_1", taken))
        advanceTimeBy(2_000)
        runCurrent()

        assertEquals("the room was holding it, so the transient goes down with it",
            true, store.abandonWithheld())
        assertEquals("nothing is held any more", emptyList<WithheldDelete>(), store.withheld)
        assertEquals("and the row is back on the session it left", emptySet<String>(),
            store.withheldIds)
        assertNull("with nothing offered to take back — the delete never happened",
            Withheld.line(store.withheld))

        advanceTimeBy(SetQueue.undoWindowMs * 2)
        runCurrent()
        assertEquals("the clock went down with the window: nothing was ever sent",
            emptyList<Pair<String, String>>(), server.removed)
        assertEquals("both sets are still on the log", listOf(82.5, 90.0),
            server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("and the room crossed nothing out locally either",
            emptySet<String>(), store.deletedSets)
        assertNull("nothing is said on the next open, because nothing happened", store.deleteRefused)
    }

    // The control on the ruling above: abandoning is what leaving does, not what a set's delete does.
    // Left alone on screen the window closes on its own clock and puts exactly one delete on the wire.
    @Test
    fun testASetLeftAloneOnScreenStillSettlesOnItsOwnClockAndSendsOneDelete() = runTest {
        val server = FakeTraining()
        server.open(Session(id = "ses_1", startedAtMs = 1_000))
        val store = seated(server)
        store.choose("bench-press")
        store.logSet(weightKg = 82.5, reps = 5)
        store.logSet(weightKg = 90.0, reps = 3)
        clockMs += 60_000
        store.flushPendingSets(force = true)
        store.finish()
        val taken = server.sets.getValue("ses_1").first()

        store.withhold(Deletion.Set("ses_1", taken))
        advanceTimeBy(SetQueue.undoWindowMs + 1)
        runCurrent()

        assertEquals(listOf("ses_1" to taken.id), server.removed)
        assertEquals("the set is gone from the log", listOf(90.0),
            server.sets.getValue("ses_1").map { it.weightKg })
        assertEquals("and nothing is left holding it", emptyList<WithheldDelete>(), store.withheld)
    }

    // Deleting the same row twice is two acts with two windows, and the first one's clock is taken
    // down with it. Left running — which is what abandoning a window would leave behind — it settles
    // the SECOND window early: a delete on the wire with its own Undo still on screen, the one lie
    // this whole mechanism exists to prevent.
    @Test
    fun testASecondWindowOverTheSameRowRunsItsOwnClockAndNotWhatIsLeftOfTheFirsts() = runTest {
        val server = FakeTraining()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "one")
        val store = seated(server)

        store.withhold(Deletion.Thread("thr_1"))
        advanceTimeBy(SetQueue.undoWindowMs - 1_000)
        runCurrent()
        assertNotNull(store.keepWithheld())
        store.withhold(Deletion.Thread("thr_1"))

        advanceTimeBy(1_001)
        runCurrent()
        assertTrue("the first window's clock fires into nothing",
            "thr_1" in server.conversations)
        assertNotNull("and the second window is still the lifter's", store.holding)

        advanceTimeBy(SetQueue.undoWindowMs)
        runCurrent()
        assertTrue("its own clock is what finally sends it", "thr_1" !in server.conversations)
    }

    @Test
    fun testARefusedSettleIsSaidOnceAndTheRowIsBackOnTheNextRead() = runTest {
        val server = FakeTraining()
        val store = seated(server)
        val routine = (store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press"))
            as GymResult.Ok).value
        server.refuseRoutineDelete = works.windmill.platform.net.WindmillApiException.Refused(
            500, works.windmill.platform.net.Refusal(message = "internal error"))

        store.withhold(Deletion.Routine(routine.id, routine.name))
        advanceTimeBy(SetQueue.undoWindowMs + 1)
        runCurrent()

        assertEquals("the log's own words, the way every refusal in this room is said",
            "internal error", store.deleteRefused)
        assertEquals("the window is closed either way", emptyList<WithheldDelete>(), store.withheld)
        assertEquals("and the row is back, because nothing local was crossed out",
            listOf(routine.id), store.routines.map { it.id })

        store.clearDeleteRefused()
        assertNull("said once", store.deleteRefused)
    }

    // A day is the ONE subject a later write can name again — every other key here is a minted id
    // nothing reuses — so weighing the day again IS the undo. Left queued behind the delete, the
    // number the lifter had just saved was invisible from the moment the sheet reported success and
    // gone off the log nine seconds later.
    @Test
    fun testAWeighInForAHeldDayTakesThatWindowBackInsteadOfQueueingBehindIt() = runTest {
        val server = FakeTraining()
        val store = seated(server)
        val day = "2026-08-31"
        store.weighIn(day, 82.0)

        store.withhold(Deletion.Bodyweight(day))
        assertEquals("the dot is off the chart and off the log's head reading",
            emptyList<String>(), store.bodyweight.map { it.dateLocal })

        assertNull("the log takes the new number", store.weighIn(day, 79.5))
        assertEquals("and nothing is holding the day any more", emptyList<WithheldDelete>(), store.withheld)
        assertEquals("so it is drawn the instant it is saved", listOf(day), store.bodyweight.map { it.dateLocal })

        advanceTimeBy(SetQueue.undoWindowMs + 1)
        runCurrent()
        assertEquals("and the clock that would have deleted it is down",
            listOf(79.5), store.bodyweight.map { it.weightKg })
        assertEquals(79.5, server.weighIns.getValue(day).weightKg, 0.0)
        assertEquals(emptyList<String>(), server.calls.filter { it == "deleteBodyweight" })
    }

    // The shelf's discard re-reads the room for the seat already in hand. That re-read may not take
    // the OTHER windows down with it: a delete dropped there is never sent, never said and its
    // transient has already promised the lifter it happened.
    @Test
    fun testTheShelfsDiscardSettlesItselfAndLeavesEveryOtherWindowRunning() = runTest {
        val server = FakeTraining()
        val store = seated(server)
        store.readNotes()
        server.writeNote("note_1", works.windmill.gym.domain.NoteWrite("Tone", "blunt"))
        store.readNotes()

        store.withhold(Deletion.Note("note_1"))
        store.withhold(Deletion.Unattributed)
        assertEquals(listOf("note_1", "unattributed"), store.withheld.map { it.subjectId })

        store.settleWithheld(Deletion.Unattributed.subjectId)
        assertEquals("the note's own clock is still the lifter's",
            listOf("note_1"), store.withheld.map { it.subjectId })

        advanceTimeBy(SetQueue.undoWindowMs + 1)
        runCurrent()
        assertEquals("and it reaches the wire on that clock", listOf("deleteNote"),
            server.calls.filter { it == "deleteNote" })
        assertEquals(emptyList<String>(), server.notebook.map { it.id })
    }

    // The notebook is the STORE's, so a settled delete drops the row AND the count together. A
    // screen holding a snapshot of its own drew the note back the moment the window closed, and kept
    // saying `10 of 10` over a log that held nine.
    @Test
    fun testASettledNoteDeleteTakesTheRowAndTheCapWithIt() = runTest {
        val server = FakeTraining()
        val store = seated(server)
        repeat(10) { server.writeNote("note_$it", works.windmill.gym.domain.NoteWrite("note $it", "")) }
        store.readNotes()
        assertEquals(10, store.noteCount)

        store.withhold(Deletion.Note("note_3"))
        assertEquals("off the drawn list at once", 9, store.notes.size)
        assertEquals("and the cap still counts it, because the log will refuse the eleventh",
            10, store.noteCount)

        advanceTimeBy(SetQueue.undoWindowMs + 1)
        runCurrent()
        assertEquals("the row stays gone", 9, store.notes.size)
        assertEquals("and the count is nine, so `Add a note` is offered again", 9, store.noteCount)
        assertEquals(9, server.notebook.size)
    }
}
