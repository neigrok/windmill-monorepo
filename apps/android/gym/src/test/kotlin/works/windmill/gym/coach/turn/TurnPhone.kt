package works.windmill.gym.coach.turn

import java.io.File
import java.util.Collections
import javax.crypto.KeyGenerator
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.TestScope
import works.windmill.agent.ToolOutcome
import works.windmill.agent.TurnEvent
import works.windmill.agent.TurnOpen
import works.windmill.agent.TurnRefusal
import works.windmill.agent.TurnSeat
import works.windmill.agent.TurnTransport
import works.windmill.agent.turnAnswer
import works.windmill.domain.kit.Catalog
import works.windmill.domain.kit.Id
import works.windmill.gym.domain.coach.CoachMessage
import works.windmill.gym.domain.coach.CoachThread
import works.windmill.gym.domain.coach.inOrder
import works.windmill.gym.store.EngineRoomFixture
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationApi
import works.windmill.platform.ai.AiInstallationResponse
import works.windmill.platform.ai.AiAllowance
import works.windmill.platform.auth.KeptValues
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.api.Change
import works.windmill.sync.api.Gesture
import works.windmill.sync.api.NewID
import works.windmill.sync.core.Json
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.ScopeRef
import works.windmill.sync.schema.Gym

// The server as one exchange scripts it: the frames it sends in order, pausing where the script awaits the phone. Each hook stands where a test kills or changes something.
internal class ScriptedTurns(private val events: List<Json>) : TurnTransport {
    var pending: String? = null
    val opened = mutableListOf<TurnOpen>()
    val seats = mutableListOf<TurnSeat>()
    val posted = mutableListOf<Json>()
    var stops = 0
    var refuseOpen: TurnRefusal? = null
    var beforePost: suspend () -> Unit = {}
    var afterPost: suspend () -> Unit = {}
    private var position = 0
    private var live: Channel<TurnEvent>? = null
    private val answered = mutableSetOf<Int>()

    // The same script again, for a second turn of one conversation.
    fun rewind() {
        position = 0
        answered.clear()
    }

    override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow {
        opened += open
        seats += seat
        refuseOpen?.let { throw it }
        stream()
    }

    override fun resume(turnId: String, seat: TurnSeat): Flow<TurnEvent> = flow {
        seats += seat
        if (pending != "resume") throw TurnRefusal(409, TurnRefusal.turnOrder, null)
        pending = null
        stream()
    }

    private suspend fun FlowCollector<TurnEvent>.stream() {
        val channel = Channel<TurnEvent>(Channel.UNLIMITED)
        live = channel
        advance()
        for (event in channel) emit(event)
    }

    override suspend fun answer(turnId: String, batch: Int, results: List<ToolOutcome>, seat: TurnSeat) {
        seats += seat
        beforePost()
        posted += turnAnswer(batch, results)
        afterPost()
        if (batch in answered) {
            if (pending == "results:$batch") {
                pending = null
                advance()
            }
            return
        }
        if (pending == "timeout") {
            pending = null
            advance()
            throw TurnRefusal(409, TurnRefusal.turnOrder, null)
        }
        if (pending != "results:$batch" && pending != "resume") throw TurnRefusal(409, TurnRefusal.turnOrder, null)
        answered += batch
        if (pending == "resume") return
        pending = null
        advance()
    }

    override suspend fun stop(turnId: String, seat: TurnSeat) {
        seats += seat
        stops += 1
        if (pending == "stop") {
            pending = null
            advance()
        }
    }

    private fun advance() {
        while (position < events.size) {
            val frame = events[position++]
            val wait = frame["await"]?.str()
            if (wait != null) {
                pending = if (wait == "results") "results:${frame.member("batch").long()}" else wait
                if (wait == "resume") hangUp()
                return
            }
            val event = TurnEvent.of(frame.member("event").str(), frame.member("data"))
            live?.trySend(event)
            if (event.closing) {
                hangUp()
                return
            }
        }
    }

    private fun hangUp() {
        live?.close()
        live = null
    }
}

// Every event and failure a phone told, for a test to read whole.
internal class TellingRecorder : Telemetry {
    val events: MutableList<Pair<String, Map<String, String>>> = Collections.synchronizedList(mutableListOf())
    val failures: MutableList<Map<String, String>> = Collections.synchronizedList(mutableListOf())
    var onEvent: (String, Map<String, String>) -> Unit = { _, _ -> }

