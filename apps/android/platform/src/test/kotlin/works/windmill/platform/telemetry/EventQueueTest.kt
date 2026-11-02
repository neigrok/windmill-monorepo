package works.windmill.platform.telemetry

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.internal.http2.ErrorCode
import okhttp3.internal.http2.StreamResetException
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

@OptIn(ExperimentalCoroutinesApi::class)
class EventQueueTest {
    @Test
    fun strayRestoreCancellationReportsAndKeepsProcessingCommands() = runTest {
        var reads = 0
        var disk: String? = null
        val reports = mutableListOf<String>()
        val sent = mutableListOf<String>()
        val queue = EventQueue(null, null, { reads++; throw CancellationException() }, { disk = it; true }, { batch, _ ->
            sent += batch.events.map { it.name }
            batch.events.size
        }, { operation, _, _ -> reports += operation }, backgroundScope)
        queue.add("app_started", emptyMap())
        runCurrent()
        queue.add("app_foregrounded", emptyMap())
        runCurrent()
        assertEquals(1, reads)
        assertEquals(listOf("telemetry_restore"), reports)
        assertEquals(listOf("app_started", "app_foregrounded"), sent)
        assertEquals(emptyList<Any>(), WindmillJson.parseToJsonElement(disk!!).jsonObject.getValue("shelves")
            .jsonArray.single().jsonObject.getValue("events").jsonArray.toList())
    }

    @Test
    fun strayWriteCancellationReportsOncePerStreakAndRetainsEventsUntilRecovery() = runTest {
        var disk: String? = null
        var writes = 0
        var failing = true
        var online = false
        val reports = mutableListOf<String>()
        val sent = mutableListOf<String>()
        val queue = EventQueue(null, null, { disk }, {
            writes++
            if (failing) throw CancellationException()
            disk = it
            true
        }, { batch, _ ->
            if (!online) throw WindmillApiException.Offline
            sent += batch.events.map { it.name }
            batch.events.size
        }, { operation, _, _ -> reports += operation }, backgroundScope, retryMs = 100)
        queue.add("app_started", emptyMap())
        runCurrent()
        queue.add("app_foregrounded", emptyMap())
        runCurrent()
        assertEquals(2, writes)
        assertNull(disk)
        assertEquals(listOf("telemetry_persist"), reports)
        failing = false
        queue.add("auth_signed_out", emptyMap())
        runCurrent()
        assertEquals(3, writes)
        assertEquals(listOf("app_started", "app_foregrounded", "auth_signed_out"),
            WindmillJson.parseToJsonElement(disk!!).jsonObject.getValue("shelves").jsonArray.single()
                .jsonObject.getValue("events").jsonArray.map { it.jsonObject.getValue("name").jsonPrimitive.content })
        failing = true
        queue.add("app_started", emptyMap())
        runCurrent()
        assertEquals(4, writes)
        assertEquals(List(2) { "telemetry_persist" }, reports)
        failing = false
        online = true
        advanceTimeBy(100)
        runCurrent()
        assertEquals(5, writes)
        assertEquals(listOf("app_started", "app_foregrounded", "auth_signed_out", "app_started"), sent)
        assertEquals(List(2) { "telemetry_persist" }, reports)
        assertEquals(emptyList<Any>(), WindmillJson.parseToJsonElement(disk!!).jsonObject.getValue("shelves")
            .jsonArray.single().jsonObject.getValue("events").jsonArray.toList())
    }

    @Test
    fun strayDeliveryCancellationRetriesWithoutStoppingDelivery() = runTest {
        var attempts = 0
        val reports = mutableListOf<String>()
        val sent = mutableListOf<String>()
        val queue = EventQueue(null, null, { null }, { true }, { batch, _ ->
            attempts++
            if (attempts == 1) throw CancellationException()
            sent += batch.events.map { it.name }
            batch.events.size
        }, { operation, _, _ -> reports += operation }, backgroundScope, retryMs = 100)
        queue.add("app_started", emptyMap())
        runCurrent()
        advanceTimeBy(100)
        runCurrent()
        queue.add("app_foregrounded", emptyMap())
        runCurrent()
        assertEquals(3, attempts)
        assertEquals(listOf("app_started", "app_foregrounded"), sent)
        assertEquals(emptyList<String>(), reports)
    }

