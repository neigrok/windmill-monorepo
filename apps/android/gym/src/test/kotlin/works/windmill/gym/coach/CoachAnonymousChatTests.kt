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
        val store = CoachStore({ owner }, { emptySet() }, {}, { null }, local, Telemetry.None, System::nanoTime,
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
        val restored = CoachStore({ owner }, { emptySet() }, {}, { null }, LocalCoach(File(temporary.root, "archive")), Telemetry.None,
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
        val store = CoachStore({ null }, { emptySet() }, {}, { null }, local, Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher, coordinator)
        val chat = store.freshChat("Earlier input")
        store.refreshAnonymousAccess(); runCurrent()
        assertEquals(AnonymousCoachAccess.Bound, store.anonymousAccess)
        assertFalse(store.submit(chat, "New input"))
        assertEquals(CoachDraft("Earlier input"), store.draft(chat))
        assertEquals(listOf(chat), store.allThreads.map { it.id })
        assertEquals(1, issued)
    }

    @Test fun dailyRefusalDeadlineSurvivesChatAndDocumentRecreationWithoutRestartingTheWait() = runTest {
        val file = File(temporary.root, "archive")
        val disk = LocalCoach(file)
        val refusal = WindmillApiException.Refused(429, Refusal(code = "ask-daily-limit"), 1_800_000_000_123L)
        val api = object : works.windmill.gym.net.GymRest by works.windmill.gym.net.FakeGymRest() {
            override suspend fun stream(question: AskQuestion, onSnapshot: suspend (AskGeneration) -> Unit): AskAnswer = throw refusal
        }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val store = CoachStore({ "account" }, { emptySet() }, {}, { api }, disk, Telemetry.None, System::nanoTime,
            backgroundScope, dispatcher)
        val chat = store.freshChat()
        assertTrue(store.submit(chat, "Refused input"))
        runCurrent()
        assertEquals(CoachDraft("Refused input"), store.draft(chat))
        val restored = CoachStore({ "account" }, { emptySet() }, {}, { api }, LocalCoach(file), Telemetry.None, System::nanoTime,
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
        val store = CoachStore({ null }, { emptySet() }, {}, { null }, local, Telemetry.None, System::nanoTime,
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
}
