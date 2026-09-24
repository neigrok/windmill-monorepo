package works.windmill.gym.net

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.concurrent.TimeUnit
import works.windmill.gym.domain.AskQuestion
import works.windmill.platform.net.WindmillApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import works.windmill.gym.domain.ExerciseWrite
import works.windmill.gym.domain.McpKey
import works.windmill.gym.domain.OAuthGrant
import works.windmill.gym.domain.NoteWrite
import works.windmill.gym.domain.SetWrite
import works.windmill.platform.telemetry.Telemetry
import works.windmill.gym.domain.SessionStart
import works.windmill.gym.domain.SetFix
import works.windmill.gym.domain.SetKind
import works.windmill.gym.store.RefusalFacts
import works.windmill.gym.store.Verdict
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.net.WindmillJson

class GymHttpTests {
    @Test
    fun coachKeepsPendingSeparateFromCompletedRepliesAndEncodesOpaquePageCursors() = runBlocking {
        val paths = mutableListOf<String>()
        val bodies = mutableListOf<String>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            paths += request.url.encodedPath + request.url.encodedQuery?.let { "?$it" }.orEmpty()
            request.body?.let { body -> val buffer = okio.Buffer(); body.writeTo(buffer); bodies += buffer.readUtf8() }
            val reply = when (request.url.encodedPath) {
                "/v1/gym/ask" -> """{"generation":{"id":"generation-a","requestId":"request-a","question":"Question","status":"running"}}"""
                "/v1/gym/threads" -> """{"threads":[{"id":"thread-old","title":"Old question"}],"nextCursor":"older+/="}"""
                else -> """{"id":"thread-old","turns":[{"from":"lifter","text":"Question","position":1,"generationId":"generation-a","requestId":"request-a"},{"from":"coach","text":"Answer","position":2,"generationId":"generation-a","requestId":"request-a"}],"nextCursor":"before+/="}"""
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                .code(if (request.url.encodedPath == "/v1/gym/ask") 202 else 200).message("OK")
                .body(reply.toResponseBody("application/json".toMediaType())).build()
        }.build()
        val gym = GymHttp(WindmillApi("https://windmill.works".toHttpUrl(), { null }, client))
        val pending = gym.ask(AskQuestion("thread-old", "Question", "request-a"))
        assertEquals("running", pending.generation?.status)
        assertEquals("", pending.answer)
        assertEquals("older+/=", gym.threadsPage("old+/=").nextCursor)
        assertEquals("before+/=", gym.threadPage("thread-old", "old+/=")?.nextCursor)
        assertEquals(listOf("""{"thread":"thread-old","question":"Question","requestId":"request-a"}"""), bodies)
        assertEquals(listOf("/v1/gym/ask", "/v1/gym/threads?limit=50&cursor=old%2B%2F%3D", "/v1/gym/threads/thread-old?limit=50&before=old%2B%2F%3D"), paths)
    }

