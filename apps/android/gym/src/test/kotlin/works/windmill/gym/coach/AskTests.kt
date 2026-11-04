package works.windmill.gym.coach

import works.windmill.gym.coach.turn.CoachTurnFault
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.TurnPhone
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.AbilityRefusal
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadServed
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.domain.coach.RecordedRead
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.schema.Gym

class AskTests {
    @Test
    fun theRoomIsCalledCoachAndItsTwoStancesAreTheBlessedOnes() {
        assertEquals("Coach", Ask.title)
        assertEquals("Coach needs your workout log. Please sign in.", Ask.accessNeedsSignIn)
        assertEquals("This Windmill does not have Coach. You can still read your log.", Ask.notHere)
        assertEquals("the apostrophe is the typographic one everywhere",
            emptyList<String>(),
            (listOf(Ask.placeholder, Ask.promise, Ask.stopped, Ask.couldNotTake, CoachTurnFault.noAnswer.sentence, Ask.notHere, Ask.accountRequired, Ask.draftGone, Ask.draftInvalid, Ask.draftRetry))
                .filter { it.contains('\'') })
    }

    @Test
    fun theDoorIsShutOnABlankQuestionAndOnOneOverTheCeiling() {
        assertEquals(8000, Ask.maxQuestionBytes)
        assertEquals("", asked("   "))
        assertEquals("what’s stalled?", asked("  what’s stalled? "))
        assertNull(CoachTurnRefusal.TooLong.of("x".repeat(Ask.maxQuestionBytes)))
        assertEquals(CoachTurnRefusal.TooLong(1), CoachTurnRefusal.TooLong.of("x".repeat(Ask.maxQuestionBytes + 1)))
        assertEquals("the ceiling is bytes, not characters",
            CoachTurnRefusal.TooLong(2), CoachTurnRefusal.TooLong.of("é".repeat(Ask.maxQuestionBytes / 2 + 1)))
    }

    @Test
    fun theReceiptSpellsWhatWasServedAndLeavesOutWhatWasNot() {
        assertEquals("read 214 sets · 12 weeks · 34 sessions",
            Ask.receipt(ReadTally(sets = 214, sessions = 34, weeks = 12)))
        assertEquals("read 1 set · 1 week · 1 session",
            Ask.receipt(ReadTally(sets = 1, sessions = 1, weeks = 1)))
        assertEquals("read 34 sessions", Ask.receipt(ReadTally(sessions = 34)))
    }

    @Test
    fun anAnswerThatReadNothingSaysSo() {
        assertEquals("read nothing from your log", Ask.receipt(ReadTally()))
    }

    @Test
    fun anAnswerThatEndedShortSaysHowAndAWholeOneSaysNothing() {
        assertEquals(mapOf(
            MessageState.running to null,
            MessageState.completed to null,
            MessageState.stopped to "Response stopped.",
            MessageState.declined to "Coach couldn’t take that one",
            MessageState.failed to "Coach didn’t answer. Try again in a moment",
            MessageState.interrupted to "Coach didn’t answer. Try again in a moment",
        ), MessageState.entries.associateWith(Ask::ending))
    }

    private fun said(name: String, outcome: AbilityCall.Outcome = AbilityCall.Outcome.Ok): CoachCall {
        val ability = TurnPhone.catalog().ability(name)
        return coachCall(name, ability?.phrase, ability?.kind, outcome)
    }

    @Test
    fun aStepIsSaidInTheLiftersWordsFromTheCatalog() {
        assertEquals(
            listOf("read your recent workouts", "read your movement history", "read your notes", "saved a note", "read your bodyweight", "updated a movement", "created a routine"),
            coachReply(calls = listOf("list_sessions", "get_stats", "list_notes", "save_note", "list_bodyweight", "update_exercise", "create_routine").map { said(it) }).steps,
        )
    }

    @Test
    fun aToolThisBuildCannotNameOrThatWasRefusedPrintsNothingAndTheRestStillDo() {
        val reply = coachReply(calls = listOf(said("list_routines"), said("summon_lightning"),
            said("save_note", AbilityCall.Outcome.Refused(AbilityRefusal.refused)), said("get_stats")))
        assertEquals(listOf("read your program", "read your movement history"), reply.steps)
        assertEquals(listOf(null, null), listOf(said("summon_lightning").phrase, said("summon_lightning").kind))
        assertTrue(reply.calls.none { it.seatRefused })
        assertTrue(said("save_note", AbilityCall.Outcome.Refused(AbilityRefusal.seatRequired)).seatRefused)
    }

    @Test
    fun anAnswersReceiptSumsWhatItsCallsReadAndARefusedCallCountsNothing() {
        val routine = RecordRef(Gym.Types.routine, RecordID("rt_00000001"))
        val call = { name: String, outcome: AbilityCall.Outcome, read: RecordedRead, created: List<RecordRef> ->
            AbilityCall("toolu_$name", name, null, outcome, created, read)
        }
        val served = ReadServed.decode(Json.objectOf("sessions" to Json.Arr(listOf(Json.of("session01"))), "sets" to Json.Arr(emptyList()), "weeks" to Json.Arr(listOf(Json.of(1_785_000_000_000L)))))
        assertEquals(CoachReceipt(ReadTally(sets = 3, sessions = 1, weeks = 1), truncated = true, created = listOf(routine)), CoachReceipt(listOf(
            call("get_session", AbilityCall.Outcome.Ok, RecordedRead.Ids(served), emptyList()),
            call("list_sessions", AbilityCall.Outcome.Ok, RecordedRead.Counts(ReadTally(sets = 3)), emptyList()),
            call("create_routine", AbilityCall.Outcome.Ok, RecordedRead.Ids(ReadServed.none), listOf(routine)),
            call("get_stats", AbilityCall.Outcome.Refused(AbilityRefusal.refused), RecordedRead.Counts(ReadTally(sets = 9)), emptyList()),
        )))
        assertEquals(CoachReceipt(ReadTally(), truncated = false, created = emptyList()), CoachReceipt(emptyList()))
    }

    @Test
    fun aSeatNobodyHasReadYetIsNotAChangeOfLifter() {
        assertFalse("the frame before /v1/me answers, with u1's thread restored",
            Ask.handedOver("u1", standing = null, known = false))
        assertFalse("and then it answers, and it is the same lifter",
            Ask.handedOver("u1", standing = "u1", known = false))
        assertFalse("nobody has ever signed in on this install",
            Ask.handedOver("", standing = null, known = false))
    }

    @Test
    fun aSeatTheRoomHasReadTakesTheThreadWithIt() {
        assertTrue("signed out with the room already standing",
            Ask.handedOver("u1", standing = null, known = true))
        assertTrue("somebody else signed in", Ask.handedOver("u1", standing = "u2", known = false))
        assertTrue("and the first sign-in of a room that opened anonymous",
            Ask.handedOver("", standing = "u1", known = false))
    }
}
