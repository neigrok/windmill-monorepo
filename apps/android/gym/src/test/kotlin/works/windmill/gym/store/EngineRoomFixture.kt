package works.windmill.gym.store

import java.io.File
import kotlinx.coroutines.CoroutineScope
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import works.windmill.gym.domain.*
import works.windmill.platform.Account
import works.windmill.platform.User
import works.windmill.platform.net.WindmillApi
import works.windmill.platform.storage.AtomicDocument
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.*
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

// One phone over the memory engine, composed the way the application composes it: the training
// store reads and writes through the engine, and only Coach, shares and credential lists reach REST.
internal class EngineRoomFixture(
    val directory: File,
    val scope: CoroutineScope,
    snapshot: Json? = null,
    private val rest: works.windmill.gym.net.GymRest? = null,
    private val undoWindowMs: Long = Withheld.windowMs,
    private val telemetry: Telemetry = Telemetry.None,
    private val workoutClock: WorkoutClock? = null,
    private val workoutAuthority: (String?) -> Boolean = { true },
    private val localCoach: LocalCoach? = null,
    private val elapsedNanos: () -> Long = System::nanoTime,
    private val mintRoutine: () -> String = Ids::routine,
    private val mintExercise: () -> String = Ids::exercise,
    private val controlsWrite: (File, String) -> Unit = AtomicDocument::write,
) : AutoCloseable {
    companion object {
        fun server(): ModelServer {
            val state = ServerState().apply {
                product = Json.objectOf("seeds" to Json.Obj(works.windmill.gym.domain.sync.SeedExercises.all.map { exercise ->
                    exercise.id.record.toString() to Json.objectOf("name" to Json.of(exercise.name),
                        "pattern" to Json.of(exercise.pattern), "equipment" to Json.of(exercise.equipment),
                        "stepKg" to Json.of(exercise.stepKg))
                }))
            }
            return ModelServer(SyncSchema.registry, GymServerRules(), state)
        }
    }
    var now = 1_800_000_000_000L
    var selected: String? = null
    private var nextSession = 0
    private var nextSet = 0
    val engine = Engine.memory(SyncSchema.registry, snapshot, clock = object : EngineClock { override fun now() = now },
        commandResultWrites = WorkoutImports.commandResultWrites, pendingDeviceWork = WorkoutImports.pendingDeviceWork,
        rewriteDeviceValue = WorkoutImports.rewriteDeviceValue)
    val training = EngineTraining(engine)
    val controlsFile = File(directory, "control.json")
    val store = freshStore()
    // As in the application: the REST doors answer only while an account is signed in.
    fun freshStore(scope: CoroutineScope = this.scope) = TrainingStore(WorkoutControls(controlsFile, write = controlsWrite), training,
        scope, rest = { rest.takeIf { selected != null } }, now = { ++now }, mintSession = { "session${(++nextSession).toString().padStart(2, '0')}" },
        mintSet = { "set${(++nextSet).toString().padStart(5, '0')}" }, mintRoutine = mintRoutine, mintExercise = mintExercise,
        undoWindowMs = undoWindowMs, workoutClock = workoutClock ?: WorkoutClock { val at = ++now; WorkoutMoment(at, at, "local") },
        workoutAuthority = workoutAuthority, telemetry = telemetry, elapsedNanos = elapsedNanos, localCoach = localCoach)
    fun account(id: String? = selected) = Account(WindmillApi("https://windmill.works".toHttpUrl(), { null }),
        id?.let { User(it, "$it@example.com") }, verified = true)
    suspend fun select(id: String?) {
        store.prepareEngineTransition()
        if (selected != null && selected != id) {
            assertTrue(engine.signOut("keep").member("complete").bool())
            selected = null
        }
        if (id != null && selected != id) {
            val question = engine.signIn(id, mapOf("gym" to true))
            if (!question.member("complete").bool()) {
                val pins = question.member("due").arr().associate { due -> due.member("product").str() to due.member("counted").arr().map(Json::str) }
                assertTrue(engine.signIn(id, mapOf("gym" to true), mapOf("gym" to "add"), pins).member("complete").bool())
            }
            selected = id
        }
        store.connect(account(id))
    }
    suspend fun workout(load: Double = 82.5, movement: String = "bench-press", finish: Boolean = true): Session {
        val session = (store.start() as GymResult.Ok).value
        store.choose(movement); store.logSet(load, 5)
        now += 60_000
        if (finish) assertTrue(store.finish() is FinishOutcome.Closed)
        return session
    }
    fun pull(server: ModelServer) {
        val request = engine.pullRequest(listOf(ScopeRef(Gym.scope)))!!
        val response = server.pull(request, Credential.Account(selected!!), now)
        assertEquals(200, response.status)
        val reading = ClockReading(now, now, "test")
        engine.onPullResponse(request, SyncResponse(response.status, response.body), RequestTiming(reading, reading))
    }
    fun sync(server: ModelServer) {
        engine.releaseHeld(true)
        while (true) {
            val request = engine.nextPush() ?: break
            val response = server.push(request, Credential.Account(selected!!), now)
            assertEquals(200, response.status)
            val reading = ClockReading(now, now, "test")
            engine.onPushResponse(request, SyncResponse(response.status, response.body), RequestTiming(reading, reading))
            pull(server)
        }
        pull(server)
    }
    fun outbox() = engine.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }
    // The selected replica's refusal notices as the engine holds them. `engine.notices(...)` is an
    // observation the engine refreshes on its own thread, so it can trail the sync that just ran.
    fun notices(): List<Json> = engine.snapshot().let { device ->
        device.member("replicas").arr().first { it.member("meta").member("replica") == device.member("active") }["notices"]?.arr().orEmpty()
    }
    override fun close() = engine.close()
}
