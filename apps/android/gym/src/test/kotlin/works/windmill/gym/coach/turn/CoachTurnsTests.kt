package works.windmill.gym.coach.turn

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.spelled
import works.windmill.gym.string
import works.windmill.agent.ToolCall
import works.windmill.agent.ToolOutcome
import works.windmill.agent.TurnEnd
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnLabel
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRecordRefused
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnState
import works.windmill.agent.TurnTransport
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Outcome
import works.windmill.gym.R
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachPictureRow
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.DeleteConversation
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.gym.store.ReplicaPin
import works.windmill.gym.telemetry.GymEvents
import works.windmill.platform.i18n.text
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.EventSchemas
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.ClockReading
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.RequestTiming
import works.windmill.sync.engine.SyncResponse
import works.windmill.sync.engine.nextPush
import works.windmill.sync.engine.onPushResponse
import works.windmill.sync.modelserver.Credential
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.reidentify
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// The turn around the driver on a real engine: admission and what it keeps, the installation's answers, a process that died at each step of a batch, a seat that changed under a batch, an account in transition, and telemetry that says nothing of what was said.
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CoachTurnsTests {
    @get:Rule val folder = TemporaryFolder()

    private val routineCall = """{"id":"rt_00000009","name":"Day 1","position":0,"entries":[{"exerciseId":"bench-press"}]}"""

    private fun script(vararg frames: String) = ScriptedTurns(frames.flatMap { Json.parse(it).arr() })

    private val answersOneCreate get() = script("""[
        {"event":"text","data":{"delta":"On it."}},
        {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"create_routine","input":$routineCall}]}},
        {"await":"results","batch":1},
        {"event":"text","data":{"delta":" Done."}},
        {"event":"done","data":{"state":"completed"}}]""")

    private fun TurnPhone.routines(): List<Routine> = engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(Routine, read.drawn(Routine.type))
    }

    private fun TurnPhone.completeSignIn(account: String) {
        val question = engine.signIn(account, mapOf("gym" to true), serverSchema = SyncSchema.registry.version)
        if (!question.member("complete").bool()) {
            val pins = question.member("due").arr().associate { due -> due.member("product").str() to due.member("counted").arr().map(Json::str) }
            assertTrue(engine.signIn(account, mapOf("gym" to true), mapOf("gym" to "add"), pins, serverSchema = SyncSchema.registry.version).member("complete").bool())
        }
        room.selected = account
    }

    private val routineReceipt = RecordRef(Gym.Types.routine, works.windmill.sync.core.RecordID("rt_00000009"))

    private fun assertNothingKept(phone: TurnPhone) {
        assertEquals(emptyList<CoachMessage>(), phone.messages())
        assertEquals(emptyList<CoachThread>(), phone.threads())
        assertNull(phone.device(EndTurn.runningTurnKey))
        assertEquals(emptyList<TurnSeat>(), phone.server.seats)
        assertEquals(0, phone.server.opened.size)
    }

    // Coach §4.1, each refusal in its turn: nothing is written, nothing leaves, and the reason is said once.
    @Test fun aFirstPullStillComingRefusesASignedInSend() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            phone.room.select("account-1")
            assertNull(phone.turns.send("Private question", null, null, anonymous = false))
            assertEquals(CoachTurnRefusal.LogArriving, phone.turns.refusal.value)
            assertNothingKept(phone)
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "refused")), phone.telling.named("gym_ask_outcome"))
        }
    }

    @Test fun aSignedOutReplicaHoldsItsFirstPullComplete() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            assertTrue(phone.room.training.anonymous)
            assertTrue(phone.room.training.firstPullComplete)
        }
    }

    @Test fun aQuestionPastItsBoundIsNoSend() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            assertNull(phone.turns.send("x".repeat(8_001), null, null, anonymous = true))
            assertNull(phone.turns.refusal.value)
            assertNull(phone.turns.fault.value)
            assertNothingKept(phone)
            assertEquals(0, phone.installationServer.reads)
        }
    }

    @Test fun noConnectionRefusesBeforeTheSeatIsAsked() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            val runtime = SyncRuntime(phone.engine, object : works.windmill.sync.engine.SyncTransport {
                override suspend fun hello(token: String?) = works.windmill.sync.engine.Reply.Unreachable
                override suspend fun push(request: Json, token: String) = works.windmill.sync.engine.Reply.Unreachable
                override suspend fun pull(request: Json, token: String?) = works.windmill.sync.engine.Reply.Unreachable
                override suspend fun openLive(token: String) = works.windmill.sync.engine.Reply.Unreachable
            }, object : works.windmill.sync.engine.SessionTokens {
                override fun token(account: String) = null
                override fun save(account: String, token: String) = Unit
                override fun delete(account: String) = Unit
                override fun accounts() = emptySet<String>()
            }, "test")
            runtime.use {
                it.connectivity(false)
                withContext(Dispatchers.IO) { withTimeout(5_000) { phone.engine.status.state.first { status -> !status.online } } }
                assertNull(phone.turns.send("Private question", null, null, anonymous = true))
            }
            assertEquals(CoachTurnRefusal.Offline, phone.turns.refusal.value)
            assertNothingKept(phone)
            assertEquals(0, phone.installationServer.reads)
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "offline")), phone.telling.named("gym_ask_outcome"))
        }
    }

    @Test fun aSeatTheAccountCannotGiveIsTheAccountChanging() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]"), accountToken = { null }).use { phone ->
            assertNull(phone.turns.send("Private question", null, null, anonymous = false))
            assertEquals(CoachTurnFault.accountChanging, phone.turns.fault.value)
            assertNothingKept(phone)
        }
    }

    @Test fun aSeatThatDoesNotMatchTheReplicaRefuses() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            assertNull(phone.turns.send("Private question", null, null, anonymous = false))
            assertEquals(CoachTurnFault.accountChanging, phone.turns.fault.value)
            assertNothingKept(phone)
        }
    }

    @Test fun theSentenceAnAccountsChangeLeftGoesWhenTheSeatMayWriteAgain() = runTest {
        var writable = false
        TurnPhone(this, folder.newFolder(), script("[]"), writable = { writable }).use { phone ->
            assertNull(phone.turns.send("Private question", null, null, anonymous = true))
            assertEquals(CoachTurnFault.accountChanging, phone.turns.fault.value)
            phone.turns.sweep()
            advanceUntilIdle()
            assertEquals("the change has not ended", CoachTurnFault.accountChanging, phone.turns.fault.value)
            writable = true
            phone.turns.sweep()
            advanceUntilIdle()
            assertNull(phone.turns.fault.value)
        }
    }

    @Test fun anAccountNotWritableRefusesASend() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]"), writable = { false }).use { phone ->
            assertNull(phone.turns.send("Private question", null, null, anonymous = true))
            assertEquals(CoachTurnFault.accountChanging, phone.turns.fault.value)
            assertNothingKept(phone)
        }
    }

    @Test fun anUnknownConversationKeepsNothing() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            assertNull(phone.turns.send("Private question", null, Id("thrdNobody000000", CoachThread), anonymous = true))
            assertEquals(CoachTurnFault.unsaved, phone.turns.fault.value)
            assertNothingKept(phone)
        }
    }

    @Test fun aSendWhileATurnRunsIsBusy() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("First", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(turn.coach.record.string, phone.turns.activity.value?.turnId)
            assertNull(phone.turns.send("Second", null, null, anonymous = true))
            assertEquals(CoachTurnFault.busy, phone.turns.fault.value)
            assertEquals(listOf("First", ""), phone.messages().map { it.text })
            phone.turns.requestStop()
            advanceUntilIdle()
            assertEquals(MessageState.stopped, phone.message(turn.coach)?.state)
            assertNull(phone.turns.activity.value)
            assertNull(phone.turns.turn.value)
        }
    }

    // The installation the server refused stands: the phone keeps it, and asks nobody the next time.
    @Test fun anInvalidInstallationAtTheOpenWithdrawsTheTurnAndStaysInvalid() = runTest {
        val server = script("[]").apply { refuseOpen = TurnRefusal(401, "invalid_installation", null) }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            checkNotNull(phone.turns.send("Private question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Installation("invalid_installation"), phone.turns.refusal.value)
            assertEquals(WithdrawnTurn("Private question", null, null), phone.turns.withdrawn.value)
            assertEquals(emptyList<CoachMessage>(), phone.messages())
            assertEquals(emptyList<CoachThread>(), phone.threads())
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(listOf(mapOf("operation" to "gym_coach_turn", "route" to "/v1/gym", "method" to "POST", "failure_kind" to "http", "status" to "401")), phone.telling.named("api_request_failed"))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "refused", "duration_ms" to "0")), phone.telling.named("gym_ask_outcome"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.named("coach_turn"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)

            val reads = phone.installationServer.reads
            assertNull(phone.turns.send("Private question", null, null, anonymous = true))
            assertEquals(CoachTurnRefusal.Installation("invalid_installation"), phone.turns.refusal.value)
            assertEquals(reads, phone.installationServer.reads)
            assertEquals(CoachRecovery.signIn, phone.turns.refusal.value?.recovery(anonymous = true))
        }
    }

    @Test fun aBoundInstallationMidTurnEndsItFailedAndStaysBound() = runTest {
        val server = script("""[{"event":"error","data":{"code":"device_bound"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val turn = checkNotNull(phone.turns.send("Private question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(MessageState.failed, phone.message(turn.coach)?.state)
            assertEquals(CoachTurnRefusal.Installation("device_bound"), phone.turns.refusal.value)
            assertNull(phone.turns.withdrawn.value)
            val reads = phone.installationServer.reads
            assertNull(phone.turns.send("Again", null, null, anonymous = true))
            assertEquals(CoachTurnRefusal.Installation("device_bound"), phone.turns.refusal.value)
            assertEquals(reads, phone.installationServer.reads)
            assertEquals(listOf("Private question", ""), phone.messages().map { it.text })
        }
    }

    @Test fun aSeatTheServerRefusesIsSaidAndKeepsNothing() = runTest {
        for ((failure, said) in listOf(
            WindmillApiException.Refused(401, Refusal(code = "invalid_installation")) to CoachTurnRefusal.Installation("invalid_installation"),
            WindmillApiException.Refused(503, Refusal(code = "anonymous_ai_unavailable")) to CoachTurnRefusal.AnonymousUnavailable,
            WindmillApiException.Offline to CoachTurnRefusal.Offline,
        )) {
            TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
                phone.installationServer.issueFailure = failure
                assertNull(phone.turns.send("Private question", null, null, anonymous = true))
                assertEquals(said, phone.turns.refusal.value)
                assertNothingKept(phone)
            }
        }
    }

    // The process dies at each step of a batch: after the call's commit before the post, and after the post. The next process ends the turn `interrupted` with one record and the right receipt, and tells of it once.
    @Test fun aProcessKilledAtEachStepOfABatchEndsInterruptedWithOneRecord() = runTest {
        for (post in listOf(false, true)) {
            lateinit var snapshot: Json
            lateinit var turn: OpenTurn.Turn
            TurnPhone(this, folder.newFolder(), script("""[
                {"event":"text","data":{"delta":"On it."}},
                {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"create_routine","input":$routineCall}]}},
                {"await":"results","batch":1}]""")).use { phone ->
                val kill: suspend () -> Unit = {
                    snapshot = phone.engine.snapshot()
                    awaitCancellation()
                }
                if (post) phone.server.afterPost = kill else phone.server.beforePost = kill
                turn = checkNotNull(phone.turns.send("Add a day", null, null, anonymous = true))
                advanceUntilIdle()
                assertEquals(if (post) 1 else 0, phone.server.posted.size)
                assertEquals(MessageState.running, phone.message(turn.coach)?.state)
            }
            TurnPhone(this, folder.newFolder(), script("[]"), snapshot = snapshot).use { reopened ->
                assertEquals(MessageState.running, reopened.message(turn.coach)?.state)
                assertEquals(turn.coach.json, reopened.device(EndTurn.runningTurnKey))
                reopened.turns.start()
                advanceUntilIdle()
                val ended = checkNotNull(reopened.message(turn.coach))
                assertEquals(MessageState.interrupted, ended.state)
                assertEquals("On it.", ended.text)
                assertEquals(CoachTurnBounds.contextReads + "create_routine", ended.calls.map { it.name })
                assertEquals(listOf(routineReceipt), ended.calls.flatMap { it.created })
                assertEquals(Json.parse("""{"read":{"sessions":0,"sets":0,"weeks":0},"results":[{"id":"rt_00000009","t":"routine"}]}""").jcs, ended.receipt?.jcs)
                assertEquals(listOf("Day 1"), reopened.routines().map { it.name })
                assertNull(reopened.device(EndTurn.runningTurnKey))
                assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "failed")), reopened.telling.named("gym_ask_outcome"))
                assertEquals(listOf(mapOf("state" to "interrupted", "seat" to "anon", "code" to "process_ended", "ability_calls" to "5", "refusals" to "0", "answer_bytes" to "6")),
                    reopened.telling.named("coach_turn"))
                assertEquals(emptyList<Map<String, String>>(), reopened.telling.failures)

                // A host left over from that turn can write nothing on a message a sweep ended.
                val host = hostOf(reopened, turn)
                assertThrowsRecordRefused { host.execute(ToolCall("toolu_1", "create_routine", Json.parse(routineCall))) }
                assertEquals(ended, reopened.message(turn.coach))
            }
        }
    }

    // The same two kills, and the call asked again of the replica the process left: one record, no second routine, the receipt whole.
    @Test fun aCallRunAgainAfterAKillKeepsOneRecord() = runTest {
        for (post in listOf(false, true)) {
            lateinit var snapshot: Json
            lateinit var turn: OpenTurn.Turn
            TurnPhone(this, folder.newFolder(), script("""[
                {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"create_routine","input":$routineCall}]}},
                {"await":"results","batch":1}]""")).use { phone ->
                val kill: suspend () -> Unit = {
                    snapshot = phone.engine.snapshot()
                    awaitCancellation()
                }
                if (post) phone.server.afterPost = kill else phone.server.beforePost = kill
                turn = checkNotNull(phone.turns.send("Add a day", null, null, anonymous = true))
                advanceUntilIdle()
            }
            TurnPhone(this, folder.newFolder(), script("[]"), snapshot = snapshot).use { reopened ->
                val host = hostOf(reopened, turn)
                val first = reopened.message(turn.coach)!!.calls
                val outcome = host.execute(ToolCall("toolu_1", "create_routine", Json.parse(routineCall)))
                assertTrue(outcome is ToolOutcome.Ok)
                assertEquals(first, reopened.message(turn.coach)!!.calls)
                assertEquals(listOf("Day 1"), reopened.routines().map { it.name })
                host.end(TurnEnd(TurnState.completed, "Done.", false, null, null))
                val ended = reopened.message(turn.coach)!!
                assertEquals(MessageState.completed, ended.state)
                assertEquals(Json.parse("""{"read":{"sessions":0,"sets":0,"weeks":0},"results":[{"id":"rt_00000009","t":"routine"}]}""").jcs, ended.receipt?.jcs)
            }
        }
    }

    // A whole turn the server re-delivers its batch to, as a resume does: the call runs twice, the record stays one, and the answer posts twice.
    @Test fun aBatchDeliveredAgainOnAResumeKeepsOneRecordAndOneRoutine() = runTest {
        val calls = """{"batch":1,"calls":[{"callId":"toolu_1","name":"create_routine","input":$routineCall}]}"""
        TurnPhone(this, folder.newFolder(), script("""[
            {"event":"calls","data":$calls},
            {"await":"resume"},
            {"event":"snapshot","data":{"text":"","state":"running","calls":$calls}},
            {"await":"results","batch":1},
            {"event":"done","data":{"state":"completed"}}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("Add a day", null, null, anonymous = true))
            advanceUntilIdle()
            val ended = phone.message(turn.coach)!!
            assertEquals(MessageState.completed, ended.state)
            assertEquals(CoachTurnBounds.contextReads + "create_routine", ended.calls.map { it.name })
            assertEquals(listOf(routineReceipt), ended.calls.flatMap { it.created })
            assertEquals(listOf("Day 1"), phone.routines().map { it.name })
            assertEquals(2, phone.server.posted.size)
            assertEquals(phone.server.posted[0].member("results").arr().map { it.member("callId") }, phone.server.posted[1].member("results").arr().map { it.member("callId") })
        }
    }

    // §4.5 Writer: a re-identify under a batch. The call in flight landed, the next call never runs, the server hears one Stop, and the message ends `interrupted` under the new id.
    @Test fun aReplicaThatChangesMidBatchEndsTheTurnInterruptedUnderItsNewId() = runTest {
        TurnPhone(this, folder.newFolder(), twoCreates()).use { phone ->
            phone.turns.start()
            advanceUntilIdle()
            val replica = phone.engine.activeReplica()
            phone.telling.onEvent = { name, properties ->
                if (name == "coach_ability" && properties["name"] == "create_routine") {
                    phone.telling.onEvent = { _, _ -> }
                    phone.engine.reidentify()
                }
            }
            val turn = checkNotNull(phone.turns.send("Add two days", null, null, anonymous = true))
            advanceUntilIdle()

            val renamed = phone.engine.activeReplica()
            assertFalse(replica == renamed)
            val ended = checkNotNull(phone.message(turn.coach))
            assertEquals(replica, ended.replica)
            assertEquals(MessageState.interrupted, ended.state)
            assertEquals(CoachTurnBounds.contextReads + "create_routine", ended.calls.map { it.name })
            assertEquals(listOf("Day 1"), phone.routines().map { it.name })
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(1, phone.server.stops)
            assertEquals(emptyList<Json>(), phone.server.posted)
            assertNull(phone.turns.activity.value)
            assertNull(phone.turns.turn.value)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertEquals(listOf(mapOf("state" to "interrupted", "seat" to "anon", "code" to "seat_changed", "ability_calls" to "5", "refusals" to "0", "answer_bytes" to "0", "duration_ms" to "0")),
                phone.telling.named("coach_turn"))
        }
    }

    // A sign-out under a batch: the record stays on the replica that holds it, untouched by the next seat, and ends when that replica comes back.
    @Test fun aSignOutMidBatchLeavesTheNextSeatCleanAndTheMessageEndsWhenItsReplicaReturns() = runTest {
        TurnPhone(this, folder.newFolder(), twoCreates()).use { phone ->
            phone.signIn()
            phone.turns.start()
            advanceUntilIdle()
            phone.telling.onEvent = { name, properties ->
                if (name == "coach_ability" && properties["name"] == "create_routine") {
                    phone.telling.onEvent = { _, _ -> }
                    assertTrue(phone.engine.signOut("keep").member("complete").bool())
                }
            }
            val turn = checkNotNull(phone.turns.send("Add two days", null, null, anonymous = false))
            advanceUntilIdle()

            assertEquals(emptyList<CoachMessage>(), phone.messages())
            assertEquals(emptyList<Routine>(), phone.routines())
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(1, phone.server.stops)
            assertEquals(listOf(mapOf("state" to "interrupted", "seat" to "bound", "code" to "seat_changed", "duration_ms" to "0")), phone.telling.named("coach_turn"))
            assertNull(phone.turns.turn.value)

            assertTrue(phone.engine.signIn("account-1", mapOf("gym" to true)).member("complete").bool())
            advanceUntilIdle()
            val back = checkNotNull(phone.message(turn.coach))
            assertEquals(MessageState.interrupted, back.state)
            assertEquals(listOf(routineReceipt), back.calls.flatMap { it.created })
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(1, phone.telling.named("coach_turn").size)
        }
    }

    // A commit can outlive the cancellation: a turn that reached its end before the seat changed keeps how it ended.
    @Test fun aTurnThatEndedBeforeTheSeatChangedKeepsItsEnding() = runTest {
        val server = script("""[{"event":"text","data":{"delta":"Answered."}},{"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.turns.start()
            advanceUntilIdle()
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            phone.engine.reidentify()
            advanceUntilIdle()
            assertEquals(MessageState.completed, phone.message(turn.coach)?.state)
            assertEquals("Answered.", phone.message(turn.coach)?.text)
            assertEquals(0, phone.server.stops)
            assertEquals(1, phone.telling.named("coach_turn").size)
        }
    }

    // The seat changes the moment the turn ends: the turn told of itself, once, and its ending stands.
    @Test fun aSeatChangeAsTheTurnEndsTellsOfItOnce() = runTest {
        val server = script("""[{"event":"text","data":{"delta":"Answered."}},{"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.turns.start()
            advanceUntilIdle()
            phone.telling.onEvent = { name, _ ->
                if (name == "coach_turn") {
                    phone.telling.onEvent = { _, _ -> }
                    phone.engine.reidentify()
                }
            }
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(MessageState.completed, phone.message(turn.coach)?.state)
            assertEquals(listOf("completed"), phone.telling.named("coach_turn").map { it["state"] })
            assertEquals(listOf("answered"), phone.telling.named("gym_ask_outcome").map { it["outcome"] })
            assertNull(phone.turns.turn.value)
        }
    }

    // D-10: a sign-in that rebinds the anon replica keeps its id and fires no change, and the seat is over all the same. The next batch never runs, and nothing the account holds leaves under the anon seat.
    @Test fun aSignInThatRebindsTheReplicaEndsTheAnonTurnAndNothingCrosses() = runTest {
        val log = EngineRoomFixture.server()
        TurnPhone(this, folder.newFolder(), script("[]")).use { other ->
            other.room.select("account-1")
            other.room.sync(log)
            other.seedRoutines()
            other.room.sync(log)
        }
        val server = script("""[
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"create_routine","input":$routineCall}]}},
            {"await":"results","batch":1},
            {"event":"calls","data":{"batch":2,"calls":[{"callId":"toolu_2","name":"list_routines","input":{}}]}},
            {"await":"results","batch":2},
            {"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.turns.start()
            advanceUntilIdle()
            val replica = phone.engine.activeReplica()
            phone.telling.onEvent = { name, properties ->
                if (name == "coach_ability" && properties["name"] == "create_routine") {
                    phone.telling.onEvent = { _, _ -> }
                    phone.completeSignIn("account-1")
                    phone.room.pull(log)
                }
            }
            val turn = checkNotNull(phone.turns.send("Add a day", null, null, anonymous = true))
            advanceUntilIdle()

            assertEquals(replica, phone.engine.activeReplica())
            assertFalse(phone.room.training.anonymous)
            val ended = checkNotNull(phone.message(turn.coach))
            assertEquals(MessageState.interrupted, ended.state)
            assertEquals(CoachTurnBounds.contextReads + "create_routine", ended.calls.map { it.name })
            assertEquals(listOf("rt_00000001", "rt_00000002", "rt_00000009"), phone.routines().map { it.id.record.string.orEmpty() }.sorted())
            assertEquals(listOf(1), server.posted.map { it.member("batch").long().toInt() })
            assertFalse(server.posted.any { "Push A" in it.jcs })
            assertEquals(1, server.stops)
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertNull(phone.turns.turn.value)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertEquals(listOf(mapOf("state" to "interrupted", "seat" to "anon", "code" to "seat_changed", "ability_calls" to "5", "refusals" to "0", "answer_bytes" to "0", "duration_ms" to "0")),
                phone.telling.named("coach_turn"))
        }
    }

    // A bound turn opened on the rebound replica is not the rebind's: only a turn under the seat that ended goes.
    @Test fun aBoundTurnSurvivesARebindItCameAfter() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")).use { phone ->
            phone.turns.start()
            phone.engine.commit(ScopeRef(Gym.scope), works.windmill.sync.api.Gesture(listOf(works.windmill.sync.api.Change.create(Gym.Types.routine, works.windmill.sync.api.NewID.Given(works.windmill.sync.core.RecordID("rt_00000001")),
                mapOf("name" to Json.of("Push A"), "position" to Json.of(0), "entries" to Json.parse("""[{"exerciseId":"bench-press"}]"""))))))
            phone.completeSignIn("account-1")
            phone.room.sync(EngineRoomFixture.server())
            val turn = checkNotNull(phone.turns.send("Bound", null, null, anonymous = false))
            advanceUntilIdle()
            assertEquals(MessageState.running, phone.message(turn.coach)?.state)
            phone.turns.requestStop()
            advanceUntilIdle()
            assertEquals(MessageState.stopped, phone.message(turn.coach)?.state)
        }
    }

    // A sign-in waiting on its decision holds the anon turn's writes, so what it counted holds still and the first Add lands; the rebind then ends the turn.
    @Test fun aPendingSignInHoldsTheTurnSoTheDecisionLands() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Hello"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")).use { phone ->
            phone.turns.start()
            advanceUntilIdle()
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            testScheduler.runCurrent()
            val question = phone.engine.signIn("account-1", mapOf("gym" to true))
            assertFalse(question.member("complete").bool())
            val pins = question.member("due").arr().associate { due -> due.member("product").str() to due.member("counted").arr().map(Json::str) }

            testScheduler.advanceTimeBy(30_000)
            testScheduler.runCurrent()
            assertEquals("", phone.message(turn.coach)?.text)
            assertEquals(LiveAnswer(turn.coach, "Hello"), phone.turns.liveAnswer.value)

            val answered = phone.engine.signIn("account-1", mapOf("gym" to true), mapOf("gym" to "add"), pins)
            assertTrue(answered.member("complete").bool())
            advanceUntilIdle()
            assertEquals(MessageState.interrupted, phone.message(turn.coach)?.state)
            assertEquals(1, phone.server.stops)
            assertEquals(listOf("seat_changed"), phone.telling.named("coach_turn").map { it["code"] })
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertNull(phone.turns.liveAnswer.value)
        }
    }

    // A running turn on each side of a sign-in's merge: each ends, neither clears the other's row, and no message stays running.
    @Test fun aRunningTurnOnEachSideOfAMergeBothEnd() = runTest {
        val server = script("""[{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.signIn("account-1")
            phone.turns.start()
            advanceUntilIdle()
            val bound = checkNotNull(phone.turns.send("Bound turn", null, null, anonymous = false))
            advanceUntilIdle()
            assertTrue(phone.engine.signOut("keep").member("complete").bool())
            phone.room.selected = null
            advanceUntilIdle()
            server.rewind()
            val anon = checkNotNull(phone.turns.send("Anon turn", null, null, anonymous = true))
            advanceUntilIdle()
            phone.completeSignIn("account-1")
            advanceUntilIdle()
            assertEquals(MessageState.interrupted, phone.message(bound.coach)?.state)
            assertEquals(MessageState.interrupted, phone.message(anon.coach)?.state)
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertNull(phone.turns.turn.value)
            assertEquals(listOf("seat_changed", "seat_changed"), phone.telling.named("coach_turn").map { it["code"] })
        }
    }

    // A death the first sweep cannot write, because the account was in transition, still tells when a later sweep ends it, once however often the sweep runs.
    @Test fun aDeathASweepCouldNotEndTellsWhenALaterOneDoes() = runTest {
        lateinit var snapshot: Json
        lateinit var turn: OpenTurn.Turn
        TurnPhone(this, folder.newFolder(), script("""[{"await":"stop"}]""")).use { phone ->
            turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            snapshot = phone.engine.snapshot()
        }
        var writable = false
        TurnPhone(this, folder.newFolder(), script("[]"), snapshot = snapshot, writable = { writable }).use { reopened ->
            reopened.turns.start()
            advanceUntilIdle()
            assertEquals(MessageState.running, reopened.message(turn.coach)?.state)
            assertEquals(emptyList<Map<String, String>>(), reopened.telling.named("coach_turn"))
            writable = true
            reopened.turns.sweep()
            reopened.turns.sweep()
            advanceUntilIdle()
            assertEquals(MessageState.interrupted, reopened.message(turn.coach)?.state)
            assertEquals(listOf("process_ended"), reopened.telling.named("coach_turn").map { it["code"] })
            reopened.turns.sweep()
            advanceUntilIdle()
            assertEquals(1, reopened.telling.named("coach_turn").size)
        }
    }

    // A conversation deleted on another phone under a live turn: nobody's fault. The turn ends, the server hears a Stop, the row lets go, and no Issue is filed.
    @Test fun aConversationDeletedElsewhereEndsTheTurnWithNoReport() = runTest {
        val server = script("""[{"event":"text","data":{"delta":"Hello"}},{"await":"results","batch":9},{"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            testScheduler.runCurrent()
            val replica = phone.engine.activeReplica()
            phone.room.training.pinnedOn(ReplicaPin(replica, true)) { runner -> assertTrue(runner.run(DeleteConversation(turn.thread)) is Outcome.Committed) }
            advanceUntilIdle()
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(1, server.stops)
            assertNull(phone.turns.turn.value)
            assertEquals(listOf(mapOf("state" to "interrupted", "seat" to "anon", "ability_calls" to "4", "refusals" to "0", "answer_bytes" to "5", "code" to "gone", "duration_ms" to "5000")), phone.telling.named("coach_turn"))
        }
    }

    // A row naming a message gone, as a process death under a deletion leaves it, lets go at the sweep.
    @Test fun aRowNamingAGoneMessageLetsGoAtTheSweep() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            val replica = phone.engine.activeReplica()
            phone.room.training.pinnedOn(ReplicaPin(replica, true)) { runner ->
                val turn = (runner.run(OpenTurn(question = "Question")) as Outcome.Committed).result
                assertTrue(runner.run(DeleteConversation(turn.thread)) is Outcome.Committed)
                phone.engine.commit(ScopeRef(Gym.scope), works.windmill.sync.api.Gesture(emptyList(), local = listOf(works.windmill.sync.api.DeviceWrite(EndTurn.runningTurnKey, turn.coach.json))))
            }
            assertTrue(phone.device(EndTurn.runningTurnKey) != null)
            phone.turns.sweep()
            advanceUntilIdle()
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.named("coach_turn"))
        }
    }

    // A lapsed token at the open is a door, not a dead end: the sign-in, in the room's own words.
    @Test fun aLapsedTokenAtTheOpenOffersTheSignIn() = runTest {
        val server = script("[]").apply { refuseOpen = TurnRefusal(401, "unauthenticated", null) }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.signIn()
            advanceUntilIdle()
            checkNotNull(phone.turns.send("Question", null, null, anonymous = false))
            advanceUntilIdle()
            val refused = phone.turns.refusal.value
            assertEquals(CoachTurnRefusal.SessionLapsed, refused)
            assertEquals(string(R.string.gym_coach_access_needs_sign_in), refused?.words.spelled())
            assertEquals(CoachRecovery.signIn, refused?.recovery(anonymous = false))
            assertFalse(refused!!.capped)
            assertEquals(WithdrawnTurn("Question", null, null), phone.turns.withdrawn.value)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // A retired catalog is the update's door, and a blank question and a catalog that cannot be read refuse with nothing written.
    @Test fun aRetiredCatalogOffersTheUpdate() = runTest {
        val server = script("[]").apply { refuseOpen = TurnRefusal(426, "coach-update-required", null) }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.UpdateRequired, phone.turns.refusal.value)
            assertEquals(CoachRecovery.update, phone.turns.refusal.value?.recovery(anonymous = true))
            assertEquals(emptyList<CoachMessage>(), phone.messages())
        }
    }

    @Test fun aBlankQuestionIsNoFailure() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            assertNull(phone.turns.send("   ", null, null, anonymous = true))
            assertEquals(CoachTurnFault.unsaved, phone.turns.fault.value)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertNothingKept(phone)
        }
    }

    @Test fun aCatalogThatCannotBeReadKeepsNothingAndReports() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            val unread = CoachTurns(phone.room.training, phone.server, phone.installation, { null }, phone.pictures,
                lazy { Catalog(Json.parse("""{"not":"a catalog"}""")) }, phone.telling, {}, "https://windmill.works", phone.scope,
                coroutineContext[kotlin.coroutines.ContinuationInterceptor] as kotlinx.coroutines.CoroutineDispatcher)
            assertNull(unread.send("Question", null, null, anonymous = true))
            assertEquals(CoachTurnFault.unsaved, unread.fault.value)
            assertEquals(listOf(mapOf("failure_kind" to "storage", "operation" to "gym.coachTurn")), phone.telling.failures)
            assertNothingKept(phone)
        }
    }

    // A round the server refuses says the balance is gone only when its read does: the same code on a positive balance says the allowance is unavailable, with the same sign-in, and neither takes the question back.
    @Test fun aRefusedRoundSaysAnAllowanceIsUsedOnlyWhenItsReadSaysSo() = runTest {
        for ((read, refused, words) in listOf(
            Triple(""","allowance":{"remaining":"0.007075000","reserved":"0.000000000"}""", CoachTurnRefusal.Allowance("subject_exhausted"), "Coach’s AI allowance is unavailable right now.\nSign in to continue."),
            Triple(""","allowance":{"remaining":"0.000000000","reserved":"0.000000000"}""", CoachTurnRefusal.Allowance("subject_exhausted", spent = true), "You have used all of your AI allowance.\nSign in to continue."),
            Triple("", CoachTurnRefusal.Allowance("subject_exhausted"), "Coach’s AI allowance is unavailable right now.\nSign in to continue."),
        )) {
            val server = script("""[{"event":"error","data":{"code":"subject_exhausted"$read}}]""")
            TurnPhone(this, folder.newFolder(), server).use { phone ->
                val turn = checkNotNull(phone.turns.send("Private question", null, null, anonymous = true))
                advanceUntilIdle()
                assertEquals(refused, phone.turns.refusal.value)
                assertEquals(words, phone.turns.refusal.value?.said(anonymous = true, clock24 = false).spelled())
                assertEquals(CoachRecovery.signIn, phone.turns.refusal.value?.recovery(anonymous = true))
                assertNull(phone.turns.withdrawn.value)
                assertEquals("Private question", checkNotNull(phone.message(turn.lifter)).text)
                assertEquals(MessageState.failed, checkNotNull(phone.message(turn.coach)).state)
                assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            }
        }
    }

    // The same words before the stream, from the read the refusal's body carries.
    @Test fun aRefusedOpenSaysAnAllowanceIsUsedOnlyWhenItsBodySaysSo() = runTest {
        for ((read, refused) in listOf(
            """{"code":"subject_exhausted","allowance":{"remaining":"0.000000000","reserved":"0.000000000"}}""" to CoachTurnRefusal.Allowance("subject_exhausted", spent = true),
            """{"code":"subject_exhausted","allowance":{"remaining":"0.000000000","reserved":"0.040775000"}}""" to CoachTurnRefusal.Allowance("subject_exhausted"),
        )) {
            val server = script("[]").apply { refuseOpen = TurnRefusal.of(429, read.encodeToByteArray()) }
            TurnPhone(this, folder.newFolder(), server).use { phone ->
                checkNotNull(phone.turns.send("Private question", null, null, anonymous = true))
                advanceUntilIdle()
                assertEquals(refused, phone.turns.refusal.value)
                assertEquals(WithdrawnTurn("Private question", null, null), phone.turns.withdrawn.value)
                assertEquals(emptyList<CoachMessage>(), phone.messages())
            }
        }
    }

    // A turn withdrawn from a conversation that stands returns to it.
    @Test fun aWithdrawnTurnInAConversationThatStandsNamesIt() = runTest {
        val server = script("""[{"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val first = checkNotNull(phone.turns.send("First", null, null, anonymous = true))
            advanceUntilIdle()
            phone.room.now += 1_000
            server.refuseOpen = TurnRefusal(429, "free_day_exhausted", null)
            checkNotNull(phone.turns.send("Second", null, first.thread, anonymous = true))
            advanceUntilIdle()
            assertEquals(WithdrawnTurn("Second", null, first.thread), phone.turns.withdrawn.value)
            assertEquals(listOf(first.thread), phone.threads().map { it.id })
        }
    }

    // The room draws every delta; the record takes the text every five seconds, at each batch and at the end. A 9.6 KB answer in 240 deltas over a minute.
    @Test fun aStreamedAnswerReachesTheRoomAtEveryDeltaAndTheRecordEveryFiveSeconds() = runTest {
        val log = EngineRoomFixture.server()
        val delta = "word ".repeat(8)
        val minute = object : TurnTransport {
            override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow {
                repeat(240) {
                    emit(TurnEvent.Text(delta))
                    delay(250)
                }
                emit(TurnEvent.Done(TurnState.completed, false))
            }
            override fun resume(turnId: String, seat: TurnSeat): Flow<TurnEvent> = flow { }
            override suspend fun answer(turnId: String, batch: Int, results: List<ToolOutcome>, seat: TurnSeat) = Unit
            override suspend fun stop(turnId: String, seat: TurnSeat) = Unit
        }
        TurnPhone(this, folder.newFolder(), minute).use { phone ->
            phone.room.select("account-1")
            phone.room.sync(log)
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = false))
            testScheduler.runCurrent()
            assertEquals(LiveAnswer(turn.coach, delta), phone.turns.liveAnswer.value)
            val opened = phone.room.outbox().size

            testScheduler.advanceTimeBy(7_000)
            testScheduler.runCurrent()
            assertEquals(delta.repeat(29), phone.turns.liveAnswer.value?.text)
            assertEquals(delta.repeat(20), phone.message(turn.coach)?.text)
            advanceUntilIdle()

            assertEquals(delta.repeat(240), phone.message(turn.coach)?.text)
            assertEquals(MessageState.completed, phone.message(turn.coach)?.state)
            assertNull(phone.turns.liveAnswer.value)
            val commits = phone.room.outbox().size - opened
            val pushedBytes = generateSequence {
                phone.engine.nextPush()?.also { request ->
                    val response = log.push(request, Credential.Account("account-1"), phone.room.now)
                    val reading = ClockReading(phone.room.now, phone.room.now, "test")
                    phone.engine.onPushResponse(request, SyncResponse(response.status, response.body), RequestTiming(reading, reading))
                }
            }.sumOf { it.jcs.length.toLong() }
            println("a streamed answer of ${delta.length * 240} bytes: $commits commits after the open, $pushedBytes bytes pushed")
            assertEquals(13, commits)
            assertTrue("pushed $pushedBytes", pushedBytes < 70_000)
        }
    }

    // §4.5, the sign-out sheet: a cancellable transition closes the door, so the turn waits, reports nothing and writes nothing; the sheet's Cancel lets it on.
    @Test fun anAccountInTransitionHoldsTheTurnUntilTheSheetCloses() = runTest {
        var writable = true
        TurnPhone(this, folder.newFolder(), answersOneCreate, writable = { writable }).use { phone ->
            phone.telling.onEvent = { name, _ ->
                if (name == "gym_ask_started") writable = false
            }
            val turn = checkNotNull(phone.turns.send("Add a day", null, null, anonymous = true))
            testScheduler.advanceTimeBy(30_000)
            testScheduler.runCurrent()
            val held = checkNotNull(phone.message(turn.coach))
            assertEquals(emptyList<AbilityCall>(), held.calls)
            assertEquals(MessageState.running, held.state)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertEquals(0, phone.server.opened.size)

            writable = true
            advanceUntilIdle()
            assertEquals(MessageState.completed, phone.message(turn.coach)?.state)
            assertEquals(listOf("Day 1"), phone.routines().map { it.name })
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // A sign-out confirmed while the turn waits on the transition: the wait ends in the abandon, and nothing lands on the anon replica.
    @Test fun aTurnWaitingOnATransitionIsAbandonedWhenTheReplicaChanges() = runTest {
        var writable = true
        TurnPhone(this, folder.newFolder(), answersOneCreate, writable = { writable }).use { phone ->
            phone.signIn()
            phone.turns.start()
            advanceUntilIdle()
            phone.telling.onEvent = { name, _ -> if (name == "gym_ask_started") writable = false }
            val turn = checkNotNull(phone.turns.send("Add a day", null, null, anonymous = false))
            testScheduler.advanceTimeBy(5_000)
            testScheduler.runCurrent()
            assertTrue(phone.engine.signOut("keep").member("complete").bool())
            writable = true
            advanceUntilIdle()
            assertEquals(emptyList<Routine>(), phone.routines())
            assertEquals(null, phone.message(turn.coach))
            assertEquals(1, phone.server.stops)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertNull(phone.turns.turn.value)
        }
    }

    // A Stop the server cannot hear ends the turn on this phone alone, and the band says so.
    @Test fun aStopWithNoConnectionStopsOnThisPhoneAndSaysSo() = runTest {
        val server = object : works.windmill.agent.TurnTransport by script("""[{"event":"text","data":{"delta":"Par"}},{"await":"stop"}]""") {
            override suspend fun stop(turnId: String, seat: TurnSeat) { throw works.windmill.agent.TurnConnectionLost(null) }
        }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            testScheduler.runCurrent()
            phone.turns.requestStop()
            advanceUntilIdle()
            assertEquals(MessageState.stopped, phone.message(turn.coach)?.state)
            assertEquals(CoachTurnFault.stoppedOffline, phone.turns.fault.value)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // §4.5: no attempt to open reached a server and no frame came, so the turn never began. Nothing of it remains, the question returns with the words that say why, and lost network files nothing.
    @Test fun everyOpenLostTakesTheTurnBackAndSaysNoConnection() = runTest {
        val server = object : TurnTransport by script("[]") {
            var opens = 0
            override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow {
                opens += 1
                throw works.windmill.agent.TurnConnectionLost(null)
            }
            var stops = 0
            override suspend fun stop(turnId: String, seat: TurnSeat) {
                stops += 1
                throw works.windmill.agent.TurnConnectionLost(null)
            }
        }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            testScheduler.advanceTimeBy(1_500)
            assertEquals(true, phone.turns.activity.value?.reconnecting)
            assertEquals(listOf("Question", ""), phone.messages().map { it.text })
            advanceUntilIdle()
            assertEquals(5, server.opens)
            assertEquals(1, server.stops)
            assertEquals(WithdrawnTurn("Question", null, null), phone.turns.withdrawn.value)
            assertEquals(CoachTurnRefusal.Offline, phone.turns.refusal.value)
            assertEquals("No connection. Your question is kept here.", phone.turns.refusal.value?.words.spelled())
            assertEquals(CoachRecovery.tryAgain, phone.turns.refusal.value?.recovery(anonymous = true))
            assertNull(phone.turns.fault.value)
            assertNull(phone.turns.activity.value)
            assertNull(phone.turns.turn.value)
            assertEquals(emptyList<CoachMessage>(), phone.messages())
            assertEquals(emptyList<CoachThread>(), phone.threads())
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(listOf(mapOf("operation" to "gym_coach_turn", "route" to "/v1/gym", "method" to "POST", "failure_kind" to "offline")), phone.telling.named("api_request_failed"))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "offline", "duration_ms" to "15000")), phone.telling.named("gym_ask_outcome"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.named("coach_turn"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // The attempts take seconds, and the log syncs on its own through them: a turn taken back after its records reached the server leaves none there, and no notice here.
    @Test fun aTurnTakenBackAfterItsRecordsSyncedLeavesNothingBehind() = runTest {
        val log = EngineRoomFixture.server()
        val server = object : TurnTransport by script("[]") {
            override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow { throw works.windmill.agent.TurnConnectionLost(null) }
        }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.room.select("account-1")
            phone.room.sync(log)
            checkNotNull(phone.turns.send("Question", null, null, anonymous = false))
            testScheduler.advanceTimeBy(1_500)
            phone.room.sync(log)
            assertEquals(emptyList<Json>(), phone.room.outbox())
            assertEquals(listOf("Question", ""), phone.messages().map { it.text })

            advanceUntilIdle()
            assertEquals(WithdrawnTurn("Question", null, null), phone.turns.withdrawn.value)
            assertEquals(emptyList<CoachMessage>(), phone.messages())
            phone.room.sync(log)
            assertEquals(emptyList<Json>(), phone.room.outbox())
            assertEquals(emptyList<Json>(), phone.room.notices())
            assertEquals(emptyList<CoachMessage>(), phone.messages())
            assertEquals(emptyList<CoachThread>(), phone.threads())
            assertNull(phone.device(EndTurn.runningTurnKey))
        }
    }

    // A captive portal's page at every attempt: the beats of a lost connection, the same taking back, no report, and a count of its own.
    @Test fun aPageThatIsNoStreamReconnectsLikeALostConnectionAndTakesTheTurnBackUnderItsOwnName() = runTest {
        val server = object : TurnTransport by script("[]") {
            override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow { throw works.windmill.agent.TurnConnectionLost(null, notAStream = true) }
        }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(WithdrawnTurn("Question", null, null), phone.turns.withdrawn.value)
            assertEquals(CoachTurnRefusal.Offline, phone.turns.refusal.value)
            assertEquals(emptyList<CoachMessage>(), phone.messages())
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(listOf(mapOf("operation" to "gym_coach_turn", "route" to "/v1/gym", "method" to "POST", "failure_kind" to "malformed")), phone.telling.named("api_request_failed"))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "offline", "duration_ms" to "15000")), phone.telling.named("gym_ask_outcome"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.named("coach_turn"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // Anonymous AI switched off on the server is a refusal it meant: the turn comes back with the sign-in door, under `refused`, and nothing is filed.
    @Test fun anonymousAiSwitchedOffIsARefusalTheServerMeant() = runTest {
        val server = script("[]").apply { refuseOpen = TurnRefusal(503, TurnRefusal.anonymousUnavailable, null) }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.AnonymousUnavailable, phone.turns.refusal.value)
            assertEquals(WithdrawnTurn("Question", null, null), phone.turns.withdrawn.value)
            assertEquals(listOf(mapOf("operation" to "gym_coach_turn", "route" to "/v1/gym", "method" to "POST", "failure_kind" to "http", "status" to "503")), phone.telling.named("api_request_failed"))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "refused", "duration_ms" to "0")), phone.telling.named("gym_ask_outcome"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // A Coach message of a shape this build cannot read, as another surface or a later build writes one: the sweep deletes no picture, files nothing and says so once per pass; once that message is gone the next sweep forgets the row no message claims.
    @Test fun aMessageThisBuildCannotReadHoldsThePictureSweepWithNoFailure() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Hi"}},{"event":"done","data":{"state":"completed"}}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            val unclaimed = CoachPictureRow("picture-1", "image/jpeg", 40, 30, 100)
            phone.engine.commit(ScopeRef(Gym.scope), works.windmill.sync.api.Gesture(emptyList(), local = listOf(works.windmill.sync.api.DeviceWrite(CoachPictureRow.key(unclaimed.id), unclaimed.json))))
            val unreadable = works.windmill.sync.core.RecordID("turnUnreadable01")
            phone.engine.commit(ScopeRef(Gym.scope), works.windmill.sync.api.Gesture(listOf(works.windmill.sync.api.Change.create(Gym.Types.message, works.windmill.sync.api.NewID.Given(unreadable),
                mapOf("threadId" to turn.thread.record.json, "role" to Json.of("coach"), "at" to Json.of(1_800_000_000_000L), "calls" to Json.parse("""[{"callId":"c","name":"n","outcome":"ok"}]"""))))))
            phone.turns.sweep()
            advanceUntilIdle()
            assertEquals(unclaimed.json, phone.device(CoachPictureRow.key(unclaimed.id)))
            assertEquals(listOf(mapOf("screen" to "coach", "action" to "picture_sweep", "outcome" to "message_unreadable")), phone.telling.named("gym_action"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            phone.engine.commit(ScopeRef(Gym.scope), works.windmill.sync.api.Gesture(listOf(works.windmill.sync.api.Change.delete(Gym.Types.message, unreadable))))
            phone.turns.sweep()
            advanceUntilIdle()
            assertNull(phone.device(CoachPictureRow.key(unclaimed.id)))
            assertEquals(1, phone.telling.named("gym_action").size)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // A Stop nobody heard, before any frame: the turn is not left running and the question is not left on a record that never reached Coach.
    @Test fun aStopNobodyHeardBeforeAnyFrameTakesTheTurnBack() = runTest {
        val server = object : TurnTransport by script("""[{"await":"stop"}]""") {
            override suspend fun stop(turnId: String, seat: TurnSeat) { throw works.windmill.agent.TurnConnectionLost(null) }
        }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            phone.turns.requestStop()
            advanceUntilIdle()
            assertEquals(WithdrawnTurn("Question", null, null), phone.turns.withdrawn.value)
            assertEquals(CoachTurnRefusal.Offline, phone.turns.refusal.value)
            assertNull(phone.turns.fault.value)
            assertNull(phone.turns.turn.value)
            assertEquals(emptyList<CoachMessage>(), phone.messages())
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "offline", "duration_ms" to "0")), phone.telling.named("gym_ask_outcome"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.named("coach_turn"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // A record the turn's own write finds gone ends the turn and reports once; a sweep never touches a live turn.
    @Test fun aSweepNeverEndsALiveTurn() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            phone.turns.sweep()
            advanceUntilIdle()
            assertEquals(MessageState.running, phone.message(turn.coach)?.state)
            assertEquals(turn.coach.json, phone.device(EndTurn.runningTurnKey))
            phone.turns.requestStop()
            advanceUntilIdle()
            assertEquals(MessageState.stopped, phone.message(turn.coach)?.state)
        }
    }

    // The event schemas hold what they do not know back: a word in a code, a count that is not one, a key nobody registered.
    @Test fun theTurnsEventSchemasKeepOnlyLabelsAndCounts() {
        val schemas = EventSchemas.platform + GymEvents.schemas
        assertEquals(mapOf("state" to "completed"), schemas.properties("coach_turn", mapOf("state" to "completed", "code" to "a private word", "refusals" to "two", "question" to "Private")))
        assertEquals(mapOf("state" to "stopped", "seat" to "bound", "code" to "coach-busy", "ability_calls" to "5", "refusals" to "0", "answer_bytes" to "12", "duration_ms" to "40"),
            schemas.properties("coach_turn", mapOf("state" to "stopped", "seat" to "bound", "code" to "coach-busy", "ability_calls" to "5", "refusals" to "0", "answer_bytes" to "12", "duration_ms" to "40")))
        assertEquals(mapOf("name" to "list_notes"), schemas.properties("coach_ability", mapOf("name" to "list_notes", "outcome" to "said something", "input" to "Private")))
        assertEquals(mapOf("screen" to "coach"), schemas.properties("gym_ask_outcome", mapOf("screen" to "coach", "name" to "list_notes", "seat" to "bound")))
    }

    // Only what the catalog names leaves as a name, and only a known code as an outcome.
    @Test fun anAbilityTheCatalogDoesNotNameLeavesAsOther() {
        val telling = TellingRecorder()
        val tells = GymTurnTelemetry(telling, lazy { TurnPhone.catalog() })
        tells.ability(TurnLabel.of("list_notes"), TurnLabel.of("ok"))
        tells.ability(TurnLabel.of("private_word"), TurnLabel.of("another_word"))
        tells.ability(TurnLabel.of("A sentence with spaces"), TurnLabel.of("refused"))
        assertEquals(listOf(mapOf("name" to "list_notes", "outcome" to "ok"), mapOf("name" to "other", "outcome" to "other"), mapOf("name" to "other", "outcome" to "refused")),
            telling.named("coach_ability"))
    }

    @Test fun theLeaseHoldsTheTurnsWork() = runTest {
        val held = mutableListOf<kotlinx.coroutines.Job>()
        TurnPhone(this, folder.newFolder(), script("""[{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]"""), lease = { held += it }).use { phone ->
            checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            assertTrue(held.single().isActive)
            phone.turns.requestStop()
            advanceUntilIdle()
            assertTrue(held.single().isCompleted)
        }
    }

    private fun twoCreates() = script("""[
        {"event":"calls","data":{"batch":1,"calls":[
            {"callId":"toolu_1","name":"create_routine","input":$routineCall},
            {"callId":"toolu_2","name":"create_routine","input":{"id":"rt_00000010","name":"Day 2","position":1,"entries":[{"exerciseId":"bench-press"}]}}]}},
        {"await":"results","batch":1}]""")

    private fun hostOf(phone: TurnPhone, turn: OpenTurn.Turn) = GymTurnHost(turn, "Add a day", ReplicaPin(phone.engine.activeReplica(), true),
        phone.room.training, TurnPhone.catalog(), phone.pictures, "https://windmill.works", Dispatchers.Unconfined)

    private suspend fun assertThrowsRecordRefused(work: suspend () -> Unit) {
        try {
            work()
        } catch (refused: TurnRecordRefused) {
            return
        }
        throw AssertionError("The record took the write")
    }

    // "What arrived is kept" holds for an app that stopped before it died: the record takes the words so far when the app stops, between its coalesced commits, and takes them once.
    @Test fun whatArrivedIsCommittedWhenTheAppStopsAndStandsOverADeath() = runTest {
        val server = script("""[{"event":"text","data":{"delta":"Four words arrived here"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.signIn()
            phone.turns.start()
            advanceUntilIdle()
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = false))
            advanceTimeBy(1_000)
            assertEquals("the coalesced commit has not come round", "", phone.message(turn.coach)?.text)
            val before = phone.engine.readRevision()

            phone.turns.appStopped()
            phone.turns.appStopped()
            advanceTimeBy(1)
            assertEquals("Four words arrived here", phone.message(turn.coach)?.text)
            assertEquals("asked twice, one commit", before + 1, phone.engine.readRevision())
            val snapshot = phone.engine.snapshot()
            phone.turns.requestStop()
            advanceUntilIdle()

            TurnPhone(this, folder.newFolder(), script("[]"), snapshot = snapshot).use { reopened ->
                reopened.turns.start()
                advanceUntilIdle()
                val message = reopened.message(turn.coach)
                assertEquals(MessageState.interrupted, message?.state)
                assertEquals("Four words arrived here", message?.text)
            }
        }
    }

    // Nothing has arrived when the app stops: nothing is written, and after a death the question stands over an interrupted answer with no words.
    @Test fun anAppThatStopsBeforeAnyWordCommitsNothingAndTheQuestionStands() = runTest {
        val server = script("""[{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.signIn()
            phone.turns.start()
            advanceUntilIdle()
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = false))
            advanceTimeBy(1_000)
            val before = phone.engine.readRevision()
            phone.turns.appStopped()
            advanceTimeBy(1)
            assertEquals(before, phone.engine.readRevision())
            val snapshot = phone.engine.snapshot()
            phone.turns.requestStop()
            advanceUntilIdle()

            TurnPhone(this, folder.newFolder(), script("[]"), snapshot = snapshot).use { reopened ->
                reopened.turns.start()
                advanceUntilIdle()
                assertEquals(MessageState.interrupted, reopened.message(turn.coach)?.state)
                assertEquals("", reopened.message(turn.coach)?.text)
                assertEquals("Question", reopened.message(turn.lifter)?.text)
            }
        }
    }
}
