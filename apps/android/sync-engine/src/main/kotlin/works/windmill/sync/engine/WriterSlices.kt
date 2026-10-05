package works.windmill.sync.engine

import works.windmill.sync.core.Constants
import works.windmill.sync.core.ScopeRef

internal class WriterSlices {
    private val chunks = mutableMapOf<ScopeRef, Int>()
    var settleEntries = 32; private set
    var resultsPerBatch = 16; private set
    fun chunkRows(scope: ScopeRef) = chunks[scope] ?: 64
    fun recordChunk(scope: ScopeRef, taken: Int, heldNanos: Long) { chunks[scope] = next(chunkRows(scope), taken, heldNanos) }
    fun recordSettle(taken: Int, heldNanos: Long) { settleEntries = next(settleEntries, taken, heldNanos) }
    fun recordResults(taken: Int, heldNanos: Long) { resultsPerBatch = next(resultsPerBatch, taken, heldNanos) }
    companion object {
        internal val aimNanos = (Constants.WRITER_SLICE_MS / 2) * 1_000_000L
        internal fun next(offered: Int, taken: Int, heldNanos: Long): Int {
            require(offered > 0 && taken >= 0)
            if (taken == 0) return offered
            val upper = minOf(2L * offered, 4_096L).toInt()
            if (heldNanos <= 0) return upper
            val fitting = (taken.toDouble() * aimNanos / heldNanos).coerceAtMost(upper.toDouble()).toInt()
            return if (heldNanos > aimNanos) maxOf(1, fitting) else maxOf(offered, fitting)
        }
    }
}
