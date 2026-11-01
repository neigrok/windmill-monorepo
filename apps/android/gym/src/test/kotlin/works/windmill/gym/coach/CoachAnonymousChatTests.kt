package works.windmill.gym.coach

import java.io.File
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.coach.onboarding.*
import works.windmill.platform.ai.*
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry

@OptIn(ExperimentalCoroutinesApi::class)
class CoachAnonymousChatTests {
    @get:Rule val temporary = TemporaryFolder()
    private val id = "11111111-1111-4111-8111-111111111111"
    private val allowance = AiAllowance("ok", "USD", "lifetime", "anonymous", true, null, "0", "0", "0")
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val values = object : KeptValues {
        val kept = mutableMapOf<String, String>()
        override fun read(key: String) = kept[key]
        override fun write(values: Map<String, String?>) {
            values.forEach { (key, value) -> if (value == null) kept.remove(key) else kept[key] = value }
        }
    }
    private var bound = false
    private var issued = 0
    private fun installation() = AiInstallation(values, SecretVault { key }, object : AiInstallationApi {
        override suspend fun issue(): AiInstallationResponse { issued++; return AiInstallationResponse(false, allowance, "A".repeat(43)) }
        override suspend fun current(credential: String) = AiInstallationResponse(bound, allowance)
        override suspend fun bind(credential: String, token: String) = AiInstallationResponse(true, allowance)
    })

    @Test fun aLateTypedRefusalKeepsTheOriginalInputAndDoesNotReplaceANewerDraftOrOwner() = runTest {
        val local = LocalCoach(File(temporary.root, "archive"))
        var owner: String? = null
        val origin = CoachOnboardingSeat(local.anonymousOwner(), "replica")
        val waiting = CompletableDeferred<CoachOnboardingResponse>()
        val posts = mutableListOf<String>()
        val api = object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse { posts += body; return waiting.await() }
            override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse = error("unexpected GET")
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val coordinator = CoachOnboardingStore(local, installation(), api, { origin.takeIf { owner == null } }, backgroundScope,
            storageDispatcher = dispatcher, requestId = { id })
        val store = CoachStore({ owner }, {}, { null }, local, Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher, coordinator)
        store.refreshAnonymousAccess(); runCurrent()
        assertEquals(AnonymousCoachAccess.Available, store.anonymousAccess)
        val original = store.freshChat()
        assertFalse(store.submit(original, "x".repeat(4_001)))
        assertEquals(CoachDraft(), store.draft(original))
        assertTrue(posts.isEmpty())
        assertTrue(store.submit(original, "Make Push A harder"))
        runCurrent()
        assertTrue(store.isAsking(original))
        store.saveDraft(original, CoachDraft("A newer input in the original chat"))
        val other = store.freshChat("Another chat's input")
        owner = "account-owner"
        store.freshChat("Account input", original)
        waiting.complete(CoachOnboardingResponse(id, "result", "failed", 1_900_000_000_000, emptyList(), allowance,
            errorCode = "account_required"))
        runCurrent()
        assertEquals(CoachDraft("Account input"), store.draft(original))
        owner = null
        assertEquals(other, store.selectedChatId)
        assertEquals(CoachDraft("Another chat's input"), store.draft(other))
        assertEquals(CoachDraft("A newer input in the original chat"), store.draft(original))
        val exchange = store.chat(original)!!.exchanges.single()
        assertEquals("Make Push A harder", exchange.question)
        assertEquals("account_required", exchange.refusalCode)
        assertEquals(Ask.accountRequired, exchange.trouble)
        assertFalse(exchange.pending)
        assertFalse(store.isAsking(original))
        store.keepPosition(original, 91, false)
        assertEquals(emptyList<AskExchange>(), local.archivedChat(origin.owner, original)!!.exchanges)
        val restored = CoachStore({ owner }, {}, { null }, LocalCoach(File(temporary.root, "archive")), Telemetry.None,
            System::nanoTime, backgroundScope, dispatcher, coordinator)
        assertEquals(listOf(exchange), restored.chat(original)!!.exchanges)
        assertEquals(91, restored.chat(original)!!.scroll)
        assertEquals(1, posts.size)
        assertEquals("Make Push A harder", local.onboarding(origin.owner, id)!!.request().text)
    }

