package works.windmill.gym.coach

import works.windmill.gym.spelled
import works.windmill.gym.string
import works.windmill.platform.i18n.text
import works.windmill.gym.R
import org.robolectric.annotation.Config
import org.robolectric.RobolectricTestRunner
import org.junit.runner.RunWith
import works.windmill.gym.coach.turn.contextCallPrefix
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AskTests {
    @Test
    fun theRoomIsCalledCoachAndItsTwoStancesAreTheBlessedOnes() {
        assertEquals("Coach", string(R.string.gym_coach_title))
        assertEquals("Coach needs your workout log. Please sign in.", string(R.string.gym_coach_access_needs_sign_in))
        assertEquals("This Windmill does not have Coach. You can still read your log.", string(R.string.gym_coach_not_here))
        assertEquals("the apostrophe is the typographic one everywhere",
            emptyList<String>(),
            (listOf(R.string.gym_coach_placeholder, R.string.gym_coach_promise, R.string.gym_coach_stopped, R.string.gym_coach_account_required, R.string.gym_coach_draft_gone,
                R.string.gym_coach_draft_invalid, R.string.gym_coach_draft_retry, R.string.gym_coach_could_not_take, CoachTurnFault.noAnswer.said, R.string.gym_coach_not_here).map(::string))
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
    fun theReceiptSaysTheWorkoutsItReadThenItsMovementHistoryThenNothingOverAnEmptyLogThenItsOtherReads() {
        assertEquals("Read 18 workouts · 6 weeks", coachReply(read = ReadTally(sets = 214, sessions = 18, weeks = 6)).readLine.spelled())
        assertEquals("Read 1 workout · 1 week", coachReply(read = ReadTally(sets = 1, sessions = 1, weeks = 1)).readLine.spelled())
        assertEquals("Read nothing from your log", coachReply().readLine.spelled())
        assertEquals("Read your movement history", coachReply(read = ReadTally(sets = 9, weeks = 2), calls = listOf(said("get_stats"))).readLine.spelled())
        assertEquals("Read 1 workout · 1 week", coachReply(read = ReadTally(sets = 1, sessions = 1, weeks = 1), calls = listOf(said("get_stats"), said("list_notes"))).readLine.spelled())
        assertEquals("Read your movement history", coachReply(read = ReadTally(sets = 9, weeks = 2), calls = listOf(said("list_notes"), said("get_stats"))).readLine.spelled())
        assertEquals("Read your notes · read your program", coachReply(calls = listOf(said("list_notes"), said("list_routines"))).readLine.spelled())
        val phoneReads = listOf("list_sessions", "list_notes", "list_exercises", "list_routines").map { said(it).copy(callId = contextCallPrefix + it) }
        val theyAll = "Read your recent workouts · read your notes · read your movement list · read your program"
        assertEquals("Read nothing from your log", coachReply(calls = phoneReads, logStood = false).readLine.spelled())
        assertEquals(theyAll, coachReply(calls = phoneReads, logStood = true).readLine.spelled())
        assertEquals("a read Coach chose says its phrase over an empty log", "$theyAll · read your bodyweight", coachReply(calls = phoneReads + said("list_bodyweight"), logStood = false).readLine.spelled())
        assertEquals("Read your notes", coachReply(calls = listOf(said("list_notes")), logStood = false).readLine.spelled())
        assertEquals("Read your movement history", coachReply(calls = phoneReads + said("get_stats"), logStood = false).readLine.spelled())
        assertEquals("Read 1 workout · 1 week", coachReply(read = ReadTally(sets = 1, sessions = 1, weeks = 1), calls = phoneReads, logStood = false).readLine.spelled())
        assertEquals("a write is no read", "Read nothing from your log", coachReply(calls = listOf(said("create_routine"))).readLine.spelled())
        assertEquals("a read that was refused did not run", "Read nothing from your log",
            coachReply(calls = listOf(said("list_notes", AbilityCall.Outcome.Refused(AbilityRefusal.refused)))).readLine.spelled())
        assertEquals("a read no phrase can say leaves no line", null, coachReply(calls = listOf(coachCall("list_notes", phrase = null))).readLine.spelled())
    }

    @Test
    fun anAnswerThatEndedShortSaysHowAndAWholeOneSaysNothing() {
        assertEquals(mapOf(
            MessageState.running to null,
            MessageState.completed to null,
            MessageState.stopped to "Stopped.",
            MessageState.declined to "Coach declined to answer this.",
            MessageState.failed to "Coach couldn’t finish. Ask again.",
            MessageState.interrupted to "Interrupted. What arrived is kept.",
        ), MessageState.entries.associateWith { Ask.ending(it, truncated = false, wordsArrived = true)?.let(::string) })
        assertEquals("Cut short. Ask Coach to go on.", Ask.ending(MessageState.completed, truncated = true, wordsArrived = true)?.let(::string))
    }

    @Test
    fun anAnswerWithNoWordsSaysHowItEndedAndAnInterruptionClaimsNothingArrived() {
        assertEquals(mapOf(
            MessageState.running to null,
            MessageState.completed to null,
            MessageState.stopped to "Stopped.",
            MessageState.declined to "Coach declined to answer this.",
            MessageState.failed to "Coach couldn’t finish. Ask again.",
            MessageState.interrupted to "Interrupted.",
        ), MessageState.entries.associateWith { Ask.ending(it, truncated = false, wordsArrived = false)?.let(::string) })
    }

    private fun said(name: String, outcome: AbilityCall.Outcome = AbilityCall.Outcome.Ok): CoachCall {
        val ability = TurnPhone.catalog().ability(name)
        return coachCall(name, ability?.phrase, outcome)
    }

    @Test
    fun aStepIsSaidInTheLiftersWordsFromTheCatalog() {
        assertEquals(
            "read your recent workouts · read your movement history · read your notes · saved a note · read your bodyweight · updated a movement · created a routine",
            coachReply(calls = listOf("list_sessions", "get_stats", "list_notes", "save_note", "list_bodyweight", "update_exercise", "create_routine").map { said(it) }).stepLine,
        )
    }

    @Test
    fun theStepLineJoinsThePhrasesOfTheCallsSoFarAndAnAnswerWithNoneDrawsNone() {
        assertEquals("read your recent workouts · read your notes · read your movement list · read your program · wrote a proposal for one of your routines",
            coachReply(calls = listOf("list_sessions", "list_notes", "list_exercises", "list_routines", "propose_routine_change").map { said(it) }).stepLine)
        assertEquals(null, coachReply().stepLine)
    }

    @Test
    fun aRowOfWhatCoachReadCountsTheWorkoutsItServedAndElseSaysItsPhrase() {
        val served = ReadServed.decode(Json.objectOf("sessions" to Json.Arr(listOf(Json.of("session01"), Json.of("session02"))), "sets" to Json.Arr(emptyList()), "weeks" to Json.Arr(listOf(Json.of(1_785_000_000_000L)))))
        assertEquals("Read 2 workouts", coachCall("list_sessions", "read your recent workouts", read = RecordedRead.Ids(served)).title.spelled())
        assertEquals("Read 3 workouts", coachCall("list_sessions", "read your recent workouts", read = RecordedRead.Counts(ReadTally(sessions = 3))).title.spelled())
        assertEquals("Read your recent workouts", coachCall("list_sessions", "read your recent workouts").title.spelled())
        assertEquals(null, coachCall("summon_lightning", phrase = null).title.spelled())
        assertEquals(listOf("list_routines"), coachReply(calls = listOf(said("list_routines"), said("summon_lightning"), said("get_stats", AbilityCall.Outcome.Refused(AbilityRefusal.refused)))).readRows.map { it.name })
    }

    @Test
    fun aToolThisBuildCannotNameOrThatWasRefusedPrintsNothingAndTheRestStillDo() {
        val reply = coachReply(calls = listOf(said("list_routines"), said("summon_lightning"),
            said("save_note", AbilityCall.Outcome.Refused(AbilityRefusal.refused)), said("get_stats")))
        assertEquals("read your program · read your movement history", reply.stepLine)
        assertEquals(null, said("summon_lightning").phrase)
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
        assertEquals(CoachReceipt(ReadTally(sets = 3, sessions = 1, weeks = 1), listOf(routine)), CoachReceipt(listOf(
            call("get_session", AbilityCall.Outcome.Ok, RecordedRead.Ids(served), emptyList()),
            call("list_sessions", AbilityCall.Outcome.Ok, RecordedRead.Counts(ReadTally(sets = 3)), emptyList()),
            call("create_routine", AbilityCall.Outcome.Ok, RecordedRead.Ids(ReadServed.none), listOf(routine)),
            call("get_stats", AbilityCall.Outcome.Refused(AbilityRefusal.refused), RecordedRead.Counts(ReadTally(sets = 9)), emptyList()),
        )))
        assertEquals(CoachReceipt(ReadTally(), emptyList()), CoachReceipt(emptyList()))
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
