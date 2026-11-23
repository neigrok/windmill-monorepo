package works.windmill.gym.coach.turn

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
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
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Instant
import works.windmill.domain.kit.Outcome
import works.windmill.domain.kit.Repository
import works.windmill.gym.coach.CoachAttachment
import works.windmill.gym.domain.coach.AbilityCall
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachTurnBounds
import works.windmill.gym.domain.coach.EndTurn
import works.windmill.gym.domain.coach.Mark
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.OpenTurn
import works.windmill.gym.domain.sync.ApplyProposal
import works.windmill.gym.domain.sync.Exercise
import works.windmill.gym.domain.sync.ImportSession
import works.windmill.gym.domain.sync.ImportedSet
import works.windmill.gym.domain.sync.Proposal
import works.windmill.gym.domain.sync.Routine
import works.windmill.gym.domain.sync.Session
import works.windmill.gym.domain.sync.TrainingSet
import works.windmill.gym.net.GymHttp
import works.windmill.gym.store.EngineTraining
import works.windmill.gym.telemetry.GymEvents
import works.windmill.platform.ai.AiHttp
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationHttp
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.telemetry.AndroidTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.engine.*
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// Gym Coach on the AI service end to end (gym Coach on the AI service §10): the real engine on SQLite, the real AI client over HTTP and the real event delivery, against the backend signing passes, the AI service, and a provider the stack plays (`apps/android/tools/coach_turn_stack.py`, which starts them and runs this). The stories: a question answered, an ability that writes, a proposal applied, a share, a picture, Stop, a connection lost and found, a sign-in under a running turn, an app killed in its last round, and an allowance used up.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class CoachTurnsLiveWireTests {
    private val gym = ScopeRef(Gym.scope)

    private class Wire(val base: HttpUrl, val bearer: String, val evidence: File) {
        val context: Context = RuntimeEnvironment.getApplication()
        val client = OkHttpClient()
        val failures: MutableList<String> = Collections.synchronizedList(mutableListOf())
        val clock = object : EngineClock { override fun now() = System.currentTimeMillis() }
        val ids = object : IdentitySource {
            override fun opaqueID() = UUID.randomUUID().toString()
            override fun draw(bound: Int) = java.security.SecureRandom().nextInt(bound)
        }
        val initial = Engine.memory(SyncSchema.registry, clock = clock).use { it.snapshot() }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val http = HTTPTransport(base.toString(), SyncSchema.registry.version.toInt())

        // What the stack is told to do next, through its origin.
        fun steer(action: String) {
            client.newCall(Request.Builder().url(base.resolve("/__stack/$action")!!).post(ByteArray(0).toRequestBody()).build()).execute().use {
                assertTrue("the stack took $action", it.isSuccessful)
            }
        }
    }

    private class Phone(val engine: Engine, val turns: CoachTurns, val work: CoroutineScope) {
        val training = EngineTraining(engine)
    }

    private fun Wire.phone(name: String, token: String?, telemetry: Telemetry, scope: CoroutineScope, existing: Boolean = false): Phone {
        val file = File(evidence, "$name.sqlite")
        if (!existing) file.delete()
        val engine = AndroidSqlite.open(file, SyncSchema.registry, initial, clock, ids, ids.actorID(), rewriteDeviceValue = EngineTraining.rewriteDeviceValue)
        val prefs = context.getSharedPreferences("wire-installation-$name", Context.MODE_PRIVATE)
        if (!existing) assertTrue(prefs.edit().clear().commit())
        val kept = object : KeptValues {
            override fun read(key: String) = prefs.getString(key, null)
            override fun write(values: Map<String, String?>) {
                val edit = prefs.edit()
                values.forEach { (key, value) -> if (value == null) edit.remove(key) else edit.putString(key, value) }
                check(edit.commit())
            }
        }
        val installation = AiInstallation(kept, SecretVault { key }, AiInstallationHttp(base, telemetry, client), telemetry)
        lateinit var turns: CoachTurns
        val transport = AiHttp(base, { turns.credentials }, allowLocalHttp = true)
        val shares = { token?.let { bearer -> GymHttp(WindmillApi(base, { bearer }, client)) } }
        turns = CoachTurns(EngineTraining(engine), transport, installation, { token }, PictureFiles { File(evidence, "$name-pictures") },
            lazy { Catalog(context.assets.open("gym-catalog.json").use { Json.parse(it.readBytes()) }) }, lazy { CoachWords.shipped(context.assets) },
            telemetry, {}, base.toString().trimEnd('/'), shares, scope)
        return Phone(engine, turns, scope)
    }

    private fun Phone.message(turn: OpenTurn.Turn): CoachMessage = checkNotNull(engine.read(gym) { Repository.decode(CoachMessage, it.drawn(CoachMessage.type)) }.firstOrNull { it.id == turn.coach })
    private fun Phone.routines(): List<Routine> = engine.read(gym) { Repository.decode(Routine, it.drawn(Routine.type)) }

    private suspend fun Phone.send(question: String, anonymous: Boolean, picture: ChosenPicture? = null): OpenTurn.Turn =
        checkNotNull(turns.send(question, picture, null, anonymous)) { "refused: ${turns.refusal.value} ${turns.fault.value}" }

    private suspend fun Phone.settled(turn: OpenTurn.Turn): CoachMessage = withTimeout(60_000) {
        while (turns.turn.value != null) delay(20)
        message(turn)
    }

    private suspend fun answer(wire: Wire, reply: Reply<SyncResponse>): SyncResponse = when (reply) {
        is Reply.Answer -> reply.value
        is Reply.Failed -> reply.response
        Reply.Unreachable -> error("The local stack is unavailable.")
    }

    private suspend fun Wire.pull(engine: Engine) {
        val request = checkNotNull(engine.pullRequest(listOf(gym)))
        val at = clock.reading()
        engine.onPullResponse(request, answer(this, http.pull(request, bearer)), RequestTiming(at, clock.reading()))
    }

    // What the host wrote is what the real server admits: every intent lands, and no refusal comes back.
    private suspend fun Wire.pushAll(engine: Engine) {
        withTimeout(30_000) {
            while (true) {
                val push = engine.nextPush() ?: break
                val at = clock.reading()
                val response = answer(this@pushAll, http.push(push, bearer))
                assertEquals(200, response.status)
                engine.onPushResponse(push, response, RequestTiming(at, clock.reading()))
                pull(engine)
            }
        }
        val replica = engine.snapshot().let { snapshot -> snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") } }
        assertEquals(0, replica["notices"]?.arr().orEmpty().count())
    }

    private suspend fun Wire.signedIn(phone: Phone) {
        val at = clock.reading()
        val hello = answer(this, http.hello(bearer))
        assertEquals(200, hello.status)
        phone.engine.onHello(hello, RequestTiming(at, clock.reading()))
        val body = checkNotNull(hello.body)
        val question = phone.engine.signIn(body.member("as").str(), body.member("holdsRecords").obj().mapValues { it.value.bool() }, serverSchema = body.member("schema").long())
        if (!question.member("complete").bool()) {
            val pins = question.member("due").arr().associate { due -> due.member("product").str() to due.member("counted").arr().map(Json::str) }
            assertTrue(phone.engine.signIn(body.member("as").str(), body.member("holdsRecords").obj().mapValues { it.value.bool() }, mapOf("gym" to "add"), pins,
                serverSchema = body.member("schema").long()).member("complete").bool())
        }
        phone.engine.subscribe(gym)
        withTimeout(20_000) { while (!phone.training.firstPullComplete) pull(phone.engine) }
    }

    private fun picture(): ChosenPicture {
        val bitmap = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        val bytes = java.io.ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray()
        return ChosenPicture(CoachAttachment("thr_" + UUID.randomUUID().toString().replace("-", "").take(16), "image/jpeg", 40, 30, bytes.size.toLong()), bytes)
    }

    @Test fun gymCoachRunsOnTheAiServiceEndToEnd() = runBlocking {
        assumeTrue(System.getenv("WM_ANDROID_TURN_WIRE_TEST") == "1")
        val base = checkNotNull(System.getenv("WM_WIRE_BASE")).toHttpUrl()
        require(base.host in setOf("127.0.0.1", "localhost"))
        val wire = Wire(base, checkNotNull(System.getenv("WM_WIRE_BEARER")), File(checkNotNull(System.getenv("WM_WIRE_EVIDENCE"))).apply { mkdirs() })
        val eventPrefs = wire.context.getSharedPreferences("works.windmill.telemetry", Context.MODE_PRIVATE)
        assertTrue(eventPrefs.edit().clear().commit())
        val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        var credential: String? = null
        val delivery = AndroidTelemetry(wire.context, base, "android-gact", "local", "gact", "4", null, { credential }, applicationScope, GymEvents.schemas)
        val events = Collections.synchronizedList(mutableListOf<Pair<String, Map<String, String>>>())
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {
                events += name to properties
                delivery.event(name, properties)
            }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
                wire.failures += "$operation $properties"
                delivery.failure(operation, error, properties)
            }
        }
        try {
            // Signed out: the installation's seat.
            val anon = wire.phone("anon", null, telemetry, applicationScope)
            anon.engine.use {
                anon.turns.start()

                val asked = anon.settled(anon.send("wire question", anonymous = true))
                assertEquals(MessageState.completed, asked.state)
                assertEquals("Done, question.", asked.text)
                assertEquals(CoachTurnBounds.contextReads.map { contextCallPrefix + it }, asked.calls.map { it.callId })
                assertNull(anon.engine.read(gym) { it.device(EndTurn.runningTurnKey) })
                assertNull(anon.engine.read(gym) { it.device(Mark.roundKey) })

                val written = anon.send("wire write", anonymous = true)
                val wrote = anon.settled(written)
                assertEquals("Done, write.", wrote.text)
                val routine = anon.routines().single { it.name == "Wire day" }
                assertEquals("${written.coach.record.string}-1", routine.id.record.string)
                assertEquals(listOf(routine.id.ref), wrote.calls.last().created)

                val seen = anon.settled(anon.send("wire picture", anonymous = true, picture = picture()))
                assertEquals("Done, picture.", seen.text)

                val stopping = anon.send("wire stop", anonymous = true)
                withTimeout(30_000) { anon.turns.liveAnswer.first { it?.message == stopping.coach && it.text.isNotEmpty() } }
                anon.turns.requestStop()
                val stopped = anon.settled(stopping)
                assertEquals(MessageState.stopped, stopped.state)
                assertEquals("Checking.", stopped.text)

                wire.steer("cut-next-stream")
                val found = anon.settled(anon.send("wire cut", anonymous = true))
                assertEquals(MessageState.completed, found.state)
                assertEquals("Part one. Part two.", found.text)

                // A sign-in under a running signed-out turn: its decision lands, the turn ends interrupted, and what it wrote joins the account.
                val running = anon.send("wire stop", anonymous = true)
                withTimeout(30_000) { anon.turns.liveAnswer.first { it?.message == running.coach && it.text.isNotEmpty() } }
                credential = wire.bearer
                delivery.identity(null)
                wire.signedIn(anon)
                val ended = anon.settled(running)
                assertEquals(MessageState.interrupted, ended.state)
                assertFalse(anon.training.anonymous)
                wire.pushAll(anon.engine)
                credential = null
            }

            // Signed in: the account's seat, its writes admitted by the real server.
            credential = wire.bearer
            val boundScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val bound = wire.phone("bound", wire.bearer, telemetry, boundScope)
            bound.engine.use {
                bound.turns.start()
                wire.signedIn(bound)

                val written = bound.send("wire write", anonymous = false)
                assertEquals("Done, write.", bound.settled(written).text)
                val routine = bound.routines().single { it.id.record.string == "${written.coach.record.string}-1" }
                wire.pushAll(bound.engine)

                val proposing = bound.send("wire proposal routine=${routine.id.record.string}", anonymous = false)
                val proposed = bound.settled(proposing)
                assertEquals(MessageState.completed, proposed.state)
                val proposal = Id<Proposal>("${proposing.coach.record.string}-1", Proposal)
                assertEquals(listOf(proposal.ref), proposed.calls.last().created)
                wire.pushAll(bound.engine)
                assertTrue(bound.training.pinnedOn(bound.training.pin()) { runner -> runner.run(ApplyProposal(proposal)) } is Outcome.Committed)
                wire.pushAll(bound.engine)
                assertEquals(listOf("back-squat"), bound.routines().single { it.id == routine.id }.entries.map { it.exerciseId.record.string })

                val session = Id<Session>("ses" + UUID.randomUUID().toString().replace("-", "").take(13), Session)
                val at = System.currentTimeMillis() - 3_600_000
                assertTrue(bound.training.pinnedOn(bound.training.pin()) { runner -> runner.run(ImportSession(session, Instant(at), Instant(at + 1_800_000),
                    listOf(ImportedSet(Id("set" + UUID.randomUUID().toString().replace("-", "").take(13), TrainingSet), Id("bench-press", Exercise), 60.0, 5, Instant(at + 60_000))))) } is Outcome.Committed)
                wire.pushAll(bound.engine)
                val shared = bound.settled(bound.send("wire share session=${session.record.string}", anonymous = false))
                assertEquals("Done, share.", shared.text)
                assertEquals(AbilityCall.Outcome.Ok, shared.calls.single { it.name == "share_session" }.outcome)
                wire.pushAll(bound.engine)

                // The app killed in its last round: a new process reads the round's answer and never sends it again.
                val killing = bound.send("wire killed", anonymous = false)
                withContext(Dispatchers.IO) { wire.steer("holding") }
                withTimeout(30_000) { bound.turns.liveAnswer.first { it?.message == killing.coach && it.text.isNotEmpty() } }
                bound.turns.appStopped()
                delay(500)
                val process = boundScope.coroutineContext[kotlinx.coroutines.Job]!!
                process.cancel()
                if (withTimeoutOrNull(10_000) { process.join() } == null)
                    File(wire.evidence, "still-running.txt").writeText(process.children.joinToString("\n") { it.toString() })
                assertEquals(MessageState.running, bound.message(killing).state)
            }
            wire.steer("release")
            val reopenedScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val reopened = wire.phone("bound", wire.bearer, telemetry, reopenedScope, existing = true)
            reopened.engine.use {
                reopened.turns.start()
                val recovered = withTimeout(60_000) {
                    while (true) {
                        val message = reopened.engine.read(gym) { Repository.decode(CoachMessage, it.drawn(CoachMessage.type)) }.single { it.text.startsWith("Almost.") }
                        if (message.state != MessageState.running) return@withTimeout message
                        delay(50)
                    }
                    @Suppress("UNREACHABLE_CODE") error("unreachable")
                }
                assertEquals(MessageState.completed, recovered.state)
                assertEquals("Almost. Done, killed.", recovered.text)
                assertNull(reopened.engine.read(gym) { it.device(EndTurn.runningTurnKey) })
            }
            reopenedScope.cancel()

            // An allowance used up: the turn never began, and its question returns with what holds it.
            credential = null
            val spent = wire.phone("spent", null, telemetry, applicationScope)
            spent.engine.use {
                spent.turns.start()
                assertEquals("Done, question.", spent.settled(spent.send("wire question", anonymous = true)).text)
                wire.steer("exhaust-installations")
                spent.send("wire question again", anonymous = true)
                withTimeout(30_000) { while (spent.turns.turn.value != null) delay(20) }
                assertEquals(CoachTurnRefusal.Shortfall(AllowanceShortfall.spent), spent.turns.refusal.value)
                assertEquals("wire question again", spent.turns.withdrawn.value?.question)
            }

            assertEquals(emptyList<String>(), wire.failures.toList())
            assertTrue(events.any { it.first == "coach_turn" && it.second["state"] == "completed" && it.second["rounds"] == "2" })
            assertTrue(events.any { it.first == "coach_ability" && it.second == mapOf("name" to "share_session", "outcome" to "ok") })
            assertTrue(events.none { (_, properties) -> properties.values.any { "wire" in it || "Done" in it } })
            withTimeout(15_000) {
                while (eventPrefs.getString("queue", null)?.let { raw ->
                    Json.parse(raw).member("shelves").arr().all { it.member("events").arr().isEmpty() }
                } != true) delay(100)
            }
            File(wire.evidence, "completed").writeText("every story")
        } finally {
            applicationScope.cancel()
        }
    }
}