    @Test fun boundInstallationKeepsItsArchiveAndCannotPostOrIssueAReplacement() = runTest {
        val local = LocalCoach(File(temporary.root, "archive"))
        val origin = CoachOnboardingSeat(local.anonymousOwner(), "replica")
        val identity = installation()
        identity.forAnonymousSend()
        identity.markBound()
        val api = object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse = error("bound phone must not POST")
            override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse = error("unexpected GET")
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val coordinator = CoachOnboardingStore(local, identity, api, { origin }, backgroundScope, storageDispatcher = dispatcher)
        val store = CoachStore({ null }, {}, { null }, local, Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher, coordinator)
        val chat = store.freshChat("Earlier input")
        store.refreshAnonymousAccess(); runCurrent()
        assertEquals(AnonymousCoachAccess.Bound, store.anonymousAccess)
        assertFalse(store.submit(chat, "New input"))
        assertEquals(CoachDraft("Earlier input"), store.draft(chat))
        assertEquals(listOf(chat), store.allThreads.map { it.id })
        assertEquals(1, issued)
    }

    @Test fun anonymousAllowanceAndOtherBudgetSentencesStayWithTheirOriginalChatAfterReopen() = runTest {
        for (code in listOf("subject_exhausted", "free_day_exhausted", "free_month_exhausted", "concurrency_exhausted", "funding_required")) {
            val file = File(temporary.root, code)
            val local = LocalCoach(file)
            val origin = CoachOnboardingSeat(local.anonymousOwner(), "replica")
            val api = object : CoachOnboardingApi {
                override suspend fun start(body: String, credential: String): CoachOnboardingResponse =
                    throw WindmillApiException.Refused(429, Refusal("Server budget sentence", code = code))
                override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse = error("Unexpected GET")
            }
            val events = mutableListOf<Pair<String, Map<String, String>>>()
            val failures = mutableListOf<String>()
            val telemetry = object : Telemetry {
                override fun event(name: String, properties: Map<String, String>) { events += name to properties }
                override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
            }
            val dispatcher = StandardTestDispatcher(testScheduler)
            val coordinator = CoachOnboardingStore(local, installation(), api, { origin }, backgroundScope,
                telemetry = telemetry, storageDispatcher = dispatcher, requestId = { id })
            val store = CoachStore({ null }, {}, { null }, local, telemetry, System::nanoTime,
                backgroundScope, dispatcher, coordinator)
            store.refreshAnonymousAccess(); runCurrent()
            val chat = store.freshChat()
            assertTrue(store.submit(chat, "Retained input")); runCurrent()
            val other = store.freshChat("Other draft")
            val restored = CoachStore({ null }, {}, { null }, LocalCoach(file), telemetry, System::nanoTime,
                backgroundScope, dispatcher, coordinator)
            val exchange = restored.chat(chat)!!.exchanges.single()
            assertEquals(if (code == "subject_exhausted") AskCap.Allowance.wordless else "Server budget sentence", exchange.trouble)
            assertEquals("Allowance".takeIf { code == "subject_exhausted" }, restored.chat(chat)!!.cap)
            assertNull(restored.chat(other)!!.cap)
            assertEquals(CoachDraft("Retained input"), restored.draft(chat))
            assertEquals(CoachDraft("Other draft"), restored.draft(other))
            assertEquals(emptyList<String>(), failures)
            val outcome = events.single { it.first == "gym_ask_outcome" }.second - "duration_ms"
            assertEquals(mapOf("state" to "anonymous", "outcome" to "capped", "cap" to "allowance"), outcome)
        }
    }

    @Test fun dailyRefusalDeadlineSurvivesChatAndDocumentRecreationWithoutRestartingTheWait() = runTest {
        val file = File(temporary.root, "archive")
        val disk = LocalCoach(file)
        val refusal = WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit"), 1_800_000_000_123L)
        val api = object : works.windmill.gym.net.GymRest by works.windmill.gym.net.FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer = throw refusal
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val store = CoachStore({ "account" }, {}, { api }, disk, Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher)
        val chat = store.freshChat()
        assertTrue(store.submit(chat, "Refused input"))
        runCurrent()
        assertEquals(CoachDraft("Refused input"), store.draft(chat))
        val restored = CoachStore({ "account" }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher)
        assertEquals("Daily", restored.chat(chat)!!.cap)
        assertEquals(1_800_000_000_123L, restored.chat(chat)!!.exchanges.single().retryAtMs)
        assertEquals(CoachDraft("Refused input"), restored.draft(chat))
    }