    @Test
    fun cancelledScopeStopsStorageAndDeliveryWithoutReportingOrRetrying() = runTest {
        for (boundary in listOf("read", "write", "send")) {
            val scope = CoroutineScope(backgroundScope.coroutineContext + SupervisorJob(backgroundScope.coroutineContext[Job]))
            val calls = mutableListOf<String>()
            val reports = mutableListOf<String>()
            fun visit(name: String) {
                calls += name
                if (boundary == name) {
                    scope.cancel()
                    throw CancellationException()
                }
            }
            val queue = EventQueue(null, null, { visit("read"); null }, { visit("write"); true }, { _, _ ->
                visit("send")
                awaitCancellation()
            }, { operation, _, _ -> reports += operation }, scope)
            queue.add("app_started", emptyMap())
            runCurrent()
            queue.add("app_foregrounded", emptyMap())
            advanceTimeBy(30_001)
            runCurrent()
            assertEquals(listOf("read", "write", "send").takeWhile { it != boundary } + boundary, calls)
            assertEquals(emptyList<String>(), reports)
        }
    }

    @Test
    fun dormantEvictionUsesOldestHeadThenShelfOrder() = runTest {
        val a = List(250) { EventIn("a-$it", "app_started", (it + 10).toLong(), emptyMap()) }
        val b = List(250) { EventIn("b-$it", "app_started", it.toLong(), emptyMap()) }
        fun encoded(events: List<EventIn>) = events.joinToString(",") { WindmillJson.encodeToString(EventIn.serializer(), it) }
        var disk = """{"shelves":[{"sessionKey":"a","userId":"a","events":[${encoded(a)}]},{"sessionKey":"b","userId":"b","events":[${encoded(b)}]}]}"""
        val queue = EventQueue("c", "secret", { disk }, { disk = it; true }, { _, _ -> awaitCancellation() },
            { _, error, _ -> throw AssertionError(error) }, backgroundScope, now = { 500L })
        repeat(12) { queue.add("app_foregrounded", emptyMap()) }
        runCurrent()
        val shelves = WindmillJson.parseToJsonElement(disk).jsonObject.getValue("shelves").jsonArray
        val events = shelves.map { shelf -> shelf.jsonObject.getValue("events").jsonArray.map {
            WindmillJson.decodeFromJsonElement(EventIn.serializer(), it)
        } }
        assertEquals(listOf("a", "b", "c"), shelves.map { it.jsonObject.getValue("userId").jsonPrimitive.content })
        assertEquals(a.drop(1), events[0])
        assertEquals(b.drop(11), events[1])
        assertEquals(List(12) { "app_foregrounded" }, events[2].map { it.name })
        assertEquals(500, events.sumOf { it.size })
    }

