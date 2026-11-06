package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ThreadContextElement
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlin.coroutines.ContinuationInterceptor
import kotlin.coroutines.CoroutineContext
import works.windmill.sync.api.Change
import works.windmill.sync.api.CommitOutcome
import works.windmill.sync.api.Gesture
import works.windmill.sync.core.Json
import works.windmill.domain.kit.ActionContext
import works.windmill.domain.kit.ActionRunner
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Instant
import works.windmill.domain.kit.Outcome
import works.windmill.domain.kit.Zone
import works.windmill.gym.domain.sync.StartSession
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnTransport
import works.windmill.gym.coach.CoachDraft
import works.windmill.gym.coach.turn.CoachTurnFault
import works.windmill.gym.coach.turn.ScriptedTurns
import works.windmill.gym.presentation.LogSetAcceptance
import works.windmill.gym.presentation.LogSetCommand
import works.windmill.gym.presentation.NoteWrite
import works.windmill.gym.presentation.Session
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class TelemetryTests {
    @get:Rule val tmp = TemporaryFolder()

    private class Recorder : Telemetry {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, Throwable>>()
        val failureProperties = mutableListOf<Map<String, String>>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            failures += operation to error
            failureProperties += properties
        }
    }

    private fun script(frames: String) = ScriptedTurns(Json.parse(frames).arr())

    // Virtual time, one dispatcher: the test advances it, and closing the room ends its work.
    private fun TestScope.work() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)

    // One private question on a room of its own, and a Stop for a turn still open: everything the room told from the send on.
    private suspend fun TestScope.asking(server: TurnTransport, account: String? = "account", pulled: Boolean = true): Recorder {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), work(), telemetry = telemetry, coachServer = server).use { room ->
            room.select(account)
            if (account != null && pulled) room.sync(EngineRoomFixture.server())
            val chat = room.store.coach.freshChat()
            telemetry.events.clear()
            assertTrue(room.store.coach.send(chat, "private question"))
            advanceUntilIdle()
            room.store.coach.stop()
            advanceUntilIdle()
        }
        return telemetry
    }

    // The time a turn took is the one number a test cannot name, so it only has to be a number.
    private fun Recorder.timeless(): List<Pair<String, Map<String, String>>> = events.map { (name, properties) ->
        properties["duration_ms"]?.let { assertTrue("$name took $it", it.toLong() >= 0) }
        name to properties - "duration_ms"
    }

    private fun assertToldNothingSaid(told: Recorder) {
        val everything = told.events.flatMap { (name, properties) -> listOf(name) + properties.keys + properties.values } +
            told.failures.flatMap { (operation, error) -> listOf(operation, error.message.orEmpty(), error.toString()) } +
            told.failureProperties.flatMap { it.keys + it.values }
        assertEquals(emptyList<String>(), everything.filter { it.contains("private") || it.contains("conversation content") })
    }

    @Test fun everyCoachOutcomeEmitsOneResultWithoutConversationOrTrainingContent() = runTest {
        val started = "gym_ask_started" to mapOf("screen" to "coach")
        val abilities = listOf("list_sessions", "list_notes", "list_exercises", "list_routines").map { "coach_ability" to mapOf("name" to it, "outcome" to "ok") }
        fun asked(outcome: String, cap: String? = null) = "gym_ask_outcome" to mapOf("screen" to "coach", "outcome" to outcome) + listOfNotNull(cap?.let { "cap" to it })
        fun ended(state: String, seat: String = "bound", code: String? = null, calls: Int = 4, bytes: Int = 0) = "coach_turn" to mapOf("state" to state, "seat" to seat,
            "ability_calls" to calls.toString(), "refusals" to "0", "answer_bytes" to bytes.toString()) + listOfNotNull(code?.let { "code" to it })
        fun request(status: Int) = "api_request_failed" to mapOf("operation" to "gym_coach_turn", "route" to "/v1/gym", "method" to "POST", "failure_kind" to "http", "status" to status.toString())
        fun refusing(status: Int, code: String) = script("[]").apply { refuseOpen = TurnRefusal(status, code, null) }

        val cases = listOf(
            script("""[{"event":"text","data":{"delta":"private answer"}},{"event":"done","data":{"state":"completed"}}]""") to
                listOf(started) + abilities + listOf(asked("answered"), ended("completed", bytes = 14)),
            script("""[{"event":"text","data":{"delta":"private answer"}},{"event":"done","data":{"state":"declined"}}]""") to
                listOf(started) + abilities + listOf(asked("refused"), ended("declined", bytes = 14)),
            script("""[{"event":"text","data":{"delta":"private answer"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""") to
                listOf(started) + abilities + listOf(asked("cancelled"), ended("stopped", bytes = 14)),
            script("""[{"event":"error","data":{"code":"subject_exhausted"}}]""") to
                listOf(started) + abilities + listOf(asked("capped", "allowance"), ended("failed", code = "subject_exhausted")),
            script("""[{"event":"error","data":{"code":"coach-vendor-error"}}]""") to
                listOf(started) + abilities + listOf(asked("failed"), ended("failed", code = "coach-vendor-error")),
            script("""[{"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"list_notes","input":{}}]}},{"await":"timeout"}]""") to
                listOf(started) + abilities + listOf("coach_ability" to mapOf("name" to "list_notes", "outcome" to "ok"), asked("failed"), ended("interrupted", code = TurnRefusal.turnOrder, calls = 5)),
            refusing(429, "subject_exhausted") to listOf(started) + abilities + listOf(request(429), asked("capped", "allowance")),
            refusing(429, "free_month_exhausted") to listOf(started) + abilities + listOf(request(429), asked("capped", "allowance")),
            refusing(429, TurnRefusal.rateLimited) to listOf(started) + abilities + listOf(request(429), asked("capped", "daily")),
            refusing(404, "not-found") to listOf(started) + abilities + listOf(request(404), asked("absent")),
            refusing(400, "coach-bad-request") to listOf(started) + abilities + listOf(request(400), asked("refused")),
        )
        for ((server, expected) in cases) {
            val told = asking(server)
            assertEquals(expected, told.timeless())
            assertEquals("a turn's own ending is no failure", emptyList<Pair<String, Throwable>>(), told.failures)
            assertToldNothingSaid(told)
        }

        val quiet = asking(refusing(503, TurnRefusal.vendorError))
        assertEquals(listOf(started) + abilities + listOf(request(503), asked("failed")), quiet.timeless())
        assertEquals("a server that broke is the one reported", listOf("gym.coachTurn" to "http"), quiet.failures.map { (operation, error) -> operation to error.message })
        assertEquals(listOf(mapOf("failure_kind" to "http", "status" to "503")), quiet.failureProperties)
        assertToldNothingSaid(quiet)

        val signedOut = asking(script("""[{"event":"text","data":{"delta":"private answer"}},{"event":"done","data":{"state":"completed"}}]"""), account = null)
        assertEquals(listOf(started) + abilities + listOf(asked("answered"), ended("completed", seat = "anon", bytes = 14)), signedOut.timeless())
        assertToldNothingSaid(signedOut)

        val arriving = asking(script("[]"), pulled = false)
        assertEquals("a send the phone refuses tells that alone", listOf(asked("refused")), arriving.timeless())
        assertToldNothingSaid(arriving)
    }

    @Test fun unexpectedHandledCoachFailureIsReportedButCancellationRemainsCancellation() = runTest {
        val started = "gym_ask_started" to mapOf("screen" to "coach")
        val abilities = listOf("list_sessions", "list_notes", "list_exercises", "list_routines").map { "coach_ability" to mapOf("name" to it, "outcome" to "ok") }
        val broken = object : TurnTransport by script("[]") {
            override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow { throw IllegalStateException("do not publish conversation content") }
            override fun resume(turnId: String, seat: TurnSeat): Flow<TurnEvent> = flow { throw IllegalStateException("do not publish conversation content") }
        }
        val told = asking(broken)
        assertEquals(listOf(started) + abilities + listOf(
            "api_request_failed" to mapOf("operation" to "gym_coach_turn", "route" to "/v1/gym", "method" to "POST", "failure_kind" to "offline"),
            "gym_ask_outcome" to mapOf("screen" to "coach", "outcome" to "offline")), told.timeless())
        assertEquals(listOf("gym.coachTurn" to "transport"), told.failures.map { (operation, error) -> operation to error.message })
        assertEquals(listOf(mapOf("failure_kind" to "transport")), told.failureProperties)
        assertToldNothingSaid(told)

        val brokenLater = object : TurnTransport by script("[]") {
            override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow {
                emit(TurnEvent.Text("private answer"))
                throw IllegalStateException("do not publish conversation content")
            }
            override fun resume(turnId: String, seat: TurnSeat): Flow<TurnEvent> = flow { throw IllegalStateException("do not publish conversation content") }
        }
        val toldLater = asking(brokenLater)
        assertEquals(listOf(started) + abilities + listOf(
            "gym_ask_outcome" to mapOf("screen" to "coach", "outcome" to "failed"),
            "coach_turn" to mapOf("state" to "interrupted", "seat" to "bound", "ability_calls" to "4", "refusals" to "0", "answer_bytes" to "14", "code" to "transport")), toldLater.timeless())
        assertEquals(listOf("gym.coachTurn" to "transport"), toldLater.failures.map { (operation, error) -> operation to error.message })
        assertEquals(listOf(mapOf("failure_kind" to "transport")), toldLater.failureProperties)
        assertToldNothingSaid(toldLater)

        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), work(), telemetry = telemetry, coachServer = script("""[{"await":"stop"}]""")).use { room ->
            room.select("account")
            room.sync(EngineRoomFixture.server())
            val chat = room.store.coach.freshChat()
            room.store.coach.saveDraft(chat, CoachDraft("private question"))
            telemetry.events.clear()
            room.engine.failNextCommit()
            assertTrue(room.store.coach.send(chat, "private question"))
            advanceUntilIdle()
            assertEquals(CoachTurnFault.unsaved, room.store.coach.fault(chat))
            assertEquals("a question the store could not keep stays with the lifter", CoachDraft("private question"), room.store.coach.draft(chat))
            assertNull(room.store.coach.chat(chat)?.conversation)
            assertEquals(listOf("gym.coachTurn" to "storage"), telemetry.failures.map { (operation, error) -> operation to error.message })
            assertEquals(listOf("gym_ask_outcome" to mapOf("screen" to "coach", "outcome" to "failed")), telemetry.events)
            telemetry.failures.clear()
            telemetry.events.clear()

            assertTrue(room.store.coach.send(chat, "private question"))
            advanceUntilIdle()
            assertEquals(listOf(started) + abilities, telemetry.timeless())
            room.scope.cancel()
            advanceUntilIdle()
            assertEquals("a room going away under a turn tells nothing: the next launch ends it", listOf(started) + abilities, telemetry.timeless())
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
            assertToldNothingSaid(telemetry)
        }
    }

    @Test fun acceptedWorkoutActionsEmitOnceAndRejectedDuplicateSetsDoNotCount() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            val store = room.store
            room.select(null)
            val routine = (store.routines.saveRoutine(works.windmill.gym.presentation.RoutineDraft(name = "Workout")
                .adding("bench-press")) as GymResult.Ok).value
            telemetry.events.clear()
            val beforeMissing = room.engine.snapshot()
            assertEquals(GymResult.Failed(WriteFailure.Refused("That is no longer on the log.")), store.workout.start("missing-routine"))
            assertEquals(beforeMissing, room.engine.snapshot())
            assertNull(store.workout.session)
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.events)
            assertTrue(store.workout.start(routine.id) is GymResult.Ok)
            assertTrue(store.workout.start(routine.id) is GymResult.Failed)
            store.workout.choose("bench-press")
            val offered = requireNotNull(store.workout.notification.value?.offer)
            val command = LogSetCommand(offered.key, offered.id)
            assertTrue(store.workout.acceptSet(command) is LogSetAcceptance.Accepted)
            assertEquals(LogSetAcceptance.Stale, store.workout.acceptSet(command))
            assertTrue(store.workout.finish() is FinishOutcome.Closed)
            assertEquals(listOf(
                "gym_session_started" to emptyMap<String, String>(),
                "gym_set_logged" to emptyMap<String, String>(),
                "gym_session_finished" to emptyMap<String, String>(),
            ), telemetry.events)
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun deletingTheSelectedRoutineBeforeTheStartDecisionCreatesNoWorkoutOrEvent() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val routine = (room.store.routines.saveRoutine(works.windmill.gym.presentation.RoutineDraft(name = "Workout")
                .adding("bench-press")) as GymResult.Ok).value
            telemetry.events.clear()
            var afterDelete: Json? = null
            var deletionAttempted = false
            var deletionFailure: Throwable? = null
            val deletion = object : ThreadContextElement<Unit> {
                override val key = object : CoroutineContext.Key<ThreadContextElement<Unit>> {}
                override fun updateThreadContext(context: CoroutineContext) {
                    if (context[GymActionContext] == null || deletionAttempted) return
                    deletionAttempted = true
                    runCatching {
                        assertTrue(room.engine.commit(ScopeRef(Gym.scope), Gesture(listOf(
                            Change.delete(Gym.Types.routine, RecordID(routine.id))))) is CommitOutcome.Committed)
                        afterDelete = room.engine.snapshot()
                    }.onFailure { deletionFailure = it }
                }
                override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) {}
            }

            val result = withContext(deletion) { room.store.workout.start(routine.id) }

            assertNull(deletionFailure?.stackTraceToString(), deletionFailure)
            assertNotNull("the selected routine was removed before the action decision", afterDelete)
            assertEquals(GymResult.Failed(WriteFailure.Refused("That is no longer on the log.")), result)
            assertEquals(afterDelete, room.engine.snapshot())
            assertNull(room.store.workout.session)
            assertTrue(room.training.details().isEmpty())
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.events)
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun aWorkoutOpenedBeforeTheStartDecisionIsResumedWithoutAnotherStartOrEvent() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select(null)
            val routine = (room.store.routines.saveRoutine(works.windmill.gym.presentation.RoutineDraft(name = "Workout")
                .adding("bench-press")) as GymResult.Ok).value
            telemetry.events.clear()
            var afterExternalStart: List<Json>? = null
            var externalStartAttempted = false
            var externalStartFailure: Throwable? = null
            val externalStart = object : ThreadContextElement<Unit> {
                override val key = object : CoroutineContext.Key<ThreadContextElement<Unit>> {}
                override fun updateThreadContext(context: CoroutineContext) {
                    if (context[GymActionContext] == null || externalStartAttempted) return
                    externalStartAttempted = true
                    runCatching {
                        val runner = ActionRunner(room.engine, room.engine.registry, Zone { 0 },
                            object : ActionContext { override var insideRun = false })
                        assertTrue(runner.run(StartSession(Id("external1", works.windmill.gym.domain.sync.Session),
                            startedAt = Instant(room.now))) is Outcome.Committed)
                        afterExternalStart = room.outbox()
                    }.onFailure { externalStartFailure = it }
                }
                override fun restoreThreadContext(context: CoroutineContext, oldState: Unit) {}
            }

            val result = withContext(externalStart) { room.store.workout.start(routine.id) }

            assertNull(externalStartFailure?.stackTraceToString(), externalStartFailure)
            assertNotNull("the external workout opened before the action decision", afterExternalStart)
            assertEquals(GymResult.Failed(WriteFailure.Refused("A workout is already open. Finish it first.")), result)
            assertEquals(afterExternalStart, room.outbox())
            assertEquals("external1", room.store.workout.session?.id)
            assertNull(room.store.workout.session?.routineId)
            assertEquals(listOf("external1"), room.training.details().map { it.session.id })
            assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.events)
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun aFailedCorrectionKeepsUndoAndOnlyCommittedWeightsEmitAnEvent() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select("account")
            val day = "2026-01-01"
            assertNull(room.store.bodyweight.weighIn(day, 182.0))
            telemetry.events.clear()
            val original = room.store.bodyweight.drawn
            room.store.deletions.withhold(Deletion.Bodyweight(day))
            runCurrent()
            val held = room.store.held.withheld
            room.engine.failNextCommit()
            assertNotNull(room.store.bodyweight.weighIn(day, 82.45))
            assertEquals(held, room.store.held.withheld)
            assertTrue(room.store.bodyweight.drawn.isEmpty())
            assertEquals(emptyList<Any>(), room.training.weighins())
            assertEquals(listOf("gym_action" to mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "held")), telemetry.events)
            assertEquals(listOf("gym.weighIn"), telemetry.failures.map { it.first })
            assertNotNull(room.store.deletions.keepWithheld())
            assertEquals(original, room.store.bodyweight.drawn)

            room.store.deletions.withhold(Deletion.Bodyweight(day))
            runCurrent()
            assertNull(room.store.bodyweight.weighIn(day, 82.45))
            assertTrue(room.store.held.withheld.isEmpty())
            assertEquals(82.45, room.store.bodyweight.drawn.single().weightKg, 0.0)
            assertNotNull(room.store.bodyweight.weighIn(day, Double.NaN))
            assertEquals(listOf(
                "gym_action" to mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "held"),
                "gym_action" to mapOf("screen" to "bodyweight", "action" to "undo", "outcome" to "ok"),
                "gym_action" to mapOf("screen" to "bodyweight", "action" to "delete", "outcome" to "held"),
                "gym_action" to mapOf("screen" to "bodyweight", "action" to "cancel", "outcome" to "rewritten"),
                "gym_bodyweight_saved" to emptyMap<String, String>(),
            ), telemetry.events)
        }
    }

    @Test fun onlyACommittedNoteMoveEmitsAnEventWithoutNoteContent() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select("account")
            for (index in 0..2) assertTrue(room.store.notes.saveNote("private_note_$index", NoteWrite("Private title $index", "Private body")) is GymResult.Ok)
            assertNull(room.store.deletions.delete(Deletion.Note("private_note_1")))
            telemetry.events.clear()
            val visible = listOf("private_note_0", "private_note_2")
            val moved = visible.reversed()
            assertTrue(room.store.notes.reorderNotes("private_note_2", visible) is GymResult.Ok)
            assertTrue(room.store.notes.reorderNotes("private_note_0", visible.dropLast(1)) is GymResult.Failed)
            val before = room.engine.snapshot()
            room.engine.failNextCommit()
            assertTrue(room.store.notes.reorderNotes("private_note_0", moved) is GymResult.Failed)
            assertEquals(before, room.engine.snapshot())
            assertTrue(telemetry.events.isEmpty())
            assertEquals(listOf("gym.reorderNotes"), telemetry.failures.map { it.first })

            assertTrue(room.store.notes.reorderNotes("private_note_0", moved) is GymResult.Ok)
            assertTrue(room.store.notes.reorderNotes("private_note_0", moved) is GymResult.Ok)
            assertEquals(emptyList<String>(), room.store.held.withheld.map { it.subjectId })
            assertEquals(listOf("gym_note_moved" to emptyMap<String, String>()), telemetry.events)
        }
    }

    @Test fun absentStorageIsNormalButUnreadableDocumentsAreReported() {
        val telemetry = Recorder()
        val file = File(tmp.root, "document")
        val storage = StoredDocument(file, telemetry)
        assertNull(storage.tree())
        assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        file.writeText("private broken document")
        assertNull(storage.tree())
        assertEquals(listOf("gym.storage.read"), telemetry.failures.map { it.first })
        assertNull(storage.one(kotlinx.serialization.json.JsonObject(emptyMap()), Session.serializer()))
        assertEquals(listOf("gym.storage.read", "gym.storage.decode"), telemetry.failures.map { it.first })
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.events)
    }
}
