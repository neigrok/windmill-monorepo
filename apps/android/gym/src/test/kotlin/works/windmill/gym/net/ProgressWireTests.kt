package works.windmill.gym.net

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Test
import works.windmill.gym.domain.*
import works.windmill.platform.net.WindmillApi

class ProgressWireTests {
    @Test
    fun readsTheCompleteOptInProjectionWithTheExactQueryAndTypedFacts() = runBlocking {
        val calls = mutableListOf<Pair<String, String>>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            calls += chain.request().method to chain.request().url.toString()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("""{"asOf":99,"sessions":[{"sessionId":"s","startedAt":10,"movements":[{"exerciseId":"bench","workingSetCount":2,"heaviest":{"setId":"h","weightKg":100,"reps":12,"rpe":6},"estimate":{"setId":"e","weightKg":80,"reps":1,"e1rm":80}}]}]}""".toResponseBody("application/json".toMediaType())).build()
        }.build()
        val api = GymHttp(WindmillApi("https://windmill.works".toHttpUrl(), { null }, client))
        assertEquals(StatsProgress(99, listOf(ProgressSession("s", 10, listOf(MovementSessionFact("bench", 2,
            PerformedFact("h", 100.0, 12, 6.0), EstimatedFact("e", 80.0, 1, null, 80.0)))))), api.progress())
        assertEquals(listOf("GET" to "https://windmill.works/v1/gym/stats?projection=progress"), calls)
    }
}
