package works.windmill.gym.coach.turn

import android.graphics.Bitmap
import android.graphics.Color
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.time.Duration.Companion.milliseconds
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
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Repository
import works.windmill.domain.kit.Seat
import works.windmill.gym.coach.CoachAttachment
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.Mark
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.sync.Proposal
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.net.GymRest
import works.windmill.gym.presentation.McpKey
import works.windmill.gym.presentation.OAuthGrant
import works.windmill.gym.sharing.SessionShare
import works.windmill.gym.telemetry.GymEvents
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.sync.api.RecordRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.core.Sha256
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.signIn
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// A gym turn on the Coach engine, on a real replica, against a scripted AI service: admission and what it keeps, the profile and the first content each seat sends, the ids the turn seeds, the once-rules, a share through the Share door, a picture uploaded once, the mark with its round, the access states and their words, Stop, a seat that changes under a turn, a process that dies in its last round, and telemetry that says nothing of what was said.
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CoachTurnsTests {
    @get:Rule val folder = TemporaryFolder()

    private fun script(vararg frames: String) = ScriptedTurns(frames.flatMap { Json.parse(it).arr() })

    private val routineCall = """{"id":"the-model-names-this","name":"Day 1","position":0,"entries":[{"exerciseId":"bench-press"}]}"""

    private fun TurnPhone.routines(): List<Routine> = engine.read(ScopeRef(Gym.scope)) { Repository.decode(Routine, it.drawn(Routine.type)) }
    private fun TurnPhone.proposals(): List<Proposal> = engine.read(ScopeRef(Gym.scope)) { Repository.decode(Proposal, it.drawn(Proposal.type)) }

    private fun TurnPhone.completeSignIn(account: String) {
        val question = engine.signIn(account, mapOf("gym" to true), serverSchema = SyncSchema.registry.version)
        if (!question.member("complete").bool()) {
            val pins = question.member("due").arr().associate { due -> due.member("product").str() to due.member("counted").arr().map(Json::str) }
            assertTrue(engine.signIn(account, mapOf("gym" to true), mapOf("gym" to "add"), pins, serverSchema = SyncSchema.registry.version).member("complete").bool())
        }
        room.selected = account
    }

    private fun assertNothingKept(phone: TurnPhone) {
        assertEquals(emptyList<CoachMessage>(), phone.messages())
        assertEquals(emptyList<CoachThread>(), phone.threads())
        assertNull(phone.device(EndTurn.runningTurnKey))
        assertEquals(0, phone.server.passes)
        assertEquals(0, phone.server.opened.size)
    }

    // Phone-hosted Coach abilities §4.1, each refusal in its turn: nothing is written, nothing leaves, and the reason is said once.
    @Test fun aFirstPullStillComingRefusesASignedInSend() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            phone.room.select("account-1")
            assertNull(phone.turns.send("Private question", null, null, anonymous = false))
            assertEquals(CoachTurnRefusal.LogArriving, phone.turns.refusal.value)
            assertNothingKept(phone)
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "refused")), phone.telling.named("gym_ask_outcome"))
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

    // Coach engine R-6: a question sent with no connection returns to the field at once, before a seat, a pass or a record.
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

    @Test fun anUnknownConversationKeepsNothing() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            assertNull(phone.turns.send("Private question", null, Id("thrdNobody000000", CoachThread), anonymous = true))
            assertEquals(CoachTurnFault.unsaved, phone.turns.fault.value)
            assertNothingKept(phone)
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

    // gym Coach on the AI service §3, §4.1: a question answered. Round 1 is the profile of the seat, its tools each strict as catalog/3 states, and the first content: each context read under its lead, then the question. The answer lands whole, the mark goes, and the turn tells its end in counts.
    @Test fun aQuestionIsAnsweredWithTheProfileOfItsSeatAndTheFirstContent() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Add "}},{"event":"text","data":{"delta":"5 kg."}},{"event":"done","data":{"state":"completed"}}]""")).use { phone ->
            phone.turns.start()
            advanceUntilIdle()
            val turn = checkNotNull(phone.turns.send("How heavy today?", null, null, anonymous = true))
            advanceUntilIdle()

            val request = phone.server.opened.single().request
            val catalog = TurnPhone.catalog()
            val offered = catalog.offered(Seat.anon)
            assertEquals(15, offered.size)
            assertEquals(offered.map { Json.objectOf("name" to Json.of(it.name), "description" to Json.of(it.description), "input" to it.input, "strict" to Json.of(it.strict)) },
                request.member("tools").arr())
            assertEquals(listOf("create_routine", "create_exercise", "propose_routine_change", "propose_routine_removal", "propose_workout_change"),
                offered.filter { it.strict }.map { it.name })
            assertEquals(Json.of("large"), request.member("model"))
            assertEquals(Json.of("low"), request.member("effort"))
            assertEquals(Json.parse("""{"maxTokens":2000,"minTokens":1024,"schema":null}"""), request.member("output"))
            assertEquals(Json.array(Json.of(TurnPhone.words().prompt)), request.member("system"))
            val words = TurnPhone.words().firstContent.member("contextLeads")
            val texts = phone.server.opened.single().texts
            assertEquals(CoachTurnBounds.contextReads.map { words.member(it).str() }, texts.dropLast(1).map { it.substringBefore('\n') })
            assertEquals("How heavy today?", texts.last())

            val answered = checkNotNull(phone.message(turn.coach))
            assertEquals(MessageState.completed, answered.state)
            assertEquals("Add 5 kg.", answered.text)
            assertEquals(CoachTurnBounds.contextReads.map { contextCallPrefix + it }, answered.calls.map { it.callId })
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertNull(phone.device(Mark.roundKey))
            assertNull(phone.turns.turn.value)
            assertNull(phone.turns.liveAnswer.value)
            assertEquals(listOf(mapOf("state" to "completed", "seat" to "anon", "rounds" to "1", "ability_calls" to "0", "refusals" to "0", "answer_bytes" to "9", "duration_ms" to "0")),
                phone.telling.named("coach_turn"))
            assertEquals(listOf(mapOf("screen" to "coach")), phone.telling.named("gym_ask_started"))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "answered", "duration_ms" to "0")), phone.telling.named("gym_ask_outcome"))
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertTrue(phone.telling.events.none { (_, properties) -> properties.values.any { "How heavy" in it || "5 kg" in it } })
        }
    }

    // The bound seat's profile: every declared ability the catalog lets Coach run or propose, the shares and the note among them, at medium effort; signed out, those an account needs are not offered, and nor is the note's once-rule.
    @Test fun eachSeatHasItsProfile() {
        val profile = GymProfile(TurnPhone.catalog(), TurnPhone.words())
        val bound = profile.of(Seat.bound)
        val anon = profile.of(Seat.anon)
        assertEquals(18, bound.tools.size)
        assertEquals(bound.tools.map { it.name } - listOf("save_note", "share_session", "revoke_share"), anon.tools.map { it.name })
        assertEquals("medium" to "low", bound.effort to anon.effort)
        assertEquals(listOf("routine-proposal", "workout-proposal", "note"), bound.groups.map { it.name })
        assertEquals(listOf("routine-proposal", "workout-proposal"), anon.groups.map { it.name })
        assertEquals(listOf(8L, 12L, 6L), listOf(bound.modelCalls, bound.abilityCalls, bound.writes))
        assertEquals(listOf("create_routine", "create_exercise", "save_note", "share_session"), bound.tools.filter { it.countsAsWrite }.map { it.name })
        assertEquals("you already wrote a routine or workout proposal this turn; fold both into one document.", bound.refusals["one-proposal"])
        assertEquals("", bound.refusals["invalid-arguments"])
        assertEquals("gym.coach" to 1L, bound.name to bound.version)
    }

    // The earlier conversation leads the first content, marked and oldest first, each line under its speaker's name.
    @Test fun theHistoryIsMarkedAndNamed() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Yes."}},{"event":"done","data":{"state":"completed"}}]""")).use { phone ->
            val first = checkNotNull(phone.turns.send("First?", null, null, anonymous = true))
            advanceUntilIdle()
            phone.room.now += 1_000
            phone.server.rewind()
            checkNotNull(phone.turns.send("Second?", null, first.thread, anonymous = true))
            advanceUntilIdle()
            val earlier = TurnPhone.words().firstContent.member("earlierConversation")
            assertEquals(earlier.member("marker").str() + "\n\n" + earlier.member("lifter").str() + ": First?\n\n" + earlier.member("coach").str() + ": Yes.",
                phone.server.opened[1].texts.first())
        }
    }

    // §4.2: an ability that writes takes the id its turn seeds, whatever the model named, and its result returns to the model as canonical bytes; the call stands on the Coach message with what it created.
    @Test fun anAbilityThatWritesTakesTheIdItsTurnSeeds() = runTest {
        val server = script("""[
            {"event":"text","data":{"delta":"On it."}},
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"create_routine","input":$routineCall}]}},
            {"await":"results","batch":1},
            {"event":"text","data":{"delta":" Done."}},
            {"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val turn = checkNotNull(phone.turns.send("Add a day", null, null, anonymous = true))
            advanceUntilIdle()
            val seeded = "${turn.coach.record.string}-1"
            assertEquals(listOf(seeded to "Day 1"), phone.routines().map { it.id.record.string to it.name })
            val ended = checkNotNull(phone.message(turn.coach))
            assertEquals(MessageState.completed, ended.state)
            assertEquals("On it. Done.", ended.text)
            val call = ended.calls.last()
            assertEquals("toolu_1" to listOf(RecordRef(Gym.Types.routine, RecordID(seeded))), call.callId to call.created)
            val result = server.results.single()
            assertEquals("toolu_1" to Json.of(false), result.member("id").str() to result.member("isError"))
            assertEquals(seeded, Json.parse(result.member("content").str()).member("id").str())
            assertEquals(CoachTurnBounds.contextReads.map { mapOf("name" to it, "outcome" to "ok") } + mapOf("name" to "create_routine", "outcome" to "ok"),
                phone.telling.named("coach_ability"))
            assertEquals("2", phone.telling.named("coach_turn").single()["rounds"])
        }
    }

    // A proposal is placed by its call: the call that made it records it, and the routine a second proposal in the turn would change is refused by the once-rule, which the model reads with its sentence.
    @Test fun aProposalIsPlacedByItsCallAndASecondIsRefusedOnce() = runTest {
        val change = """{"id":"x","routineId":"rt_00000001","name":null,"entries":[{"exerciseId":"back-squat"}],"summary":"Squat"}"""
        val server = script("""[
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"propose_routine_change","input":$change},{"callId":"toolu_2","name":"propose_routine_removal","input":{"id":"x","routineId":"rt_00000001","summary":null}}]}},
            {"await":"results","batch":1},
            {"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            phone.seedRoutines()
            val turn = checkNotNull(phone.turns.send("Swap bench for squat", null, null, anonymous = true))
            advanceUntilIdle()
            val seeded = "${turn.coach.record.string}-1"
            assertEquals(listOf(seeded), phone.proposals().map { it.id.record.string })
            val call = checkNotNull(phone.message(turn.coach)).calls.single { it.callId == "toolu_1" }
            assertEquals(listOf(RecordRef(Gym.Types.proposal, RecordID(seeded))), call.created)
            val refused = server.results.single { it.member("id").str() == "toolu_2" }
            assertEquals(Json.of(true), refused.member("isError"))
            assertEquals(Json.objectOf("code" to Json.of("one-proposal"), "message" to Json.of("you already wrote a routine or workout proposal this turn; fold both into one document.")),
                Json.parse(refused.member("content").str()))
            assertEquals(listOf(mapOf("name" to "propose_routine_change", "outcome" to "ok"), mapOf("name" to "propose_routine_removal", "outcome" to "one-proposal")),
                phone.telling.named("coach_ability").drop(CoachTurnBounds.contextReads.size))
        }
    }

    // §4.3: a share is made through the door the Share sheet calls, and its call stands on the message like any other.
    @Test fun aShareRunsThroughTheShareDoor() = runTest {
        val asked = mutableListOf<String>()
        val door = object : GymRest {
            override suspend fun share(sessionId: String): SessionShare { asked += "share $sessionId"; return SessionShare("tok", "https://windmill.works/s/tok", 1_900_000_000_000) }
            override suspend fun revokeShare(sessionId: String) { asked += "revoke $sessionId"; throw WindmillApiException.Refused(404, Refusal(code = "not_found")) }
            override suspend fun grants() = emptyList<OAuthGrant>()
            override suspend fun mcpKeys() = emptyList<McpKey>()
        }
        val server = script("""[
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"share_session","input":{"sessionId":"sesAAAAAAAAAAAA1"}},{"callId":"toolu_2","name":"revoke_share","input":{"sessionId":"sesAAAAAAAAAAAA2"}}]}},
            {"await":"results","batch":1},
            {"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server, shares = { door }).use { phone ->
            phone.signIn()
            val turn = checkNotNull(phone.turns.send("Share my last workout", null, null, anonymous = false))
            advanceUntilIdle()
            assertEquals(listOf("share sesAAAAAAAAAAAA1", "revoke sesAAAAAAAAAAAA2"), asked)
            val (shared, revoked) = server.results
            assertEquals(Json.parse("""{"expiresAt":1900000000000,"token":"tok","url":"https://windmill.works/s/tok"}"""), Json.parse(shared.member("content").str()))
            assertEquals(Json.of(true), revoked.member("isError"))
            assertEquals("refused", Json.parse(revoked.member("content").str()).member("code").str())
            assertEquals(listOf(AbilityCall.Outcome.Ok, AbilityCall.Outcome.Refused(works.windmill.gym.domain.coach.AbilityRefusal.refused)),
                checkNotNull(phone.message(turn.coach)).calls.filter { it.name in setOf("share_session", "revoke_share") }.map { it.outcome })
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // R-12: a picture's model copy is uploaded once, under its digest, and every round names it.
    @Test fun aPictureIsUploadedOnceAndNamedInEveryRound() = runTest {
        val server = script("""[
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"list_notes","input":{}}]}},
            {"await":"results","batch":1},
            {"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            val bitmap = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
            val bytes = java.io.ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
            val picture = ChosenPicture(CoachAttachment("thr_0123456789abcdef", "image/jpeg", 40, 30, bytes.size.toLong()), bytes)
            checkNotNull(phone.turns.send("", picture, null, anonymous = true))
            advanceUntilIdle()
            val named = Sha256.hex("thr_0123456789abcdef".encodeToByteArray())
            assertEquals(listOf(named), phone.server.uploads)
            assertEquals(2, server.rounds.size)
            for (round in server.rounds) assertTrue(Json.objectOf("image" to Json.objectOf("picture" to Json.of(named))) in round.member("messages").arr()[0].member("parts").arr())
            assertEquals(TurnPhone.words().firstContent.member("pictureOnlyQuestion").str(), server.opened.single().question)
        }
    }

    // Coach engine D-6, gym §4.4: the mark is the turn and the round in flight, with the bytes of text before it; each round writes it after the text so far, and the end clears both rows.
    @Test fun theMarkHoldsEachRound() = runTest {
        val marks = mutableListOf<Pair<Json?, Json?>>()
        val server = script("""[
            {"event":"text","data":{"delta":"Reading é."}},
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"list_notes","input":{}}]}},
            {"await":"results","batch":1},
            {"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            server.beforeRound = { marks += phone.device(EndTurn.runningTurnKey) to phone.device(Mark.roundKey) }
            val turn = checkNotNull(phone.turns.send("Notes?", null, null, anonymous = true))
            advanceUntilIdle()
            val turnId = Json.of(turn.coach.record.string!!)
            assertEquals(listOf(turnId, turnId), marks.map { it.first })
            assertEquals(listOf(0L, "Reading é.".encodeToByteArray().size.toLong()), marks.map { it.second!!.member("bytesBefore").long() })
            assertTrue(marks.all { it.second!!.member("message") == turnId })
            assertEquals(2, marks.map { it.second!!.member("callId") }.distinct().size)
            assertEquals("Reading é.", phone.message(turn.coach)?.text)
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertNull(phone.device(Mark.roundKey))
        }
    }

    // The room draws the answer from the engine's text at every delta; the record takes it every five seconds and at the end.
    @Test fun theAnswerReachesTheRoomAtEveryDeltaAndTheRecordEveryFiveSeconds() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Four words arrived here"}},{"await":"stop"},{"event":"text","data":{"delta":" and more."}},{"event":"done","data":{"state":"completed"}}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceTimeBy(1_000)
            assertEquals(LiveAnswer(turn.coach, "Four words arrived here"), phone.turns.liveAnswer.value)
            assertEquals("", phone.message(turn.coach)?.text)
            phone.server.release()
            advanceUntilIdle()
            assertEquals("Four words arrived here and more.", phone.message(turn.coach)?.text)
            assertNull(phone.turns.liveAnswer.value)
        }
    }

    // Coach engine §5, Stop: the round in flight is read to its end, its calls are discarded, and the turn ends stopped with what arrived.
    @Test fun aStopEndsTheTurnAfterTheRoundInFlight() = runTest {
        val held = mutableListOf<kotlinx.coroutines.Job>()
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"stopped"}}]"""), lease = { held += it }).use { phone ->
            val turn = checkNotNull(phone.turns.send("First", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(turn.coach.record.string, phone.turns.activity.value?.turnId)
            assertTrue(held.single().isActive)
            assertNull(phone.turns.send("Second", null, null, anonymous = true))
            assertEquals(CoachTurnFault.busy, phone.turns.fault.value)
            phone.turns.requestStop()
            advanceUntilIdle()
            assertEquals(MessageState.stopped, phone.message(turn.coach)?.state)
            assertEquals("Reading", phone.message(turn.coach)?.text)
            assertTrue(held.single().isCompleted)
            assertNull(phone.turns.activity.value)
            assertEquals("stopped", phone.telling.named("coach_turn").single()["state"])
            assertEquals("cancelled", phone.telling.named("gym_ask_outcome").last()["outcome"])
        }
    }

    // Coach engine §7, an allowance used up: round 1 refused proves nothing was admitted, so the turn never began. The question returns to the field, and the words say what holds it and when it comes back.
    @Test fun anAllowanceUsedUpWithdrawsTheTurnAndSaysWhatHoldsIt() = runTest {
        for ((amounts, said) in listOf(
            ("0" to "0") to CoachTurnRefusal.Shortfall(AllowanceShortfall.spent, 1_900_000_000_000),
            ("0" to "0.1") to CoachTurnRefusal.Shortfall(AllowanceShortfall.held, 1_900_000_000_000),
            ("0.01" to "0") to CoachTurnRefusal.Shortfall(AllowanceShortfall.tooLarge, 1_900_000_000_000),
        )) {
            val server = script("[]").apply { refuseOpen = ScriptedTurns.Refusal(429, "subject_exhausted", scriptedAllowance("subject_exhausted", amounts.first, amounts.second, resetsAt = 1_900_000_000_000)) }
            TurnPhone(this, folder.newFolder(), server).use { phone ->
                checkNotNull(phone.turns.send("Private question", null, null, anonymous = true))
                advanceUntilIdle()
                assertEquals(said, phone.turns.refusal.value)
                assertEquals(WithdrawnTurn("Private question", null, null), phone.turns.withdrawn.value)
                assertEquals(emptyList<CoachMessage>(), phone.messages())
                assertNull(phone.device(EndTurn.runningTurnKey))
                assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "capped", "cap" to "allowance", "duration_ms" to "0")), phone.telling.named("gym_ask_outcome"))
                assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            }
        }
    }

    // Every other access state by the code that stands for it.
    @Test fun theAccessStatesReadAsTheBoardsSayThem() {
        fun of(code: String?, source: String = "text", anonymous: Boolean = true, allowance: Json? = null) =
            CoachTurnRefusal.of(works.windmill.agent.coach.AiFailure(source, code, works.windmill.agent.coach.Admission.none, allowance), anonymous)
        assertEquals(CoachTurnRefusal.Allowance("free_day_exhausted", 1_800_086_400_000), of("free_day_exhausted", allowance = scriptedAllowance("free_day_exhausted", "1", "0", budgetResetsAt = 1_800_086_400_000)))
        assertEquals(CoachTurnRefusal.FreeMonthExhausted(null), of("free_month_exhausted"))
        assertEquals(CoachTurnRefusal.Allowance("concurrency_exhausted"), of("concurrency_exhausted"))
        assertEquals(listOf(CoachTurnRefusal.RateLimited), listOf("rate_limited", "busy", "paused").map { of(it) }.distinct())
        assertEquals(CoachTurnRefusal.SessionLapsed, of("unauthenticated", "pass", anonymous = false))
        assertEquals(CoachTurnRefusal.Installation("device_bound"), of("device_bound", "pass"))
        assertEquals(CoachTurnRefusal.UpdateRequired, of("client-update-required", "pass"))
        assertEquals(CoachTurnRefusal.AnonymousUnavailable, of("anonymous_ai_unavailable", "pass"))
        assertEquals(CoachTurnRefusal.Absent, of("anonymous_ai_unavailable", "pass", anonymous = false))
        assertEquals(CoachTurnRefusal.Offline, of(null, "transport"))
        assertEquals(listOf(CoachTurnRefusal.Unanswered), listOf("provider_failed", "answer-timeout", "model-call-limit", "invalid-answer", "result_gone").map { of(it) }.distinct())
    }

    // A round the provider failed ends the turn failed with what arrived, and the room says Coach did not answer.
    @Test fun aRoundTheProviderFailedEndsTheTurnFailed() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Hal"}},{"event":"error","data":{"code":"provider_failed"}}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(MessageState.failed, phone.message(turn.coach)?.state)
            assertEquals("Hal", phone.message(turn.coach)?.text)
            assertNull(phone.turns.refusal.value)
            assertNull(phone.turns.withdrawn.value)
            assertEquals("provider_failed", phone.telling.named("coach_turn").single()["code"])
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "failed", "duration_ms" to "0")), phone.telling.named("gym_ask_outcome"))
        }
    }

    // A device bound to an account while signed out: the AI service refuses the round, the phone keeps that it is bound, and asks nobody the next time.
    @Test fun aBoundInstallationIsKeptAndAskedNoMore() = runTest {
        val server = script("[]").apply { refuseOpen = ScriptedTurns.Refusal(409, "device_bound", atPassDoor = true) }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            checkNotNull(phone.turns.send("Private question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Installation("device_bound"), phone.turns.refusal.value)
            assertEquals(WithdrawnTurn("Private question", null, null), phone.turns.withdrawn.value)
            val reads = phone.installationServer.reads
            val passes = server.passes
            assertNull(phone.turns.send("Again", null, null, anonymous = true))
            assertEquals(CoachTurnRefusal.Installation("device_bound"), phone.turns.refusal.value)
            assertEquals(reads to passes, phone.installationServer.reads to server.passes)
            assertEquals(CoachRecovery.signIn, phone.turns.refusal.value?.recovery(anonymous = true))
        }
    }

    // Coach engine §5, the seat changes: a sign-in that rebinds the signed-out replica keeps its id, and the turn ends interrupted with what it wrote; nothing the account holds reaches a later round.
    @Test fun aSignInThatRebindsTheReplicaEndsTheAnonTurn() = runTest {
        val log = works.windmill.gym.store.EngineRoomFixture.server()
        TurnPhone(this, folder.newFolder(), script("[]")).use { other ->
            other.room.select("account-1")
            other.room.sync(log)
            other.seedRoutines()
            other.room.sync(log)
        }
        val server = script("""[
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"create_routine","input":$routineCall}]}},
            {"await":"results","batch":1},
            {"event":"calls","data":{"batch":2,"calls":[{"callId":"toolu_2","name":"list_routines","input":{"routineId":null}}]}},
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
            assertEquals(CoachTurnBounds.contextReads.map { contextCallPrefix + it } + "toolu_1", ended.calls.map { it.callId })
            assertFalse(server.rounds.any { "Push A" in it.jcs })
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertNull(phone.turns.turn.value)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertEquals("interrupted", phone.telling.named("coach_turn").single()["state"])
        }
    }

    // A sign-in waiting on its decision holds the turn's writes, so the decision lands; the rebind then ends the turn.
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
            assertEquals(LiveAnswer(turn.coach, "Hello"), phone.turns.liveAnswer.value)

            assertTrue(phone.engine.signIn("account-1", mapOf("gym" to true), mapOf("gym" to "add"), pins).member("complete").bool())
            phone.server.release()
            advanceUntilIdle()
            assertEquals(MessageState.interrupted, phone.message(turn.coach)?.state)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
            assertNull(phone.turns.turn.value)
        }
    }

    // Coach engine §5, the process ends in the last round: a new process reads the marked round's answer, never sends it again, and places it after the bytes the mark says came before.
    @Test fun anAppKilledInItsLastRoundRecoversTheAnswer() = runTest {
        val first = script("""[
            {"event":"text","data":{"delta":"Reading. "}},
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"list_notes","input":{}}]}},
            {"await":"results","batch":1},
            {"event":"text","data":{"delta":"Partial"}},
            {"await":"stop"}]""")
        val (turn, snapshot, round) = TurnPhone(this, folder.newFolder(), first).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceTimeBy(6_000)
            phone.turns.appStopped()
            advanceTimeBy(1)
            Triple(turn, phone.engine.snapshot(), checkNotNull(phone.device(Mark.roundKey)))
        }
        assertEquals("Reading. ".encodeToByteArray().size.toLong(), round.member("bytesBefore").long())

        val again = script("""[{"event":"text","data":{"delta":"All read."}},{"event":"done","data":{"state":"completed"}}]""").apply { holdsAnswers = true }
        TurnPhone(this, folder.newFolder(), again, snapshot = snapshot).use { reopened ->
            reopened.turns.start()
            advanceUntilIdle()
            val recovered = checkNotNull(reopened.message(turn.coach))
            assertEquals(MessageState.completed, recovered.state)
            assertEquals("Reading. All read.", recovered.text)
            assertEquals(listOf("/v1/calls/${round.member("callId").str()}/result"), again.reads)
            assertEquals(0, again.rounds.size)
            assertNull(reopened.device(EndTurn.runningTurnKey))
            assertNull(reopened.device(Mark.roundKey))
        }
    }

    // A process killed in a round whose answer the service no longer holds cannot carry on: the next process ends the turn interrupted with what arrived.
    @Test fun anAppKilledWithNoAnswerToReadEndsInterrupted() = runTest {
        val (turn, snapshot) = TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Four words arrived here"}},{"await":"stop"}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceTimeBy(1_000)
            phone.turns.appStopped()
            advanceTimeBy(1)
            turn to phone.engine.snapshot()
        }
        TurnPhone(this, folder.newFolder(), script("[]"), snapshot = snapshot).use { reopened ->
            reopened.turns.start()
            advanceUntilIdle()
            val message = reopened.message(turn.coach)
            assertEquals(MessageState.interrupted, message?.state)
            assertEquals("Four words arrived here", message?.text)
            assertEquals("Question", reopened.message(turn.lifter)?.text)
            assertNull(reopened.device(EndTurn.runningTurnKey))
        }
    }

    // Coach engine §5, the seat changes: a sign-out confirmed while the turn's call waits on the account ends the turn interrupted with what arrived, both rows of the mark cleared, through the training the change still lets write.
    @Test fun aSignOutConfirmedWhileACallWaitsEndsTheTurnInterrupted() = runTest {
        var writable = true
        val server = script("""[
            {"event":"text","data":{"delta":"Hello"}},
            {"await":"stop"},
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"list_notes","input":{}}]}},
            {"await":"results","batch":1},
            {"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server, writable = { writable }).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceTimeBy(1_000)
            writable = false
            phone.server.release()
            advanceTimeBy(3_000)
            val drain = works.windmill.gym.store.EngineTraining(phone.room.training.engine, writeAuthority = { true })
            val confirming = launch { phone.turns.seatWillChange(drain) }
            advanceUntilIdle()
            confirming.join()
            val message = checkNotNull(phone.message(turn.coach))
            assertEquals(MessageState.interrupted to "Hello", message.state to message.text)
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertNull(phone.device(Mark.roundKey))
            assertEquals(listOf("interrupted"), phone.telling.named("coach_turn").map { it["state"] })
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // The same confirmation while the round streams, nothing waiting on the account.
    @Test fun aSignOutConfirmedWhileTheRoundStreamsEndsTheTurnInterrupted() = runTest {
        var writable = true
        val server = script("""[{"event":"text","data":{"delta":"Hello"}},{"await":"stop"},{"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server, writable = { writable }).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceTimeBy(1_000)
            writable = false
            val drain = works.windmill.gym.store.EngineTraining(phone.room.training.engine, writeAuthority = { true })
            val confirming = launch { phone.turns.seatWillChange(drain) }
            advanceTimeBy(3_000)
            phone.server.release()
            advanceUntilIdle()
            confirming.join()
            val message = checkNotNull(phone.message(turn.coach))
            assertEquals(MessageState.interrupted to "Hello", message.state to message.text)
            assertNull(phone.device(EndTurn.runningTurnKey))
        }
    }

    // A trailing commit that comes round after the writer ended its turn lands nowhere: the end stands, its words whole.
    @Test fun aTrailingCommitAfterTheEndLandsNowhere() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Hel"}},{"await":"stop"},{"event":"done","data":{"state":"completed"}}]""")).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceTimeBy(1_000)
            val drain = works.windmill.gym.store.EngineTraining(phone.room.training.engine, writeAuthority = { true })
            launch { phone.turns.seatWillChange(drain) }
            advanceTimeBy(1)
            assertEquals(MessageState.interrupted to "Hel", phone.message(turn.coach)?.let { it.state to it.text })
            val late = phone.room.training.pinnedOn(phone.room.training.pin()) { it.run(works.windmill.gym.domain.coach.StreamTurnText(turn.coach, "He")) }
            assertEquals(works.windmill.domain.kit.Outcome.Unchanged(Unit), late)
            advanceTimeBy(10_000)
            phone.server.release()
            advanceUntilIdle()
            assertEquals(MessageState.interrupted to "Hel", phone.message(turn.coach)?.let { it.state to it.text })
        }
    }

    // A conversation deleted on another device under the running turn ends it, writing nothing and reporting nothing.
    @Test fun aConversationDeletedElsewhereEndsTheTurnWithNoReport() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Reading"}},{"await":"stop"},{"event":"done","data":{"state":"completed"}}]"""), textEvery = 1.milliseconds).use { phone ->
            val turn = checkNotNull(phone.turns.send("Question", null, null, anonymous = true))
            advanceTimeBy(1_000)
            phone.engine.commit(ScopeRef(Gym.scope), works.windmill.sync.api.Gesture(phone.messages().map { works.windmill.sync.api.Change.delete(CoachMessage.type, it.id.record) } +
                works.windmill.sync.api.Change.delete(CoachThread.type, turn.thread.record)))
            phone.server.release()
            advanceUntilIdle()
            assertNull(phone.message(turn.coach))
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertNull(phone.turns.turn.value)
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)
        }
    }

    // A host fault before the engine holds the turn: the question returns to the field with its picture, nothing stays running, Coach says it did not answer, and the fault is reported once, as itself.
    @Test fun aPictureUnreadableAtTheOpenReturnsTheQuestionAndReportsOnce() = runTest {
        TurnPhone(this, folder.newFolder(), script("""[{"event":"text","data":{"delta":"Hi"}}]""")).use { phone ->
            val bitmap = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
            val bytes = java.io.ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
            val picture = ChosenPicture(CoachAttachment("thr_0123456789abcdef", "image/jpeg", 40, 30, bytes.size.toLong()), bytes)
            checkNotNull(phone.turns.send("Private question about my knee", picture, null, anonymous = true))
            phone.pictureFolder.listFiles()!!.filter { it.name.endsWith("model") }.forEach { it.delete(); it.mkdirs() }
            advanceUntilIdle()
            assertEquals(emptyList<CoachMessage>(), phone.messages())
            assertNull(phone.device(EndTurn.runningTurnKey))
            assertNull(phone.turns.turn.value)
            assertEquals(WithdrawnTurn("Private question about my knee", picture, null), phone.turns.withdrawn.value)
            assertEquals(CoachTurnFault.noAnswer, phone.turns.fault.value)
            assertEquals(listOf("agent-host"), phone.telling.failures.map { it["operation"] })
            assertTrue(phone.telling.errors.single() is java.io.IOException)
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to "failed", "duration_ms" to "0")), phone.telling.named("gym_ask_outcome"))
            assertTrue(phone.telling.events.none { (_, properties) -> properties.values.any { "knee" in it } })
        }
    }

    // A picture whose model copy cannot be read at the send is no send: the room says so before any record.
    @Test fun aPictureUnreadableAtTheSendIsHeldBack() = runTest {
        TurnPhone(this, folder.newFolder(), script("[]")).use { phone ->
            val picture = ChosenPicture(CoachAttachment("thr_0123456789abcdef", "image/jpeg", 40, 30, 3), byteArrayOf(1, 2, 3))
            phone.pictureFolder.mkdirs()
            File(phone.pictureFolder, "thr_0123456789abcdef.model").mkdirs()
            assertNull(phone.turns.send("Look", picture, null, anonymous = true))
            assertEquals(CoachTurnFault.pictureUnavailable, phone.turns.fault.value)
            assertEquals(emptyList<CoachMessage>(), phone.messages())
        }
    }

    // A host fault mid-turn ends the turn failed on its own code, reported once with the throwable that failed, whose class sets it apart from every other cause.
    @Test fun aHostFaultMidTurnEndsOnItsOwnCodeAndReportsItsCause() = runTest {
        val server = script("""[
            {"event":"text","data":{"delta":"Sharing"}},
            {"event":"calls","data":{"batch":1,"calls":[{"callId":"toolu_1","name":"share_session","input":{"sessionId":"sesAAAAAAAAAAAA1"}}]}},
            {"await":"results","batch":1},
            {"event":"done","data":{"state":"completed"}}]""")
        TurnPhone(this, folder.newFolder(), server, shares = { throw IllegalStateException("Heavy Squat Day") }).use { phone ->
            phone.signIn()
            val turn = checkNotNull(phone.turns.send("Share my workout", null, null, anonymous = false))
            advanceUntilIdle()
            assertEquals(MessageState.failed to "Sharing", phone.message(turn.coach)?.let { it.state to it.text })
            assertEquals("host", phone.telling.named("coach_turn").single()["code"])
            assertEquals(listOf("agent-host"), phone.telling.failures.map { it["operation"] })
            assertTrue(phone.telling.errors.single() is IllegalStateException)
        }
    }

    // A pass door answering a 5xx that names no refusal did not answer: never "no connection", and reported once by its status class.
    @Test fun aPassDoorFailingIsNoLostConnection() = runTest {
        val server = script("[]").apply { passAnswer = works.windmill.platform.ai.AiResponse(500) }
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            checkNotNull(phone.turns.send("Private question", null, null, anonymous = true))
            advanceUntilIdle()
            assertEquals(CoachTurnRefusal.Unanswered, phone.turns.refusal.value)
            assertEquals("Private question", phone.turns.withdrawn.value?.question)
            assertEquals(listOf(mapOf("failure_kind" to "proxy-5xx", "operation" to "ai-pass")), phone.telling.failures)
        }
    }

    @Test fun theTurnsEventSchemasKeepOnlyLabelsAndCounts() {
        val schemas = GymEvents.schemas
        assertEquals(mapOf("state" to "completed", "seat" to "bound", "code" to "other", "rounds" to "2", "ability_calls" to "1", "refusals" to "0", "answer_bytes" to "9", "duration_ms" to "0"),
            schemas.properties("coach_turn", mapOf("state" to "completed", "seat" to "bound", "code" to "other", "rounds" to "2", "ability_calls" to "1", "refusals" to "0",
                "answer_bytes" to "9", "duration_ms" to "0", "question" to "How heavy today?")))
    }
}
