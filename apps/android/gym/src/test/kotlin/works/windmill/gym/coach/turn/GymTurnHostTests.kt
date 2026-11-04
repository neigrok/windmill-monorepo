package works.windmill.gym.coach.turn

import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnSeat
import works.windmill.agent.json
import works.windmill.domain.kit.Outcome
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.telemetry.GymEvents
import works.windmill.platform.telemetry.EventSchemas
import works.windmill.sync.core.Json

// Every exchange of `packages/api-contract/gym/turns/` replayed as the phone, through the real host on a real engine: the calls, the receipt, the state, the text, what the server was sent and what the telemetry said.
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(Parameterized::class)
class GymTurnHostTests(private val name: String) {
    @get:Rule val folder = TemporaryFolder()

    companion object {
        private val root = File(System.getProperty("windmill.contract"), "gym/turns")

        @JvmStatic @Parameterized.Parameters(name = "{0}")
        fun exchanges(): List<String> = root.listFiles { file -> file.extension == "json" }!!.map { it.nameWithoutExtension }.sorted()
    }

    @Test fun replaysAsThePhone() = runTest {
        assertEquals(15, exchanges().size)
        val vector = Json.parse(File(root, "$name.json").readBytes())
        val body = vector.member("open")
        val end = vector.member("end")
        val anonymous = vector.member("seat").str() == "anon"
        val events = vector.member("events").arr()
        val server = ScriptedTurns(events)
        TurnPhone(this, folder.newFolder(), server).use { phone ->
            if (!anonymous) phone.signIn()
            advanceUntilIdle()
            phone.seedRoutines()
            phone.turns.start()
            advanceUntilIdle()

            val history = body.member("history").arr()
            val earlier = history.takeIf { it.isNotEmpty() }?.let {
                val replica = phone.engine.activeReplica()
                phone.room.training.pinnedOn(replica, anonymous) { runner ->
                    val first = (runner.run(OpenTurn(question = history[0].member("text").str())) as Outcome.Committed).result
                    assertTrue(runner.run(EndTurn(first.coach, MessageState.completed, history[1].member("text").str())) is Outcome.Committed)
                    first
                }
            }
            phone.room.now += 1_000

            val question = body.member("question").str()
            val turn = checkNotNull(phone.turns.send(question, null, earlier?.thread, anonymous))
            advanceUntilIdle()
            if (vector["stop"] != null) {
                assertEquals("stop", server.pending)
                phone.turns.requestStop()
                advanceUntilIdle()
            }
            assertEquals(null, phone.turns.turn.value)

            val answer = checkNotNull(phone.message(turn.coach))
            val lifter = checkNotNull(phone.message(turn.lifter))
            val state = end.member("state").str()
            val text = events.fold("") { held, frame ->
                when (frame["event"]?.str()) {
                    "text" -> held + frame.member("data").member("delta").str()
                    "snapshot" -> frame.member("data").member("text").str()
                    else -> held
                }
            }
            assertEquals(question, lifter.text)
            assertEquals(state, answer.state.name)
            assertEquals(end["truncated"]?.bool() ?: false, answer.truncated)
            assertEquals(text, answer.text)
            assertEquals(AbilityCall.receipt(answer.calls), answer.receipt)
            assertNull(phone.device(EndTurn.runningTurnKey))

            val opened = server.opened.single()
            val sent = opened.json
            assertEquals("catalog/2", sent.member("catalog").str())
            assertEquals(question, sent.member("question").str())
            assertEquals(turn.coach.record.string, sent.member("turnId").str())
            assertEquals(body.member("history"), sent.member("history"))
            assertEquals(CoachTurnBounds.contextReads, sent.member("context").arr().map { it.member("name").str() })
            assertEquals(CoachTurnBounds.contextReads, opened.contextOutcomes.map { it.name })
            val expectedSeat: TurnSeat = if (anonymous) TurnSeat.Anon(phone.installationServer.credential) else TurnSeat.Bound("account-token")
            assertEquals(setOf(expectedSeat), server.seats.toSet())

            // The calls the server sent follow the four context reads on the Coach message, one record per call however often the server asked.
            val batches = events.mapNotNull { frame ->
                when (frame["event"]?.str()) {
                    "calls" -> (TurnEvent.of("calls", frame.member("data")) as TurnEvent.Calls).batch
                    "snapshot" -> (TurnEvent.of("snapshot", frame.member("data")) as TurnEvent.Snapshot).batch
                    else -> null
                }
            }
            val asked = batches.flatMap { it.calls }
            assertEquals(CoachTurnBounds.contextReads + asked.distinctBy { it.callId }.map { it.name }, answer.calls.map { it.name })
            assertEquals(batches.map { Json.of(it.batch) }, server.posted.map { it.member("batch") })
            assertEquals(batches.map { batch -> batch.calls.map { it.callId } }, server.posted.map { post -> post.member("results").arr().map { it.member("callId").str() } })

            val silent = vector["phone"]?.str() == "silent"
            val code = end["code"]?.str() ?: if (silent) "coach-turn-order" else null
            val refused = if (state == "failed") code?.let { CoachTurnRefusal.of(it, resetsAtMs = events.last()["data"]?.get("budgetResetsAtMs")?.long()) } else null
            assertEquals(refused.takeUnless { it == CoachTurnRefusal.Unanswered }, phone.turns.refusal.value)
            assertNull(phone.turns.fault.value)
            assertNull(phone.turns.withdrawn.value)

            val outcome = when (state) {
                "completed" -> "answered"
                "stopped" -> "cancelled"
                "declined" -> "refused"
                else -> if (refused?.askOutcome?.second == "allowance") "capped" else "failed"
            }
            val cap = if (outcome == "capped") mapOf("cap" to "allowance") else emptyMap()
            val duration = testScheduler.currentTime.toString()
            assertEquals(listOf(mapOf("screen" to "coach")), phone.telling.named("gym_ask_started"))
            assertEquals(listOf(mapOf("screen" to "coach", "outcome" to outcome, "duration_ms" to duration) + cap), phone.telling.named("gym_ask_outcome"))
            val refusals = answer.calls.count { it.outcome is AbilityCall.Outcome.Refused }
            assertEquals(listOf(buildMap {
                put("state", state)
                put("seat", if (anonymous) "anon" else "bound")
                put("ability_calls", (CoachTurnBounds.contextReads.size + asked.size).toString())
                put("refusals", refusals.toString())
                put("answer_bytes", text.encodeToByteArray().size.toString())
                code?.let { put("code", it) }
                put("duration_ms", duration)
            }), phone.telling.named("coach_turn"))
            assertEquals(CoachTurnBounds.contextReads + asked.map { it.name }, phone.telling.named("coach_ability").map { it["name"] })
            assertEquals(emptyList<Map<String, String>>(), phone.telling.failures)

            // The client's allowlists let every property through as it was told, and no word of the question or answer is among them.
            val schemas = EventSchemas.platform + GymEvents.schemas
            for ((event, properties) in phone.telling.events) {
                assertTrue(event, schemas.accepts(event))
                assertEquals(event, properties, schemas.properties(event, properties))
                assertFalse(event, properties.values.any { value -> question in value || text.isNotEmpty() && text in value })
            }
            assertEquals(OpenTurn.Turn(answer.threadId, lifter.id, answer.id), turn)
        }
    }
}
