package works.windmill.sync.engine

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.BufferOverflow

enum class EngineOperation { commit, read, undo, release, dismiss, storage, writer, shutdown, sync, hello, push, pull, live, lifecycle, subscription }
enum class EngineOutcome { success, refused, failure, timeout }
data class EngineEvent(val operation: EngineOperation, val outcome: EngineOutcome, val code: String? = null)
fun interface EngineTelemetry { suspend fun record(event: EngineEvent) }
object NoEngineTelemetry : EngineTelemetry { override suspend fun record(event: EngineEvent) = Unit }

internal class TelemetryQueue(private val sink: EngineTelemetry) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val events = Channel<EngineEvent>(64, BufferOverflow.DROP_OLDEST)
    private val worker = if (sink === NoEngineTelemetry) null else scope.launch {
        for (event in events) {
            try { withTimeout(2_000) { sink.record(event) } }
            catch (cancelled: CancellationException) { if (!isActive) throw cancelled }
            catch (_: Exception) { /* A reporting failure cannot fail or retry a committed write. */ }
        }
    }
    fun offer(operation: EngineOperation, outcome: EngineOutcome, code: String? = null) {
        if (worker == null) return
        val safe = code?.takeIf { it in setOf("malformed", "not-writable", "store-failure", "cap", "too-large", "scope-dead", "sync-digest-mismatch", "sync-push-malformed") } ?: code?.let { "unknown" }
        events.trySend(EngineEvent(operation, outcome, safe))
    }
    fun close() { events.close(); scope.cancel() }
}

// One bounded queue for background work. The synchronous Replica port uses the same engine transaction lock.
class CoroutineWriter(private val engine: Engine, capacity: Int = 64, private val timeoutMs: Long = 60_000) : AutoCloseable {
    private class Work<T>(val body: suspend (Engine) -> T, val answer: CompletableDeferred<T>) {
        suspend fun run(engine: Engine, timeout: Long) {
            if (!answer.isActive) return
            supervisorScope {
                val task = async { withTimeout(timeout) { body(engine) } }
                val cancellation = answer.invokeOnCompletion { if (answer.isCancelled) task.cancel() }
                try { answer.complete(task.await()) }
                catch (failure: Throwable) {
                    answer.completeExceptionally(failure)
                    engine.report(EngineOperation.writer, if (failure is TimeoutCancellationException) EngineOutcome.timeout else EngineOutcome.failure)
                    if (failure is CancellationException && !currentCoroutineContext().isActive) throw failure
                } finally { cancellation.dispose() }
            }
        }
        fun cancel() { answer.cancel(CancellationException("writer-closed")) }
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = Channel<Work<*>>(capacity, onUndeliveredElement = { it.cancel() })
    private val worker = scope.launch {
        try { for (work in queue) work.run(engine, timeoutMs) }
        finally { queue.cancel() }
    }
    init { require(capacity > 0 && timeoutMs > 0) }
    suspend fun <T> submit(body: suspend (Engine) -> T): T {
        val answer = CompletableDeferred<T>()
        try {
            return withTimeout(timeoutMs) { queue.send(Work(body, answer)); answer.await() }
        } finally { if (!answer.isCompleted) answer.cancel() }
    }
    suspend fun shutdown(): Boolean {
        queue.close()
        val drained = withTimeoutOrNull(timeoutMs) { worker.join(); true } ?: false
        engine.report(EngineOperation.shutdown, if (drained) EngineOutcome.success else EngineOutcome.timeout)
        scope.cancel()
        engine.close()
        return drained
    }
    override fun close() { queue.cancel(); scope.cancel(); engine.close() }
}

internal object BoundaryTelemetry {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pending = Channel<Pair<EngineTelemetry, EngineEvent>>(64, BufferOverflow.DROP_OLDEST)
    init { scope.launch { for ((sink, event) in pending) try { withTimeout(2_000) { sink.record(event) } } catch (_: Exception) { } } }
    fun offer(sink: EngineTelemetry, operation: EngineOperation, code: String? = null) {
        pending.trySend(sink to EngineEvent(operation, EngineOutcome.failure, code))
    }
}
