package works.windmill.agent

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

// The fixed sequence of one turn (§4): open the stream, land the answer's text in coalesced commits, run each batch through the host and post its results, reconnect after a drop, and end. A product supplies the host; `scope` outlives the turn and carries the stop requests.
class TurnDriver(
    private val transport: TurnTransport,
    private val telemetry: TurnTelemetry,
    private val scope: CoroutineScope,
    private val beat: Duration = 1.seconds,
    private val coalesce: Duration = 250.milliseconds,
    private val elapsedMs: () -> Long,
) {
    private val published = MutableStateFlow<TurnActivity?>(null)
    private val driving = AtomicReference<DrivenTurn?>(null)
    private val live = MutableStateFlow<String?>(null)

    val activity: StateFlow<TurnActivity?> = published.asStateFlow()
    // The answer so far, at every delta, while a turn runs; the record takes it every `coalesce`, at each batch and at the end.
    val liveText: StateFlow<String?> = live.asStateFlow()

    // One turn at a time. Cancelling the caller passes through and ends nothing.
    suspend fun run(turnId: String, seat: TurnSeat, host: TurnHost): TurnExit = coroutineScope {
        val turn = DrivenTurn(turnId, seat, host)
        turn.work = launch(start = CoroutineStart.LAZY) { turn.drive() }
        check(driving.compareAndSet(null, turn)) { "A driver runs one turn at a time" }
        published.value = TurnActivity(turnId, stopping = false, reconnecting = false)
        live.value = ""
        try {
            turn.work.join()
            turn.exit ?: TurnExit.abandoned
        } finally {
            if (driving.compareAndSet(turn, null) || driving.get() == null) live.value = null
            turn.publish { null }
        }
    }

    // §4.5: asked of the server, whose stream then ends the turn stopped. A server that cannot be told leaves the turn to stop on this phone alone or, before any frame, to go back to the field.
    fun requestStop() {
        val turn = driving.get() ?: return
        if (!turn.stopAsked.compareAndSet(false, true)) return
        turn.publish { it.copy(stopping = true) }
        tellServerToStop(turn) { failure ->
            turn.reportStop(failure)
            if (driving.get() === turn) turn.stopHere(failure)
        }
    }

    // The app is leaving the screen, and a death from here loses what the last commit had not taken: the record takes the words so far now, on the turn's own work, and one commit however often this is asked.
    fun commitNow() {
        driving.get()?.commitAsked?.trySend(Unit)
    }

    // The seat changed under the turn: the run is cancelled, its record left to the caller, and the server is told to stop once so its slot is not held; whether that lands changes nothing here.
    fun abandon() {
        val turn = driving.getAndSet(null) ?: return
        live.value = null
        turn.publish { null }
        turn.work.cancel()
        turn.tellServerOnce()
    }

    private fun tellServerToStop(turn: DrivenTurn, unheard: (Exception) -> Unit) {
        scope.launch {
            try {
                transport.stop(turn.turnId, turn.seat)
            } catch (failure: Exception) {
                ensureActive()
                unheard(failure)
            }
        }
    }

    private inner class DrivenTurn(val turnId: String, val seat: TurnSeat, val host: TurnHost) {
        val started = elapsedMs()
        val stopAsked = AtomicBoolean(false)
        lateinit var work: Job
        @Volatile var exit: TurnExit? = null

        @Volatile private var following: Job? = null
        @Volatile private var stopFailure: Exception? = null
        @Volatile private var frameArrived = false

        @Volatile private var streamed = ""
        private var committed = ""
        private val writing = Mutex()
        private val textWaiting = Channel<Unit>(Channel.CONFLATED)
        val commitAsked = Channel<Unit>(Channel.CONFLATED)

        private var calls = 0
        private var refusals = 0
        private val reported = ConcurrentHashMap.newKeySet<TurnFailure>()

        fun publish(change: (TurnActivity) -> TurnActivity?) {
            published.update { activity -> if (activity?.turnId == turnId) change(activity) else activity }
        }

        fun stopHere(failure: Exception) {
            stopFailure = failure
            following?.cancel()
        }

        // One Stop reaches the server for a turn, whoever asks; whether it lands changes nothing here.
        fun tellServerOnce() {
            if (stopAsked.compareAndSet(false, true)) tellServerToStop(this) {}
        }

        // A lost connection, a 4xx and a refusal the server meant say nothing is broken; any other 5xx, a bad certificate or a wire fault do.
        fun reportStop(failure: Exception) {
            when (failure) {
                is TurnConnectionLost -> return
                is TurnRefusal -> if (failure.serverFault) report(TurnFailure.http, failure.status)
                is TurnWireFault -> report(TurnFailure.decode)
                else -> report(TurnFailure.transport)
            }
        }

        // Every write runs inside `work`, so an abandon reaches each of them; a stop this phone alone heard cancels the following and nothing else.
        suspend fun drive() = coroutineScope {
            val follower = async { followed() }
            following = follower
            if (stopFailure != null) follower.cancel()
            val close = try {
                follower.await()
            } catch (stopped: CancellationException) {
                ensureActive()
                StoppedHere
            }
            exit = when (close) {
                is Ended -> end(close)
                is Withdrawn -> withdraw(close.refusal)
                // A Stop the server did not hear: a turn with no frame holds only its question, which goes back to the field; any other ends `stopped` on this phone.
                StoppedHere -> if (!frameArrived) withdraw(TurnRefusal.unreached) else {
                    end(Ended(TurnState.stopped))
                    if (stopFailure is TurnConnectionLost) TurnExit.stoppedOffline else TurnExit.stopUnheard
                }
            }
        }

        // Everything until the turn's close is known. The committer has stopped by then, so no text commit lands after the end.
        private suspend fun followed(): Close = try {
            coroutineScope {
                // A commit that fails is reported once, the stream goes on, and the next commit tries again; a record that refuses it, or is gone, ends the turn.
                suspend fun committing() {
                    try { commitText() } catch (failed: TurnInterrupted) { if (failed.code == TurnFailure.refusal.name || failed.code == TurnLabel.gone) throw failed }
                }
                val committer = launch {
                    for (waiting in textWaiting) {
                        delay(coalesce)
                        committing()
                    }
                }
                val asked = launch { for (waiting in commitAsked) committing() }
                follow().also {
                    committer.cancel()
                    asked.cancel()
                }
            }
        } catch (interrupted: TurnInterrupted) {
            interruptedHere(interrupted.code)
        } catch (failure: Exception) {
            currentCoroutineContext().ensureActive()
            report(TurnFailure.storage)
            interruptedHere(TurnFailure.storage.name)
        }

        // The server would hold a turn this phone left until it gave up on the batch, so it is told once; a turn it refused as out of order or unknown holds nothing.
        private fun interruptedHere(code: String): Ended {
            if (code != TurnRefusal.turnOrder && code != TurnRefusal.turnUnknown) tellServerOnce()
            return Ended(TurnState.interrupted, code = code)
        }

        // §4.5: until a frame arrives the server may never have heard of the turn, so a reconnect opens again, the same body under the same id, which attaches to a turn that did land. After a frame a reconnect reads, and so does one after a Stop, since an open then could begin what was stopped.
        private suspend fun follow(): Close {
            val open = onHost { host.open() }
            open.contextOutcomes.forEach(::tell)
            var reconnects = 0
            while (true) {
                val opening = !frameArrived && !stopAsked.get()
                try {
                    val stream = if (opening) transport.open(open, seat) else transport.resume(turnId, seat)
                    val close = stream.mapNotNull { event ->
                        frameArrived = true
                        publish { it.copy(reconnecting = false) }
                        settle(event)
                    }.firstOrNull()
                    return close ?: throw TurnConnectionLost(null)
                } catch (interrupted: TurnInterrupted) {
                    throw interrupted
                } catch (refusal: TurnRefusal) {
                    // A refused open never began, though an earlier attempt's may have landed. A refused read says nothing of the open.
                    if (opening && !frameArrived) {
                        if (reconnects > 0) tellServerOnce()
                        return Withdrawn(refusal)
                    }
                    if (refusal.serverFault) report(TurnFailure.http, refusal.status)
                    if (!frameArrived) return Withdrawn(TurnRefusal.unreached)
                    throw TurnInterrupted(refusal.code)
                } catch (failure: Exception) {
                    currentCoroutineContext().ensureActive()
                    // §4.5: a dropped stream, or one another stream of this turn replaced, reconnects after 1, 2, 4 and 8 beats, and a fifth loss closes the turn. A frame that cannot be read closes it at once. With no frame the turn never began, as far as this phone can know, and the server is told in case it did.
                    val dropped = failure !is TurnWireFault || failure.kind == TurnWireFault.replaced
                    if (reconnects == 4 || !dropped) {
                        val kind = if (dropped) TurnFailure.transport else TurnFailure.decode
                        if (failure !is TurnConnectionLost) report(kind)
                        if (frameArrived) throw TurnInterrupted(kind.name)
                        tellServerOnce()
                        return Withdrawn(TurnRefusal.unreached)
                    }
                    reconnects += 1
                    publish { it.copy(reconnecting = true) }
                    delay(beat * (1 shl (reconnects - 1)))
                }
            }
        }

        // One frame: the close it brings, or null while the stream runs on.
        private suspend fun settle(event: TurnEvent): Close? = when (event) {
            is TurnEvent.Text -> {
                landText(streamed + event.delta)
                textWaiting.trySend(Unit)
                null
            }
            is TurnEvent.Snapshot -> {
                landText(event.text)
                commitText()
                // A terminal snapshot is followed by the turn's closing frame, which alone names its code, its moment and its truncation.
                if (!event.state.terminal) event.batch?.let { answer(it) }
                null
            }
            is TurnEvent.Calls -> {
                commitText()
                answer(event.batch)
                null
            }
            is TurnEvent.Done -> Ended(event.state, event.truncated)
            is TurnEvent.Error -> {
                if (event.code == TurnRefusal.streamReplaced) throw TurnWireFault(TurnWireFault.replaced)
                Ended(TurnState.failed, code = event.code, budgetResetsAtMs = event.budgetResetsAtMs, spent = event.spent)
            }
        }

        private fun landText(text: String) {
            streamed = text
            if (driving.get() === this) live.value = text
        }

        // §4.3: every call of the batch, in order, through the host, then the batch's results in one request, asked again after a lost answer, since the same body answers 204. §4.5: nothing runs or posts once Stop is asked, and a late post the server turns away is no failure; the stream's closing frame, or this phone's own stop, ends the turn.
        private suspend fun answer(batch: TurnBatch) {
            val results = batch.calls.map { call ->
                if (stopAsked.get()) return
                val outcome = onHost { host.execute(call) }
                tell(outcome)
                if (outcome is ToolOutcome.Refused) refusals += 1
                outcome
            }
            var attempts = 0
            while (!stopAsked.get()) {
                try {
                    transport.answer(turnId, batch.batch, results, seat)
                    return
                } catch (refusal: TurnRefusal) {
                    if (refusal.code == TurnRefusal.turnOrder && stopAsked.get()) return
                    if (refusal.serverFault) report(TurnFailure.http, refusal.status)
                    throw TurnInterrupted(refusal.code)
                } catch (fault: TurnWireFault) {
                    report(TurnFailure.decode)
                    throw TurnInterrupted(TurnFailure.decode.name)
                } catch (failure: Exception) {
                    currentCoroutineContext().ensureActive()
                    if (attempts == 3) {
                        if (failure !is TurnConnectionLost) report(TurnFailure.transport)
                        throw TurnInterrupted(TurnFailure.transport.name)
                    }
                    attempts += 1
                    delay(beat * (1 shl (attempts - 1)))
                }
            }
        }

        private fun tell(outcome: ToolOutcome) {
            calls += 1
            telemetry.ability(TurnLabel.of(outcome.name), TurnLabel.of(if (outcome is ToolOutcome.Refused) outcome.code else "ok"))
        }

        // The text landed so far, never one commit per token: a frame that must find it on the record commits at once, and the committer takes the rest after `coalesce`.
        private suspend fun commitText() = writing.withLock {
            val text = streamed
            if (text != committed) {
                onHost { host.writeText(text) }
                committed = text
            }
        }

        // A cancellation that is not this turn's own (a timeout inside the port, work its own scope gave up) is that port's failure; `ensureActive` lets the turn's own pass through.
        private suspend fun <T> onHost(work: suspend () -> T): T = try {
            work()
        } catch (gone: TurnRecordGone) {
            throw TurnInterrupted(TurnLabel.gone)
        } catch (refused: TurnRecordRefused) {
            report(TurnFailure.refusal)
            throw TurnInterrupted(TurnFailure.refusal.name)
        } catch (failure: Exception) {
            currentCoroutineContext().ensureActive()
            report(TurnFailure.storage)
            throw TurnInterrupted(TurnFailure.storage.name)
        }

        // Once per turn and kind: a store that stays broken files one report, however long the stream runs.
        private fun report(kind: TurnFailure, status: Int? = null) {
            if (reported.add(kind)) telemetry.failure(kind, status)
        }

        // §4.4: the terminal state and all the text in one write, then what the telemetry says of it.
        private suspend fun end(close: Ended): TurnExit {
            val text = streamed
            quietly { host.end(TurnEnd(close.state, text, close.truncated, close.code, close.budgetResetsAtMs, close.spent)) }
            telemetry.ended(close.state, seat.kind, close.code?.let(TurnLabel::code), TurnTally(calls, refusals, text.encodeToByteArray().size), elapsedMs() - started)
            return TurnExit.ended
        }

        // A turn that never began, refused before any frame or never reaching a server: the host takes its records back.
        private suspend fun withdraw(refusal: TurnRefusal): TurnExit {
            quietly { host.withdraw(refusal) }
            if (refusal.serverFault) report(TurnFailure.http, refusal.status)
            telemetry.withdrawn(refusal.status, TurnLabel.code(refusal.code), elapsedMs() - started)
            return TurnExit.withdrawn
        }

        // A close the store could not keep is reported, and the turn is over all the same.
        private suspend fun quietly(write: suspend () -> Unit) {
            try {
                write()
            } catch (gone: TurnRecordGone) {
                currentCoroutineContext().ensureActive()
            } catch (refused: TurnRecordRefused) {
                report(TurnFailure.refusal)
            } catch (failure: Exception) {
                currentCoroutineContext().ensureActive()
                report(TurnFailure.storage)
            }
        }
    }
}

private sealed interface Close
private data class Ended(val state: TurnState, val truncated: Boolean = false, val code: String? = null, val budgetResetsAtMs: Long? = null, val spent: Boolean = false) : Close
private data class Withdrawn(val refusal: TurnRefusal) : Close
private data object StoppedHere : Close

// Why a turn ends `interrupted` on this phone, in the word its code carries: a §6.5 code the server refused with or the phone's own cause, anything else `other`.
private class TurnInterrupted(code: String) : Exception(code) {
    val code = TurnLabel.code(code).value
}
