package works.windmill.gym.coach

import works.windmill.gym.spelled
import works.windmill.gym.R
import works.windmill.platform.i18n.text
import works.windmill.platform.i18n.Words
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.domain.kit.Repository
import works.windmill.domain.kit.Seat
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.coach.turn.contextCallPrefix
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.coach.turn.TurnPhone
import works.windmill.gym.domain.coach.AbilityOutcome
import works.windmill.gym.domain.coach.AbilityRequest
import works.windmill.gym.domain.coach.RunAbility
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.DeleteConversation
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.sync.api.Change
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
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

    // The room's first composition asks for the selected chat, and a connect reads again: neither reads anything while no screen of Coach stands.
    @Test fun aSeatThatNeverOpensCoachReadsNothingOfIt() = runTest {
        val file = File(folder.newFolder(), LocalCoach.fileName)
        val answers = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Hi"}},{"event":"done","data":{"state":"completed"}}]""").arr())
        val seed = EngineRoomFixture(folder.newFolder(), work(), localCoach = LocalCoach(file), coachServer = answers).use { room ->
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            assertTrue(room.store.coach.send(room.store.coach.freshChat(), "Question"))
            advanceUntilIdle()
            room.engine.snapshot()
        }
        EngineRoomFixture(folder.newFolder(), work(), snapshot = seed, localCoach = LocalCoach(file), coachServer = answers, coachShown = false).use { room ->
            room.selected = "alice"
            room.store.observeEngine()
            room.store.connect(room.account("alice"))
            val chat = checkNotNull(room.store.coach.selectedChatId)
            advanceUntilIdle()
            room.store.conversations.read()
            assertEquals(emptyList<CoachThread>(), room.store.conversations.threads)
            assertEquals(emptyList<CoachExchange>(), room.store.coach.exchanges(chat))
            assertNull(room.store.conversations.rows)

            room.store.conversations.showing(true)
            advanceUntilIdle()
            assertEquals(listOf("Question"), room.store.coach.exchanges(chat).map { it.question })
            assertEquals(listOf("Question"), room.store.conversations.threads.map { it.title })
        }
    }

    // A frame sliding away and the one taking its place both stand for a moment; the reads stop with the last, and a turn running then keeps its words and asks for no read.
    @Test fun theReadsFollowTheScreensAndARunningTurnAsksForNone() = runTest {
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"text","data":{"delta":" it all."}},{"event":"done","data":{"state":"completed"}}]""").arr())
        EngineRoomFixture(folder.newFolder(), work(), coachServer = server, localCoach = LocalCoach(File(folder.newFolder(), LocalCoach.fileName)), coachShown = false).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            backgroundScope.launch { conversations.observe() }
            conversations.showing(true)
            conversations.showing(true)
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceTimeBy(1_000)
            conversations.showing(false)
            val running = checkNotNull(coach.exchanges(chat).single().answer)
            coach.stop()
            advanceTimeBy(1_000)
            conversations.showing(false)
            assertEquals("Reading it all.", room.coachRecord().text)
            assertEquals("the last screen read the end", MessageState.completed, coach.exchanges(chat).single().answer?.state)

            val second = coach.freshChat()
            server.rewind()
            assertTrue(coach.send(second, "Another"))
            advanceTimeBy(1_000)
            assertEquals("no screen reads the second turn", listOf("Question"), conversations.threads.map { it.title })
            assertEquals("its words follow all the same", "Reading", conversations.standing(running.copy(id = checkNotNull(room.store.coachTurns?.turn?.value?.coach?.record?.string))).text)

            conversations.showing(true)
            advanceTimeBy(1_000)
            assertEquals(setOf("Question", "Another"), conversations.threads.map { it.title }.toSet())
            assertEquals(listOf("Another"), coach.exchanges(second).map { it.question })
            coach.stop()
            advanceUntilIdle()
        }
    }

    // What a return draws before its first read lands. A turn of this phone's that ended while nothing watched is no longer on its way, and the read says how it ended. History's row of it is held back for that read, as a first visit's are.
    @Test fun theFirstFrameOfAReturnDrawsNoEndedTurnAsRunning() = runTest {
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"text","data":{"delta":" it all."}},{"event":"done","data":{"state":"completed"}}]""").arr())
        EngineRoomFixture(folder.newFolder(), work(), coachServer = server, localCoach = LocalCoach(File(folder.newFolder(), LocalCoach.fileName)), coachShown = false).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            backgroundScope.launch { conversations.observe() }
            conversations.showing(true)
            conversations.watchHistory(true)
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceTimeBy(1_000)
            assertEquals(listOf(MessageState.running), coach.exchanges(chat).map { it.answer?.state })
            assertTrue(coach.exchanges(chat).single().waiting)
            assertEquals(listOf(true), coach.history.map { it.answering })

            conversations.watchHistory(false)
            conversations.showing(false)
            coach.stop()
            advanceUntilIdle()
            runCurrent()
            val first = coach.exchanges(chat).single()
            assertFalse(first.waiting)
            assertEquals("", first.answer?.text)
            assertNull(conversations.rows)

            conversations.showing(true)
            conversations.watchHistory(true)
            advanceTimeBy(1_000)
            val read = checkNotNull(coach.exchanges(chat).single().answer)
            assertEquals(MessageState.completed, read.state)
            assertEquals("Reading it all.", read.text)
            assertEquals(listOf(false), coach.history.map { it.answering })
        }
    }

    // A running message from another phone is that phone's: its turn may be alive, so a return draws it running.
    @Test fun aRunningMessageFromAnotherPhoneStaysRunningOnAReturn() = runTest {
        val log = EngineRoomFixture.server()
        val turn = EngineRoomFixture(folder.newFolder(), work()).use { other ->
            other.select("alice")
            other.sync(log)
            val runner = ActionRunner(other.engine, other.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
            (runner.run(OpenTurn(null, "Question")) as Outcome.Committed).result.also { other.sync(log) }
        }
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList()), localCoach = LocalCoach(File(folder.newFolder(), LocalCoach.fileName))).use { room ->
            room.select("alice")
            room.sync(log)
            val coach = room.store.coach
            val conversations = room.store.conversations
            val chat = checkNotNull(turn.thread.record.string)
            coach.selectChat(chat)
            conversations.read()
            conversations.showing(false)
            val first = coach.exchanges(chat).single()
            assertTrue(first.waiting)
            assertEquals(true, first.answer?.elsewhere)
        }
    }

    // A visit's rows stand while the log stands still, so a return with nothing new draws them at once. Once the log has moved none of them is drawn, a conversation deleted since among them, until the return's first read.
    @Test fun aReturnToHistoryDrawsNoRowOfAConversationDeletedSince() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList()), localCoach = LocalCoach(File(folder.newFolder(), LocalCoach.fileName)), coachShown = false).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            backgroundScope.launch { conversations.observe() }
            val thread = room.heldConversation("Old question")
            conversations.watchHistory(true)
            advanceTimeBy(1_000)
            assertEquals(listOf(thread), coach.history.map { it.id })
            conversations.watchHistory(false)
            advanceTimeBy(1_000)
            assertEquals(listOf(thread), coach.history.map { it.id })

            val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
            assertTrue(runner.run(DeleteConversation(Id(thread, CoachThread))) is Outcome.Committed)
            advanceTimeBy(1_000)
            assertNull(conversations.rows)
            assertEquals(emptyList<ConversationRow>(), coach.history)

            conversations.watchHistory(true)
            advanceTimeBy(1_000)
            assertEquals(emptyList<ConversationRow>(), conversations.rows)
        }
    }

    // A verified flip or a recreated room connects the seat in hand again: nothing it read leaves the screen on the way, the words of a running answer among it.
    @Test fun aSameOwnerConnectKeepsTheConversationAndTheRunningWordsThroughItsReads() = runTest {
        val server = ScriptedTurns(Json.parse("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""").arr())
        EngineRoomFixture(folder.newFolder(), work(), coachServer = server, localCoach = LocalCoach(File(folder.newFolder(), LocalCoach.fileName)), readDispatcher = StandardTestDispatcher(testScheduler)).use { room ->
            val coach = room.store.coach
            val conversations = room.store.conversations
            backgroundScope.launch { conversations.observe() }
            room.select("alice")
            room.sync(EngineRoomFixture.server())
            val chat = coach.freshChat()
            assertTrue(coach.send(chat, "Question"))
            advanceTimeBy(1_000)
            conversations.watchHistory(true)
            advanceTimeBy(1_000)
            val running = checkNotNull(coach.exchanges(chat).single().answer)
            val rows = conversations.rows

            val connecting = launch(start = CoroutineStart.UNDISPATCHED) { room.store.connect(room.account("alice")) }
            assertFalse("the connect is under way, on its first read", connecting.isCompleted)
            assertEquals(listOf("Question"), coach.exchanges(chat).map { it.question })
            assertEquals(listOf("Question"), conversations.threads.map { it.title })
            assertEquals(rows, conversations.rows)
            assertEquals("Reading", conversations.standing(running).text)
            connecting.join()
            advanceTimeBy(1_000)
            assertEquals(listOf("Question"), coach.exchanges(chat).map { it.question })
            assertEquals("Reading", conversations.standing(checkNotNull(coach.exchanges(chat).single().answer)).text)
            coach.stop()
            advanceUntilIdle()
        }
    }

    // History reads every message on every revision, so a row asks only what it says: a message whose calls this build cannot read still dates and previews its row, and nothing is reported.
    @Test fun aHistoryRowReadsOnlyWhatItSaysOfEachMessage() = runTest {
        val telling = TellingRecorder()
        EngineRoomFixture(folder.newFolder(), work(), telemetry = telling, coachServer = ScriptedTurns(emptyList())).use { room ->
            room.store.connect(room.account(null))
            val gym = ScopeRef(Gym.scope)
            fun message(id: String, role: String, at: Long, text: String, extra: Map<String, Json> = emptyMap()) = Change.create(Gym.Types.message, NewID.Given(RecordID(id)),
                mapOf("threadId" to Json.of("thread-one"), "role" to Json.of(role), "at" to Json.of(at), "text" to Json.of(text)) + extra)
            room.engine.commit(gym, Gesture(listOf(
                Change.create(Gym.Types.thread, NewID.Given(RecordID("thread-one")), mapOf("title" to Json.of("First question"))),
                message("message-1", "lifter", 1_000, "First question"),
                message("message-2", "coach", 2_000, "The first answer", mapOf("state" to Json.of("completed"), "calls" to Json.objectOf("not" to Json.of("an array")))),
                message("message-3", "lifter", 3_000, "Second question"),
                message("message-4", "coach", 4_000, "", mapOf("state" to Json.of("running"))),
            )))
            room.store.conversations.watchHistory(true)
            room.store.conversations.read()
            assertEquals(listOf(ConversationRow("thread-one", Words.Plain("First question"), 4_000, answering = true, answerPreview = "The first answer")), room.store.conversations.rows)
            assertEquals(emptyList<Map<String, String>>(), telling.failures)
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

    private fun EngineRoomFixture.turn(thread: Id<CoachThread>?, vararg calls: Pair<String, String>, phoneReads: List<String> = emptyList()): OpenTurn.Turn {
        val runner = ActionRunner(engine, engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
        val turn = (runner.run(OpenTurn(thread, "Question")) as Outcome.Committed).result
        fun ran(id: String, name: String, input: String) {
            val outcome = runner.run(RunAbility(AbilityRequest(id, name, Json.parse(input)), turn.coach, Seat.bound, TurnPhone.catalog(), "https://windmill.works"))
            assertTrue("$name ran: $outcome", (outcome as Outcome.Committed).result is AbilityOutcome.Result)
        }
        phoneReads.forEach { name -> ran(contextCallPrefix + name, name, "{}") }
        calls.forEachIndexed { index, (name, input) -> ran("call-$index-$name", name, input) }
        check(runner.run(EndTurn(turn.coach, MessageState.completed, "An answer")) is Outcome.Committed)
        return turn
    }

    private suspend fun rows(room: EngineRoomFixture, turn: OpenTurn.Turn): List<Pair<String?, String?>> {
        val conversations = room.store.conversations
        conversations.watch("chat", checkNotNull(turn.thread.record.string), emptyList())
        conversations.read()
        val reply = checkNotNull(conversations.exchanges("chat").first().answer)
        return conversations.withDetails(reply.id, reply.readRows).map { it.title.spelled() to it.detail.spelled() }
    }

    // A turn over the program and the notes read something: the line says what, and the sheet it opens does not contradict it.
    @Test fun aTurnThatReadTheProgramAndTheNotesSaysWhatItRead() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val seeded = room.turn(null, "save_note" to """{"id":"note00000001","title":"Shoulder","body":"Left shoulder hurts."}""",
                "create_routine" to """{"id":"rt_00000001","name":"Push A","position":0,"entries":[{"exerciseId":"bench-press"}]}""")
            room.now += 60_000
            val asked = room.turn(seeded.thread, phoneReads = CoachTurnBounds.contextReads)
            val conversations = room.store.conversations
            conversations.watch("chat", checkNotNull(asked.thread.record.string), emptyList())
            conversations.read()
            val reply = checkNotNull(conversations.exchanges("chat").last().answer)
            assertEquals("Read your recent workouts · read your notes · read your movement list · read your program", reply.readLine.spelled())
            assertEquals(listOf("Read your recent workouts", "Read your notes", "Read your movement list", "Read your program"), reply.readRows.map { it.title.spelled() })
        }
    }

    // A screenshot turn on an empty log, as 01.8 and 01.16 draw it: what it made is no log it read. A later turn reads what that one made, and the earlier line stands.
    @Test fun aScreenshotTurnOnAnEmptyLogThatMadeThreeRoutinesReadNothing() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            fun routine(n: Int) = "create_routine" to """{"id":"rt_0000000$n","name":"Day $n","position":${n - 1},"entries":[{"exerciseId":"bench-press"}]}"""
            val made = room.turn(null, routine(1), routine(2), routine(3), phoneReads = CoachTurnBounds.contextReads)
            val conversations = room.store.conversations
            conversations.watch("chat", checkNotNull(made.thread.record.string), emptyList())
            conversations.read()
            val reply = checkNotNull(conversations.exchanges("chat").single().answer)
            assertEquals("Read nothing from your log", reply.readLine.spelled())
            assertEquals(listOf(CreatedRoutine("rt_00000001", "Day 1", 1), CreatedRoutine("rt_00000002", "Day 2", 1), CreatedRoutine("rt_00000003", "Day 3", 1)), reply.routines)
            room.now += 60_000
            room.turn(made.thread, phoneReads = CoachTurnBounds.contextReads)
            conversations.read()
            assertEquals(listOf("Read nothing from your log", "Read your recent workouts · read your notes · read your movement list · read your program"), conversations.exchanges("chat").map { it.answer?.readLine.spelled() })
        }
    }

    // The seeded movement list is a catalog: reading it says nothing of an empty log, and says its phrase once a note stood.
    @Test fun theSeededMovementListCountsAsNoLogOfThePersons() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val first = room.turn(null, phoneReads = listOf("list_exercises"))
            room.now += 60_000
            room.turn(first.thread, "save_note" to """{"id":"note00000001","title":"Shoulder","body":"Left shoulder hurts."}""")
            room.now += 60_000
            room.turn(first.thread, phoneReads = listOf("list_exercises"))
            val conversations = room.store.conversations
            conversations.watch("chat", checkNotNull(first.thread.record.string), emptyList())
            conversations.read()
            assertEquals(listOf("Read nothing from your log", "Read nothing from your log", "Read your movement list"), conversations.exchanges("chat").map { it.answer?.readLine.spelled() })
        }
    }

    // A phone holding only weigh-ins has no note and no routine, and Coach chose to look: the read it asked for says its phrase and never that it read nothing.
    @Test fun aPhoneHoldingOnlyWeighInsSaysTheBodyweightCoachChoseToRead() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val day = Instant.ofEpochMilli(room.now).atZone(ZoneId.of("UTC")).toLocalDate()
            assertNull(room.store.bodyweight.weighIn(day.toString(), 80.5))
            val first = room.turn(null, phoneReads = CoachTurnBounds.contextReads)
            room.now += 60_000
            room.turn(first.thread, "list_bodyweight" to "{}", phoneReads = CoachTurnBounds.contextReads)
            val conversations = room.store.conversations
            conversations.watch("chat", checkNotNull(first.thread.record.string), emptyList())
            conversations.read()
            assertEquals(listOf("Read nothing from your log", "Read your recent workouts · read your notes · read your movement list · read your program · read your bodyweight"),
                conversations.exchanges("chat").map { it.answer?.readLine.spelled() })
        }
    }

    // What an old turn read does not grow when the log does; what its own earlier calls made it did read, and one made since does not stand under it.
    @Test fun aTurnsListRowSaysWhatItReadThenNotWhatStandsNow() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val old = room.turn(null, "save_note" to """{"id":"note00000001","title":"Shoulder","body":"Left shoulder hurts."}""", "list_notes" to "{}", "list_routines" to "{}")
            val then = listOf("Saved a note" to "Shoulder", "Read your notes" to "1 note", "Read your program" to null)
            assertEquals(then, rows(room, old))
            room.turn(null, "save_note" to """{"id":"note00000002","title":"Knee","body":"Left knee is fine."}""",
                "create_routine" to """{"id":"rt_00000001","name":"Made Later","position":0,"entries":[{"exerciseId":"bench-press"}]}""")
            room.store.conversations.forgetSeat()
            assertEquals(then, rows(room, old))
        }
    }

    // §9.2 records a later call less what earlier calls hold, weeks included: a row's weeks are its own workouts'.
    @Test fun aSecondReadInTheSameWeekSaysItsOwnWeek() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val first = room.workout()
            val second = room.workout()
            val asked = room.turn(null, "get_session" to """{"sessionId":"${first.id}"}""", "get_session" to """{"sessionId":"${second.id}"}""")
            fun day(at: Long) = DateTimeFormatter.ofPattern("MMM d").format(Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()))
            assertEquals(listOf("Read 1 workout" to "1 week · ${day(first.startedAtMs)}", "Read 1 workout" to "1 week · ${day(second.startedAtMs)}"), rows(room, asked))
        }
    }

    // A revision reads the transcript and no detail: its rows hold their titles alone, an unchanged answer reads equal, and only the sheet's read says what a call did.
    @Test fun aTranscriptReadHoldsNoDetailsAndTheSheetsReadSaysThem() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val turn = room.turn(null, "save_note" to """{"id":"note00000001","title":"Shoulder","body":"Left shoulder hurts."}""")
            val conversations = room.store.conversations
            conversations.watch("chat", checkNotNull(turn.thread.record.string), emptyList())
            conversations.read()
            val reply = checkNotNull(conversations.exchanges("chat").single().answer)
            assertEquals(listOf("Saved a note" to null), reply.readRows.map { it.title.spelled() to it.detail.spelled() })
            assertEquals(listOf("Saved a note" to "Shoulder"), conversations.withDetails(reply.id, reply.readRows).map { it.title.spelled() to it.detail.spelled() })
            conversations.read()
            assertEquals("an unchanged answer reads equal, so nothing draws again", reply, conversations.exchanges("chat").single().answer)
        }
    }

    // One failed read is one report under the static name, carrying nothing said, and the rows keep their titles. An answer the records do not hold is no failure.
    @Test fun aDetailReadThatFailsLeavesTheRowsTheirTitlesAndReportsOnce() = runTest {
        val telling = TellingRecorder()
        EngineRoomFixture(folder.newFolder(), work(), telemetry = telling, coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val turn = room.turn(null, "save_note" to """{"id":"note00000001","title":"Shoulder","body":"Left shoulder hurts."}""")
            val conversations = room.store.conversations
            conversations.watch("chat", checkNotNull(turn.thread.record.string), emptyList())
            conversations.read()
            val reply = checkNotNull(conversations.exchanges("chat").single().answer)
            assertEquals(reply.readRows, conversations.withDetails("no-such-answer", reply.readRows))
            assertEquals(emptyList<Map<String, String>>(), telling.failures)
            room.engine.close()
            assertEquals(reply.readRows, conversations.withDetails(reply.id, reply.readRows))
            assertEquals(listOf(mapOf("operation" to "gym.readConversation")), telling.failures)
        }
    }

    @Test fun whatACallServedOrWroteIsReadFromTheRecordsNow() = runTest {
        EngineRoomFixture(folder.newFolder(), work(), coachServer = ScriptedTurns(emptyList())).use { room ->
            room.select("u1")
            val session = room.workout()
            val runner = ActionRunner(room.engine, room.engine.registry, FixedZone(0), object : ActionContext { override var insideRun = false })
            val turn = (runner.run(OpenTurn(null, "Question")) as Outcome.Committed).result
                fun ran(name: String, input: String) {
                val outcome = runner.run(RunAbility(AbilityRequest("call-$name", name, Json.parse(input)), turn.coach, Seat.bound, TurnPhone.catalog(), "https://windmill.works"))
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
            assertEquals("no revision pays for what the sheet says", listOf(null), reply.readRows.map { it.detail }.distinct())
            assertEquals(listOf(
                "Read 1 workout" to "1 week · $day",
                "Saved a note" to "Shoulder",
                "Created a movement" to "Incline Dumbbell Press",
                "Created a routine" to "Push A",
                "Wrote a proposal for one of your routines" to "Push A · 2 changes",
                "Read your notes" to "1 note",
                "Read your program" to "Push A",
            ), conversations.withDetails(reply.id, reply.readRows).map { it.title.spelled() to it.detail.spelled() })
            assertEquals(listOf(CreatedRoutine("rt_00000001", "Push A", movements = 2)), reply.routines)
            assertEquals(listOf(SavedNote("note00000001", "Left shoulder hurts on wide-grip bench.")), reply.savedNotes)
            assertEquals(listOf(MadeMovement("ex_00000001", "Incline Dumbbell Press", Words.Message(R.string.gym_equipment_dumbbells), 2.5)), reply.madeMovements)
            assertEquals("Dumbbells", reply.madeMovements.single().equipment.spelled())
            assertEquals("Read 1 workout · 1 week", reply.readLine.spelled())
            assertEquals("a proposal this phone minted names its routine before the server does", "Push A", room.training.proposal("pr_00000001")?.routineNamed.spelled())
        }
    }
}
