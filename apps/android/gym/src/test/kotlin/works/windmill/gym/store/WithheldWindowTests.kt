package works.windmill.gym.store

import kotlinx.coroutines.test.advanceTimeBy
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
import works.windmill.gym.coach.AskThread
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Routine
import works.windmill.gym.domain.RoutineDraft
import works.windmill.gym.domain.TrainingSet
import works.windmill.gym.net.FakeGymRest
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.sync.engine.signIn

class WithheldWindowTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun loggedSet(id: String = "set_1", weightKg: Double = 81.5, reps: Int = 5) =
        TrainingSet(id = id, exerciseId = "bench-press", weightKg = weightKg, reps = reps,
                    completedAtMs = 1_000)

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
        assertEquals("The Undo window closed.", Withheld.alreadyGone)

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

    @Test
    fun theConversationDeleteCarriesWhatItKeepsOnTheTransientItself() {
        assertEquals("your routine keeps what you applied", Deletion.Thread("thr_1").detail)
        val said = Withheld.line(listOf(WithheldDelete(Deletion.Thread("thr_1"), untilMs = 10_000)))!!
        assertEquals("Conversation deleted.\nyour routine keeps what you applied", said)
        assertEquals(2, said.lines().size)
        assertNull("and no other verb invents one",
            Deletion.Session("ses_1").detail ?: Deletion.Routine("rt_1", "Push A").detail
                ?: Deletion.Set("ses_1", loggedSet()).detail ?: Deletion.Note("nte_1").detail
                ?: Deletion.Bodyweight("2026-08-30").detail)
    }

    @Test
    fun anonymousDiscardIsAnAccountDecisionWithNoDeleteWindow() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            room.store.create("Unclaimed press", "machine", "exercise1")
            room.store.prepareEngineTransition()
            room.engine.signIn("u1", mapOf("gym" to true), mapOf("gym" to "discard"))
            room.selected = "u1"
            room.store.connect(room.account("u1"))
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull(room.store.holding)
            assertFalse(room.store.catalog.any { it.id == "exercise1" })
        }
    }

    @Test
    fun onlyTheVerbsTheLogCanRefuseCarryASentenceForAfterTheWindow() {
        assertEquals("that set is still on the log", Deletion.Set("ses_1", loggedSet()).stillThere)
        assertEquals("Push A is still in your program", Deletion.Routine("rt_1", "Push A").stillThere)
        assertEquals("that conversation is still here", Deletion.Thread("thr_1").stillThere)
        assertEquals("that session is still on the log", Deletion.Session("ses_1").stillThere)
        assertEquals("that note is still here", Deletion.Note("nte_1").stillThere)
        assertNull(Deletion.Bodyweight("2026-08-30").stillThere)
    }

    @Test
    fun oneHeldDeleteIsNamedAndSeveralAreCounted() {
        val two = listOf(
            WithheldDelete(Deletion.Thread("thr_1"), untilMs = 10_000),
            WithheldDelete(Deletion.Session("ses_1"), untilMs = 10_000),
        )

        assertEquals("2 deleted.", Withheld.line(two))
        assertEquals("one held thing is NAMED, never counted",
            "Session deleted.", Withheld.line(two.drop(1)))
        assertEquals("Weigh-in deleted.",
            Withheld.line(listOf(WithheldDelete(Deletion.Bodyweight("2026-08-30"), untilMs = 10_000))))
        assertNull(Withheld.line(emptyList()))
    }

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
    }

    @Test
    fun everyTransientSentenceNamesItsSubjectFirstAndEndsInAFullStop() {
        val said = listOf(
            Deletion.Set("ses_1", loggedSet()).line,
            Deletion.Routine("rt_1", "Push A").line,
            Deletion.Session("ses_1").line,
            Deletion.Thread("thr_1").line,
            Withheld.line(listOf(WithheldDelete(Deletion.Thread("t"), 1), WithheldDelete(Deletion.Thread("u"), 1)))!!,
            Withheld.alreadyGone,
        )

        assertEquals(
            listOf(
                "81.5 kg × 5 is out of the log.",
                "Push A deleted.",
                "Session deleted.",
                "Conversation deleted.",
                "2 deleted.",
                "The Undo window closed.",
            ),
            said,
        )
        assertTrue("every one of them ends in a full stop", said.all { it.endsWith(".") })
        assertEquals("Undo", Withheld.undo)
    }

    @Test
    fun testAConversationIsNotOnTheWireUntilItsOwnWindowCloses() = runTest {
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server).use { room ->
            room.select("u1")

            room.store.withhold(Deletion.Thread("thr_1"))
            runCurrent()
            val window = room.store.withheld.single().untilMs - room.now
            advanceTimeBy(window - 1)
            runCurrent()

            assertEquals("the row is off every list that reads it", setOf("thr_1"), room.store.withheldIds)
            assertTrue("and the log has not been asked anything",
                "deleteThread" !in server.calls)
            assertTrue("it is still there to come back to", "thr_1" in server.conversations)

            assertNotNull("so Undo is a local act", room.store.keepWithheld())
            assertEquals(emptySet<String>(), room.store.withheldIds)
            advanceTimeBy(Withheld.windowMs * 2)
            runCurrent()
            assertTrue("and the clock that would have sent it finds nothing owed",
                "deleteThread" !in server.calls)
            assertTrue("thr_1" in server.conversations)
        }
    }

    @Test
    fun testTheWindowClosingOnItsOwnSendsTheConversationAndNothingElse() = runTest {
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server).use { room ->
            room.select("u1")

            room.store.withhold(Deletion.Thread("thr_1"))
            runCurrent()
            val window = room.store.withheld.single().untilMs - room.now
            advanceTimeBy(window - 1)
            runCurrent()
            assertTrue("a millisecond before the window closes, nothing has gone",
                "thr_1" in server.conversations)

            advanceTimeBy(2)
            runCurrent()
            assertTrue("thr_1" !in server.conversations)
            assertEquals("and nothing else", listOf("deleteThread"), server.calls)
            assertEquals("and the window retires itself", emptyList<WithheldDelete>(), room.store.withheld)
            assertNull("with nothing to say — the ordinary settle is silent", room.store.deleteRefused)
        }
    }

    @Test
    fun testTwoDeletesInTheSameSecondBothCarryTheirOwnClockAndBothRestore() = runTest {
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "one")
        server.conversations["thr_2"] = AskThread(id = "thr_2", title = "two")
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server).use { room ->
            room.select("u1")

            room.store.withhold(Deletion.Thread("thr_1"))
            room.store.withhold(Deletion.Thread("thr_2"))

            assertEquals(setOf("thr_1", "thr_2"), room.store.withheldIds)
            assertEquals("nothing was settled by the second", listOf<String>(),
                server.calls.filter { it == "deleteThread" })
            assertEquals("two held can only be counted — naming one would say the wrong thing " +
                "about the other",
                "2 deleted.", Withheld.line(room.store.withheld))

            assertEquals("Undo takes the newest first",
                Deletion.Thread("thr_2"), room.store.keepWithheld()?.deletion)
            assertEquals("and the one left is named again — with what its delete keeps, which a count " +
                "could not have carried",
                "Conversation deleted.\nyour routine keeps what you applied",
                Withheld.line(room.store.withheld))
            assertEquals(Deletion.Thread("thr_1"), room.store.keepWithheld()?.deletion)

            advanceTimeBy(Withheld.windowMs * 2)
            runCurrent()
            assertEquals("both conversations survive", setOf("thr_1", "thr_2"), server.conversations.keys)
        }
    }

    @Test
    fun aRoutineLeavesTheProgramAtItsSettledDeleteWithNoUndo() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            assertNull(room.store.delete(Deletion.Routine(routine.id, routine.name)))
            assertEquals(emptyList<Routine>(), room.training.program())
            assertEquals(emptyList<Routine>(), room.store.routines)
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull(room.store.keepWithheld())
            assertNull(room.store.delete(Deletion.Routine(routine.id, routine.name)))
            assertEquals(1, room.outbox().count { entry -> entry.member("intent")["d"]?.arr()?.any {
                it["t"]?.str() == "routine" && it["life"]?.arr()?.first()?.str() == "dead"
            } == true })
        }
    }

    @Test
    fun testASessionWithheldIsOffTheLogAndItsSetsSurviveAnUndo() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val session = room.workout(82.5)
            runCurrent()

            room.store.withhold(Deletion.Session(session.id))

            assertEquals("the row is off the log", emptyList<String>(), room.store.recent.map { it.id })
            assertEquals("and the workout is still on the account", listOf(session.id),
                room.training.details().map { it.session.id })
            assertEquals("Session deleted.", Withheld.line(room.store.withheld))

            assertNotNull(room.store.keepWithheld())
            assertEquals(listOf(session.id), room.store.recent.map { it.id })
            assertEquals(listOf(82.5), room.training.session(session.id)!!.sets.map { it.weightKg })
        }
    }

    @Test
    fun testLeavingTheRoomAbandonsWhatItHeldAndTellsTheLogNothing() = runTest {
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server).use { room ->
            room.select("u1")
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press"))
                as GymResult.Ok).value

            room.store.withhold(Deletion.Thread("thr_1"))
            advanceTimeBy(1_000)
            runCurrent()

            assertTrue("the room was holding something, so the transient goes down with it",
                room.store.abandonWithheld())
            assertEquals("nothing is held any more", emptyList<WithheldDelete>(), room.store.withheld)
            assertEquals("the routine is back on the program",
                listOf(routine.id), room.store.routines.map { it.id })
            assertNull("and nothing is offered to take back — the delete never happened",
                Withheld.line(room.store.withheld))

            advanceTimeBy(Withheld.windowMs * 2)
            runCurrent()
            assertTrue("the clocks went down with the window", "deleteThread" !in server.calls)
            assertTrue("thr_1" in server.conversations)
            assertEquals(listOf(routine), room.training.program())
            assertNull("and nothing is said on the next open", room.store.deleteRefused)
            assertEquals("a second leaving has nothing left to let go of", false, room.store.abandonWithheld())
        }
    }

    @Test
    fun aSettledSetDeleteSurvivesLeavingTheRoom() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val session = room.workout()
            val taken = room.training.session(session.id)!!.sets.single()
            assertNull(room.store.delete(Deletion.Set(session.id, taken)))
            assertFalse(room.store.abandonWithheld())
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertNull(room.store.keepWithheld())
            advanceTimeBy(Withheld.windowMs * 2)
            runCurrent()
            assertEquals(emptyList<TrainingSet>(), room.training.session(session.id)!!.sets)
            assertEquals(setOf(taken.id), room.store.deletedSets)
        }
    }

    @Test
    fun aSettledSetDeleteQueuesExactlyOneIntent() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            val session = room.startExternalWorkout()
            room.store.choose("bench-press")
            room.store.logSet(weightKg = 82.5, reps = 5)
            room.store.logSet(weightKg = 90.0, reps = 3)
            room.now += 60_000
            assertTrue(room.store.finish() is FinishOutcome.Closed)
            val taken = room.training.session(session.id)!!.sets.first()

            assertNull(room.store.delete(Deletion.Set(session.id, taken)))
            advanceTimeBy(Withheld.windowMs + 1)
            runCurrent()

            assertEquals(listOf(taken.id), room.outbox().map { it.member("intent") }.filter { intent ->
                intent["d"]?.arr()?.any { it["t"]?.str() == "set" && it["life"]?.arr()?.first()?.str() == "dead" } == true
            }.map { it.member("d").arr().single().member("id").str() })
            assertEquals("the set is gone from the log", listOf(90.0),
                room.training.session(session.id)!!.sets.map { it.weightKg })
            assertEquals("and nothing is left holding it", emptyList<WithheldDelete>(), room.store.withheld)
        }
    }

    @Test
    fun testASecondWindowOverTheSameRowRunsItsOwnClockAndNotWhatIsLeftOfTheFirsts() = runTest {
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "one")
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server).use { room ->
            room.select("u1")

            room.store.withhold(Deletion.Thread("thr_1"))
            advanceTimeBy(Withheld.windowMs - 1_000)
            runCurrent()
            assertNotNull(room.store.keepWithheld())
            room.store.withhold(Deletion.Thread("thr_1"))

            advanceTimeBy(1_001)
            runCurrent()
            assertTrue("the first window's clock fires into nothing",
                "thr_1" in server.conversations)
            assertNotNull("and the second window is still the lifter's", room.store.holding)

            advanceTimeBy(Withheld.windowMs)
            runCurrent()
            assertTrue("its own clock is what finally sends it", "thr_1" !in server.conversations)
        }
    }

    @Test
    fun testARefusedSettleIsSaidOnceAndTheRowIsBackOnTheNextRead() = runTest {
        val server = FakeGymRest()
        server.conversations["thr_1"] = AskThread(id = "thr_1", title = "why is my bench stalled?")
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server).use { room ->
            room.select("u1")
            assertTrue(room.store.coach.readThreads() is GymResult.Ok)
            server.refuseThreads = WindmillApiException.Refused(500, Refusal(message = "internal error"))

            room.store.withhold(Deletion.Thread("thr_1"))
            advanceTimeBy(Withheld.windowMs + 1)
            runCurrent()

            assertEquals("the log's own words, the way every refusal in this room is said",
                "internal error", room.store.deleteRefused)
            assertEquals("the window is closed either way", emptyList<WithheldDelete>(), room.store.withheld)
            assertEquals("and the row is back, because nothing local was crossed out",
                listOf("thr_1"), room.store.coach.threads.map { it.id })

            room.store.clearDeleteRefused()
            assertNull("said once", room.store.deleteRefused)
        }
    }

    @Test
    fun aRoutineDeleteLeavesTheHeldWeightWindowRunning() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select(null)
            val routine = (room.store.saveRoutine(RoutineDraft(name = "Push A").adding("bench-press")) as GymResult.Ok).value
            assertNull(room.store.weighIn("2026-09-01", 81.25))
            room.store.withhold(Deletion.Bodyweight("2026-09-01"))
            runCurrent()
            val held = room.store.withheld.single()
            assertNull(room.store.delete(Deletion.Routine(routine.id, routine.name)))
            assertNull(room.training.routine(routine.id))
            assertEquals(listOf(held), room.store.withheld)
            room.now = held.untilMs
            room.engine.releaseHeld()
            room.store.refreshEngine()
            assertEquals(emptyList<WithheldDelete>(), room.store.withheld)
            assertEquals(emptyList<Any>(), room.training.weighins())
        }
    }

    @Test
    fun testASettledNoteDeleteTakesTheRowAndTheCapWithIt() = runTest {
        EngineRoomFixture(tmp.newFolder(), backgroundScope).use { room ->
            room.select("u1")
            repeat(10) { assertTrue(room.store.saveNote("note000$it", NoteWrite("note $it", "")) is GymResult.Ok) }
            room.store.readNotes()
            assertEquals(10, room.store.noteCount)

            assertNull(room.store.delete(Deletion.Note("note0003")))
            assertEquals("off the drawn list at once", 9, room.store.notes.size)
            assertEquals("the committed delete releases the note slot", 9, room.store.noteCount)

            advanceTimeBy(Withheld.windowMs + 1)
            runCurrent()
            assertEquals("the row stays gone", 9, room.store.notes.size)
            assertEquals("and the count is nine, so `Add a note` is offered again", 9, room.store.noteCount)
            assertEquals(9, room.training.notes().size)
        }
    }
}
