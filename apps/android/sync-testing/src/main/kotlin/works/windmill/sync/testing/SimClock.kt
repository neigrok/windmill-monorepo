package works.windmill.sync.testing

import java.util.concurrent.CompletableFuture
import works.windmill.sync.core.ClockReading
import works.windmill.sync.engine.EngineClock

// Wall and monotonic time move only at the test's command. Completion runs outside the clock lock.
class SimClock(wallMs: Long = 0) : EngineClock, AutoCloseable {
    private val lock = Any()
    private var wall = wallMs; private var mono = 0L; private var skew = 0L; private var boot = 1L
    private var closed = false
    private val sleepers = linkedMapOf<CompletableFuture<Unit>, Long>()
    override fun now(): Long = synchronized(lock) { wall + skew }
    override fun reading(): ClockReading = synchronized(lock) { ClockReading(wall + skew, mono, "boot-$boot") }
    val monotonicMs: Long get() = synchronized(lock) { mono }
    val sleeping: Int get() = synchronized(lock) { sleepers.size }
    fun advanceToNext(): Boolean {
        val delay = synchronized(lock) { sleepers.values.minOrNull()?.let { maxOf(0, it - mono) } } ?: return false
        advance(delay); return true
    }
    fun sleepUntil(deadline: Long): CompletableFuture<Unit> {
        val future = CompletableFuture<Unit>()
        val immediately = synchronized(lock) {
            check(!closed) { "clock-closed" }
            if (deadline <= mono) true else { sleepers[future] = deadline; false }
        }
        future.whenComplete { _, _ -> synchronized(lock) { sleepers.remove(future) } }
        if (immediately) future.complete(Unit)
        return future
    }
    fun advance(ms: Long) {
        require(ms >= 0)
        val wake = synchronized(lock) {
            check(!closed) { "clock-closed" }; val nextMono = Math.addExact(mono, ms); val nextWall = Math.addExact(wall, ms)
            mono = nextMono; wall = nextWall
            sleepers.filterValues { it <= mono }.keys.toList().also { due -> due.forEach(sleepers::remove) }
        }
        wake.forEach { it.complete(Unit) }
    }
    fun jump(ms: Long) = synchronized(lock) { check(!closed); wall = Math.addExact(wall, ms) }
    fun skew(ms: Long) = synchronized(lock) { check(!closed); skew = ms }
    fun reboot() = synchronized(lock) { check(!closed); boot++ }
    override fun close() {
        val cancelled = synchronized(lock) { if (closed) return; closed = true; sleepers.keys.toList().also { sleepers.clear() } }
        cancelled.forEach { it.cancel(false) }
    }
}
