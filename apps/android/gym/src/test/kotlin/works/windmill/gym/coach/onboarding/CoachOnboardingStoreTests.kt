package works.windmill.gym.coach.onboarding

import java.io.File
import java.io.IOException
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.coach.CoachDraft
import works.windmill.gym.coach.AskAnswer
import works.windmill.gym.coach.AskExchange
import works.windmill.gym.coach.ReadTally
import works.windmill.gym.coach.LocalChat
import works.windmill.gym.coach.LocalCoach
import works.windmill.platform.ai.*
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.schema.SyncSchema

class CoachOnboardingStoreTests {
    @get:Rule val temporary = TemporaryFolder()
    private val id = "11111111-1111-4111-8111-111111111111"
    private val allowance = AiAllowance("ok", "USD", "lifetime", "anonymous", true, null, "0", "0", "0")
    private val credential = "A".repeat(43)
    private val origin = CoachOnboardingSeat("anonymous:fixture", "replica")
    private var seat: CoachOnboardingSeat? = origin
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val values = object : KeptValues {
        val kept = mutableMapOf<String, String>()
        override fun read(key: String) = kept[key]
        override fun write(values: Map<String, String?>) {
            values.forEach { (key, value) -> if (value == null) kept.remove(key) else kept[key] = value }
        }
    }
    private val issues = mutableListOf<String>()
    private val events = mutableListOf<Pair<String, Map<String, String>>>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) { events += name to properties }
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { issues += operation }
    }
    private var issued = 0
    private var bound = false
    private var issueWait: CompletableDeferred<Unit>? = null
    private fun archive(file: File, chat: String = "chat") = LocalCoach(file).also {
        it.saveChat(origin.owner, LocalChat(chat))
    }
    private fun installation() = AiInstallation(values, SecretVault { key }, object : AiInstallationApi {
        override suspend fun issue(): AiInstallationResponse {
            issued++
            issueWait?.await()
            return AiInstallationResponse(false, allowance, credential)
        }
        override suspend fun current(credential: String) = AiInstallationResponse(bound, allowance)
        override suspend fun bind(credential: String, token: String): AiInstallationResponse {
            bound = true
            return AiInstallationResponse(true, allowance)
        }
    }, telemetry)

    private fun response(status: String = "completed") = CoachOnboardingResponse(id, "result", status, 1_900_000_000_000,
        if (status == "pending") emptyList() else listOf(CoachOnboardingResponse.Routine("Upper",
            listOf(CoachOnboardingResponse.Entry("bench-press", listOf(CoachOnboardingResponse.Target(5, 0.0)), 90)))), allowance)

    private class Api : CoachOnboardingApi {
        val posts = mutableListOf<Pair<String, String>>()
        val gets = mutableListOf<Pair<String, String>>()
        var onPost: suspend (String) -> CoachOnboardingResponse = { error("unexpected POST") }
        var onGet: suspend (String) -> CoachOnboardingResponse = { error("unexpected GET") }
        override suspend fun start(body: String, credential: String): CoachOnboardingResponse {
            posts += body to credential
            return onPost(body)
        }
        override suspend fun get(requestId: String, credential: String): CoachOnboardingResponse {
            gets += requestId to credential
            return onGet(requestId)
        }
    }

    @Test fun requestIsDurableBeforePostAndAResponseAlwaysReturnsToItsOriginalChat() = runTest {
        val local = archive(File(temporary.root, "archive.json"), "original-chat")
        val api = Api()
        val waiting = CompletableDeferred<CoachOnboardingResponse>()
        api.onPost = { body ->
            val kept = LocalCoach(File(temporary.root, "archive.json")).onboarding(origin.owner, id)!!
            assertEquals(body, kept.body)
            assertTrue(kept.submitted)
            assertEquals(origin.replica, kept.replica)
            waiting.await()
        }
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id }, { 1_800_000_000_000 })
        val one = store.send("original-chat", "Do not log this question")
        val two = store.send("original-chat", "A second click cannot replace the pending question")
        assertSame(one, two)
        runCurrent()
        local.saveChat(origin.owner, LocalChat("new-chat"), select = true)
        waiting.complete(response())
        val answered = one.await() as CoachOnboardingOutcome.Answered
        assertEquals("original-chat", answered.record.chat)
        assertEquals(listOf(answered.record), store.records(origin.owner, "original-chat"))
        assertTrue(store.records(origin.owner, "new-chat").isEmpty())
        assertEquals("new-chat", local.selected(origin.owner))
        assertEquals(1, api.posts.size)
        assertFalse(events.toString().contains("Do not log this question"))
        assertFalse(events.toString().contains(id))
        assertFalse(events.toString().contains(credential))
        assertEquals("answered", events.last().second["outcome"])
    }

    @Test fun timeoutRecoversTheSameIdAndRetainsTheExactWireBody() = runTest {
        val local = archive(File(temporary.root, "archive.json"))
        local.saveChat(origin.owner, LocalChat("chat", exchanges = listOf(AskExchange("earlier question",
            answer = AskAnswer("earlier answer", ReadTally())))))
        val api = Api().apply {
            onPost = { throw WindmillApiException.Timeout(IOException("fixture")) }
            onGet = { assertEquals(id, it); response() }
        }
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        val result = store.send("chat", "é whole draft").await()
        assertTrue(result is CoachOnboardingOutcome.Answered)
        val kept = local.onboarding(origin.owner, id)!!
        assertTrue(kept.submitted)
        assertEquals(kept.body, api.posts.single().first)
        assertEquals(listOf(id to credential), api.gets)
        assertEquals("é whole draft", kept.request().text)
        assertEquals(listOf(CoachOnboardingContext("user", "earlier question"), CoachOnboardingContext("assistant", "earlier answer")), kept.request().context)
        assertEquals(1, issued)
    }

    @Test fun processDeathMidPollResumesWithGetAfterBindingAndKeepsTheOriginalOwner() = runTest {
        val file = File(temporary.root, "archive.json")
        val local = archive(file, "original-chat")
        val api = Api().apply { onPost = { response("pending") }; onGet = { response() } }
        val firstScope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))
        val access = installation()
        val first = CoachOnboardingStore(local, access, api, { seat }, firstScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        first.send("original-chat", "whole retained question")
        runCurrent()
        assertEquals("pending", local.onboarding(origin.owner, id)?.response?.status)
        firstScope.cancel()
        runCurrent()
        access.bind("account", "token")
        seat = null
        val restored = CoachOnboardingStore(LocalCoach(file), installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { error("recovery must not mint") })
        val result = restored.resume().single().await() as CoachOnboardingOutcome.Answered
        assertEquals(origin.owner, result.record.owner)
        assertEquals("original-chat", result.record.chat)
        assertEquals(listOf(id to credential), api.gets)
        assertEquals(1, api.posts.size)
        assertEquals(1, issued)
    }

    @Test fun missingRecoveryNeverPostsUntilAnExplicitRetryAndRetryKeepsTheBodyAndId() = runTest {
        val local = archive(File(temporary.root, "archive.json"))
        val api = Api().apply {
            onPost = { throw WindmillApiException.Timeout(IOException("fixture")) }
            onGet = { throw WindmillApiException.Refused(404, Refusal(code = "not_found")) }
        }
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        assertTrue(store.send("chat", "whole retained question").await() is CoachOnboardingOutcome.Unanswered)
        assertTrue(store.resume().single().await() is CoachOnboardingOutcome.Unanswered)
        assertEquals(1, api.posts.size)
        val original = api.posts.single()
        api.onPost = { response() }
        assertTrue(store.retry(origin.owner, id).await() is CoachOnboardingOutcome.Answered)
        assertEquals(listOf(original, original), api.posts)
        assertTrue(api.gets.all { it == id to credential })
        assertEquals(1, issued)
    }

    @Test fun bindingDuringReadinessPreventsPostWithoutReplacingTheDraftOrCredential() = runTest {
        val local = archive(File(temporary.root, "archive.json"))
        val api = Api()
        issueWait = CompletableDeferred()
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        val job = store.send("chat", "retain this whole question")
        runCurrent()
        seat = null
        issueWait!!.complete(Unit)
        assertEquals("seat_changed", (job.await() as CoachOnboardingOutcome.Refused).code)
        assertTrue(api.posts.isEmpty())
        assertEquals("retain this whole question", local.onboarding(origin.owner, id)?.request()?.text)
        assertEquals(1, issued)
        assertTrue(issues.isEmpty())
    }

    @Test fun aLimitRetainsTheWholeDraftAndPersistenceFailureNeverStartsTransport() = runTest {
        val file = File(temporary.root, "archive.json")
        var failWrite = false
        val local = LocalCoach(file) { target, contents ->
            if (failWrite) throw IOException("fixture")
            target.writeText(contents)
        }
        local.saveChat(origin.owner, LocalChat("chat"))
        val api = Api()
        var next = 0
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { if (next++ == 0) id else "22222222-2222-4222-8222-222222222222" })
        val text = "é".repeat(2001)
        val limited = store.send("chat", text).await() as CoachOnboardingOutcome.Limited
        assertEquals(CoachOnboardingLimit.text, limited.limit)
        assertEquals(text, local.onboarding(origin.owner, id)?.request()?.text)
        assertEquals(0, issued)
        assertTrue(api.posts.isEmpty())
        local.saveDraft(origin.owner, "other", CoachDraft("entire unsent draft"))
        failWrite = true
        assertTrue(store.send("other", "entire unsent draft").await() is CoachOnboardingOutcome.Failed)
        assertEquals("entire unsent draft", local.draft(origin.owner, "other").text)
        assertEquals(listOf("gym.coachOnboarding"), issues)
        assertEquals(0, issued)
    }

    @Test fun pollingUsesOneSecondAndAnExpiredResultDoesNotBecomeAnotherRequest() = runTest {
        val local = archive(File(temporary.root, "archive.json"))
        val api = Api().apply { onPost = { response("pending") }; onGet = { response("expired").copy(errorCode = "result_expired") } }
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        val job = store.send("chat", "whole draft")
        runCurrent()
        assertTrue(api.gets.isEmpty())
        advanceTimeBy(999); runCurrent()
        assertTrue(api.gets.isEmpty())
        advanceTimeBy(1); runCurrent()
        assertEquals("result_expired", (job.await() as CoachOnboardingOutcome.Refused).code)
        assertEquals(1, api.posts.size)
        assertEquals(listOf(id to credential), api.gets)
        assertTrue(store.resume().isEmpty())
        assertEquals("refused", events.last().second["outcome"])
        assertTrue(issues.isEmpty())
    }

    @Test fun deletingHistoryRetiresThePendingRequestAndALateReplyCannotRecreateTheChat() = runTest {
        val file = File(temporary.root, "archive.json")
        val local = archive(file, "deleted-chat")
        val waiting = CompletableDeferred<CoachOnboardingResponse>()
        val api = Api().apply { onPost = { waiting.await() } }
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        val job = store.send("deleted-chat", "whole question")
        runCurrent()
        assertEquals(1, api.posts.size)
        local.clear(origin.owner, "deleted-chat")
        waiting.complete(response())
        try { job.await(); fail("deleted request must retire") }
        catch (_: kotlinx.coroutines.CancellationException) { }
        val reopened = LocalCoach(file)
        assertNull(reopened.onboarding(origin.owner, id))
        assertTrue(reopened.chats(origin.owner).isEmpty())
        assertTrue(reopened.onboarding().isEmpty())
        assertTrue(issues.isEmpty())
        assertEquals("cancelled", events.last().second["outcome"])
    }

    @Test fun aBoundRetryCanReadItsMissingResultButCannotPostOrMintAnotherInstallation() = runTest {
        val local = archive(File(temporary.root, "archive.json"))
        val api = Api().apply {
            onPost = { throw WindmillApiException.Timeout(IOException("fixture")) }
            onGet = { throw WindmillApiException.Refused(404, Refusal(code = "not_found")) }
        }
        val access = installation()
        val store = CoachOnboardingStore(local, access, api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        assertTrue(store.send("chat", "whole retained question").await() is CoachOnboardingOutcome.Unanswered)
        access.bind("account", "token")
        assertEquals("device_bound", (store.retry(origin.owner, id).await() as CoachOnboardingOutcome.Refused).code)
        assertEquals(1, api.posts.size)
        assertEquals(2, api.gets.size)
        assertEquals(1, issued)
        assertEquals("whole retained question", local.onboarding(origin.owner, id)?.request()?.text)
        assertTrue(issues.isEmpty())
    }

    @Test fun deletingTheDurableChatBeforeTheFirstQueuedKeepCannotRecreateItOrStartTransport() = runTest {
        val file = File(temporary.root, "archive.json")
        val local = archive(file, "deleted-chat")
        val api = Api()
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        val job = store.send("deleted-chat", "whole retained question")
        local.clear(origin.owner, "deleted-chat")
        try { job.await(); fail("first keep must respect the deleted chat") }
        catch (_: kotlinx.coroutines.CancellationException) { }
        assertTrue(LocalCoach(file).chats(origin.owner).isEmpty())
        assertTrue(LocalCoach(file).onboarding().isEmpty())
        assertTrue(api.posts.isEmpty())
        assertEquals(0, issued)
        assertTrue(issues.isEmpty())
    }

    @Test fun sendRequiresTheExistingDurableChatAndDerivesOnlyItsLatestTwelveWholeContextMessages() = runTest {
        val local = archive(File(temporary.root, "archive.json"), "original-chat")
        val exchanges = (0..7).map { index -> AskExchange("question-$index", requestId = "earlier-$index",
            answer = AskAnswer("answer-$index", ReadTally()), atMs = index.toLong()) }
        val unfinished = AskExchange("unsent question", requestId = "unfinished")
        local.saveChat(origin.owner, LocalChat("original-chat", exchanges = exchanges + unfinished))
        local.saveDraft(origin.owner, "original-chat", CoachDraft("private unsent draft"))
        local.saveChat(origin.owner, LocalChat("other-chat", exchanges = listOf(AskExchange("private other chat",
            answer = AskAnswer("private other answer", ReadTally())))), select = true)
        local.saveChat("other-owner", LocalChat("original-chat", exchanges = listOf(AskExchange("private other owner",
            answer = AskAnswer("private owner answer", ReadTally())))))
        val api = Api().apply { onPost = { response() } }
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        assertEquals("not_found", (store.send("not-durable", "new question").await() as CoachOnboardingOutcome.Refused).code)
        assertTrue(api.posts.isEmpty())
        assertTrue(store.send("original-chat", "new question").await() is CoachOnboardingOutcome.Answered)
        val body = WindmillJson.decodeFromString(CoachOnboardingRequest.serializer(), api.posts.single().first)
        assertEquals((2..7).flatMap { listOf(CoachOnboardingContext("user", "question-$it"), CoachOnboardingContext("assistant", "answer-$it")) }, body.context)
        assertFalse(body.context.toString().contains("private other"))
        assertFalse(body.context.toString().contains("unsent"))
        assertFalse(body.context.toString().contains("new question"))
        assertEquals("other-chat", local.selected(origin.owner))
        assertEquals("new question", body.text)
        assertEquals("private unsent draft", local.draft(origin.owner, "original-chat").text)
    }

    @Test fun contextKeepsWholeExchangesWithinSixteenThousandBytesAndIncludesPriorAnonymousReplies() = runTest {
        val local = archive(File(temporary.root, "archive.json"))
        val exchanges = (0..2).map { index -> AskExchange("q$index".padEnd(4000, 'q'), requestId = "earlier-$index",
            answer = AskAnswer("a$index".padEnd(4000, 'a'), ReadTally()), atMs = index.toLong()) }
        local.saveChat(origin.owner, LocalChat("chat", exchanges = exchanges))
        val earlierId = "22222222-2222-4222-8222-222222222222"
        val earlierRequest = CoachOnboardingRequest(earlierId, "conversation", "prior anonymous question", emptyList())
        assertTrue(local.keepOnboarding(CoachOnboardingRecord(origin.owner, "chat", origin.replica, earlierId,
            WindmillJson.encodeToString(CoachOnboardingRequest.serializer(), earlierRequest), 100,
            response = response().copy(requestId = earlierId, resultId = "earlier-result", message = "prior anonymous reply"))))
        val api = Api().apply { onPost = { response() } }
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        assertTrue(store.send("chat", "new question").await() is CoachOnboardingOutcome.Answered)
        val body = WindmillJson.decodeFromString(CoachOnboardingRequest.serializer(), api.posts.single().first)
        assertEquals(listOf(CoachOnboardingContext("user", exchanges.last().question),
            CoachOnboardingContext("assistant", exchanges.last().answer!!.answer),
            CoachOnboardingContext("user", "prior anonymous question"), CoachOnboardingContext("assistant", "prior anonymous reply")), body.context)
        assertTrue(body.context.sumOf { it.text.toByteArray().size } <= 16_000)
        assertEquals(exchanges, local.archivedChat(origin.owner, "chat")?.exchanges)
    }

    @Test fun anOversizedNewestExchangeLeavesAnEmptyContextWithoutTruncatingOrSkippingIt() = runTest {
        val local = archive(File(temporary.root, "archive.json"))
        val exchanges = listOf(
            AskExchange("older question", requestId = "older", answer = AskAnswer("older answer", ReadTally()), atMs = 1),
            AskExchange("é".repeat(2001), requestId = "oversized", answer = AskAnswer("newest answer", ReadTally()), atMs = 2),
        )
        local.saveChat(origin.owner, LocalChat("chat", exchanges = exchanges))
        val api = Api().apply { onPost = { response() } }
        val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { id })
        assertTrue(store.send("chat", "new question").await() is CoachOnboardingOutcome.Answered)
        val body = WindmillJson.decodeFromString(CoachOnboardingRequest.serializer(), api.posts.single().first)
        assertEquals(emptyList<CoachOnboardingContext>(), body.context)
        assertEquals(exchanges, local.archivedChat(origin.owner, "chat")?.exchanges)
        assertEquals("new question", body.text)
    }

    @Test fun terminalTechnicalFailuresEmitFailedWithoutDuplicatingTheServerIssue() = runTest {
        for (code in listOf("provider_failed", "invalid_result", "internal_error", "output_truncated", "interrupted", "unavailable")) {
            val local = archive(File(temporary.root, "$code.json"))
            val api = Api().apply { onPost = { response("failed").copy(errorCode = code) } }
            val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
                StandardTestDispatcher(testScheduler), { id }, elapsedNanos = { 0 })
            val failed = store.send("chat", "private current question").await() as CoachOnboardingOutcome.Failed
            assertEquals(code, failed.record?.response?.errorCode)
            assertEquals(failed.record, LocalCoach(File(temporary.root, "$code.json")).onboarding(origin.owner, id))
            assertEquals(mapOf("state" to "anonymous", "outcome" to "failed", "duration_ms" to "0"), events.last().second)
            assertTrue(store.resume().isEmpty())
            assertEquals(1, api.posts.size)
        }
        assertTrue(issues.isEmpty())
        assertFalse(events.toString().contains("private current question"))
        assertFalse(events.toString().contains(id))
        assertFalse(events.toString().contains(credential))
    }

    @Test fun terminalPolicyRefusalsKeepBoundedRefusedOrAllowanceOutcomes() = runTest {
        val caps = listOf("subject_exhausted", "free_month_exhausted", "free_day_exhausted", "concurrency_exhausted",
            "funding_required", "debt_outstanding", "unconfigured")
        for (code in caps + listOf("model_refused", "provider_busy", "insufficient_details", "unsupported_equipment",
            "installation_rate_limited", "anonymous_ai_unavailable", "result_expired")) {
            val local = archive(File(temporary.root, "$code.json"))
            val api = Api().apply { onPost = { response(if (code == "result_expired") "expired" else "failed").copy(errorCode = code) } }
            val store = CoachOnboardingStore(local, installation(), api, { seat }, backgroundScope, telemetry,
                StandardTestDispatcher(testScheduler), { id }, elapsedNanos = { 0 })
            assertEquals(code, (store.send("chat", "whole question").await() as CoachOnboardingOutcome.Refused).code)
            assertEquals(buildMap<String, String> {
                put("state", "anonymous"); put("outcome", if (code in caps) "capped" else "refused"); put("duration_ms", "0")
                if (code in caps) put("cap", "allowance")
            }, events.last().second)
            assertTrue(store.resume().isEmpty())
        }
        assertTrue(issues.isEmpty())
    }

    @Test fun terminalInstallationBindingPreventsAnotherPostAndRetainsOriginalGetRecovery() = runTest {
        val local = archive(File(temporary.root, "archive.json"))
        val terminal = response("failed").copy(errorCode = "installation_bound")
        val api = Api().apply { onPost = { terminal }; onGet = { terminal } }
        val access = installation()
        var next = 0
        val store = CoachOnboardingStore(local, access, api, { seat }, backgroundScope, telemetry,
            StandardTestDispatcher(testScheduler), { if (next++ == 0) id else "22222222-2222-4222-8222-222222222222" })
        assertEquals("installation_bound", (store.send("chat", "original retained input").await() as CoachOnboardingOutcome.Refused).code)
        assertEquals("device_bound", (store.send("chat", "later retained input").await() as CoachOnboardingOutcome.Refused).code)
        assertEquals("installation_bound", (store.retry(origin.owner, id).await() as CoachOnboardingOutcome.Refused).code)
        assertEquals(1, api.posts.size)
        assertEquals(listOf(id to credential), api.gets)
        assertEquals(1, issued)
        assertEquals("original retained input", local.onboarding(origin.owner, id)?.request()?.text)
        assertEquals("later retained input", local.onboarding(origin.owner, "22222222-2222-4222-8222-222222222222")?.request()?.text)
        assertTrue(issues.isEmpty())
    }

    @Test fun unexpectedHttpFailuresStayFailedWhileDeclaredUnavailableIsARefusal() = runTest {
        MockWebServer().use { server ->
            server.start()
            val local = archive(File(temporary.root, "archive.json"))
            val ids = listOf(id, "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")
            var next = 0
            val store = CoachOnboardingStore(local, installation(), CoachOnboardingHttp(server.url("/"), telemetry),
                { seat }, backgroundScope, telemetry, StandardTestDispatcher(testScheduler), { ids[next++] })
            val replies = listOf(503 to "anonymous_ai_unavailable", 500 to "internal_error", 503 to "unavailable")
            val outcomes = replies.map { (status, code) ->
                server.enqueue(MockResponse().setResponseCode(status).setBody("{\"code\":\"$code\"}"))
                store.send("chat", "private retained question").await()
            }
            assertEquals("anonymous_ai_unavailable", (outcomes[0] as CoachOnboardingOutcome.Refused).code)
            assertTrue("HTTP 500 is a failed boundary", outcomes[1] is CoachOnboardingOutcome.Failed)
            assertTrue("technical HTTP 503 is a failed boundary", outcomes[2] is CoachOnboardingOutcome.Failed)
            assertEquals(listOf("refused", "failed", "failed"),
                events.filter { it.first == "gym_ask_outcome" }.map { it.second["outcome"] })
            assertEquals(listOf("gym.coachOnboarding", "gym.coachOnboarding"), issues)
            for ((index, key) in ids.withIndex()) {
                val kept = local.onboarding(origin.owner, key)!!
                assertEquals("private retained question", kept.request().text)
                assertEquals(replies[index].second, kept.refusalCode)
                assertFalse(kept.pending)
                val request = server.takeRequest()
                assertEquals("POST", request.method)
                assertEquals(SyncSchema.version.toString(), request.getHeader("Sync-Schema"))
                assertEquals(credential, request.getHeader("X-Windmill-Installation"))
                assertNull(request.getHeader("Authorization"))
            }
            assertEquals(1, issued)
            assertFalse(events.toString().contains("private retained question"))
            assertFalse(events.toString().contains(id))
            assertFalse(events.toString().contains(credential))
        }
    }
}