    @Test
    fun callersNeverTouchStorageAndOneTurnWritesOnce() = runTest {
        var reads = 0
        val writes = mutableListOf<String>()
        val queue = EventQueue("a", "secret", { reads++; null }, { writes += it; true }, { _, _ ->
            awaitCancellation()
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope, now = { 7L })
        queue.add("account_delete", emptyMap())
        queue.identity(null, null)
        queue.add("app_started", emptyMap(), signedOut = true)
        queue.retire("a", setOf("account_delete"))
        assertEquals(0, reads)
        assertEquals(emptyList<String>(), writes)
        runCurrent()
        assertEquals(1, reads)
        assertEquals(1, writes.size)
        val shelves = WindmillJson.parseToJsonElement(writes.single()).jsonObject.getValue("shelves").jsonArray
        assertEquals(1, shelves.size)
        val shelf = shelves.single().jsonObject
        assertNull(shelf["userId"])
        val events = shelf.getValue("events").jsonArray.map { WindmillJson.decodeFromJsonElement(EventIn.serializer(), it) }
        assertEquals(listOf("app_started", "account_delete"), events.map { it.name })
        assertEquals(listOf(7L, 7L), events.map { it.clientMs })
        assertEquals(listOf(emptyMap<String, JsonPrimitive>(), emptyMap()), events.map { it.props })
    }

    @Test
    fun commandsBeforeRestoreApplyOnTopOfTheRestoredQueue() = runTest {
        var read = false
        var disk = """{"shelves":[{"sessionKey":"session-a","userId":"a","events":[{"id":"e1","name":"app_started","clientMs":1,"props":{}}]}]}"""
        val sent = mutableListOf<Pair<EventBatchIn, String?>>()
        val queue = EventQueue("a", "a-secret", { read = true; disk }, {
            assertTrue(read)
            disk = it
            true
        }, { batch, bearer -> sent += batch to bearer; batch.events.size },
            { _, error, _ -> throw AssertionError(error) }, backgroundScope, now = { 2L })
        queue.add("app_foregrounded", emptyMap())
        assertFalse(read)
        runCurrent()
        val batch = sent.single().first
        assertEquals(EventBatchIn("session-a", listOf(EventIn("e1", "app_started", 1L, emptyMap()),
            EventIn(batch.events[1].id, "app_foregrounded", 2L, emptyMap())), "android") to "a-secret", sent.single())
    }

    @Test
    fun aDormantAccountsFullShelfYieldsToTheSignedInAccount() = runTest {
        var disk: String? = null
        var clock = 0L
        val failures = mutableListOf<String>()
        val sent = mutableListOf<Pair<EventBatchIn, String?>>()
        val queue = EventQueue("a", "a-secret", { disk }, { disk = it; true }, { batch, bearer ->
            if (bearer == "a-secret") throw WindmillApiException.Offline
            sent += batch to bearer
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope, now = { clock++ }, retryMs = 100)
        repeat(500) { queue.add("app_started", emptyMap()) }
        runCurrent()
        val original = WindmillJson.parseToJsonElement(disk!!).jsonObject.getValue("shelves").jsonArray.single().jsonObject
            .getValue("events").jsonArray.map { WindmillJson.decodeFromJsonElement(EventIn.serializer(), it) }
        queue.identity("b", "b-secret")
        queue.add("app_foregrounded", emptyMap())
        runCurrent()
        advanceTimeBy(100)
        runCurrent()
        assertEquals(listOf("app_foregrounded" to "b-secret"), sent.flatMap { (batch, bearer) -> batch.events.map { it.name to bearer } })
        assertEquals(emptyList<String>(), failures)
        val shelves = WindmillJson.parseToJsonElement(disk!!).jsonObject.getValue("shelves").jsonArray
        assertEquals(listOf("a", "b"), shelves.map { it.jsonObject.getValue("userId").jsonPrimitive.content })
        assertEquals(original.drop(1), shelves.first().jsonObject.getValue("events").jsonArray.map {
            WindmillJson.decodeFromJsonElement(EventIn.serializer(), it)
        })
        assertEquals(emptyList<Any>(), shelves.last().jsonObject.getValue("events").jsonArray.toList())
        val restored = mutableListOf<Pair<EventBatchIn, String?>>()
        EventQueue("a", "renewed", { disk }, { disk = it; true }, { batch, bearer ->
            restored += batch to bearer
            batch.events.size
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope)
        runCurrent()
        assertEquals(original.drop(1).map { it to "renewed" }, restored.flatMap { (batch, bearer) -> batch.events.map { it to bearer } })
    }

    @Test
    fun drainableEventsAloneReachCapacityAndReportOnce() = runTest {
        var disk: String? = null
        var online = false
        val failures = mutableListOf<String>()
        var delivered = 0
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, _ ->
            if (!online) throw WindmillApiException.Offline
            delivered += batch.events.size
            online = false
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope, retryMs = 100)
        repeat(502) { queue.add("app_started", emptyMap()) }
        runCurrent()
        assertEquals(listOf("telemetry_overflow"), failures)
        assertEquals(500, WindmillJson.parseToJsonElement(disk!!).jsonObject.getValue("shelves").jsonArray.single()
            .jsonObject.getValue("events").jsonArray.size)
        online = true
        advanceTimeBy(100)
        runCurrent()
        assertEquals(50, delivered)
        repeat(52) { queue.add("app_foregrounded", emptyMap()) }
        runCurrent()
        assertEquals(List(2) { "telemetry_overflow" }, failures)
        assertEquals(500, WindmillJson.parseToJsonElement(disk!!).jsonObject.getValue("shelves").jsonArray.single()
            .jsonObject.getValue("events").jsonArray.size)
    }

    @Test
    fun anAcknowledgementRemovesTheEventsItCarried() = runTest {
        var disk: String? = null
        val landed = CompletableDeferred<Unit>()
        val sent = mutableListOf<Pair<EventBatchIn, String?>>()
        val queue = EventQueue("a", "a-secret", { disk }, { disk = it; true }, { batch, bearer ->
            sent += batch to bearer
            landed.await()
            batch.events.size
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope)
        queue.add("account_delete", emptyMap())
        queue.add("app_foregrounded", emptyMap())
        runCurrent()
        queue.retire("a", setOf("account_delete"))
        queue.add("auth_signed_out", emptyMap(), signedOut = true)
        runCurrent()
        landed.complete(Unit)
        runCurrent()
        assertEquals(listOf(listOf("account_delete", "app_foregrounded") to "a-secret", listOf("auth_signed_out") to null),
            sent.map { (batch, bearer) -> batch.events.map { it.name } to bearer })
        val shelves = WindmillJson.parseToJsonElement(disk!!).jsonObject.getValue("shelves").jsonArray
        assertEquals(listOf("a", null), shelves.map { it.jsonObject["userId"]?.jsonPrimitive?.content })
        assertEquals(listOf(0, 0), shelves.map { it.jsonObject.getValue("events").jsonArray.size })
    }

    @Test
    fun aRetiredAccountSendsItsCarriedEventsWithoutCredentialsAndDropsTheRest() = runTest {
        var disk: String? = null
        val sent = mutableListOf<Pair<List<EventIn>, String?>>()
        val queue = EventQueue("account-a", "revoked", { disk }, { disk = it; true }, { batch, bearer ->
            if (bearer != null) throw WindmillApiException.Refused(401, Refusal())
            sent += batch.events to bearer
            batch.events.size
        }, { _, _, _ -> }, backgroundScope, now = { 7L })
        queue.add("account_delete", mapOf("state" to "shown"))
        queue.add("app_foregrounded", mapOf("screen" to "coach"))
        queue.add("account_delete", mapOf("outcome" to "pending_confirmation"))
        runCurrent()
        queue.retire("account-a", setOf("account_delete"))
        advanceTimeBy(30_001)
        runCurrent()
        assertEquals(listOf(listOf("account_delete" to mapOf("state" to JsonPrimitive("shown")),
            "account_delete" to mapOf("outcome" to JsonPrimitive("pending_confirmation"))) to null),
            sent.map { (events, bearer) -> events.map { it.name to it.props } to bearer })
        assertFalse(disk!!.contains("app_foregrounded"))
        assertFalse(disk!!.contains("account_delete"))
    }

    @Test
    fun aSignedOutEventLeavesWithoutCredentialsAndOutlivesTheAccountItWasToldUnder() = runTest {
        var disk: String? = null
        val sent = mutableListOf<Pair<List<String>, String?>>()
        val queue = EventQueue("account-a", "secret-a", { disk }, { disk = it; true }, { batch, bearer ->
            sent += batch.events.map { it.name } to bearer
            batch.events.size
        }, { _, _, _ -> }, backgroundScope, now = { 7L })
        queue.add("gym_sign_out", mapOf("action" to "keep", "outcome" to "completed"), signedOut = true)
        queue.add("app_foregrounded", emptyMap())
        queue.identity(null, null)
        queue.add("auth_signed_out", emptyMap())
        runCurrent()
        assertEquals(listOf(listOf("gym_sign_out", "auth_signed_out") to null), sent)
        assertTrue(disk!!.contains("app_foregrounded"))
    }

    @Test
    fun aReservedPrefixRefusesUnregisteredNamesAndItsSchemasKeepOnlyTheirLabels() = runTest {
        var disk: String? = null
        val failures = mutableListOf<String>()
        val sent = mutableListOf<EventBatchIn>()
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, _ ->
            sent += batch
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope,
            schemas = EventSchemas(mapOf("probe_opened" to LabelSchema(mapOf("state" to setOf("first", "again")))), setOf("probe_")))
        for (name in listOf("probe_custom", "probe_opened_private", "PROBE_OPENED", "probe_")) queue.add(name, mapOf("state" to "first"))
        runCurrent()
        assertEquals(List(4) { "telemetry_event_name" }, failures)
        assertTrue(sent.isEmpty())
        queue.add("probe_opened", mapOf("state" to "again", "screen" to "private_screen", "platform" to "android"))
        queue.add("probe_opened", mapOf("state" to "private_state"))
        queue.add("app_started", mapOf("screen" to "home", "question" to "private_question"))
        runCurrent()
        assertEquals(listOf(
            "probe_opened" to mapOf("state" to JsonPrimitive("again"), "platform" to JsonPrimitive("android")),
            "probe_opened" to emptyMap(),
            "app_started" to mapOf("screen" to JsonPrimitive("home")),
        ), sent.flatMap { it.events }.map { it.name to it.props })
    }

    @Test
    fun retriesTheSameEventIdAndKeepsOnlySafeProperties() = runTest {
        var disk: String? = null
        var online = false
        val attempts = mutableListOf<EventBatchIn>()
        val failures = mutableListOf<String>()
        val queue = EventQueue(null, null, { disk }, { disk = it; true }, { batch, bearer ->
            assertNull(bearer)
            attempts += batch
            if (!online) throw EventDeliveryFailure(WindmillApiException.Offline, mapOf(
                "method" to "POST", "route" to "/v1/events", "duration_ms" to "10", "network_phase" to "dns",
            ))
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope, now = { 123L }, retryMs = 100)
        queue.add("app_started", mapOf("screen" to "coach", "question" to "private message", "status" to "200"))
        runCurrent()
        assertEquals(1, attempts.size)
        assertFalse(disk!!.contains("private"))
        online = true
        advanceTimeBy(100)
        runCurrent()
        assertEquals(attempts[0], attempts[1])
        assertEquals("android", attempts[0].platform)
        assertEquals(mapOf("screen" to JsonPrimitive("coach"), "status" to JsonPrimitive("200")), attempts[0].events.single().props)
        assertEquals(123L, attempts[0].events.single().clientMs)
        assertEquals(emptyList<String>(), failures)
        assertTrue(disk!!.contains("\"events\":[]"))
    }

    @Test
    fun persistedEventsWaitForTheirOwnerAndAnonymousEventsNeverTakeAnAccountBearer() = runTest {
        var disk: String? = null
        val sent = mutableListOf<Pair<EventBatchIn, String?>>()
        val queue = EventQueue("first", "first-secret", { disk }, { disk = it; true }, { batch, bearer ->
            sent += batch to bearer
            batch.events.size
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope, now = { 123L })
        queue.add("first_event", emptyMap())
        queue.identity(null, null)
        queue.add("anonymous_event", emptyMap())
        queue.identity("second", "second-secret")
        queue.add("second_event", emptyMap())
        runCurrent()
        assertFalse(disk!!.contains("secret"))
        assertEquals(listOf("anonymous_event", "second_event"), sent.map { it.first.events.single().name })
        assertEquals(listOf(null, "second-secret"), sent.map { it.second })
        assertTrue(disk!!.contains("first_event"))
        val restored = EventQueue("first", "first-renewed", { disk }, { disk = it; true }, { batch, bearer ->
            sent += batch to bearer
            batch.events.size
        }, { _, error, _ -> throw AssertionError(error) }, backgroundScope)
        runCurrent()
        assertEquals("first_event", sent.last().first.events.single().name)
        assertEquals("first-renewed", sent.last().second)
        assertEquals("android", WindmillJson.decodeFromString<EventBatchIn>(
            WindmillJson.encodeToString(EventBatchIn.serializer(), sent.last().first)).platform)
    }

    @Test
    fun failedPersistenceAndDeliveryAreReportedWithoutLosingMemoryQueue() = runTest {
        val failures = mutableListOf<String>()
        var online = false
        var writes = false
        val queue = EventQueue(null, null, { null }, { writes }, { batch, _ ->
            if (!online) throw IllegalStateException("failed intake")
            batch.events.size
        }, { operation, _, _ -> failures += operation }, backgroundScope, retryMs = 100)
        queue.add("app_started", emptyMap())
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        assertEquals(listOf("telemetry_persist", "telemetry_delivery"), failures)
        online = true
        writes = true
        advanceTimeBy(100)
        runCurrent()
        assertEquals(listOf("telemetry_persist", "telemetry_delivery"), failures)
    }

    @Test
    fun deliveryDiagnosticsReportOncePerFailureStreakAndResetAfterSuccess() = runTest {
        var online = false
        var attempts = 0
        val failure = WindmillApiException.Unexpected(IllegalStateException("private transport detail"))
        val diagnostics = mapOf(
            "method" to "POST", "route" to "/v1/events", "network_phase" to "decode",
            "duration_ms" to "40", "operation" to "http_request", "failure_kind" to "unexpected",
        )
        val reports = mutableListOf<Pair<String, Map<String, String>>>()
        val queue = EventQueue(null, null, { null }, { true }, { batch, _ ->
            attempts += 1
            if (!online) throw EventDeliveryFailure(failure, diagnostics)
            batch.events.size
        }, { operation, error, properties ->
            assertEquals(failure, error)
            reports += operation to properties
        }, backgroundScope, retryMs = 100)
        queue.add("app_started", emptyMap())
        runCurrent()
        advanceTimeBy(200)
        runCurrent()
        assertEquals(3, attempts)
        assertEquals(listOf("telemetry_delivery" to diagnostics), reports)

        online = true
        advanceTimeBy(100)
        runCurrent()
        assertEquals(4, attempts)
        online = false
        queue.add("app_foregrounded", emptyMap())
        runCurrent()
        assertEquals(5, attempts)
        assertEquals(List(2) { "telemetry_delivery" to diagnostics }, reports)
    }

    @Test
    fun lostNetworkRetriesSilentlyWhileARefusedCertificateOrABrokenReplyReportsOncePerStreak() = runTest {
        val refusedCertificate = WindmillApiException.Transport(javax.net.ssl.SSLHandshakeException("chain validation failed")
            .apply { initCause(java.security.cert.CertificateException("untrusted")) })
        val outcomes = listOf<Exception?>(
            WindmillApiException.Offline,
            WindmillApiException.Timeout(java.net.SocketTimeoutException("timeout")),
            WindmillApiException.Transport(java.net.SocketException("Connection reset")),
            WindmillApiException.Transport(java.io.IOException("unexpected end of stream", java.io.EOFException())),
            refusedCertificate,
            WindmillApiException.Unexpected(IllegalStateException("private")),
            null,
            WindmillApiException.Malformed,
        )
        var attempts = 0
        val reports = mutableListOf<Pair<String, Throwable>>()
        val queue = EventQueue(null, null, { null }, { true }, { batch, _ ->
            outcomes.getOrNull(attempts++)?.let { throw EventDeliveryFailure(it, emptyMap()) }
            batch.events.size
        }, { operation, error, _ -> reports += operation to error }, backgroundScope, retryMs = 100)
        queue.add("app_started", emptyMap())
        runCurrent()
        repeat(6) { advanceTimeBy(100); runCurrent() }
        assertEquals(7, attempts)
        assertEquals(listOf<Pair<String, Throwable>>("telemetry_delivery" to refusedCertificate), reports)
        queue.add("app_foregrounded", emptyMap())
        runCurrent()
        advanceTimeBy(100); runCurrent()
        assertEquals(9, attempts)
        assertEquals(listOf("telemetry_delivery" to refusedCertificate, "telemetry_delivery" to WindmillApiException.Malformed), reports)
    }

    @Test
    fun deliveryCountsLostNetworkAsTheSyncEngineDoes() {
        val rows = java.io.File(requireNotNull(System.getProperty("windmill.failureKinds"))).readLines().filter { it.isNotBlank() && !it.startsWith("#") }
        val table = rows.map { row -> row.substringAfter('\t') to (row.substringBefore('\t') == "unreachable") }
        fun failure(chain: String): Throwable = chain.split(" <- ").map { link ->
            val type = Class.forName(link.substringBefore('('))
            val argument = link.substringAfter('(', "").removeSuffix(")")
            when {
                type == StreamResetException::class.java -> StreamResetException(ErrorCode.valueOf(argument))
                argument.isEmpty() -> type.getConstructor().newInstance() as Throwable
                else -> type.getConstructor(String::class.java).newInstance(argument) as Throwable
            }
        }.reduceRight { failure, cause -> failure.initCause(cause) }
        assertEquals(table, table.map { (chain, _) -> chain to TelemetryPolicy.networkLoss(failure(chain)) })
        val transported = table.filter { (chain, _) -> failure(chain) is java.io.IOException }
        assertEquals(transported, transported.map { (chain, _) -> chain to TelemetryPolicy.networkLoss(WindmillApiException.Transport(failure(chain) as java.io.IOException)) })
        assertEquals(setOf(true, false), table.map { it.second }.toSet())
        assertEquals(listOf(true, true, false, false, false), listOf(WindmillApiException.Offline,
            WindmillApiException.Timeout(java.net.SocketTimeoutException("timeout")), WindmillApiException.Malformed,
            WindmillApiException.Refused(503, works.windmill.platform.net.Refusal()), WindmillApiException.Unexpected(IllegalStateException("bug")),
        ).map(TelemetryPolicy::networkLoss))
    }

    @Test
    fun deliveryReportsTransportFaultsAndRetriesLostNetworkSilentlyOverRealSockets() = runBlocking {
        suspend fun reported(vararg responses: MockResponse, h2: Boolean = false, plaintextTls: Boolean = false): List<String> = MockWebServer().use { server ->
            java.net.ServerSocket(0).use { plaintext ->
                if (h2) server.protocols = listOf(Protocol.H2_PRIOR_KNOWLEDGE)
                responses.forEach(server::enqueue)
                Thread { runCatching { plaintext.accept().use { it.getOutputStream().write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n".toByteArray()); Thread.sleep(500) } } }
                    .apply { isDaemon = true; start() }
                val base = if (plaintextTls) "https://127.0.0.1:${plaintext.localPort}/".toHttpUrl() else "http://127.0.0.1:${server.port}/".toHttpUrl()
                val client = OkHttpClient.Builder().apply { if (h2) protocols(listOf(Protocol.H2_PRIOR_KNOWLEDGE)) }.build()
                val reports = java.util.concurrent.CopyOnWriteArrayList<String>()
                val retried = CompletableDeferred<Unit>()
                val attempts = java.util.concurrent.atomic.AtomicInteger()
                val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
                try {
                    EventQueue(null, null, { null }, { true }, { batch, bearer ->
                        if (attempts.incrementAndGet() > 1) { retried.complete(Unit); awaitCancellation() }
                        WindmillApi(base, { bearer }, client).send<EventBatchOut>("POST", "/v1/events", batch, operation = "telemetry_delivery").accepted
                    }, { operation, error, _ -> reports += "$operation ${TelemetryPolicy.failureKind(error)}" }, scope, retryMs = 1).add("app_started", emptyMap())
                    withTimeout(10_000) { retried.await() }
                    reports.toList()
                } finally { scope.cancel() }
            }
        }
        fun reset(code: ErrorCode) = MockResponse().setSocketPolicy(SocketPolicy.RESET_STREAM_AT_START).apply { http2ErrorCode = code.httpCode }
        assertEquals(listOf(
            listOf("telemetry_delivery transport"), listOf("telemetry_delivery transport"), listOf("telemetry_delivery transport"),
            listOf("telemetry_delivery http"), emptyList(), emptyList(),
        ), listOf(
            reported(MockResponse().setStatus("garbage")),
            reported(reset(ErrorCode.INTERNAL_ERROR), h2 = true),
            reported(plaintextTls = true),
            reported(MockResponse().setResponseCode(500)),
            reported(reset(ErrorCode.REFUSED_STREAM), reset(ErrorCode.REFUSED_STREAM), h2 = true),
            reported(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)),
        ))
    }
}