    override fun event(name: String, properties: Map<String, String>) {
        events += name to properties
        onEvent(name, properties)
    }

    override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
        failures += properties + ("operation" to operation)
    }

    fun named(name: String) = events.filter { it.first == name }.map { it.second }
}

internal class ScriptedInstallation : AiInstallationApi {
    val credential = "a".repeat(43)
    var reads = 0
    var refuseCurrent: WindmillApiException? = null
    var issueFailure: WindmillApiException? = null

    private val allowance = AiAllowance("subject", "USD", "lifetime", "free", true, used = "0", reserved = "0", remaining = "1")

    override suspend fun issue(): AiInstallationResponse {
        issueFailure?.let { throw it }
        return AiInstallationResponse(false, allowance, credential)
    }

    override suspend fun current(credential: String): AiInstallationResponse {
        reads += 1
        refuseCurrent?.let { throw it }
        return AiInstallationResponse(false, allowance)
    }

    override suspend fun bind(credential: String, token: String) = AiInstallationResponse(true, allowance)
}

// One phone for a turn: the real engine, the store composed as the application composes it, `CoachTurns` on them, and a scripted server. A snapshot reopens a phone as a new process finds it. Virtual time, one dispatcher: the test advances it.
internal class TurnPhone(
    test: TestScope,
    directory: File,
    transport: TurnTransport,
    snapshot: Json? = null,
    private val writable: () -> Boolean = { true },
    private val lease: (Job) -> Unit = {},
    private val accountToken: () -> String? = { "account-token" },
) : AutoCloseable {
    val telling = TellingRecorder()
    val scope = CoroutineScope(SupervisorJob() + test.coroutineContext[ContinuationInterceptor] as CoroutineDispatcher)
    val room = EngineRoomFixture(directory, scope, snapshot = snapshot, writeAuthority = writable)
    val engine get() = room.engine
    val installationServer = ScriptedInstallation()
    val pictureFolder = File(directory, "pictures")
    val pictures = PictureFiles { pictureFolder }
    private val kept = mutableMapOf<String, String?>()
    val installation = AiInstallation(object : KeptValues {
        override fun read(key: String) = kept[key]
        override fun write(values: Map<String, String?>) { kept.putAll(values) }
    }, KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().let { key -> SecretVault { key } }, installationServer)
    val server = transport as? ScriptedTurns ?: ScriptedTurns(emptyList())
    val turns = CoachTurns(room.training, transport, installation, accountToken, pictures, lazy { catalog() }, telling, lease,
        "https://windmill.works", scope, test.coroutineContext[ContinuationInterceptor] as CoroutineDispatcher, elapsedMs = { test.testScheduler.currentTime })

    suspend fun signIn(account: String = "account-1") {
        room.select(account)
        room.sync(EngineRoomFixture.server())
    }

    fun seedRoutines() {
        for ((position, routine) in listOf("rt_00000001" to "Push A", "rt_00000002" to "Pull A").withIndex()) {
            engine.commit(ScopeRef(Gym.scope), Gesture(listOf(Change.create(Gym.Types.routine, NewID.Given(RecordID(routine.first)), mapOf(
                "name" to Json.of(routine.second), "position" to Json.of(position), "entries" to Json.parse("""[{"exerciseId":"bench-press"}]"""))))))
        }
    }

    fun messages(): List<CoachMessage> = room.engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachMessage, read.drawn(CoachMessage.type))
    }.inOrder

    fun threads(): List<CoachThread> = room.engine.read(ScopeRef(Gym.scope)) { read ->
        works.windmill.domain.kit.Repository.decode(CoachThread, read.drawn(CoachThread.type))
    }

    fun message(id: Id<CoachMessage>): CoachMessage? = messages().firstOrNull { it.id == id }

    fun device(key: String): Json? = engine.read(ScopeRef(Gym.scope)) { it.device(key) }

    override fun close() {
        scope.cancel()
        room.close()
    }

    companion object {
        fun catalog() = Catalog(Json.parse(File(System.getProperty("windmill.contract"), "gym/catalog.json").readBytes()))
    }
}
