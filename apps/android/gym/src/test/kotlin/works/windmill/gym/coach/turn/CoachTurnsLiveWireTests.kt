package works.windmill.gym.coach.turn

import android.content.Context
import java.io.File
import java.util.Collections
import java.util.UUID
import javax.crypto.KeyGenerator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Repository
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.telemetry.GymEvents
import works.windmill.platform.agent.TurnHttp
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationHttp
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.telemetry.AndroidTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.*
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// The turn against a local backend and a fake model vendor: signed in and signed out, a read batch, a `create_routine`, a proposal and a Stop, on the real wire, a real SQLite engine and the real event delivery. The harness that starts them greps the server's lines and the intake.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class CoachTurnsLiveWireTests {
    private val scope = ScopeRef(Gym.scope)

    private fun TurnsOn.routines(): List<Routine> = engine.read(scope) { Repository.decode(Routine, it.drawn(Routine.type)) }
    private fun TurnsOn.message(turn: OpenTurn.Turn): CoachMessage = checkNotNull(engine.read(scope) { read -> Repository.decode(CoachMessage, read.drawn(CoachMessage.type)) }.firstOrNull { it.id == turn.coach })

    private class TurnsOn(val engine: Engine, val turns: CoachTurns)

    private suspend fun TurnsOn.send(question: String, anonymous: Boolean): OpenTurn.Turn {
        val turn = checkNotNull(turns.send(question, null, null, anonymous)) { "refused: ${turns.refusal.value} ${turns.fault.value}" }
        return turn
    }

    private suspend fun TurnsOn.settled(turn: OpenTurn.Turn): CoachMessage = withTimeout(30_000) {
        while (!turns.idle) delay(20)
        message(turn)
    }

    // Every step a real turn takes, on one seat.
    private suspend fun TurnsOn.walk(anonymous: Boolean, reads: List<String> = CoachTurnBounds.contextReads) {
        val read = settled(send("wire read-batch", anonymous))
        assertEquals(MessageState.completed, read.state)
        assertEquals(reads + listOf("list_routines", "list_exercises"), read.calls.map { it.name })
        assertTrue(read.calls.all { it.outcome == AbilityCall.Outcome.Ok })
        assertEquals("Checking.Done, read-batch.", read.text.replace("\n", ""))
        assertEquals(AbilityCall.receipt(read.calls), read.receipt)

        val made = settled(send("wire create-routine", anonymous))
        assertEquals(MessageState.completed, made.state)
        val created = made.calls.last()
        assertEquals("create_routine", created.name)
        assertEquals(AbilityCall.Outcome.Ok, created.outcome)
        val routine = routines().single { it.name == "Wire day" }
        assertEquals(listOf(routine.id.ref), created.created)
        assertEquals(Json.objectOf("read" to made.receipt!!.member("read"), "results" to Json.Arr(listOf(Json.objectOf("t" to Json.of(Gym.Types.routine), "id" to routine.id.json)))).jcs, made.receipt!!.jcs)

        val proposed = settled(send("wire proposal routine=${routine.id.record.string}", anonymous))
        assertEquals(MessageState.completed, proposed.state)
        assertEquals("propose_routine_change", proposed.calls.last().name)
        assertEquals(AbilityCall.Outcome.Ok, proposed.calls.last().outcome)
        assertEquals(1, proposed.calls.last().created.size)

        val stopping = send("wire stop", anonymous)
        withTimeout(10_000) { turns.activity.first { it != null } }
        withTimeout(10_000) { while (message(stopping).calls.size < reads.size) delay(20) }
        turns.requestStop()
        val stopped = settled(stopping)
        assertEquals(MessageState.stopped, stopped.state)
        assertEquals(reads, stopped.calls.map { it.name })
        assertNull(turns.fault.value)
        assertNull(turns.refusal.value)
    }

    private fun kept(context: Context, name: String): KeptValues {
        val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)
        assertTrue(prefs.edit().clear().commit())
        return object : KeptValues {
            override fun read(key: String) = prefs.getString(key, null)
            override fun write(values: Map<String, String?>) {
                val edit = prefs.edit()
                values.forEach { (key, value) -> if (value == null) edit.remove(key) else edit.putString(key, value) }
                check(edit.commit())
            }
        }
    }

    @Test fun aTurnRunsOnTheRealWireOnBothSeats() = runBlocking {
        assumeTrue(System.getenv("WM_ANDROID_TURN_WIRE_TEST") == "1")
        val base = checkNotNull(System.getenv("WM_WIRE_BASE")).toHttpUrl()
        require(base.host in setOf("127.0.0.1", "localhost"))
        val bearer = checkNotNull(System.getenv("WM_WIRE_BEARER"))
        val evidence = File(checkNotNull(System.getenv("WM_WIRE_EVIDENCE"))).apply { mkdirs() }
        val context = RuntimeEnvironment.getApplication()
        val eventPrefs = context.getSharedPreferences("works.windmill.telemetry", Context.MODE_PRIVATE)
        assertTrue(eventPrefs.edit().clear().commit())
        val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        var credential: String? = bearer
        val delivery = AndroidTelemetry(context, base, "android-apc-w4", "local", "w4", "4", null, { credential }, applicationScope, GymEvents.schemas)
        val failures = Collections.synchronizedList(mutableListOf<String>())
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = delivery.event(name, properties)
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                failures += "$operation $properties"
                delivery.failure(operation, error, properties)
            }
        }
        val clock = object : EngineClock { override fun now() = System.currentTimeMillis() }
        val ids = object : IdentitySource {
            override fun opaqueID() = UUID.randomUUID().toString()
            override fun draw(bound: Int) = java.security.SecureRandom().nextInt(bound)
        }
        val initial = Engine.memory(SyncSchema.registry, clock = clock).use { it.snapshot() }
        val catalog = lazy { Catalog(context.assets.open("gym-catalog.json").use { Json.parse(it.readBytes()) }) }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val client = OkHttpClient()
        val transport = TurnHttp(base, "/v1/gym/coach/turns", SyncSchema.version.toInt(), client)
        fun turnsOn(name: String, token: String?): TurnsOn {
            val engine = AndroidSqlite.open(File(evidence, "$name.sqlite"), SyncSchema.registry, initial, clock, ids, ids.actorID(), rewriteDeviceValue = EngineTraining.rewriteDeviceValue)
            val installation = AiInstallation(kept(context, "wire-installation-$name"), SecretVault { key }, AiInstallationHttp(base, telemetry, client), telemetry)
            return TurnsOn(engine, CoachTurns(EngineTraining(engine), transport, installation, { token }, PictureFiles { File(evidence, "$name-pictures") }, catalog,
                telemetry, {}, base.toString().trimEnd('/'), applicationScope))
        }
        try {
            val http = HTTPTransport(base.toString(), SyncSchema.registry.version.toInt())
            suspend fun answer(reply: Reply<SyncResponse>): SyncResponse = when (reply) {
                is Reply.Answer -> reply.value
                is Reply.Failed -> reply.response
                Reply.Unreachable -> error("The local verification server is unavailable.")
            }

            val signedIn = turnsOn("bound", bearer)
            signedIn.engine.use { engine ->
                signedIn.turns.start()
                val sent = clock.reading()
                val hello = answer(http.hello(bearer))
                assertEquals(200, hello.status)
                engine.onHello(hello, RequestTiming(sent, clock.reading()))
                val body = checkNotNull(hello.body)
                assertTrue(engine.signIn(body.member("as").str(), body.member("holdsRecords").obj().mapValues { it.value.bool() }, serverSchema = body.member("schema").long()).member("complete").bool())
                engine.subscribe(scope)

                val arriving = signedIn.turns.send("wire read-batch", null, null, anonymous = false)
                assertNull(arriving)
                assertEquals(CoachTurnRefusal.LogArriving, signedIn.turns.refusal.value)

                val training = EngineTraining(engine)
                suspend fun pull() {
                    val request = checkNotNull(engine.pullRequest(listOf(scope)))
                    val at = clock.reading()
                    engine.onPullResponse(request, answer(http.pull(request, bearer)), RequestTiming(at, clock.reading()))
                }
                withTimeout(20_000) { while (!training.firstPullComplete) pull() }

                signedIn.walk(anonymous = false)

                // What the host wrote is what the real server admits: every intent lands, and no refusal comes back.
                withTimeout(30_000) {
                    while (true) {
                        val push = engine.nextPush() ?: break
                        val at = clock.reading()
                        val response = answer(http.push(push, bearer))
                        assertEquals(200, response.status)
                        engine.onPushResponse(push, response, RequestTiming(at, clock.reading()))
                        pull()
                    }
                }
                val replica = engine.snapshot().let { snapshot -> snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") } }
                assertEquals(0, replica["notices"]?.arr().orEmpty().count())
            }

            credential = null
            delivery.identity(null)
            val signedOut = turnsOn("anon", null)
            signedOut.engine.use {
                signedOut.turns.start()
                signedOut.walk(anonymous = true)
            }

            assertEquals(emptyList<String>(), failures.toList())
            withTimeout(15_000) {
                while (eventPrefs.getString("queue", null)?.let { raw ->
                    Json.parse(raw).member("shelves").arr().all { it.member("events").arr().isEmpty() }
                } != true) delay(100)
            }
            File(evidence, "completed").writeText("both seats")
        } finally {
            applicationScope.cancel()
        }
    }
}
