package works.windmill.gym.coach.turn

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
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
import works.windmill.agent.ToolCall
import works.windmill.agent.ToolOutcome
import works.windmill.agent.TurnLabel
import works.windmill.agent.TurnEnd
import works.windmill.agent.TurnRecordRefused
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnState
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.telemetry.GymEvents
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.EventSchemas
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.reidentify
import works.windmill.sync.engine.signIn
import works.windmill.sync.engine.signOut
import works.windmill.sync.schema.Gym

// The turn around the driver on a real engine: admission and what it keeps, the installation's answers, a process that died at each step of a batch, a seat that changed under a batch, an account in transition, and telemetry that says nothing of what was said.
@OptIn(ExperimentalCoroutinesApi::class)
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
            assertTrue(phone.turns.idle)
        }
    }

    // The installation the server refused stands: the phone keeps it, and asks nobody the next time.
    @Test fun anInvalidInstallationAtTheOpenWithdrawsTheTurnAndStaysInvalid() = runTest {
        val server = script("[]").apply { refuseOpen = TurnRefusal(401, "invalid_installation", null) }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val turn = checkNotNull(phone.turns.send("Private question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Installation("invalid_installation"), phone.turns.refusal.value)
            assertEquals(turn, phone.turns.withdrawn.value)
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
            WindmillApiException.Refused(503, Refusal(code = "anonymous_ai_unavailable")) to CoachTurnRefusal.Said("anonymous_ai_unavailable"),
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
            assertTrue(phone.turns.idle)
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
            assertTrue(phone.turns.idle)

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
            assertTrue(phone.turns.idle)
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
            assertTrue(phone.turns.idle)
        }
    }

    // A Stop the server cannot hear ends the turn on this phone alone, and the band says so.
    @Test fun aStopWithNoConnectionStopsOnThisPhoneAndSaysSo() = runTest {
        val server = object : works.windmill.agent.TurnTransport by script("""[{"await":"stop"}]""") {
            override suspend fun stop(turnId: String, seat: TurnSeat) { throw works.windmill.agent.TurnConnectionLost(null) }
        }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            phone.turns.requestStop()
            advanceUntilIdle()
            assertEquals(MessageState.stopped, phone.message(turn.coach)?.state)
            assertEquals(CoachTurnFault.stoppedOffline, phone.turns.fault.value)
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

    private fun hostOf(phone: TurnPhone, turn: OpenTurn.Turn) = GymTurnHost(turn, TurnSeat.Anon("credential"), "Add a day", phone.engine.activeReplica(),
        phone.room.training, TurnPhone.catalog(), phone.pictures, "https://windmill.works", Dispatchers.Unconfined)

    private suspend fun assertThrowsRecordRefused(work: suspend () -> Unit) {
        try {
            work()
        } catch (refused: TurnRecordRefused) {
            return
        }
        throw AssertionError("The record took the write")
    }
}