    @Test
    fun failedRequestsIdentifyTheirActionWithoutIdsQueriesOrContent() = runBlocking {
        val events = mutableListOf<Pair<String, Map<String, String>>>()
        val failures = mutableListOf<Pair<String, Map<String, String>>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { events += name to properties }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                assertEquals(503, (error as WindmillApiException.Refused).status)
                failures += operation to properties
            }
        }
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(503).message("Unavailable")
                .body("""{"error":"private diagnostic"}""".toResponseBody("application/json".toMediaType())).build()
        }.build()
        val gym = GymHttp(WindmillApi("https://windmill.works".toHttpUrl(), { "private-bearer" }, client, telemetry))
        val requests = listOf<suspend () -> Any?>(
            { gym.sessions(50, 100, "private-cursor") },
            { gym.session("private-session") },
            { gym.startSession(SessionStart("private-session", 100)) },
            { gym.appendSet("private-session", SetWrite("private-set", "private-movement", 92.5, 6, SetKind.Working, 200)) },
            { gym.finishSession("private-session", 300) },
            { gym.routine("private-routine") },
            { gym.writeNote("private-note", NoteWrite("private-title", "private training notes")) },
            { gym.ask(AskQuestion("private-thread", "private question")) },
        )
        for (request in requests) {
            try {
                request()
                fail("the server refused the request")
            } catch (error: WindmillApiException.Refused) {
                assertEquals(503, error.status)
            }
        }
        val actions = listOf(
            "gym_sessions" to "GET", "gym_session" to "GET", "gym_start_session" to "POST",
            "gym_append_set" to "POST", "gym_finish_session" to "POST", "gym_routine" to "GET",
            "gym_write_note" to "PUT", "gym_ask" to "POST",
        )
        val expected = actions.map { (operation, method) -> operation to mapOf(
            "method" to method, "route" to "/v1/gym", "failure_kind" to "http", "operation" to operation, "status" to "503",
            "network_phase" to "response_body",
        ) }
        assertEquals(expected.map { "api_request_failed" to it.second }, events.map { it.first to it.second.minus("duration_ms") })
        assertEquals(expected, failures.map { it.first to it.second.minus("duration_ms") })
        assertEquals(events.map { it.second }, failures.map { it.second })
        assertTrue(failures.all { it.second.getValue("duration_ms").toLong() >= 0 })
    }

    @Test
    fun coachReceivesItsBoundedModelBudgetWhileOrdinaryRequestsKeepTheirTimeout() = runBlocking {
        val timeouts = mutableListOf<Triple<String, Int, Long>>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            timeouts += Triple(chain.request().url.encodedPath, chain.readTimeoutMillis(),
                TimeUnit.NANOSECONDS.toSeconds(chain.call().timeout().timeoutNanos()))
            val body = if (chain.request().url.encodedPath == "/v1/gym/ask")
                """{"answer":"An answer","read":{}}""" else """{"exercises":[]}"""
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("OK").body(body.toResponseBody("application/json".toMediaType())).build()
        }.build()
        val gym = GymHttp(WindmillApi("https://windmill.works".toHttpUrl(), { null }, client))
        assertEquals("An answer", gym.ask(AskQuestion("thread", "question")).answer)
        assertEquals(emptyList<works.windmill.gym.domain.Exercise>(), gym.exercises())
        assertEquals(listOf(Triple("/v1/gym/ask", 660_000, 660L),
            Triple("/v1/gym/exercises", 10_000, 0L)), timeouts)
    }

    @Test
    fun testAStorageFailureAndATransportFailureAreBothRetries() {
        assertEquals(RefusalFacts(offline = true), RefusalFacts(WindmillApiException.Offline))
        assertEquals(RefusalFacts(malformed = true), RefusalFacts(WindmillApiException.Malformed))
        assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(WindmillApiException.Offline)))
        assertEquals(Verdict.Retry, Verdict.refusing(RefusalFacts(WindmillApiException.Malformed)))
        assertNull(Verdict.refusing(RefusalFacts(WindmillApiException.Offline)).terminalReason(afterRemints = 0))
    }

    @Test
    fun testAnExerciseWriteStatesPatternAndEquipmentOnTheWire() {
        val encoded = WindmillJson.encodeToString(
            ExerciseWrite.serializer(),
            ExerciseWrite(id = "ex_probe", name = "Nordic Curl", pattern = "isolation", equipment = "barbell"),
        )
        assertEquals(
            """{"id":"ex_probe","name":"Nordic Curl","pattern":"isolation","equipment":"barbell"}""",
            encoded,
        )
    }

    @Test
    fun testAnAdHocStartOmitsTheRoutineRatherThanSendingNull() {
        val encoded = WindmillJson.encodeToString(
            SessionStart.serializer(),
            SessionStart(id = "ses_probe", startedAt = 1_000, routineId = null),
        )
        assertEquals("""{"id":"ses_probe","startedAt":1000}""", encoded)
    }

    @Test
    fun testASetFixStatesAllThreeFieldsEvenAtTheValuesADefaultWouldHide() {
        val encoded = WindmillJson.encodeToString(
            SetFix.serializer(),
            SetFix(weightKg = 0.0, reps = 0, kind = SetKind.Warmup),
        )
        assertEquals("""{"weightKg":0.0,"reps":0,"kind":"warmup"}""", encoded)
        assertEquals(
            """{"weightKg":82.5,"reps":5,"kind":"working"}""",
            WindmillJson.encodeToString(SetFix.serializer(),
                SetFix(weightKg = 82.5, reps = 5, kind = SetKind.Working)),
        )
    }

    // The wire's `lastUsedMs` is a last-used and is not read: a row would draw it as a last-read. A
    // blank name and a missing scope both decode, because the server sends both.
    @Test
    fun testAGrantAndAKeyDecodeWithoutTheirLastUsedInstant() {
        assertEquals(
            OAuthGrant(clientId = "c1", name = "Claude Desktop", grantedMs = 1_700L, scope = "gym:read gym:write"),
            WindmillJson.decodeFromString(OAuthGrant.serializer(),
                """{"clientId":"c1","name":"Claude Desktop","grantedMs":1700,"lastUsedMs":1900,"scope":"gym:read gym:write"}"""),
        )
        assertEquals(
            OAuthGrant(clientId = "c2", name = "", grantedMs = 1_700L, scope = ""),
            WindmillJson.decodeFromString(OAuthGrant.serializer(), """{"clientId":"c2","grantedMs":1700}"""),
        )
        assertEquals(
            McpKey(id = "k1", name = "laptop", createdMs = 1_500L),
            WindmillJson.decodeFromString(McpKey.serializer(),
                """{"id":"k1","name":"laptop","createdMs":1500,"lastUsedMs":null}"""),
        )
    }
}
