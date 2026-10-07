package works.windmill.gym.store

import works.windmill.gym.coach.AskOutcome
import java.io.File
import java.net.SocketTimeoutException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.coach.AskCap
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.Session
import works.windmill.gym.net.FakeGymRest
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry

class TelemetryTests {
    @get:Rule val tmp = TemporaryFolder()

    private class Recorder : Telemetry {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, Throwable>>()
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            failures += operation to error
        }
    }

    @Test fun everyCoachOutcomeEmitsOneResultWithoutConversationOrTrainingContent() = runTest {
        val telemetry = Recorder()
        val server = FakeGymRest()
        var tick = 0L
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server, telemetry = telemetry,
            elapsedNanos = { tick++ * 1_000_000 }).use { room ->
            val store = room.store
            room.select("account")
            telemetry.events.clear()
            assertTrue(store.coach.ask("private-thread-id", "private question") is AskOutcome.Answered)
            assertEquals(listOf("gym_ask_started" to emptyMap<String, String>(),
                "gym_ask_outcome" to mapOf("outcome" to "answered", "duration_ms" to "1")), telemetry.events)

            val cases = listOf(
                Triple(WindmillApiException.Refused(401, Refusal(message = "sign in first")),
                    AskOutcome.Refused("sign in first"),
                    mapOf("outcome" to "refused", "failure_kind" to "http", "status" to "401")),
                Triple(WindmillApiException.Refused(429, Refusal(code = "ask-out-of-budget")),
                    AskOutcome.Capped("This account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on.", AskCap.Ceiling),
                    mapOf("outcome" to "capped", "cap" to "ceiling", "failure_kind" to "http", "status" to "429")),
                Triple(WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit")),
                    AskOutcome.Capped("The next question frees up in a couple of hours.", AskCap.Daily),
                    mapOf("outcome" to "capped", "cap" to "daily", "failure_kind" to "http", "status" to "429")),
                Triple(WindmillApiException.Refused(404, Refusal()), AskOutcome.Absent,
                    mapOf("outcome" to "absent", "failure_kind" to "http", "status" to "404")),
                Triple(WindmillApiException.Refused(409, Refusal(code = "ask-thread-full")),
                    AskOutcome.Fresh("This conversation is unavailable. Start a new one."),
                    mapOf("outcome" to "fresh", "failure_kind" to "http", "status" to "409")),
                Triple(WindmillApiException.Refused(503, Refusal()),
                    AskOutcome.Failed("Coach didn’t answer. Try again in a moment"),
                    mapOf("outcome" to "failed", "failure_kind" to "http", "status" to "503")),
                Triple(WindmillApiException.Timeout(SocketTimeoutException("private URL")),
                    AskOutcome.Failed("Coach didn’t answer. Try again in a moment"),
                    mapOf("outcome" to "failed", "failure_kind" to "timeout")),
                Triple(WindmillApiException.Offline,
                    AskOutcome.Failed("Coach didn’t answer. Try again in a moment"),
                    mapOf("outcome" to "failed", "failure_kind" to "offline")),
                Triple(WindmillApiException.Malformed,
                    AskOutcome.Failed("Coach didn’t answer. Try again in a moment"),
                    mapOf("outcome" to "failed", "failure_kind" to "malformed")),
            )
            for ((error, expected, properties) in cases) {
                telemetry.events.clear()
                server.refuseAsk = error
                assertEquals(expected, store.coach.ask("private-thread-id", "private question"))
                assertEquals(listOf("gym_ask_started" to emptyMap<String, String>(),
                    "gym_ask_outcome" to (properties + ("duration_ms" to "1"))), telemetry.events)
            }
            assertEquals("HTTP owns reporting these failures once", emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun unexpectedHandledCoachFailureIsReportedButCancellationRemainsCancellation() = runTest {
        val telemetry = Recorder()
        val server = FakeGymRest()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, rest = server, telemetry = telemetry,
            elapsedNanos = { 1_000_000 }).use { room ->
            val store = room.store
            room.select("account")
            val broken = IllegalStateException("do not publish conversation content")
            server.refuseAsk = broken
            assertEquals(AskOutcome.Failed("Coach didn’t answer. Try again in a moment"), store.coach.ask("thread", "question"))
            assertEquals(listOf("gym.ask" to broken), telemetry.failures)
            assertEquals(listOf("gym_ask_started" to emptyMap<String, String>(),
                "gym_ask_outcome" to mapOf("outcome" to "failed", "failure_kind" to "unexpected", "duration_ms" to "0")), telemetry.events)
            telemetry.events.clear()
            val cancelled = CancellationException("left the request")
            server.refuseAsk = cancelled
            try {
                store.coach.ask("thread", "question")
                fail("cancellation must propagate")
            } catch (error: CancellationException) {
                assertSame(cancelled, error)
            }
            assertEquals(listOf("gym.ask" to broken), telemetry.failures)
            assertEquals(listOf("gym_ask_started" to emptyMap<String, String>(),
                "gym_ask_outcome" to mapOf("outcome" to "cancelled", "duration_ms" to "0")), telemetry.events)
        }
    }

    @Test fun acceptedWorkoutActionsEmitOnceAndRejectedDuplicateSetsDoNotCount() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            val store = room.store
            room.select(null)
            assertTrue(store.start() is GymResult.Ok)
            store.choose("bench-press")
            val offered = requireNotNull(store.notification.value?.offer)
            val command = LogSetCommand(offered.key, offered.id)
            assertTrue(store.acceptSet(command) is LogSetAcceptance.Accepted)
            assertEquals(LogSetAcceptance.Stale, store.acceptSet(command))
            assertTrue(store.finish() is FinishOutcome.Closed)
            assertEquals(listOf(
                "gym_session_started" to emptyMap<String, String>(),
                "gym_set_logged" to emptyMap<String, String>(),
                "gym_session_finished" to emptyMap<String, String>(),
            ), telemetry.events)
            assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
        }
    }

    @Test fun aFailedCorrectionKeepsUndoAndOnlyCommittedWeightsEmitAnEvent() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select("account")
            val day = "2026-01-01"
            assertNull(room.store.weighIn(day, 182.0))
            telemetry.events.clear()
            val original = room.store.bodyweight
            room.store.withhold(Deletion.Bodyweight(day))
            val held = room.store.withheld
            room.engine.failNextCommit()
            assertNotNull(room.store.weighIn(day, 82.45))
            assertEquals(held, room.store.withheld)
            assertTrue(room.store.bodyweight.isEmpty())
            assertEquals(original, room.training.weighins())
            assertTrue(telemetry.events.isEmpty())
            assertEquals(listOf("gym.weighIn"), telemetry.failures.map { it.first })
            assertNotNull(room.store.keepWithheld())
            assertEquals(original, room.store.bodyweight)

            room.store.withhold(Deletion.Bodyweight(day))
            assertNull(room.store.weighIn(day, 82.45))
            assertTrue(room.store.withheld.isEmpty())
            assertEquals(82.45, room.store.bodyweight.single().weightKg, 0.0)
            assertNotNull(room.store.weighIn(day, Double.NaN))
            assertEquals(listOf("gym_bodyweight_saved" to emptyMap<String, String>()), telemetry.events)
        }
    }

    @Test fun onlyACommittedNoteMoveEmitsAnEventWithoutNoteContent() = runTest {
        val telemetry = Recorder()
        EngineRoomFixture(tmp.newFolder(), backgroundScope, telemetry = telemetry).use { room ->
            room.select("account")
            for (index in 0..2) assertTrue(room.store.saveNote("private_note_$index", NoteWrite("Private title $index", "Private body")) is GymResult.Ok)
            room.store.withhold(Deletion.Note("private_note_1"))
            val visible = listOf("private_note_0", "private_note_2")
            val moved = visible.reversed()
            assertTrue(room.store.reorderNotes("private_note_2", visible) is GymResult.Ok)
            assertTrue(room.store.reorderNotes("private_note_0", visible.dropLast(1)) is GymResult.Failed)
            val before = room.engine.snapshot()
            room.engine.failNextCommit()
            assertTrue(room.store.reorderNotes("private_note_0", moved) is GymResult.Failed)
            assertEquals(before, room.engine.snapshot())
            assertTrue(telemetry.events.isEmpty())
            assertEquals(listOf("gym.reorderNotes"), telemetry.failures.map { it.first })

            assertTrue(room.store.reorderNotes("private_note_0", moved) is GymResult.Ok)
            assertTrue(room.store.reorderNotes("private_note_0", moved) is GymResult.Ok)
            assertEquals(listOf("private_note_1"), room.store.withheld.map { it.subjectId })
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
