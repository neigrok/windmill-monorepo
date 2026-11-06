@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package works.windmill.agent

import java.io.File
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import works.windmill.sync.core.Json

// The product side of a turn with nothing behind it: it answers a call with its own input, or the outcome it was given, and writes down what the driver asked of it.
class EchoHost(private val open: TurnOpen = TurnOpen("tn_1", "catalog/2", "Hi", emptyList(), emptyList(), emptyList(), emptyList()),
    private val answers: Map<String, ToolOutcome> = emptyMap()) : TurnHost {
    val executed = mutableListOf<ToolCall>()
    val writes = mutableListOf<String>()
    val ends = mutableListOf<TurnEnd>()
    val withdrawals = mutableListOf<TurnRefusal>()
    var openFault: Exception? = null
    var executeFault: Exception? = null
    var writeFault: Exception? = null
    var endFault: Exception? = null
    var withdrawFault: Exception? = null

    override suspend fun open(): TurnOpen {
        openFault?.let { throw it }
        return open
    }

    override suspend fun execute(call: ToolCall): ToolOutcome {
        executeFault?.let { throw it }
        executed += call
        return answers[call.callId] ?: ToolOutcome.Ok(call.callId, call.name, call.input)
    }

    override suspend fun writeText(text: String) {
        writeFault?.let { throw it }
        writes += text
    }

    override suspend fun end(end: TurnEnd) {
        endFault?.let { throw it }
        ends += end
    }

    override suspend fun withdraw(refusal: TurnRefusal) {
        withdrawFault?.let { throw it }
        withdrawals += refusal
    }
}

class RecordingTelemetry : TurnTelemetry {
    val lines: MutableList<String> = Collections.synchronizedList(mutableListOf())
    override fun ability(name: TurnLabel, outcome: TurnLabel) { lines += "ability ${name.value} ${outcome.value}" }
    override fun ended(state: TurnState, seat: SeatKind, code: TurnLabel?, tally: TurnTally, durationMs: Long) {
        lines += "ended $state $seat ${code?.value ?: "-"} calls=${tally.calls} refusals=${tally.refusals} bytes=${tally.answerBytes} ms=$durationMs"
    }
    override fun withdrawn(status: Int, code: TurnLabel, durationMs: Long) { lines += "withdrawn $status ${code.value} ms=$durationMs" }
    override fun failure(kind: TurnFailure, status: Int?) { lines += "failure $kind ${status ?: "-"}" }
}

// The server as one exchange scripts it: the frames it sends in order, pausing where the script awaits the phone.
class ScriptedServer(private val events: List<Json>) : TurnTransport {
    var pending: String? = null
    val opened = mutableListOf<TurnOpen>()
    val seats = mutableListOf<TurnSeat>()
    val posted = mutableListOf<Json>()
    var stops = 0
    private var position = 0
    private var live: Channel<TurnEvent>? = null
    private val answered = mutableSetOf<Int>()

