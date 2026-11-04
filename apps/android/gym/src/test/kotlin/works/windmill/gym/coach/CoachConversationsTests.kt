package works.windmill.gym.coach

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
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
import works.windmill.domain.kit.Outcome
import works.windmill.domain.kit.Repository
import works.windmill.domain.kit.Seat
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.TurnPhone
import works.windmill.gym.domain.coach.AbilityExecutor
import works.windmill.gym.domain.coach.AbilityOutcome
import works.windmill.gym.domain.coach.AbilityRequest
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

// The room's read over a turn's records: the running words stand over a record that takes them every few seconds, and what a call served or wrote is read from the records now.
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CoachConversationsTests {
    @get:Rule val folder = TemporaryFolder()

    private fun TestScope.work() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)

    private fun EngineRoomFixture.coachRecord(): CoachMessage = engine.read(ScopeRef(Gym.scope)) { read ->
        Repository.decode(CoachMessage, read.drawn(CoachMessage.type)).single { it.role == CoachMessage.Role.coach }
    }

    @Test fun theRunningWordsStandOverTheRecordBetweenCommitsAndTheRecordsFinalTextWins() = runTest {
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"text","data":{"delta":" it all."}},{"event":"done","data":{"state":"completed"}}]""").arr())
        EngineRoomFixture(folder.newFolder(), work(), coachServer = server, localCoach = LocalCoach(folder.newFile("coach.json").apply { delete() })).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            backgroundScope.launch { conversations.observe() }
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceTimeBy(1_000)

            val running = checkNotNull(coach.exchanges(chat).single().answer)
            assertEquals("the record holds none of it until its next commit", "", room.coachRecord().text)
            assertEquals("", running.text)
            assertEquals(MessageState.running, running.state)
            assertEquals("Reading", conversations.standing(running).text)

            coach.stop()
            advanceUntilIdle()

            val ended = checkNotNull(coach.exchanges(chat).single().answer)
            assertEquals("Reading it all.", room.coachRecord().text)
            assertEquals("Reading it all.", ended.text)
            assertEquals(MessageState.completed, ended.state)
            assertSame("an ended message is its record's alone", ended, conversations.standing(ended))
            assertFalse(coach.isAsking(chat))
        }
    }

    @Test fun anAnswerAnotherDeviceWritesTakesNoWordsFromThisPhonesTurn() = runTest {
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""").arr())
        EngineRoomFixture(folder.newFolder(), work(), coachServer = server, localCoach = LocalCoach(folder.newFile("coach.json").apply { delete() })).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            backgroundScope.launch { conversations.observe() }
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceTimeBy(1_000)
            val elsewhere = coachReply("Words from the other phone", MessageState.running, id = "another-message", onThisPhone = false)
            assertSame(elsewhere, conversations.standing(elsewhere))
            coach.stop()
            advanceUntilIdle()
        }
    }

    @Test fun whatACallServedOrWroteIsReadFromTheRecordsNow() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val session = room.workout()
            val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
            val turn = (runner.run(OpenTurn(null, "Question")) as Outcome.Committed).result
            val executor = AbilityExecutor(runner, TurnPhone.catalog(), "https://windmill.works")
            fun ran(name: String, input: String) {
                val outcome = executor.run(AbilityRequest("call-$name", name, Json.parse(input)), turn.coach, Seat.bound)
                val answered = (outcome as Outcome.Committed).result
                assertTrue("$name ran: $answered", answered is AbilityOutcome.Result)
            }
            ran("list_sessions", "{}")
            ran("save_note", """{"id":"note00000001","title":"Shoulder","body":"Left shoulder hurts on wide-grip bench."}""")
            ran("create_exercise", """{"id":"ex_00000001","name":"Incline Dumbbell Press","pattern":"press","equipment":"dumbbell","stepKg":2.5}""")
            ran("create_routine", """{"id":"rt_00000001","name":"Push A","position":0,"entries":[{"exerciseId":"bench-press"},{"exerciseId":"ex_00000001"}]}""")
            ran("propose_routine_change", """{"id":"pr_00000001","routineId":"rt_00000001","summary":"Heavier.","entries":[{"exerciseId":"bench-press","sets":[{"reps":3,"weightKg":90}]}]}""")
            ran("list_notes", "{}")
            ran("list_routines", "{}")
            check(runner.run(EndTurn(turn.coach, MessageState.completed, "An answer")) is Outcome.Committed)

            val conversations = room.store.conversations
            val thread = checkNotNull(turn.thread.record.string)
            conversations.watch("chat", thread, emptyList())
            conversations.read()

            val reply = checkNotNull(conversations.exchanges("chat").single().answer)
            val day = DateTimeFormatter.ofPattern("MMM d").format(Instant.ofEpochMilli(session.startedAtMs).atZone(ZoneId.systemDefault()))
            assertEquals(listOf(
                "Read 1 workout" to "1 week · $day",
                "Saved a note" to "Shoulder",
                "Created a movement" to "Incline Dumbbell Press",
                "Created a routine" to "Push A",
                "Wrote a proposal for one of your routines" to "Push A · 2 changes",
                "Read your notes" to "1 note",
                "Read your program" to "Push A",
            ), reply.readRows.map { it.title to it.detail })
            assertEquals(listOf(CreatedRoutine("rt_00000001", "Push A", movements = 2)), reply.routines)
            assertEquals(listOf(SavedNote("note00000001", "Left shoulder hurts on wide-grip bench.")), reply.savedNotes)
            assertEquals(listOf(MadeMovement("ex_00000001", "Incline Dumbbell Press", "Dumbbells", 2.5)), reply.madeMovements)
            assertEquals("Read 1 workout · 1 week", reply.readLine)
            assertEquals("a proposal this phone minted names its routine before the server does", "Push A", room.training.proposal("pr_00000001")?.routineName)
        }
    }
}
