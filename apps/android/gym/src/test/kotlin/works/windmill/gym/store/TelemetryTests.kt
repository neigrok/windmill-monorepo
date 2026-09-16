package works.windmill.gym.store

import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.AskCap
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.Session
import works.windmill.gym.net.FakeTraining
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
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
        val server = FakeTraining()
        var tick = 0L
        val store = TrainingStore(
            SetQueue(File(tmp.root, "sets")), DeviceCopy(File(tmp.root, "catalog")),
            LocalLog(File(tmp.root, "log")), LocalPreferences(File(tmp.root, "preferences")),
            LocalBodyweight(File(tmp.root, "body")), backgroundScope,
            sync = { server }, telemetry = telemetry, elapsedNanos = { tick++ * 1_000_000 },
        )
        store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
            User("account", "private@example.com", "Private")))
        telemetry.events.clear()
        assertTrue(store.ask("private-thread-id", "private question") is AskOutcome.Answered)
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
                AskOutcome.Fresh("This conversation holds four questions. Start a new one."),
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
            assertEquals(expected, store.ask("private-thread-id", "private question"))
            assertEquals(listOf("gym_ask_started" to emptyMap<String, String>(),
                "gym_ask_outcome" to (properties + ("duration_ms" to "1"))), telemetry.events)
        }
        assertEquals("HTTP owns reporting these failures once", emptyList<Pair<String, Throwable>>(), telemetry.failures)
    }

    @Test fun unexpectedHandledCoachFailureIsReportedButCancellationRemainsCancellation() = runTest {
        val telemetry = Recorder()
        val server = FakeTraining()
        val store = TrainingStore(
            SetQueue(File(tmp.root, "sets")), DeviceCopy(File(tmp.root, "catalog")),
            LocalLog(File(tmp.root, "log")), LocalPreferences(File(tmp.root, "preferences")),
            LocalBodyweight(File(tmp.root, "body")), backgroundScope,
            sync = { server }, telemetry = telemetry, elapsedNanos = { 1_000_000 },
        )
        store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
            User("account", "private@example.com", "Private")))
        val broken = IllegalStateException("do not publish conversation content")
        server.refuseAsk = broken
        assertEquals(AskOutcome.Failed("Coach didn’t answer. Try again in a moment"), store.ask("thread", "question"))
        assertEquals(listOf("gym.ask" to broken), telemetry.failures)
        assertEquals(listOf("gym_ask_started" to emptyMap<String, String>(),
            "gym_ask_outcome" to mapOf("outcome" to "failed", "failure_kind" to "unexpected", "duration_ms" to "0")), telemetry.events)
        telemetry.events.clear()
        val cancelled = CancellationException("left the request")
        server.refuseAsk = cancelled
        try {
            store.ask("thread", "question")
            fail("cancellation must propagate")
        } catch (error: CancellationException) {
            assertSame(cancelled, error)
        }
        assertEquals(listOf("gym.ask" to broken), telemetry.failures)
        assertEquals(listOf("gym_ask_started" to emptyMap<String, String>(),
            "gym_ask_outcome" to mapOf("outcome" to "cancelled", "duration_ms" to "0")), telemetry.events)
    }

    @Test fun acceptedWorkoutActionsEmitOnceAndRejectedDuplicateSetsDoNotCount() = runTest {
        val telemetry = Recorder()
        val store = TrainingStore(
            SetQueue(File(tmp.root, "sets")), DeviceCopy(File(tmp.root, "catalog")),
            LocalLog(File(tmp.root, "log")), LocalPreferences(File(tmp.root, "preferences")),
            LocalBodyweight(File(tmp.root, "body")), backgroundScope,
            now = { 100_000 }, sync = { null }, telemetry = telemetry,
        )
        store.connect(Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }), null))
        assertTrue(store.start() is GymResult.Ok)
        store.choose("bench-press")
        val offered = requireNotNull(store.notification.value?.offer)
        val command = LogSetCommand(offered.key, offered.id)
        assertTrue(store.acceptSet(command, scheduleDelivery = false) is LogSetAcceptance.Accepted)
        assertEquals(LogSetAcceptance.Stale, store.acceptSet(command, scheduleDelivery = false))
        assertTrue(store.finish() is FinishOutcome.Closed)
        assertEquals(listOf(
            "gym_session_started" to mapOf("storage" to "device"),
            "gym_set_logged" to emptyMap<String, String>(),
            "gym_session_finished" to mapOf("storage" to "device"),
        ), telemetry.events)
        assertEquals(emptyList<Pair<String, Throwable>>(), telemetry.failures)
    }

    @Test fun absentStorageIsNormalButUnreadableAndUnwritableDocumentsAreReported() {
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
        val blocker = File(tmp.root, "blocked").apply { writeText("file, not a directory") }
        StoredDocument(File(blocker, "nested"), telemetry).write(Session("private-id", 1), Session.serializer())
        assertEquals(listOf("gym.storage.read", "gym.storage.decode", "gym.storage.write"), telemetry.failures.map { it.first })
        assertTrue(telemetry.failures.last().second is IOException)
        assertEquals(emptyList<Pair<String, Map<String, String>>>(), telemetry.events)
    }
}