    override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> = flow {
        opened += open
        seats += seat
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
        posted += turnAnswer(batch, results)
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

// Each exchange of the shared contract replayed through the real driver, as the phone. The server's side of a file (`model`, `after`, the probes it refuses) is the backend's to replay.
@RunWith(Parameterized::class)
class TurnExchangeTests(private val name: String) {
    companion object {
        val contract: File by lazy {
            System.getProperty("windmill.contract")?.let(::File) ?: generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
                .map { File(it, "packages/api-contract") }.first { it.isDirectory }
        }

        @JvmStatic @Parameterized.Parameters(name = "{0}")
        fun exchanges(): List<String> = File(contract, "gym/turns").listFiles { file -> file.extension == "json" }!!.map { it.nameWithoutExtension }.sorted()
    }

    @Test fun replaysThroughTheDriver() = runTest {
        assertEquals(16, exchanges().size)
        val vector = Json.parse(File(contract, "gym/turns/$name.json").readBytes())
        val body = vector.member("open")
        val events = vector.member("events").arr()
        val end = vector.member("end")
        val phonePosts = vector.member("results").arr().filter { it["expect"]?.str() != TurnRefusal.turnOrder }
        val seat: TurnSeat = if (vector.member("seat").str() == "anon") TurnSeat.Anon("an-installation") else TurnSeat.Bound("a-token")
        val context = body.member("context").arr().map { ContextRead(it.member("name").str(), it.member("input"), it.member("result")) }
        val open = TurnOpen(body.member("turnId").str(), "catalog/2", body.member("question").str(), emptyList(),
            body.member("history").arr().map { TurnLine(it.member("role").str(), it.member("text").str()) }, context,
            context.map { ToolOutcome.Ok("context-${it.name}", it.name, it.result) })
        val batches = events.mapNotNull { frame ->
            when (frame["event"]?.str()) {
                "calls" -> (TurnEvent.of("calls", frame.member("data")) as TurnEvent.Calls).batch
                "snapshot" -> (TurnEvent.of("snapshot", frame.member("data")) as TurnEvent.Snapshot).batch
                else -> null
            }
        }
        val answers = phonePosts.flatMap { post -> post.member("results").arr() }.associate { result ->
            val callId = result.member("callId").str()
            val call = batches.flatMap { it.calls }.first { it.callId == callId }
            callId to if (result.member("ok").bool()) ToolOutcome.Ok(callId, call.name, result.member("result")) else ToolOutcome.Refused(callId, call.name, result.member("code").str())
        }
        val host = EchoHost(open, answers)
        val server = ScriptedServer(events)
        val telemetry = RecordingTelemetry()
        val driver = TurnDriver(server, telemetry, this, elapsedMs = { testScheduler.currentTime })

        val run = async { driver.run(open.turnId, seat, host) }
        advanceUntilIdle()
        if (vector["stop"] != null) {
            assertEquals("stop", server.pending)
            driver.requestStop()
            advanceUntilIdle()
        }

        assertEquals(TurnExit.ended, run.await())
        assertNull(driver.activity.value)
        assertEquals(emptyList<TurnRefusal>(), host.withdrawals)

        val text = events.fold("") { text, frame ->
            when (frame["event"]?.str()) {
                "text" -> text + frame.member("data").member("delta").str()
                "snapshot" -> frame.member("data").member("text").str()
                else -> text
            }
        }
        val silent = vector["phone"]?.str() == "silent"
        val code = end["code"]?.str() ?: if (silent) TurnRefusal.turnOrder else null
        val state = end.member("state").str()
        val closing = events.lastOrNull { it["event"]?.str() == "error" }?.member("data")
        val reset = closing?.get("budgetResetsAtMs")?.long()
        val spent = closing?.get("allowance")?.member("remaining")?.str() == "0.000000000"
        assertEquals(listOf(TurnEnd(TurnState.valueOf(state), text, end["truncated"]?.bool() ?: false, code, reset, spent)), host.ends)

        assertEquals(listOf(body.obj().toMutableMap().apply { put("catalog", Json.of("catalog/2")) }.let { fields -> Json.Obj(fields.toList()) }), server.opened.map { it.json })
        assertEquals(setOf(seat), server.seats.toSet())

        assertEquals(batches.flatMap { it.calls }, host.executed)
        if (silent) assertEquals(batches.map { turnAnswer(it.batch, it.calls.map { call -> ToolOutcome.Ok(call.callId, call.name, call.input) }) }, server.posted)
        else assertEquals(phonePosts.map { Json.objectOf("batch" to it.member("batch"), "results" to it.member("results")) }, server.posted)

        val abilities = context.map { "ability ${it.name} ok" } + batches.flatMap { it.calls }.map { call ->
            "ability ${call.name} ${(answers[call.callId] as? ToolOutcome.Refused)?.code ?: "ok"}"
        }
        val refusals = batches.flatMap { it.calls }.count { answers[it.callId] is ToolOutcome.Refused }
        assertEquals(abilities + "ended $state ${seat.kind} ${code ?: "-"} calls=${abilities.size} refusals=$refusals bytes=${text.encodeToByteArray().size} ms=${testScheduler.currentTime}", telemetry.lines)
        assertEquals(if (vector["stop"] != null) 1 else 0, server.stops)
    }
}

// A server the test writes by hand: one flow for the open and one per resume, one answer per post, and the virtual time of each.
class ManualServer(private val now: () -> Long) : TurnTransport {
    val streams = ArrayDeque<Flow<TurnEvent>>()
    val answers = ArrayDeque<suspend () -> Unit>()
    var stopAnswer: suspend () -> Unit = {}
    val opened = mutableListOf<TurnOpen>()
    val openedAt = mutableListOf<Long>()
    val resumedAt = mutableListOf<Long>()
    val postedAt = mutableListOf<Long>()
    val posted = mutableListOf<Json>()
    var stops = 0

    override fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent> {
        opened += open
        openedAt += now()
        return streams.removeFirst()
    }

    override fun resume(turnId: String, seat: TurnSeat): Flow<TurnEvent> {
        resumedAt += now()
        return streams.removeFirst()
    }

    override suspend fun answer(turnId: String, batch: Int, results: List<ToolOutcome>, seat: TurnSeat) {
        postedAt += now()
        posted += turnAnswer(batch, results)
        answers.removeFirstOrNull()?.invoke()
    }

    override suspend fun stop(turnId: String, seat: TurnSeat) {
        stops += 1
        stopAnswer()
    }
}

class TurnDriverTests {
    private val seat = TurnSeat.Bound("a-token")
    private val lost: Flow<TurnEvent> = flow { throw TurnConnectionLost(null) }
    private val silent: Flow<TurnEvent> = flow { awaitCancellation() }
    private val done = TurnEvent.Done(TurnState.completed, false)
    private val emptyInput = Json.objectOf()

    private fun call(id: String, name: String = "list_things") = ToolCall(id, name, emptyInput)
    private fun calls(batch: Int, vararg calls: ToolCall) = TurnEvent.Calls(TurnBatch(batch, calls.toList()))
    private fun TestScope.server() = ManualServer { testScheduler.currentTime }
    private fun TestScope.driver(server: TurnTransport, telemetry: TurnTelemetry) = TurnDriver(server, telemetry, this, elapsedMs = { testScheduler.currentTime })

    // The room's copy of the answer: every delta, a snapshot's whole text, and nothing outside a turn. The record takes it on its own cadence.
    @Test fun theLiveTextHoldsTheAnswerAtEveryDeltaWhileTheRecordCoalesces() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val server = server().apply { streams += frames.receiveAsFlow() }
        val host = EchoHost()
        val driver = TurnDriver(server, RecordingTelemetry(), this, coalesce = 5.seconds, elapsedMs = { testScheduler.currentTime })
        assertNull(driver.liveText.value)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        assertEquals("", driver.liveText.value)
        frames.send(TurnEvent.Text("Add "))
        runCurrent()
        assertEquals("Add ", driver.liveText.value)
        frames.send(TurnEvent.Text("5 kg."))
        runCurrent()
        assertEquals("Add 5 kg.", driver.liveText.value)
        assertEquals(emptyList<String>(), host.writes)
        advanceTimeBy(5_001)
        assertEquals(listOf("Add 5 kg."), host.writes)
        frames.send(TurnEvent.Snapshot("Replaced.", TurnState.running, null))
        runCurrent()
        assertEquals("Replaced.", driver.liveText.value)
        assertEquals(listOf("Add 5 kg.", "Replaced."), host.writes)
        frames.send(done)
        assertEquals(TurnExit.ended, run.await())
        assertNull(driver.liveText.value)
        assertEquals("Replaced.", host.ends.single().text)
    }

    @Test fun anAbandonLeavesNoLiveText() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("Add ")); awaitCancellation() } }
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, EchoHost()) }
        runCurrent()
        assertEquals("Add ", driver.liveText.value)
        driver.abandon()
        assertNull(driver.liveText.value)
        assertEquals(TurnExit.abandoned, run.await())
        assertNull(driver.liveText.value)
    }

    // A record removed elsewhere ends the turn: the server hears one Stop, and nothing is reported, since nothing is broken.
    @Test fun aRecordGoneEndsTheTurnWithNoReport() = runTest {
        for (fault in listOf<(EchoHost) -> Unit>({ it.executeFault = TurnRecordGone() }, { it.openFault = TurnRecordGone() })) {
            val server = server().apply { streams += flowOf(calls(1, call("c1"))) }
            val host = EchoHost().also(fault)
            val telemetry = RecordingTelemetry()
            assertEquals(TurnExit.ended, driver(server, telemetry).run("tn_1", seat, host))
            advanceUntilIdle()
            assertEquals(listOf(TurnEnd(TurnState.interrupted, "", false, "gone", null)), host.ends)
            assertEquals(1, server.stops)
            assertEquals(listOf("ended interrupted bound gone calls=0 refusals=0 bytes=0 ms=${testScheduler.currentTime}"), telemetry.lines)
        }
    }

    @Test fun aRecordGoneAtATextCommitEndsTheTurnAndAtItsEndIsNoFailure() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("Add ")); awaitCancellation() } }
        val host = EchoHost().apply { writeFault = TurnRecordGone(); endFault = TurnRecordGone() }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf("ended interrupted bound gone calls=0 refusals=0 bytes=4 ms=${testScheduler.currentTime}"), telemetry.lines)
    }

    @Test fun afterAFrameAReconnectReadsAfterOneTwoFourAndEightBeatsAndAFifthLossEndsTheTurn() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); throw TurnConnectionLost(null) }; repeat(4) { streams += lost } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(listOf(0L), server.openedAt)
        assertEquals(listOf(1000L, 3000L, 7000L, 15000L), server.resumedAt)
        assertEquals(TurnExit.ended, run.await())
        assertEquals(emptyList<TurnRefusal>(), host.withdrawals)
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "A", false, "transport", null)), host.ends)
        assertEquals(listOf("ended interrupted bound transport calls=0 refusals=0 bytes=1 ms=15000"), telemetry.lines)
    }

    @Test fun aFifthDropThatIsNoLostConnectionIsReported() = runTest {
        val server = server().apply {
            streams += flow { emit(TurnEvent.Text("A")); throw IOException("Certificate pinning failure") }
            repeat(4) { streams += flow<TurnEvent> { throw IOException("Certificate pinning failure") } }
        }
        val telemetry = RecordingTelemetry()
        val host = EchoHost()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        run.await()
        assertEquals(listOf("failure transport -", "ended interrupted bound transport calls=0 refusals=0 bytes=1 ms=15000"), telemetry.lines)
    }

    // §4.5: an open whose answer was lost may or may not have landed. The same body under the same id settles it, so nothing is lost either way.
    @Test fun untilAFrameArrivesAReconnectOpensAgainWithTheSameBodyOnTheSameBeats() = runTest {
        val host = EchoHost()
        val server = server().apply {
            repeat(3) { streams += lost }
            streams += flowOf(TurnEvent.Snapshot("Add 5 kg.", TurnState.running, null), done)
        }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(0L, 1000L, 3000L, 7000L), server.openedAt)
        assertEquals(List(4) { host.open() }, server.opened)
        assertEquals(emptyList<Long>(), server.resumedAt)
        assertEquals(emptyList<TurnRefusal>(), host.withdrawals)
        assertEquals(listOf(TurnEnd(TurnState.completed, "Add 5 kg.", false, null, null)), host.ends)
        assertEquals(listOf("ended completed bound - calls=0 refusals=0 bytes=9 ms=7000"), telemetry.lines)
        assertEquals(0, server.stops)
    }

    @Test fun theFrameThatArrivesOnAnOpenTurnsTheNextReconnectIntoARead() = runTest {
        val server = server().apply {
            streams += lost
            streams += flow { emit(TurnEvent.Text("A")); throw TurnConnectionLost(null) }
            streams += flowOf(TurnEvent.Snapshot("A B", TurnState.running, null), done)
        }
        val host = EchoHost()
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(0L, 1000L), server.openedAt)
        assertEquals(listOf(3000L), server.resumedAt)
        assertEquals(listOf(TurnEnd(TurnState.completed, "A B", false, null, null)), host.ends)
    }

    @Test fun everyAttemptSaysItIsReconnectingUntilAFrameArrives() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val server = server().apply { repeat(4) { streams += lost }; streams += frames.receiveAsFlow() }
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, EchoHost()) }
        runCurrent()
        val reconnecting = TurnActivity("tn_1", reconnecting = true)
        assertEquals(reconnecting, driver.activity.value)
        for ((wait, attempts) in listOf(1001L to 2, 2000L to 3, 4000L to 4, 8000L to 5)) {
            advanceTimeBy(wait)
            assertEquals(attempts, server.opened.size)
            assertEquals(reconnecting, driver.activity.value)
        }
        frames.trySend(TurnEvent.Snapshot("", TurnState.running, null))
        runCurrent()
        assertEquals(TurnActivity("tn_1", reconnecting = false), driver.activity.value)
        frames.trySend(done)
        assertEquals(TurnExit.ended, run.await())
        assertNull(driver.activity.value)
    }

    // No attempt reached a server: the turn never began, so it goes back to the field. An attempt may have landed with its answer lost, so the server hears one Stop.
    @Test fun everyAttemptLostBeforeAnyFrameWithdrawsAndTellsTheServerOnce() = runTest {
        val cases = listOf<Pair<Exception, List<String>>>(
            TurnConnectionLost(null) to emptyList(),
            IOException("Certificate pinning failure") to listOf("failure transport -"),
        )
        for ((failure, reports) in cases) {
            val server = server().apply { repeat(5) { streams += flow<TurnEvent> { throw failure } } }
            val host = EchoHost()
            val telemetry = RecordingTelemetry()
            val driver = driver(server, telemetry)
            val started = testScheduler.currentTime
            val run = async { driver.run("tn_1", seat, host) }
            advanceUntilIdle()
            assertEquals(TurnExit.withdrawn, run.await())
            assertEquals(listOf(0L, 1000L, 3000L, 7000L, 15000L), server.openedAt.map { it - started })
            assertEquals(emptyList<Long>(), server.resumedAt)
            assertEquals(listOf(TurnRefusal(0, "unreachable", null)), host.withdrawals)
            assertEquals(emptyList<TurnEnd>(), host.ends)
            assertEquals(reports + "withdrawn 0 unreachable ms=15000", telemetry.lines)
            assertEquals(1, server.stops)
            assertNull(driver.activity.value)
        }
    }

    // A first frame no build of this phone can read: no beats help, and the wire fault reports once.
    @Test fun aFaultBeforeAnyFrameWithdrawsAtOnceAndReportsDecodeOnce() = runTest {
        for (kind in listOf(TurnWireFault.unknownEvent, TurnWireFault.lineTooLong)) {
            val server = server().apply { streams += flow<TurnEvent> { throw TurnWireFault(kind) } }
            val host = EchoHost()
            val telemetry = RecordingTelemetry()
            val driver = driver(server, telemetry)
            val started = testScheduler.currentTime
            val run = async { driver.run("tn_1", seat, host) }
            advanceUntilIdle()
            assertEquals(TurnExit.withdrawn, run.await())
            assertEquals(listOf(started), server.openedAt)
            assertEquals(emptyList<Long>(), server.resumedAt)
            assertEquals(listOf(TurnRefusal(0, "unreachable", null)), host.withdrawals)
            assertEquals(emptyList<TurnEnd>(), host.ends)
            assertEquals(listOf("failure decode -", "withdrawn 0 unreachable ms=0"), telemetry.lines)
            assertEquals(1, server.stops)
        }

        val afterALoss = server().apply { streams += lost; streams += flow<TurnEvent> { throw TurnWireFault(TurnWireFault.unknownEvent) } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(afterALoss, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.withdrawn, run.await())
        assertEquals(listOf(TurnRefusal(0, "unreachable", null)), host.withdrawals)
        assertEquals(listOf("failure decode -", "withdrawn 0 unreachable ms=1000"), telemetry.lines)
    }

    // A captive portal's page, or a proxy's interstitial, is a lost connection with a name: the same beats, no report, and the turn ends under that name, taken back when no frame ever came. One plain drop among the losses takes the name away.
    @Test fun aPageThatIsNoStreamReconnectsOnTheBeatsAndTheFifthEndsTheTurnUnderItsOwnName() = runTest {
        val portal: Flow<TurnEvent> = flow { throw TurnConnectionLost(null, notAStream = true) }
        val beforeAnyFrame = server().apply { repeat(5) { streams += portal } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(beforeAnyFrame, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.withdrawn, run.await())
        assertEquals(listOf(0L, 1000L, 3000L, 7000L, 15000L), beforeAnyFrame.openedAt)
        assertEquals(emptyList<Long>(), beforeAnyFrame.resumedAt)
        assertEquals(listOf(TurnRefusal(0, "not-a-stream", null)), host.withdrawals)
        assertEquals(emptyList<TurnEnd>(), host.ends)
        assertEquals(listOf("withdrawn 0 not-a-stream ms=15000"), telemetry.lines)
        assertEquals(1, beforeAnyFrame.stops)

        val started = testScheduler.currentTime
        val afterAFrame = server().apply { streams += flow { emit(TurnEvent.Text("A")); throw TurnConnectionLost(null, notAStream = true) }; repeat(4) { streams += portal } }
        val framed = EchoHost()
        val told = RecordingTelemetry()
        val framedRun = async { driver(afterAFrame, told).run("tn_1", seat, framed) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, framedRun.await())
        assertEquals(listOf(1000L, 3000L, 7000L, 15000L), afterAFrame.resumedAt.map { it - started })
        assertEquals(emptyList<TurnRefusal>(), framed.withdrawals)
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "A", false, "not-a-stream", null)), framed.ends)
        assertEquals(listOf("ended interrupted bound not-a-stream calls=0 refusals=0 bytes=1 ms=15000"), told.lines)
        assertEquals(1, afterAFrame.stops)

        val mixed = server().apply { repeat(4) { streams += portal }; streams += lost }
        val plain = EchoHost()
        val plainTelemetry = RecordingTelemetry()
        val mixedRun = async { driver(mixed, plainTelemetry).run("tn_1", seat, plain) }
        advanceUntilIdle()
        assertEquals(TurnExit.withdrawn, mixedRun.await())
        assertEquals(listOf(TurnRefusal.unreached), plain.withdrawals)
        assertEquals(listOf("withdrawn 0 unreachable ms=15000"), plainTelemetry.lines)
        assertEquals(1, mixed.stops)
    }

    @Test fun aReconnectingTurnSaysSoUntilItsNextFrame() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); throw TurnConnectionLost(null) }; streams += frames.receiveAsFlow() }
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, EchoHost()) }
        runCurrent()
        assertEquals(TurnActivity("tn_1", reconnecting = true), driver.activity.value)
        advanceTimeBy(1001)
        assertEquals(TurnActivity("tn_1", reconnecting = true), driver.activity.value)
        frames.trySend(TurnEvent.Snapshot("A", TurnState.running, null))
        runCurrent()
        assertEquals(TurnActivity("tn_1", reconnecting = false), driver.activity.value)
        frames.trySend(done)
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertNull(driver.activity.value)
    }

    @Test fun aReplacedStreamResumesAndNeverEndsTheTurnBeforeTheFifthTime() = runTest {
        val replaced = TurnEvent.Error(TurnRefusal.streamReplaced, null)
        val server = server().apply {
            streams += flowOf(TurnEvent.Text("A"), replaced)
            streams += flowOf(TurnEvent.Snapshot("A B", TurnState.running, null), done)
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(1000L), server.resumedAt)
        assertEquals(listOf(TurnEnd(TurnState.completed, "A B", false, null, null)), host.ends)
        assertEquals(listOf("ended completed bound - calls=0 refusals=0 bytes=3 ms=1000"), telemetry.lines)

        val fought = server().apply { repeat(5) { streams += flowOf(replaced) } }
        val foughtHost = EchoHost()
        val foughtTelemetry = RecordingTelemetry()
        val foughtRun = async { driver(fought, foughtTelemetry).run("tn_1", seat, foughtHost) }
        advanceUntilIdle()
        foughtRun.await()
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "", false, "transport", null)), foughtHost.ends)
        assertEquals(listOf("failure transport -", "ended interrupted bound transport calls=0 refusals=0 bytes=0 ms=15000"), foughtTelemetry.lines)
    }

    @Test fun aFrameThatCannotBeReadEndsTheTurnWithoutAResume() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); throw TurnWireFault(TurnWireFault.unknownEvent) } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        run.await()
        assertEquals(emptyList<Long>(), server.resumedAt)
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "A", false, "decode", null)), host.ends)
        assertEquals(listOf("failure decode -", "ended interrupted bound decode calls=0 refusals=0 bytes=1 ms=0"), telemetry.lines)
    }

    @Test fun aRefusalBeforeAnyFrameWithdrawsTheTurn() = runTest {
        for ((refusal, failures) in listOf(
            TurnRefusal(426, "client-update-required", null) to emptyList(),
            TurnRefusal(429, "subject_exhausted", 1_793_000_000_000) to emptyList(),
            TurnRefusal(429, "free_month_exhausted", 1_793_000_000_000) to emptyList(),
            TurnRefusal(503, "free_month_exhausted", 1_793_000_000_000) to emptyList(),
            TurnRefusal(503, "coach-rate-limited", null) to emptyList(),
            TurnRefusal(503, "coach-busy", null) to emptyList(),
            TurnRefusal(503, TurnRefusal.vendorError, null) to listOf("failure http 503"),
            TurnRefusal(500, "an unknown thing", null) to listOf("failure http 500"),
        )) {
            val server = server().apply { streams += flow<TurnEvent> { throw refusal } }
            val host = EchoHost()
            val telemetry = RecordingTelemetry()
            val driver = driver(server, telemetry)
            val run = async { driver.run("tn_1", seat, host) }
            advanceUntilIdle()
            assertEquals(TurnExit.withdrawn, run.await())
            assertEquals(listOf(refusal), host.withdrawals)
            assertEquals(emptyList<TurnEnd>(), host.ends)
            assertEquals(emptyList<Long>(), server.resumedAt)
            assertEquals(failures + "withdrawn ${refusal.status} ${TurnLabel.code(refusal.code).value} ms=0", telemetry.lines)
            assertEquals(0, server.stops)
            assertNull(driver.activity.value)
        }
    }

    @Test fun aRefusalAfterAFrameEndsInterruptedWithItsCode() = runTest {
        val refusal = TurnRefusal(409, TurnRefusal.turnOrder, null)
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); throw refusal } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(emptyList<TurnRefusal>(), host.withdrawals)
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "A", false, TurnRefusal.turnOrder, null)), host.ends)
        assertEquals(listOf("ended interrupted bound coach-turn-order calls=0 refusals=0 bytes=1 ms=0"), telemetry.lines)
    }

    @Test fun aRefusalOnAResumeAfterAFrameEndsInterruptedWithItsCode() = runTest {
        val unknown = TurnRefusal(404, TurnRefusal.turnUnknown, null)
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); throw TurnConnectionLost(null) }; streams += flow<TurnEvent> { throw unknown } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(emptyList<TurnRefusal>(), host.withdrawals)
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "A", false, TurnRefusal.turnUnknown, null)), host.ends)
        assertEquals(listOf("ended interrupted bound coach-turn-unknown calls=0 refusals=0 bytes=1 ms=1000"), telemetry.lines)
    }

    // A refusal of an open on any attempt says the turn never began. An earlier attempt may have landed all the same, so the server hears one Stop.
    @Test fun aRefusalOnALaterOpenWithdrawsWithThatRefusalAndA5xxStaysReported() = runTest {
        for ((refusal, failures) in listOf(
            TurnRefusal(426, "client-update-required", null) to emptyList(),
            TurnRefusal(429, "subject_exhausted", 1_793_000_000_000) to emptyList(),
            TurnRefusal(503, "free_month_exhausted", 1_793_000_000_000) to emptyList(),
            TurnRefusal(503, "coach-busy", null) to emptyList(),
            TurnRefusal(503, TurnRefusal.vendorError, null) to listOf("failure http 503"),
        )) {
            val server = server().apply { repeat(2) { streams += lost }; streams += flow<TurnEvent> { throw refusal } }
            val host = EchoHost()
            val telemetry = RecordingTelemetry()
            val driver = driver(server, telemetry)
            val started = testScheduler.currentTime
            val run = async { driver.run("tn_1", seat, host) }
            advanceUntilIdle()
            assertEquals(TurnExit.withdrawn, run.await())
            assertEquals(listOf(0L, 1000L, 3000L), server.openedAt.map { it - started })
            assertEquals(emptyList<Long>(), server.resumedAt)
            assertEquals(listOf(refusal), host.withdrawals)
            assertEquals(emptyList<TurnEnd>(), host.ends)
            assertEquals(failures + "withdrawn ${refusal.status} ${TurnLabel.code(refusal.code).value} ms=3000", telemetry.lines)
            assertEquals(1, server.stops)
            assertNull(driver.activity.value)
        }
    }

    @Test fun aLaterServerFailureIsReportedAndAnUnknownCodeIsBounded() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); throw TurnRefusal(500, "an unknown thing", null) } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        run.await()
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "A", false, "other", null)), host.ends)
        assertEquals(listOf("failure http 500", "ended interrupted bound other calls=0 refusals=0 bytes=1 ms=0"), telemetry.lines)
    }

    @Test fun aLaterBusyServerIsNotAFailure() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); throw TurnRefusal(503, "coach-busy", null) } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        run.await()
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "A", false, "coach-busy", null)), host.ends)
        assertEquals(listOf("ended interrupted bound coach-busy calls=0 refusals=0 bytes=1 ms=0"), telemetry.lines)
    }

    @Test fun anErrorFrameEndsFailedAndCarriesTheResetAndTheBalanceToTheHost() = runTest {
        for (spent in listOf(false, true)) {
            val server = server().apply { streams += flowOf(TurnEvent.Text("A"), TurnEvent.Error("free_month_exhausted", 1_793_000_000_000, spent)) }
            val host = EchoHost()
            val telemetry = RecordingTelemetry()
            val run = async { driver(server, telemetry).run("tn_1", seat, host) }
            advanceUntilIdle()
            run.await()
            assertEquals(listOf(TurnEnd(TurnState.failed, "A", false, "free_month_exhausted", 1_793_000_000_000, spent)), host.ends)
            assertEquals(listOf("ended failed bound free_month_exhausted calls=0 refusals=0 bytes=1 ms=0"), telemetry.lines)
        }
    }

    @Test fun theResultsAreAskedAgainWithTheSameBodyAfterALostAnswer() = runTest {
        val server = server().apply {
            streams += flowOf(calls(1, call("a")), done)
            repeat(3) { answers.addLast { throw TurnConnectionLost(null) } }
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(0L, 1000L, 3000L, 7000L), server.postedAt)
        assertEquals(List(4) { """{"batch":1,"results":[{"callId":"a","ok":true,"result":{}}]}""" }, server.posted.map { it.jcs })
        assertEquals(listOf(call("a")), host.executed)
        assertEquals(listOf(TurnEnd(TurnState.completed, "", false, null, null)), host.ends)
        assertEquals(listOf("ability list_things ok", "ended completed bound - calls=1 refusals=0 bytes=0 ms=7000"), telemetry.lines)
    }

    @Test fun resultsLostAFourthTimeEndTheTurn() = runTest {
        val server = server().apply {
            streams += flow { emit(calls(1, call("a"))); awaitCancellation() }
            repeat(4) { answers.addLast { throw TurnConnectionLost(null) } }
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(0L, 1000L, 3000L, 7000L), server.postedAt)
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "", false, "transport", null)), host.ends)
        assertEquals(listOf("ability list_things ok", "ended interrupted bound transport calls=1 refusals=0 bytes=0 ms=7000"), telemetry.lines)

        val faulty = server().apply {
            streams += flowOf(calls(1, call("a")))
            repeat(4) { answers.addLast { throw IOException("Certificate pinning failure") } }
        }
        val faultyTelemetry = RecordingTelemetry()
        val faultyRun = async { driver(faulty, faultyTelemetry).run("tn_1", seat, EchoHost()) }
        advanceUntilIdle()
        faultyRun.await()
        assertEquals(listOf("ability list_things ok", "failure transport -", "ended interrupted bound transport calls=1 refusals=0 bytes=0 ms=7000"), faultyTelemetry.lines)
    }

    @Test fun refusedResultsAreNotAskedAgain() = runTest {
        for ((refusal, failures) in listOf(TurnRefusal(409, TurnRefusal.turnOrder, null) to emptyList(), TurnRefusal(503, "coach-busy", null) to emptyList(), TurnRefusal(502, TurnRefusal.vendorError, null) to listOf("failure http 502"))) {
            val server = server().apply { streams += flow { emit(calls(1, call("a"))); awaitCancellation() }; answers.addLast { throw refusal } }
            val host = EchoHost()
            val telemetry = RecordingTelemetry()
            val run = async { driver(server, telemetry).run("tn_1", seat, host) }
            advanceUntilIdle()
            run.await()
            assertEquals(listOf(0L), server.postedAt)
            assertEquals(listOf(TurnEnd(TurnState.interrupted, "", false, refusal.code, null)), host.ends)
            assertEquals(listOf("ability list_things ok") + failures + "ended interrupted bound ${refusal.code} calls=1 refusals=0 bytes=0 ms=0", telemetry.lines)
        }
    }

    @Test fun aStopTheServerHeardIsEndedByItsStream() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val server = server().apply { streams += frames.receiveAsFlow() }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        driver.requestStop()
        runCurrent()
        assertEquals(1, server.stops)
        assertEquals(TurnActivity("tn_1", reconnecting = false), driver.activity.value)
        assertEquals(emptyList<TurnEnd>(), host.ends)
        frames.trySend(TurnEvent.Done(TurnState.stopped, false))
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(TurnEnd(TurnState.stopped, "", false, null, null)), host.ends)
    }

    @Test fun aStopThatFindsNoConnectionEndsTheTurnOnThisPhone() = runTest {
        val server = server().apply {
            streams += flow { emit(TurnEvent.Text("Par")); emit(TurnEvent.Text("tial")); awaitCancellation() }
            stopAnswer = { throw TurnConnectionLost(null) }
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        advanceUntilIdle()
        assertEquals(TurnExit.stoppedOffline, run.await())
        assertEquals(listOf(TurnEnd(TurnState.stopped, "Partial", false, null, null)), host.ends)
        assertEquals(emptyList<String>(), host.writes)
        assertEquals(listOf("ended stopped bound - calls=0 refusals=0 bytes=7 ms=0"), telemetry.lines)
        assertNull(driver.activity.value)
    }

    @Test fun aStopTheServerRefusedEndsTheTurnOnThisPhoneAndSaysItWentUnheard() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); awaitCancellation() }; stopAnswer = { throw TurnRefusal(404, TurnRefusal.turnUnknown, null) } }
        val host = EchoHost()
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        advanceUntilIdle()
        assertEquals(TurnExit.stopUnheard, run.await())
        assertEquals(listOf(TurnEnd(TurnState.stopped, "A", false, null, null)), host.ends)
    }

    // A Stop the server did not hear, before any frame: the turn holds only its question, so it goes back to the field at once, and no open follows. The Stop was the one thing the server is told.
    @Test fun aStopUnheardBeforeAnyFrameWithdrawsAtOnceAndNothingMoreGoesOut() = runTest {
        val cases = listOf<Pair<Exception, List<String>>>(
            TurnConnectionLost(null) to emptyList(),
            TurnRefusal(404, TurnRefusal.turnUnknown, null) to emptyList(),
            TurnRefusal(503, "coach-busy", null) to emptyList(),
            TurnRefusal(503, TurnRefusal.vendorError, null) to listOf("failure http 503"),
            IOException("Certificate pinning failure") to listOf("failure transport -"),
            TurnWireFault(TurnWireFault.badAddress) to listOf("failure decode -"),
        )
        for ((failure, reports) in cases) {
            for (during in listOf<ManualServer.() -> Unit>({ streams += lost }, { streams += silent })) {
                val server = server().apply(during).apply { stopAnswer = { throw failure } }
                val host = EchoHost()
                val telemetry = RecordingTelemetry()
                val driver = driver(server, telemetry)
                val started = testScheduler.currentTime
                val run = async { driver.run("tn_1", seat, host) }
                runCurrent()
                driver.requestStop()
                advanceUntilIdle()
                assertEquals(TurnExit.withdrawn, run.await())
                assertEquals(started, testScheduler.currentTime)
                assertEquals(1, server.opened.size)
                assertEquals(emptyList<Long>(), server.resumedAt)
                assertEquals(listOf(TurnRefusal(0, "unreachable", null)), host.withdrawals)
                assertEquals(emptyList<TurnEnd>(), host.ends)
                assertEquals(reports + "withdrawn 0 unreachable ms=0", telemetry.lines)
                assertEquals(1, server.stops)
                assertNull(driver.activity.value)
            }
        }
    }

    // A Stop the server heard means it held the turn, and its stream says how that ended. A reconnect only reads: an open could begin what was stopped.
    @Test fun aStopHeardBeforeAnyFrameIsEndedByTheStreamAReadFinds() = runTest {
        val server = server().apply {
            streams += lost
            streams += flowOf(TurnEvent.Snapshot("", TurnState.stopped, null), TurnEvent.Done(TurnState.stopped, false))
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        runCurrent()
        assertEquals(TurnActivity("tn_1", reconnecting = true), driver.activity.value)
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(0L), server.openedAt)
        assertEquals(listOf(1000L), server.resumedAt)
        assertEquals(1, server.stops)
        assertEquals(emptyList<TurnRefusal>(), host.withdrawals)
        assertEquals(listOf(TurnEnd(TurnState.stopped, "", false, null, null)), host.ends)
        assertEquals(listOf("ended stopped bound - calls=0 refusals=0 bytes=0 ms=1000"), telemetry.lines)
    }

    @Test fun aStopHeardWithEveryReadLostWithdraws() = runTest {
        val server = server().apply { repeat(5) { streams += lost } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        advanceUntilIdle()
        assertEquals(TurnExit.withdrawn, run.await())
        assertEquals(listOf(0L), server.openedAt)
        assertEquals(listOf(1000L, 3000L, 7000L, 15000L), server.resumedAt)
        assertEquals(1, server.stops)
        assertEquals(listOf(TurnRefusal(0, "unreachable", null)), host.withdrawals)
        assertEquals(emptyList<TurnEnd>(), host.ends)
        assertEquals(listOf("withdrawn 0 unreachable ms=15000"), telemetry.lines)
    }

    // A read refused while the Stop is on its way says nothing of the open: the question returns under no connection, whatever its code, and a 5xx stays reported.
    @Test fun aReadRefusedAfterAStopBeforeAnyFrameWithdraws() = runTest {
        for ((refusal, reports) in listOf(TurnRefusal(404, TurnRefusal.turnUnknown, null) to emptyList(), TurnRefusal(503, "coach-busy", null) to emptyList(), TurnRefusal(502, TurnRefusal.vendorError, null) to listOf("failure http 502"))) {
            val heard = CompletableDeferred<Unit>()
            val server = server().apply {
                streams += lost
                streams += flow<TurnEvent> { throw refusal }
                stopAnswer = { heard.await() }
            }
            val host = EchoHost()
            val telemetry = RecordingTelemetry()
            val driver = driver(server, telemetry)
            val run = async { driver.run("tn_1", seat, host) }
            runCurrent()
            driver.requestStop()
            advanceUntilIdle()
            assertEquals(TurnExit.withdrawn, run.await())
            assertEquals(listOf(TurnRefusal(0, "unreachable", null)), host.withdrawals)
            assertEquals(reports + "withdrawn 0 unreachable ms=1000", telemetry.lines)
            heard.complete(Unit)
            advanceUntilIdle()
            assertEquals(1, server.stops)
        }
    }

    // The open in flight when Stop was asked was answered: its refusal is the true reason, so it is the one said.
    @Test fun anOpenRefusedWhileAStopIsOnItsWayWithdrawsWithThatRefusal() = runTest {
        val refusal = TurnRefusal(429, "subject_exhausted", null)
        val answering = CompletableDeferred<Unit>()
        val heard = CompletableDeferred<Unit>()
        val server = server().apply {
            streams += flow<TurnEvent> { answering.await(); throw refusal }
            stopAnswer = { heard.await() }
        }
        val host = EchoHost()
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        runCurrent()
        answering.complete(Unit)
        runCurrent()
        assertEquals(TurnExit.withdrawn, run.await())
        assertEquals(listOf(refusal), host.withdrawals)
        heard.complete(Unit)
    }

    @Test fun aLostStopThatComesAfterTheEndWritesNoSecondEnd() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val release = Channel<Unit>()
        val server = server().apply {
            streams += frames.receiveAsFlow()
            stopAnswer = { release.receive(); throw TurnConnectionLost(null) }
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        runCurrent()
        frames.trySend(done)
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        release.send(Unit)
        advanceUntilIdle()
        assertEquals(listOf(TurnEnd(TurnState.completed, "", false, null, null)), host.ends)
        assertEquals(listOf("ended completed bound - calls=0 refusals=0 bytes=0 ms=0"), telemetry.lines)
    }

    @Test fun aLostStopWhileTheEndIsBeingWrittenLeavesThatEnd() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val release = Channel<Unit>()
        val written = mutableListOf<TurnEnd>()
        val host = object : TurnHost by EchoHost() {
            override suspend fun end(end: TurnEnd) {
                written += end
                release.receive()
            }
        }
        val server = server().apply { streams += frames.receiveAsFlow(); stopAnswer = { throw TurnConnectionLost(null) } }
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        frames.trySend(done)
        runCurrent()
        driver.requestStop()
        runCurrent()
        release.send(Unit)
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(TurnEnd(TurnState.completed, "", false, null, null)), written)
    }

    @Test fun aStopWhileABatchRunsLeavesTheRestUnrunAndUnpostedAndEndsStoppedByTheStream() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        lateinit var driver: TurnDriver
        val server = server().apply {
            streams += frames.receiveAsFlow()
            stopAnswer = { frames.trySend(TurnEvent.Done(TurnState.stopped, false)) }
        }
        val telemetry = RecordingTelemetry()
        val echo = EchoHost()
        val host = object : TurnHost by echo {
            override suspend fun execute(call: ToolCall): ToolOutcome {
                driver.requestStop()
                delay(10)
                return echo.execute(call)
            }
        }
        driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        frames.trySend(calls(1, call("a"), call("b")))
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(call("a")), echo.executed)
        assertEquals(emptyList<Json>(), server.posted)
        assertEquals(listOf(TurnEnd(TurnState.stopped, "", false, null, null)), echo.ends)
        assertEquals(listOf("ability list_things ok", "ended stopped bound - calls=1 refusals=0 bytes=0 ms=10"), telemetry.lines)
    }

    @Test fun resultsTheServerTurnsAwayAfterAStopAreNoFailure() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        lateinit var driver: TurnDriver
        val server = server().apply {
            streams += frames.receiveAsFlow()
            answers.addLast {
                driver.requestStop()
                frames.trySend(TurnEvent.Done(TurnState.stopped, false))
                throw TurnRefusal(409, TurnRefusal.turnOrder, null)
            }
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        frames.trySend(calls(1, call("a")))
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(TurnEnd(TurnState.stopped, "", false, null, null)), host.ends)
        assertEquals(listOf("ability list_things ok", "ended stopped bound - calls=1 refusals=0 bytes=0 ms=0"), telemetry.lines)
    }

    @Test fun resultsLostAfterAStopAreNotAskedAgain() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        lateinit var driver: TurnDriver
        val server = server().apply {
            streams += frames.receiveAsFlow()
            answers.addLast {
                driver.requestStop()
                frames.trySend(TurnEvent.Done(TurnState.stopped, false))
                throw TurnConnectionLost(null)
            }
        }
        val host = EchoHost()
        driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        frames.trySend(calls(1, call("a")))
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(1, server.posted.size)
        assertEquals(listOf(TurnEnd(TurnState.stopped, "", false, null, null)), host.ends)
    }

    @Test fun aBatchArrivingAfterAStopWritesNothing() = runTest {
        val batch = TurnBatch(1, listOf(call("create")))
        for (late in listOf(TurnEvent.Calls(batch), TurnEvent.Snapshot("So far", TurnState.running, batch))) {
            val frames = Channel<TurnEvent>(Channel.UNLIMITED)
            val server = server().apply { streams += frames.receiveAsFlow() }
            val host = EchoHost()
            val driver = driver(server, RecordingTelemetry())
            val run = async { driver.run("tn_1", seat, host) }
            runCurrent()
            driver.requestStop()
            runCurrent()
            frames.trySend(late)
            frames.trySend(TurnEvent.Done(TurnState.stopped, false))
            advanceUntilIdle()
            assertEquals(TurnExit.ended, run.await())
            assertEquals(emptyList<ToolCall>(), host.executed)
            assertEquals(emptyList<Json>(), server.posted)
            assertEquals(TurnState.stopped, host.ends.single().state)
        }
    }

    @Test fun aStopThatFailsIsReportedUnlessTheNetworkOrAClientRefusalSaysWhy() = runTest {
        val cases = listOf<Triple<Exception, TurnExit, List<String>>>(
            Triple(TurnConnectionLost(null), TurnExit.stoppedOffline, emptyList()),
            Triple(TurnRefusal(404, TurnRefusal.turnUnknown, null), TurnExit.stopUnheard, emptyList()),
            Triple(TurnRefusal(503, "coach-busy", null), TurnExit.stopUnheard, emptyList()),
            Triple(TurnRefusal(503, TurnRefusal.vendorError, null), TurnExit.stopUnheard, listOf("failure http 503")),
            Triple(IOException("Certificate pinning failure"), TurnExit.stopUnheard, listOf("failure transport -")),
            Triple(TurnWireFault(TurnWireFault.badAddress), TurnExit.stopUnheard, listOf("failure decode -")),
        )
        for ((failure, exit, reports) in cases) {
            val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); awaitCancellation() }; stopAnswer = { throw failure } }
            val telemetry = RecordingTelemetry()
            val driver = driver(server, telemetry)
            val run = async { driver.run("tn_1", seat, EchoHost()) }
            runCurrent()
            driver.requestStop()
            advanceUntilIdle()
            assertEquals(exit, run.await())
            assertEquals(reports + "ended stopped bound - calls=0 refusals=0 bytes=1 ms=0", telemetry.lines)
        }
    }

    @Test fun aStopLostBeforeTheFollowingStartsStillClosesTheTurn() = runTest {
        val server = server().apply { streams += silent; stopAnswer = { throw TurnConnectionLost(null) } }
        val host = EchoHost()
        val driver = TurnDriver(server, RecordingTelemetry(), CoroutineScope(Dispatchers.Unconfined), elapsedMs = { testScheduler.currentTime })
        val run = async { driver.run("tn_1", seat, host) }
        launch { driver.requestStop() }
        advanceUntilIdle()
        assertEquals(TurnExit.withdrawn, run.await())
        assertEquals(listOf(TurnRefusal(0, "unreachable", null)), host.withdrawals)
        assertEquals(emptyList<TurnEnd>(), host.ends)
    }

    @Test fun abandoningWhileAPortWaitsReportsNothingAndEndsNothing() = runTest {
        val waiting = listOf("open", "execute", "write", "coalesced write", "end", "withdraw", "post", "last post", "stream", "last stream")
        for (port in waiting) {
            val echo = EchoHost()
            val host = object : TurnHost by echo {
                override suspend fun open(): TurnOpen {
                    if (port == "open") awaitCancellation()
                    return echo.open()
                }
                override suspend fun execute(call: ToolCall): ToolOutcome {
                    if (port == "execute") awaitCancellation()
                    return echo.execute(call)
                }
                override suspend fun writeText(text: String) {
                    if (port == "write" || port == "coalesced write") awaitCancellation()
                    echo.writeText(text)
                }
                override suspend fun end(end: TurnEnd) {
                    if (port == "end") awaitCancellation()
                    echo.end(end)
                }
                override suspend fun withdraw(refusal: TurnRefusal) {
                    if (port == "withdraw") awaitCancellation()
                    echo.withdraw(refusal)
                }
            }
            val server = server().apply {
                if (port == "last stream") repeat(4) { streams += lost }
                if (port == "last post") repeat(3) { answers.addLast { throw TurnConnectionLost(null) } }
                streams += when (port) {
                    "end" -> flowOf(done)
                    "withdraw" -> flow<TurnEvent> { throw TurnRefusal(429, "subject_exhausted", null) }
                    "stream", "last stream", "open" -> silent
                    "coalesced write" -> flow { emit(TurnEvent.Text("A")); awaitCancellation() }
                    else -> flow { emit(TurnEvent.Text("A")); emit(calls(1, call("a"))); awaitCancellation() }
                }
                answers.addLast { awaitCancellation() }
            }
            val telemetry = RecordingTelemetry()
            val driver = driver(server, telemetry)
            val run = async { driver.run("tn_1", seat, host) }
            advanceTimeBy(20_000)
            driver.abandon()
            advanceUntilIdle()
            assertEquals(port, TurnExit.abandoned, run.await())
            assertEquals(port, emptyList<TurnEnd>(), echo.ends)
            assertEquals(port, emptyList<TurnRefusal>(), echo.withdrawals)
            assertEquals(port, emptyList<String>(), telemetry.lines.filterNot { it.startsWith("ability") })
            assertEquals(port, 1, server.stops)
        }
    }

    @Test fun theDriversOwnScopeEndingUnderAStopIsNoFailure() = runTest {
        val server = server().apply { streams += silent; stopAnswer = { awaitCancellation() } }
        val stops = CoroutineScope(coroutineContext + Job())
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val driver = TurnDriver(server, telemetry, stops, elapsedMs = { testScheduler.currentTime })
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        runCurrent()
        stops.cancel()
        runCurrent()
        assertEquals(TurnActivity("tn_1", reconnecting = false), driver.activity.value)
        assertEquals(emptyList<String>(), telemetry.lines)
        driver.abandon()
        advanceUntilIdle()
        assertEquals(TurnExit.abandoned, run.await())
        assertEquals(emptyList<TurnEnd>(), host.ends)
    }

    @Test fun abandoningDuringThePhoneOnlyStopWritesNothingMore() = runTest {
        val written = mutableListOf<TurnEnd>()
        val release = Channel<Unit>()
        val host = object : TurnHost by EchoHost() {
            override suspend fun end(end: TurnEnd) {
                release.receive()
                written += end
            }
        }
        val server = server().apply { streams += flow { emit(TurnEvent.Text("A")); awaitCancellation() }; stopAnswer = { throw TurnConnectionLost(null) } }
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        runCurrent()
        driver.abandon()
        runCurrent()
        release.trySend(Unit)
        advanceUntilIdle()
        assertEquals(TurnExit.abandoned, run.await())
        assertEquals(emptyList<TurnEnd>(), written)
    }

    @Test fun aCommitThatOutlivesAnAbandonIsTheCallersToReRead() = runTest {
        val written = mutableListOf<TurnEnd>()
        val host = object : TurnHost by EchoHost() {
            override suspend fun end(end: TurnEnd) {
                withContext(NonCancellable) {
                    delay(10)
                    written += end
                }
                delay(1)
            }
        }
        val server = server().apply { streams += flowOf(done) }
        val telemetry = RecordingTelemetry()
        val driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.abandon()
        advanceUntilIdle()
        assertEquals(TurnExit.abandoned, run.await())
        assertEquals(listOf(TurnEnd(TurnState.completed, "", false, null, null)), written)
        assertEquals(emptyList<String>(), telemetry.lines)
    }

    @Test fun abandoningWritesNothingAndTellsTheServerOnce() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("Unsaid")); awaitCancellation() } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val driver = driver(server, telemetry)
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.abandon()
        driver.abandon()
        driver.requestStop()
        assertNull(driver.activity.value)
        advanceUntilIdle()
        assertEquals(TurnExit.abandoned, run.await())
        assertEquals(1, server.stops)
        assertEquals(emptyList<TurnEnd>(), host.ends)
        assertEquals(emptyList<String>(), host.writes)
        assertEquals(emptyList<TurnRefusal>(), host.withdrawals)
        assertEquals(emptyList<String>(), telemetry.lines)
    }

    @Test fun abandoningAfterAStopAskedTellsTheServerNoSecondTimeAndAnUnheardStopChangesNothing() = runTest {
        val server = server().apply { streams += silent; stopAnswer = { throw TurnConnectionLost(null) } }
        val host = EchoHost()
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        driver.abandon()
        advanceUntilIdle()
        assertEquals(TurnExit.abandoned, run.await())
        assertEquals(1, server.stops)
        assertEquals(emptyList<TurnEnd>(), host.ends)
    }

    @Test fun abandoningRightAfterALostStopStillWritesNothing() = runTest {
        val server = server().apply { streams += silent; stopAnswer = { throw TurnConnectionLost(null) } }
        val host = EchoHost()
        val driver = driver(server, RecordingTelemetry())
        val run = async { driver.run("tn_1", seat, host) }
        runCurrent()
        driver.requestStop()
        launch { driver.abandon() }
        advanceUntilIdle()
        assertEquals(TurnExit.abandoned, run.await())
        assertEquals(emptyList<TurnEnd>(), host.ends)
    }

    @Test fun abandoningLeavesAFreshTurnFree() = runTest {
        val server = server().apply { streams += silent; streams += flowOf(done) }
        val driver = driver(server, RecordingTelemetry())
        val first = async { driver.run("tn_1", seat, EchoHost()) }
        runCurrent()
        driver.abandon()
        val second = async { driver.run("tn_2", seat, EchoHost()) }
        advanceUntilIdle()
        assertEquals(TurnExit.abandoned, first.await())
        assertEquals(TurnExit.ended, second.await())
        assertNull(driver.activity.value)
    }

    @Test fun cancellingTheCallerPassesThroughAndWritesNothing() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("Unsaid")); awaitCancellation() } }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val driver = driver(server, telemetry)
        val run = launch { driver.run("tn_1", seat, host) }
        runCurrent()
        run.cancelAndJoin()
        advanceUntilIdle()
        assertEquals(0, server.stops)
        assertEquals(emptyList<TurnEnd>(), host.ends)
        assertEquals(emptyList<String>(), host.writes)
        assertEquals(emptyList<String>(), telemetry.lines)
        assertNull(driver.activity.value)
    }

    @Test fun aForeignCancellationFromAPortIsThatPortsFailure() = runTest {
        val cancelled = CancellationException("the scope went away")
        val cases = listOf<Triple<ManualServer.() -> Unit, EchoHost.() -> Unit, List<String>>>(
            Triple({ streams += flow { emit(TurnEvent.Text("A")); throw cancelled }; repeat(4) { streams += flow<TurnEvent> { throw cancelled } } }, {},
                listOf("failure transport -", "ended interrupted bound transport calls=0 refusals=0 bytes=1 ms=15000")),
            Triple({ streams += flowOf(calls(1, call("a"))); repeat(4) { answers.addLast { throw cancelled } } }, {},
                listOf("ability list_things ok", "failure transport -", "ended interrupted bound transport calls=1 refusals=0 bytes=0 ms=7000")),
            Triple({ streams += flowOf(calls(1, call("a"))) }, { executeFault = cancelled },
                listOf("failure storage -", "ended interrupted bound storage calls=0 refusals=0 bytes=0 ms=0")),
            Triple({ streams += flowOf(TurnEvent.Snapshot("A", TurnState.running, null)) }, { writeFault = cancelled },
                listOf("failure storage -", "ended interrupted bound storage calls=0 refusals=0 bytes=1 ms=0")),
            Triple({}, { openFault = cancelled },
                listOf("failure storage -", "ended interrupted bound storage calls=0 refusals=0 bytes=0 ms=0")),
            Triple({ streams += flowOf(done) }, { endFault = cancelled },
                listOf("failure storage -", "ended completed bound - calls=0 refusals=0 bytes=0 ms=0")),
        )
        for ((serve, broken, lines) in cases) {
            val server = server().apply(serve)
            val telemetry = RecordingTelemetry()
            val driver = driver(server, telemetry)
            val run = async { driver.run("tn_1", seat, EchoHost().apply(broken)) }
            advanceUntilIdle()
            assertEquals(TurnExit.ended, run.await())
            assertEquals(lines, telemetry.lines)
            assertNull(driver.activity.value)
        }
    }

    @Test fun aForeignCancellationFromAWithdrawalOrAStopIsThatPortsFailure() = runTest {
        val cancelled = CancellationException("the scope went away")
        val refused = server().apply { streams += flow<TurnEvent> { throw TurnRefusal(429, "subject_exhausted", null) } }
        val refusedTelemetry = RecordingTelemetry()
        val refusedRun = async { driver(refused, refusedTelemetry).run("tn_1", seat, EchoHost().apply { withdrawFault = cancelled }) }
        advanceUntilIdle()
        assertEquals(TurnExit.withdrawn, refusedRun.await())
        assertEquals(listOf("failure storage -", "withdrawn 429 subject_exhausted ms=0"), refusedTelemetry.lines)

        val stopped = server().apply { streams += flow { emit(TurnEvent.Text("A")); awaitCancellation() }; stopAnswer = { throw cancelled } }
        val stoppedTelemetry = RecordingTelemetry()
        val stoppedDriver = driver(stopped, stoppedTelemetry)
        val stoppedRun = async { stoppedDriver.run("tn_1", seat, EchoHost()) }
        runCurrent()
        stoppedDriver.requestStop()
        advanceUntilIdle()
        assertEquals(TurnExit.stopUnheard, stoppedRun.await())
        assertEquals(listOf("failure transport -", "ended stopped bound - calls=0 refusals=0 bytes=1 ms=0"), stoppedTelemetry.lines)
    }

    @Test fun aHostsOwnTimeoutOrCancelledWorkStillEndsAndReportsTheTurn() = runTest {
        val faults = listOf<suspend () -> Unit>({ withTimeout(5) { awaitCancellation() } }, { CompletableDeferred<Unit>().apply { cancel() }.await() })
        for (fault in faults) {
            val server = server().apply { streams += flowOf(TurnEvent.Text("A"), calls(1, call("a")), done) }
            val echo = EchoHost()
            val host = object : TurnHost by echo {
                override suspend fun execute(call: ToolCall): ToolOutcome { fault(); error("unreachable") }
            }
            val telemetry = RecordingTelemetry()
            val start = testScheduler.currentTime
            val run = async { driver(server, telemetry).run("tn_1", seat, host) }
            advanceUntilIdle()
            assertEquals(TurnExit.ended, run.await())
            assertEquals(listOf(TurnEnd(TurnState.interrupted, "A", false, "storage", null)), echo.ends)
            assertEquals(listOf("failure storage -", "ended interrupted bound storage calls=0 refusals=0 bytes=1 ms=${testScheduler.currentTime - start}"), telemetry.lines)
        }
    }

    @Test fun aHostsOwnCancellationOnACoalescedCommitDoesNotSilenceLaterCommits() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val server = server().apply { streams += frames.receiveAsFlow() }
        val writes = mutableListOf<String>()
        var failNext = true
        val host = object : TurnHost by EchoHost() {
            override suspend fun writeText(text: String) {
                if (failNext) {
                    failNext = false
                    withTimeout(1) { awaitCancellation() }
                }
                writes += text
            }
        }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        runCurrent()
        frames.trySend(TurnEvent.Text("A"))
        advanceTimeBy(300)
        frames.trySend(TurnEvent.Text("B"))
        advanceTimeBy(300)
        assertEquals(listOf("AB"), writes)
        frames.trySend(done)
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf("failure storage -", "ended completed bound - calls=0 refusals=0 bytes=2 ms=600"), telemetry.lines)
    }

    @Test fun aCommitThatKeepsFailingIsReportedOnce() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val server = server().apply { streams += frames.receiveAsFlow() }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, EchoHost().apply { writeFault = IllegalStateException("disk") }) }
        runCurrent()
        repeat(40) {
            frames.trySend(TurnEvent.Text("x"))
            advanceTimeBy(251)
        }
        frames.trySend(done)
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf("failure storage -", "ended completed bound - calls=0 refusals=0 bytes=40 ms=10040"), telemetry.lines)
    }

    @Test fun aRecordRefusingACoalescedCommitEndsTheTurn() = runTest {
        val server = server().apply { streams += flow { emit(TurnEvent.Text("x")); awaitCancellation() } }
        val host = EchoHost().apply { writeFault = TurnRecordRefused() }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "x", false, "refusal", null)), host.ends)
        assertEquals(listOf("failure refusal -", "ended interrupted bound refusal calls=0 refusals=0 bytes=1 ms=250"), telemetry.lines)
    }

    @Test fun aRefusedEndIsReportedAsARefusal() = runTest {
        val server = server().apply { streams += flowOf(done) }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, EchoHost().apply { endFault = TurnRecordRefused() }) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf("failure refusal -", "ended completed bound - calls=0 refusals=0 bytes=0 ms=0"), telemetry.lines)
    }

    @Test fun aWireFaultOnAPostIsDecodeAndIsNotRetried() = runTest {
        val server = server().apply {
            streams += flow { emit(calls(1, call("a"))); awaitCancellation() }
            repeat(4) { answers.addLast { throw TurnWireFault(TurnWireFault.badAddress) } }
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(0L), server.postedAt)
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "", false, "decode", null)), host.ends)
        assertEquals(listOf("ability list_things ok", "failure decode -", "ended interrupted bound decode calls=1 refusals=0 bytes=0 ms=0"), telemetry.lines)
    }

    @Test fun aTurnThisPhoneEndsTellsTheServerOnce() = runTest {
        val cases = listOf<Pair<ManualServer.() -> Unit, EchoHost.() -> Unit>>(
            Pair({ streams += flow { emit(TurnEvent.Text("A")); throw TurnWireFault(TurnWireFault.unknownEvent) } }, {}),
            Pair({ streams += flowOf(calls(1, call("a"))) }, { executeFault = IllegalStateException("disk") }),
            Pair({ streams += flow { emit(calls(1, call("a"))); awaitCancellation() }; answers.addLast { throw TurnRefusal(400, "coach-bad-request", null) } }, {}),
            Pair({ streams += flow { emit(calls(1, call("a"))); awaitCancellation() }; repeat(4) { answers.addLast { throw TurnConnectionLost(null) } } }, {}),
            Pair({ streams += flow { emit(TurnEvent.Text("A")); throw TurnConnectionLost(null) }; repeat(4) { streams += lost }; stopAnswer = { throw TurnConnectionLost(null) } }, {}),
            Pair({}, { openFault = IllegalStateException("disk") }),
            Pair({ streams += flow { emit(TurnEvent.Text("A")); awaitCancellation() } }, { writeFault = TurnRecordRefused() }),
        )
        for ((serve, broken) in cases) {
            val server = server().apply(serve)
            val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, EchoHost().apply(broken)) }
            advanceUntilIdle()
            assertEquals(TurnExit.ended, run.await())
            assertEquals(1, server.stops)
        }
    }

    @Test fun aTurnTheServerRefusedAsOutOfOrderOrUnknownOrClosedItselfIsNotTold() = runTest {
        val cases = listOf<ManualServer.() -> Unit>(
            { streams += flow { emit(calls(1, call("a"))); awaitCancellation() }; answers.addLast { throw TurnRefusal(409, TurnRefusal.turnOrder, null) } },
            { streams += flow { emit(TurnEvent.Text("A")); throw TurnConnectionLost(null) }; streams += flow<TurnEvent> { throw TurnRefusal(404, TurnRefusal.turnUnknown, null) } },
            { streams += flowOf(done) },
            { streams += flowOf(TurnEvent.Error("coach-vendor-error", null)) },
            { streams += flow<TurnEvent> { throw TurnRefusal(429, "subject_exhausted", null) } },
        )
        for (serve in cases) {
            val server = server().apply(serve)
            val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, EchoHost()) }
            advanceUntilIdle()
            run.await()
            assertEquals(0, server.stops)
        }
    }

    @Test fun textLandsInCoalescedCommits() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val server = server().apply { streams += frames.receiveAsFlow() }
        val host = EchoHost()
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        runCurrent()
        for (word in listOf("one ", "two ", "three ")) {
            frames.trySend(TurnEvent.Text(word))
            advanceTimeBy(100)
        }
        assertEquals(listOf("one two three "), host.writes)
        advanceTimeBy(1000)
        assertEquals(listOf("one two three "), host.writes)
        frames.trySend(TurnEvent.Text("four"))
        advanceTimeBy(249)
        assertEquals(listOf("one two three "), host.writes)
        advanceTimeBy(2)
        assertEquals(listOf("one two three ", "one two three four"), host.writes)
        frames.trySend(done)
        advanceUntilIdle()
        run.await()
        assertEquals(listOf("one two three ", "one two three four"), host.writes)
        assertEquals("one two three four", host.ends.single().text)
    }

    @Test fun aPendingCommitLandsBeforeABatchRuns() = runTest {
        val order = mutableListOf<String>()
        val host = object : TurnHost {
            override suspend fun open() = TurnOpen("tn_1", "catalog/2", "Hi", emptyList(), emptyList(), emptyList(), emptyList())
            override suspend fun execute(call: ToolCall): ToolOutcome { order += "execute"; return ToolOutcome.Ok(call.callId, call.name, call.input) }
            override suspend fun writeText(text: String) { order += "write $text" }
            override suspend fun end(end: TurnEnd) { order += "end ${end.text}" }
            override suspend fun withdraw(refusal: TurnRefusal) { order += "withdraw" }
        }
        val server = server().apply { streams += flowOf(TurnEvent.Text("Looking."), calls(1, call("a")), TurnEvent.Text(" Found."), done) }
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        advanceUntilIdle()
        run.await()
        assertEquals(listOf("write Looking.", "execute", "end Looking. Found."), order)
    }

    @Test fun aPendingCommitIsNotLostAtTheEndAndNoCommitFollowsIt() = runTest {
        val server = server().apply { streams += flowOf(TurnEvent.Text("All of it"), done) }
        val host = EchoHost()
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        advanceUntilIdle()
        run.await()
        advanceTimeBy(1000)
        assertEquals(emptyList<String>(), host.writes)
        assertEquals("All of it", host.ends.single().text)
    }

    @Test fun aSnapshotReplacesTheTextAndTheFrameAfterATerminalOneEndsTheTurn() = runTest {
        val server = server().apply {
            streams += flow { emit(TurnEvent.Text("Par")); throw TurnConnectionLost(null) }
            streams += flowOf(TurnEvent.Snapshot("Partial and whole", TurnState.declined, null), TurnEvent.Done(TurnState.declined, false))
        }
        val host = EchoHost()
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf("Par", "Partial and whole"), host.writes)
        assertEquals(listOf(TurnEnd(TurnState.declined, "Partial and whole", false, null, null)), host.ends)
    }

    private fun resumeOf(bytes: String): Flow<TurnEvent> = flow {
        for (event in TurnSse().consume(bytes.encodeToByteArray())) {
            emit(event)
            if (event.closing) return@flow
        }
        throw TurnConnectionLost(null)
    }

    @Test fun aResumedFailedTurnKeepsItsCodeAndMoment() = runTest {
        val wire = "event: snapshot\ndata: {\"state\":\"failed\",\"text\":\"\"}\n\nevent: error\ndata: {\"budgetResetsAtMs\":1701388800000,\"code\":\"free_month_exhausted\"}\n\n"
        val server = server().apply { streams += lost; streams += resumeOf(wire) }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(TurnEnd(TurnState.failed, "", false, "free_month_exhausted", 1_701_388_800_000)), host.ends)
        assertEquals(listOf("ended failed bound free_month_exhausted calls=0 refusals=0 bytes=0 ms=1000"), telemetry.lines)
    }

    @Test fun aResumedTruncatedTurnStaysTruncated() = runTest {
        val wire = "event: snapshot\ndata: {\"state\":\"completed\",\"text\":\"Cut\"}\n\nevent: done\ndata: {\"state\":\"completed\",\"truncated\":true}\n\n"
        val server = server().apply { streams += lost; streams += resumeOf(wire) }
        val host = EchoHost()
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(TurnEnd(TurnState.completed, "Cut", true, null, null)), host.ends)
    }

    @Test fun aTerminalSnapshotRunsNoBatch() = runTest {
        val server = server().apply {
            streams += lost
            streams += flowOf(TurnEvent.Snapshot("Over", TurnState.completed, TurnBatch(1, listOf(call("a")))), done)
        }
        val host = EchoHost()
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(emptyList<ToolCall>(), host.executed)
        assertEquals(emptyList<Json>(), server.posted)
    }

    @Test fun aTerminalSnapshotCutOffFromItsClosingFrameIsADrop() = runTest {
        val cut = TurnEvent.Snapshot("Cut", TurnState.completed, null)
        val server = server().apply { streams += lost; streams += flowOf(cut); streams += flowOf(cut, TurnEvent.Done(TurnState.completed, true)) }
        val host = EchoHost()
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(0L, 1000L), server.openedAt)
        assertEquals(listOf(3000L), server.resumedAt)
        assertEquals(listOf(TurnEnd(TurnState.completed, "Cut", true, null, null)), host.ends)
    }

    @Test fun textAroundAResumeIsCountedOnce() = runTest {
        val server = server().apply {
            streams += flow { emit(TurnEvent.Text("Жим ")); emit(TurnEvent.Text("")); throw TurnConnectionLost(null) }
            streams += flowOf(TurnEvent.Snapshot("Жим 100", TurnState.running, null), TurnEvent.Text(" кг 💪"), done)
        }
        val host = EchoHost()
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        run.await()
        assertEquals("Жим 100 кг 💪", host.ends.single().text)
        assertEquals(listOf("ended completed bound - calls=0 refusals=0 bytes=${"Жим 100 кг 💪".encodeToByteArray().size} ms=1000"), telemetry.lines)
    }

    @Test fun aPostLostOnADroppedStreamIsAskedAgainAndTheBatchRunsOnce() = runTest {
        val server = server().apply {
            streams += flow { emit(calls(1, call("a"))); throw TurnConnectionLost(null) }
            streams += flowOf(TurnEvent.Snapshot("", TurnState.running, null), done)
            answers.addLast { throw TurnConnectionLost(null) }
        }
        val host = EchoHost()
        val run = async { driver(server, RecordingTelemetry()).run("tn_1", seat, host) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(call("a")), host.executed)
        assertEquals(2, server.posted.size)
        assertEquals(listOf(TurnEnd(TurnState.completed, "", false, null, null)), host.ends)
    }

    @Test fun aHostFaultEndsTheTurnInterruptedWithStorage() = runTest {
        val fault = IllegalStateException("A sentence that must not travel")
        val cases = listOf<Triple<ManualServer.() -> Unit, EchoHost.() -> Unit, TurnEnd>>(
            Triple({}, { openFault = fault }, TurnEnd(TurnState.interrupted, "", false, "storage", null)),
            Triple({ streams += flowOf(TurnEvent.Text("A"), calls(1, call("a"))) }, { executeFault = fault }, TurnEnd(TurnState.interrupted, "A", false, "storage", null)),
            Triple({ streams += flowOf(TurnEvent.Text("A"), calls(1, call("a"))) }, { writeFault = fault }, TurnEnd(TurnState.interrupted, "A", false, "storage", null)),
            Triple({ streams += flowOf(TurnEvent.Snapshot("A", TurnState.running, null)) }, { writeFault = fault }, TurnEnd(TurnState.interrupted, "A", false, "storage", null)),
        )
        for ((serve, broken, end) in cases) {
            val server = server().apply(serve)
            val host = EchoHost().apply(broken)
            val telemetry = RecordingTelemetry()
            val run = async { driver(server, telemetry).run("tn_1", seat, host) }
            advanceUntilIdle()
            assertEquals(TurnExit.ended, run.await())
            assertEquals(listOf(end), host.ends)
            assertEquals(emptyList<ToolCall>(), host.executed)
            assertEquals(emptyList<Long>(), server.resumedAt)
            assertEquals(listOf("failure storage -", "ended interrupted bound storage calls=0 refusals=0 bytes=${end.text.length} ms=0"), telemetry.lines)
        }
    }

    @Test fun theTurnsOwnRecordRefusingItEndsTheTurnWithRefusal() = runTest {
        val server = server().apply { streams += flowOf(calls(1, call("a"))) }
        val host = EchoHost().apply { executeFault = TurnRecordRefused() }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        advanceUntilIdle()
        run.await()
        assertEquals(listOf(TurnEnd(TurnState.interrupted, "", false, "refusal", null)), host.ends)
        assertEquals(listOf("failure refusal -", "ended interrupted bound refusal calls=0 refusals=0 bytes=0 ms=0"), telemetry.lines)
    }

    @Test fun aCommitThatFailsBetweenFramesIsReportedAndTheStreamGoesOn() = runTest {
        val frames = Channel<TurnEvent>(Channel.UNLIMITED)
        val server = server().apply { streams += frames.receiveAsFlow() }
        val host = EchoHost().apply { writeFault = IllegalStateException("disk") }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", seat, host) }
        runCurrent()
        frames.trySend(TurnEvent.Text("A"))
        advanceTimeBy(251)
        assertEquals(listOf("failure storage -"), telemetry.lines)
        assertEquals(emptyList<TurnEnd>(), host.ends)
        host.writeFault = null
        frames.trySend(TurnEvent.Text("B"))
        advanceTimeBy(251)
        assertEquals(listOf("AB"), host.writes)
        frames.trySend(done)
        advanceUntilIdle()
        assertEquals(TurnExit.ended, run.await())
        assertEquals(listOf(TurnEnd(TurnState.completed, "AB", false, null, null)), host.ends)
    }

    @Test fun anEndOrAWithdrawalTheStoreLosesIsReportedAndTheTurnIsOverAllTheSame() = runTest {
        val ended = server().apply { streams += flowOf(done) }
        val endTelemetry = RecordingTelemetry()
        val endDriver = driver(ended, endTelemetry)
        val endRun = async { endDriver.run("tn_1", seat, EchoHost().apply { endFault = IllegalStateException("disk") }) }
        advanceUntilIdle()
        assertEquals(TurnExit.ended, endRun.await())
        assertEquals(listOf("failure storage -", "ended completed bound - calls=0 refusals=0 bytes=0 ms=0"), endTelemetry.lines)
        assertNull(endDriver.activity.value)

        val refused = server().apply { streams += flow<TurnEvent> { throw TurnRefusal(429, "subject_exhausted", null) } }
        val refusedTelemetry = RecordingTelemetry()
        val refusedRun = async { driver(refused, refusedTelemetry).run("tn_1", seat, EchoHost().apply { withdrawFault = IllegalStateException("disk") }) }
        advanceUntilIdle()
        assertEquals(TurnExit.withdrawn, refusedRun.await())
        assertEquals(listOf("failure storage -", "withdrawn 429 subject_exhausted ms=0"), refusedTelemetry.lines)
    }

    @Test fun everyAbilityIsToldAndCountedContextOutcomesFirst() = runTest {
        val open = TurnOpen("tn_1", "catalog/2", "Hi", emptyList(), emptyList(), emptyList(), listOf(
            ToolOutcome.Ok("context-list_a", "list_a", emptyInput),
            ToolOutcome.Refused("context-list_b", "list_b", "result-too-large"),
        ))
        val answers = mapOf<String, ToolOutcome>("b" to ToolOutcome.Refused("b", "save_thing", "record-dead"))
        val host = EchoHost(open, answers)
        val server = server().apply {
            streams += flowOf(TurnEvent.Text("Жим "), calls(1, call("a", "get_thing"), call("b", "save_thing")), calls(2, call("c", "get_thing")), TurnEvent.Text("💪"), done)
        }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", TurnSeat.Anon("an-installation"), host) }
        advanceUntilIdle()
        run.await()
        assertEquals(listOf(
            "ability list_a ok",
            "ability list_b result-too-large",
            "ability get_thing ok",
            "ability save_thing record-dead",
            "ability get_thing ok",
            "ended completed anon - calls=5 refusals=1 bytes=11 ms=0",
        ), telemetry.lines)
        assertEquals(listOf(
            """{"batch":1,"results":[{"callId":"a","ok":true,"result":{}},{"callId":"b","code":"record-dead","ok":false}]}""",
            """{"batch":2,"results":[{"callId":"c","ok":true,"result":{}}]}""",
        ), server.posted.map { it.jcs })
    }

    @Test fun telemetryCannotCarryTextByItsParameterTypes() = runTest {
        assertEquals(setOf(TurnLabel::class.java, TurnState::class.java, SeatKind::class.java, TurnTally::class.java, TurnFailure::class.java,
            Int::class.javaPrimitiveType, Long::class.javaPrimitiveType, Int::class.javaObjectType),
            TurnTelemetry::class.java.declaredMethods.flatMap { it.parameterTypes.toList() }.toSet())
        assertEquals(emptyList<Any>(), TurnLabel::class.java.constructors.filterNot { it.isSynthetic })
        assertEquals(setOf(Int::class.javaPrimitiveType), TurnTally::class.java.declaredFields.map { it.type }.toSet())

        val secrets = listOf("A private question", "A private answer", "private input", "private result", "a-private-token")
        val open = TurnOpen("tn_1", "catalog/2", secrets[0], emptyList(), emptyList(), emptyList(), emptyList())
        val call = ToolCall("a", secrets[2], Json.objectOf("x" to Json.of(secrets[2])))
        val host = EchoHost(open, mapOf("a" to ToolOutcome.Refused("a", secrets[2], secrets[3])))
        val server = server().apply { streams += flowOf(TurnEvent.Text(secrets[1]), calls(1, call), TurnEvent.Error(secrets[0], null)) }
        val telemetry = RecordingTelemetry()
        val run = async { driver(server, telemetry).run("tn_1", TurnSeat.Bound(secrets[4]), host) }
        advanceUntilIdle()
        run.await()
        assertEquals(listOf("ability other other", "ended failed bound other calls=1 refusals=1 bytes=${secrets[1].length} ms=0"), telemetry.lines)
    }

    @Test fun racesOnRealThreadsKeepEveryInvariant() {
        val pool = Executors.newFixedThreadPool(4).asCoroutineDispatcher()
        val scope = CoroutineScope(SupervisorJob() + pool)
        val iterations = System.getenv("TURN_STRESS_ITERATIONS")?.toInt() ?: 2000
        val broken = Collections.synchronizedList(mutableListOf<String>())
        runBlocking(pool) {
            repeat(iterations) { index ->
                val frames = Channel<TurnEvent>(Channel.UNLIMITED)
                val server = ManualServer { 0L }.apply {
                    streams += frames.receiveAsFlow()
                    stopAnswer = { if (index % 2 == 0) throw TurnConnectionLost(null) }
                }
                val driver = TurnDriver(server, RecordingTelemetry(), scope, elapsedMs = { 0L })
                val host = EchoHost()
                val gate = CountDownLatch(1)
                val runner = async { gate.await(); driver.run("tn_$index", seat, host) }
                val abandoner = launch { gate.await(); if (index % 3 != 2) driver.abandon() }
                val stopper = launch { gate.await(); if (index % 3 != 1) driver.requestStop() }
                val ender = launch { gate.await(); frames.trySend(TurnEvent.Done(TurnState.completed, false)) }
                gate.countDown()
                val late = launch { delay(1); driver.abandon() }
                val exit = withTimeout(60_000) { runner.await() }
                abandoner.join(); stopper.join(); ender.join(); late.join()
                if (driver.activity.value != null) broken += "$index left its activity"
                val closes = host.ends.size + host.withdrawals.size
                if (closes > 1) broken += "$index closed twice"
                if (exit == TurnExit.abandoned && closes != 0) broken += "$index abandoned wrote"
                if (exit != TurnExit.abandoned && closes == 0) broken += "$index $exit wrote nothing"
            }
        }
        scope.cancel()
        pool.close()
        assertEquals(emptyList<String>(), broken)
    }

    @Test fun aDriverRunsOneTurnAtATime() = runTest {
        val server = server().apply { streams += silent }
        val driver = driver(server, RecordingTelemetry())
        val first = async { driver.run("tn_1", seat, EchoHost()) }
        runCurrent()
        assertTrue(runCatching { driver.run("tn_2", seat, EchoHost()) }.exceptionOrNull() is IllegalStateException)
        assertEquals(TurnActivity("tn_1", reconnecting = false), driver.activity.value)
        driver.abandon()
        advanceUntilIdle()
        assertEquals(TurnExit.abandoned, first.await())
        assertEquals(1, server.stops)
    }
}
