package works.windmill.gym.coach

import java.io.File
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.net.FakeGymRest
import works.windmill.gym.net.GymRest
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class CoachRefusalTests {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun terminalRefusalsKeepTheCompleteDraftAndDoNotPostAgainAfterRecreation() = runTest {
        val refusals = listOf(
            WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit")),
            WindmillApiException.Refused(429, Refusal(code = "subject_exhausted")),
            WindmillApiException.Refused(404, Refusal()),
            WindmillApiException.Refused(409, Refusal("Finish the workout", code = "ask-session-open")),
            WindmillApiException.Refused(409, Refusal(code = "ask-thread-full")),
        )
        for ((index, refusal) in refusals.withIndex()) {
            val file = File(temporary.root, "terminal-$index")
            val disk = LocalCoach(file)
            val server = FakeGymRest().apply { refuseAsk = refusal }
            val events = mutableListOf<String>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) { events += name }
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { fail("Unexpected $operation") }
            }
            val rest = object : GymRest by server {
                override suspend fun uploadPhoto(threadId: String, photo: CoachAttachment, bytes: ByteArray, onProgress: (Float) -> Unit): CoachAttachment {
                    onProgress(1f)
                    return photo
                }
            }
            fun store(local: LocalCoach) = CoachStore({ "alice" }, { emptySet() }, {}, { rest }, local, telemetry,
                System::nanoTime, backgroundScope, StandardTestDispatcher(testScheduler))
            val store = store(disk)
            val chat = store.freshChat(id = "thread-a")
            val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
            val draft = CoachDraft("Private draft", photo, setup = true)
            disk.savePhoto("alice", photo.id, byteArrayOf(1, 2, 3))
            store.saveDraft(chat, draft)
            assertTrue(store.submit(chat, draft.text, photo, "request-a"))
            runCurrent()
            assertFalse(store.isAsking(chat))
            assertTrue(disk.archivedChat("alice", chat)!!.exchanges.single().terminalRefusal)
            assertEquals(emptyList<AskQuestion>(), disk.pending("alice"))
            repeat(2) { store.resumeChats(); runCurrent() }
            val reopened = LocalCoach(file)
            repeat(2) { store(reopened).resumeChats(); runCurrent() }
            assertEquals(1, server.asked.size)
            assertEquals(draft, reopened.draft("alice", chat))
            assertArrayEquals(byteArrayOf(1, 2, 3), reopened.photoFile("alice", photo.id).readBytes())
            assertEquals(1, events.count { it == "gym_ask_started" })
            assertEquals(1, events.count { it == "gym_ask_outcome" })
        }
    }

    @Test fun legacyTerminalExchangesAreRetiredBeforeResumeWithoutParsingTheirSentence() = runTest {
        for (kind in listOf("cap", "absent", "fresh", "marked")) {
            val file = File(temporary.root, "legacy-$kind")
            val disk = LocalCoach(file)
            val request = AskQuestion("thread-a", "Question", "request-a", purpose = "conversation")
            val exchange = AskExchange(request.question, trouble = "Any localized sentence", requestId = "request-a",
                retryAtMs = 1_800_000_000_000L, needsNew = kind == "fresh", terminalRefusal = kind == "marked")
            val chat = LocalChat(request.thread, exchanges = listOf(exchange), cap = "Daily".takeIf { kind == "cap" }, absent = kind == "absent")
            disk.saveChat("alice", chat)
            disk.saveDraft("alice", chat.id, CoachDraft(request.question))
            disk.keep("alice", request)
            val before = LocalCoach(file).archivedChat("alice", chat.id)
            val server = FakeGymRest()
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { server }, disk, Telemetry.None,
                System::nanoTime, backgroundScope, StandardTestDispatcher(testScheduler))
            repeat(2) { store.resumeChats(); runCurrent() }
            assertEquals(emptyList<AskQuestion>(), server.asked)
            assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("alice"))
            assertEquals(before, LocalCoach(file).archivedChat("alice", chat.id))
            assertEquals(CoachDraft(request.question), LocalCoach(file).draft("alice", chat.id))
        }
    }

    @Test fun aRunningSnapshotAndUncertainTransportKeepTheExactRequestRecoverable() = runTest {
        val cases = listOf(
            WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit")) to true,
            WindmillApiException.Refused(404, Refusal()) to true,
            WindmillApiException.Offline to false,
            WindmillApiException.Refused(503, Refusal()) to false,
        )
        for ((index, case) in cases.withIndex()) {
            val (refusal, running) = case
            val file = File(temporary.root, "uncertain-$index")
            val disk = LocalCoach(file)
            val request = AskQuestion("thread-a", "Question", "request-a")
            val generation = AskGeneration("generation-a", "request-a", request.question, "running", "Partial", revision = 2)
            disk.keep("alice", request)
            val server = FakeGymRest().apply {
                refuseAsk = refusal
                if (running) conversations[request.thread] = AskThread(request.thread, generation = generation)
            }
            val store = CoachStore({ "alice" }, { emptySet() }, {}, { server }, disk, Telemetry.None,
                System::nanoTime, backgroundScope, StandardTestDispatcher(testScheduler))
            store.ask(request.thread, request.question, "request-a")
            assertEquals(listOf(request), disk.pending("alice"))
            assertEquals(generation.takeIf { running }, disk.snapshot("alice", "request-a"))
            store.resumeChats(); runCurrent()
            assertEquals(listOf(request, request), server.asked)
            assertEquals(listOf(request), LocalCoach(file).pending("alice"))
            assertEquals(generation.takeIf { running }, LocalCoach(file).snapshot("alice", "request-a"))
        }
    }

    @Test fun aPublishedRetirementSurvivesThrownWritesAndTemporarilyUnreadableReadback() = runTest {
        for (unreadable in listOf(false, true)) {
            val file = File(temporary.root, "published-$unreadable")
            val held = File(temporary.root, "held-$unreadable")
            var armed = false
            val disk = LocalCoach(file) { target, text ->
                AtomicDocument.write(target, text)
                val body = WindmillJson.parseToJsonElement(text) as JsonObject
                val pending = (body["pending"] as? JsonObject)?.get("alice") as? JsonObject
                if (armed && text.contains("\"terminalRefusal\":true") && pending.isNullOrEmpty()) {
                    armed = false
                    if (unreadable) { check(target.renameTo(held)); check(target.mkdir()) }
                    throw IOException("private-storage-canary")
                }
            }
            val failures = mutableListOf<String>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) {}
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
            }
            val server = FakeGymRest().apply { refuseAsk = WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit")) }
            val rest = object : GymRest by server {
                override suspend fun uploadPhoto(threadId: String, photo: CoachAttachment, bytes: ByteArray, onProgress: (Float) -> Unit): CoachAttachment {
                    onProgress(1f)
                    return photo
                }
            }
            fun store(local: LocalCoach) = CoachStore({ "alice" }, { emptySet() }, {}, { rest }, local, telemetry,
                System::nanoTime, backgroundScope, StandardTestDispatcher(testScheduler))
            val store = store(disk)
            val chat = store.freshChat(id = "thread-a")
            val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 3)
            disk.savePhoto("alice", photo.id, byteArrayOf(3, 2, 1))
            store.saveDraft(chat, CoachDraft("Question", photo))
            armed = true
            assertTrue(store.ask(chat, "Question", "request-a", photo) is AskOutcome.Capped)
            store.resumeChats(); runCurrent()
            assertEquals(1, server.asked.size)
            if (unreadable) { check(file.delete()); check(held.renameTo(file)) }
            store.resumeChats(); runCurrent()
            val reopened = LocalCoach(file)
            store(reopened).resumeChats(); runCurrent()
            assertEquals(1, server.asked.size)
            assertEquals(emptyList<AskQuestion>(), reopened.pending("alice"))
            assertTrue(reopened.archivedChat("alice", chat)!!.exchanges.single().terminalRefusal)
            assertEquals(CoachDraft("Question", photo), reopened.draft("alice", chat))
            assertArrayEquals(byteArrayOf(3, 2, 1), reopened.photoFile("alice", photo.id).readBytes())
            assertEquals(1, failures.count { it == "gym.saveConversation" })
            assertTrue(failures.all { it in setOf("gym.saveConversation", "gym.restoreConversation") })
        }
    }
}