    @Test fun acceptedAttachmentRemainsAfterComposerClearAndOnlyUnreferencedChatPhotosAreDeleted() = runTest {
        val file = File(temporary.root, "photos")
        val local = LocalCoach(file)
        val origin = CoachOnboardingSeat(local.anonymousOwner(), "replica")
        val photo = CoachAttachment("image001", "image/png", 1, 1, 3)
        local.savePhoto(origin.owner, photo.id, byteArrayOf(1, 2, 3))
        fun retain(chat: String, requestId: String) {
            local.saveChat(origin.owner, LocalChat(chat))
            local.saveDraft(origin.owner, chat, CoachDraft(photo = photo))
            val request = CoachOnboardingRequest(requestId, "conversation", "", emptyList(), CoachOnboardingImage("image/png", "AQID"))
            assertTrue(local.keepOnboarding(CoachOnboardingRecord(origin.owner, chat, origin.replica, requestId,
                WindmillJson.encodeToString(CoachOnboardingRequest.serializer(), request), 1_800_000_000_000,
                response = CoachOnboardingResponse(requestId, "result-$chat", "completed", 1_900_000_000_000, emptyList(), allowance, message = "Read the photo."),
                attachment = photo)))
            local.saveDraft(origin.owner, chat, CoachDraft())
        }
        retain("original", id)
        retain("another", "22222222-2222-4222-8222-222222222222")
        val coordinator = CoachOnboardingStore(local, installation(), object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse = error("unexpected POST")
            override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse = error("unexpected GET")
        }, { origin }, backgroundScope)
        val store = CoachStore({ null }, {}, { null }, local, Telemetry.None, System::nanoTime,
            backgroundScope, StandardTestDispatcher(testScheduler), coordinator)
        assertEquals(CoachDraft(), store.draft("original"))
        assertEquals(listOf(photo), store.chat("original")!!.exchanges.single().attachments)
        assertEquals(photo, LocalCoach(file).onboarding(origin.owner, id)!!.attachment)
        assertArrayEquals(byteArrayOf(1, 2, 3), local.photoFile(origin.owner, photo.id).readBytes())
        local.clear(origin.owner, "original")
        assertNull(local.onboarding(origin.owner, id))
        assertTrue(local.photoFile(origin.owner, photo.id).isFile)
        assertEquals(photo, local.onboarding(origin.owner, "22222222-2222-4222-8222-222222222222")!!.attachment)
        local.clear(origin.owner, "another")
        assertFalse(local.photoFile(origin.owner, photo.id).exists())
    }

    @Test fun aNewQuestionAfterAFailedRecoveryIsPostedAndTheEarlierOneStaysRetryable() = runTest {
        val local = LocalCoach(File(temporary.root, "archive"))
        val origin = CoachOnboardingSeat(local.anonymousOwner(), "replica")
        val second = "22222222-2222-4222-8222-222222222222"
        val ids = ArrayDeque(listOf(id, second))
        val posts = mutableListOf<String>()
        val api = object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse {
                posts += WindmillJson.decodeFromString(CoachOnboardingRequest.serializer(), body).text
                if (posts.size == 1) throw WindmillApiException.Timeout(java.io.IOException("fixture"))
                return CoachOnboardingResponse(second, "result", "completed", 1_900_000_000_000, emptyList(), allowance, message = "Answer")
            }
            override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse =
                throw WindmillApiException.Transport(java.io.IOException("fixture"))
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val coordinator = CoachOnboardingStore(local, installation(), api, { origin }, backgroundScope,
            storageDispatcher = dispatcher, requestId = { ids.removeFirst() })
        val store = CoachStore({ null }, {}, { null }, local, Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher, coordinator)
        store.refreshAnonymousAccess(); runCurrent()
        val chat = store.freshChat()
        assertTrue(store.submit(chat, "First question")); repeat(50) { runCurrent() }
        assertTrue(store.chat(chat)!!.exchanges.single().again)
        store.saveDraft(chat, CoachDraft("Second question"))
        assertTrue(store.submit(chat, "Second question")); repeat(50) { runCurrent() }
        assertEquals(listOf("First question", "Second question"), posts)
        assertEquals(CoachDraft(), store.draft(chat))
        assertEquals(listOf(Triple("First question", Ask.interrupted, true), Triple("Second question", null, false)),
            store.chat(chat)!!.exchanges.map { Triple(it.question, it.trouble, it.again) })
        assertEquals("Answer", store.chat(chat)!!.exchanges.last().answer?.answer)
        assertEquals(CoachOnboardingRecord.unanswered, local.onboarding(origin.owner, id)?.refusalCode)
    }

    @Test fun aNewQuestionAfterAnUnansweredRequestIsPostedAndTheOldOneNeverReplays() = runTest {
        val local = LocalCoach(File(temporary.root, "archive"))
        val origin = CoachOnboardingSeat(local.anonymousOwner(), "replica")
        val second = "22222222-2222-4222-8222-222222222222"
        val ids = ArrayDeque(listOf(id, second))
        val posts = mutableListOf<String>()
        val events = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) = error("No failure is expected: $operation")
        }
        val api = object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse {
                posts += WindmillJson.decodeFromString(CoachOnboardingRequest.serializer(), body).text
                if (posts.size == 1) throw WindmillApiException.Timeout(java.io.IOException("fixture"))
                return CoachOnboardingResponse(second, "result", "completed", 1_900_000_000_000, emptyList(), allowance, message = "Answer")
            }
            override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse =
                throw WindmillApiException.Refused(404, Refusal(code = "not_found"))
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val coordinator = CoachOnboardingStore(local, installation(), api, { origin }, backgroundScope, telemetry,
            storageDispatcher = dispatcher, requestId = { ids.removeFirst() })
        val store = CoachStore({ null }, {}, { null }, local, Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher, coordinator)
        store.refreshAnonymousAccess(); runCurrent()
        val chat = store.freshChat()
        assertTrue(store.submit(chat, "First question")); repeat(50) { runCurrent() }
        assertEquals(CoachOnboardingRecord.unanswered, local.onboarding(origin.owner, id)?.refusalCode)
        assertEquals(Triple("First question", Ask.interrupted, true), store.chat(chat)!!.exchanges.single().let { Triple(it.question, it.trouble, it.again) })
        store.saveDraft(chat, CoachDraft("Second question"))
        assertTrue(store.submit(chat, "Second question")); repeat(50) { runCurrent() }
        repeat(3) { coordinator.resume().forEach { it.await() } }
        assertEquals(listOf("First question", "Second question"), posts)
        assertEquals(2, events.count { it == "gym_ask_started" })
        assertEquals(CoachDraft(), store.draft(chat))
    }

    @Test fun aQuestionAnsweredWhileTheAppWasDeadLeavesTheComposerEmptySoSendCannotAskItAgain() = runTest {
        val file = File(temporary.root, "archive")
        val posts = mutableListOf<String>()
        val dispatcher = StandardTestDispatcher(testScheduler)
        val dead = LocalCoach(file)
        val origin = CoachOnboardingSeat(dead.anonymousOwner(), "replica")
        val stalled = object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse {
                posts += body
                return CompletableDeferred<CoachOnboardingResponse>().await()
            }
            override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse = error("unexpected GET")
        }
        val before = CoachStore({ null }, {}, { null }, dead, Telemetry.None, System::nanoTime, backgroundScope, dispatcher,
            CoachOnboardingStore(dead, installation(), stalled, { origin }, backgroundScope, storageDispatcher = dispatcher, requestId = { id }))
        before.refreshAnonymousAccess(); runCurrent()
        val chat = before.freshChat()
        before.saveDraft(chat, CoachDraft("Make Push A harder "))
        assertTrue(before.submit(chat, "Make Push A harder ")); runCurrent()
        assertEquals(1, posts.size)
        val relaunched = LocalCoach(file)
        val answering = object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse { posts += body; error("unexpected POST") }
            override suspend fun get(requestId: String, credential: String) =
                CoachOnboardingResponse(id, "result", "completed", 1_900_000_000_000, emptyList(), allowance, message = "Answer")
        }
        val after = CoachStore({ null }, {}, { null }, relaunched, Telemetry.None, System::nanoTime, backgroundScope, dispatcher,
            CoachOnboardingStore(relaunched, installation(), answering, { origin }, backgroundScope, storageDispatcher = dispatcher, requestId = { id }))
        after.resumeAnonymous(); repeat(50) { runCurrent() }
        assertEquals(CoachDraft(), after.draft(chat))
        assertEquals(CoachDraft(), LocalCoach(file).draft(origin.owner, chat))
        assertEquals(listOf("Make Push A harder" to "Answer"), after.chat(chat)!!.exchanges.map { it.question to it.answer?.answer })
        assertEquals(1, posts.size)
    }

    @Test fun trailingWhitespaceIsTrimmedBeforeTheLimitAndTheRequest() = runTest {
        val local = LocalCoach(File(temporary.root, "archive"))
        val origin = CoachOnboardingSeat(local.anonymousOwner(), "replica")
        val posts = mutableListOf<String>()
        val api = object : CoachOnboardingApi {
            override suspend fun start(body: String, credential: String): CoachOnboardingResponse {
                posts += WindmillJson.decodeFromString(CoachOnboardingRequest.serializer(), body).text
                return CoachOnboardingResponse(id, "result", "completed", 1_900_000_000_000, emptyList(), allowance, message = "Answer")
            }
            override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse = error("unexpected GET")
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val coordinator = CoachOnboardingStore(local, installation(), api, { origin }, backgroundScope,
            storageDispatcher = dispatcher, requestId = { id })
        val store = CoachStore({ null }, {}, { null }, local, Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher, coordinator)
        store.refreshAnonymousAccess(); runCurrent()
        val chat = store.freshChat()
        assertTrue(store.submit(chat, "x".repeat(3_990) + " ".repeat(20))); repeat(50) { runCurrent() }
        assertEquals(listOf("x".repeat(3_990)), posts)
        assertEquals("Answer", store.chat(chat)!!.exchanges.single().answer?.answer)
    }
}
