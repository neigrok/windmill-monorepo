package works.windmill.sync.core

class StampError : IllegalArgumentException("invalid-stamp")

@ConsistentCopyVisibility
data class Stamp private constructor(val ms: Long, val counter: Long, val actor: String) : Comparable<Stamp> {
    constructor(text: String) : this(parts(text))
    private constructor(parts: Triple<Long, Long, String>) : this(parts.first, parts.second, parts.third)
    val text: String get() = "$ms:$counter:$actor"
    val json: Json get() = Json.of(text)
    override fun compareTo(other: Stamp): Int {
        if (ms != other.ms) return ms.compareTo(other.ms)
        if (counter != other.counter) return counter.compareTo(other.counter)
        return compareBytes(actor, other.actor)
    }
    override fun toString(): String = text
    companion object {
        const val MS_LIMIT = 9_007_199_254_740_992L
        const val COUNTER_LIMIT = 4_294_967_296L
        val UNSET = Stamp(0, 0, "")
        fun of(ms: Long, counter: Long, actor: String): Stamp = Stamp("$ms:$counter:$actor")
        fun validActor(actor: String): Boolean = actor.length in 1..64 && actor.all { it.code in 32..126 }
        fun parts(text: String): Triple<Long, Long, String> {
            if (text == "0:0:") return Triple(0, 0, "")
            val parts = text.split(':', limit = 3)
            if (parts.size != 3 || !validActor(parts[2])) throw StampError()
            fun decimal(text: String, limit: Long): Long {
                if (text.isEmpty() || text.any { it !in '0'..'9' } || (text.length > 1 && text[0] == '0')) throw StampError()
                val number = text.toLongOrNull() ?: throw StampError()
                if (number >= limit) throw StampError()
                return number
            }
            return Triple(decimal(parts[0], MS_LIMIT), decimal(parts[1], COUNTER_LIMIT), parts[2])
        }
    }
}

class Hlc(ms: Long = 0, counter: Long = 0) {
    var ms: Long = ms; private set
    var counter: Long = counter; private set
    init { require(ms in 0 until Stamp.MS_LIMIT && counter in 0 until Stamp.COUNTER_LIMIT) }
    constructor(json: Json) : this(json.member("ms").long(0), json.member("counter").long(0)) {
        json.expectKeys(listOf("ms", "counter"))
    }
    val json: Json get() = Json.objectOf("ms" to Json.of(ms), "counter" to Json.of(counter))
    fun tick(physNow: Long, actor: String): Stamp {
        if (!Stamp.validActor(actor)) throw StampError()
        val nextMs = if (physNow > ms) physNow else if (counter == Stamp.COUNTER_LIMIT - 1) ms + 1 else ms
        val nextCounter = if (nextMs > ms) 0 else counter + 1
        val stamp = Stamp.of(nextMs, nextCounter, actor)
        ms = nextMs; counter = nextCounter
        return stamp
    }
    fun reading(actor: String): Stamp = Stamp.of(ms, counter, actor)
    fun observe(stamp: Stamp) {
        if (stamp.ms > ms || (stamp.ms == ms && stamp.counter > counter)) { ms = stamp.ms; counter = stamp.counter }
    }
    companion object {
        fun pairMaximum(a: Hlc, b: Hlc): Hlc = if (a.ms > b.ms || (a.ms == b.ms && a.counter >= b.counter)) {
            Hlc(a.ms, a.counter)
        } else Hlc(b.ms, b.counter)
    }
}

data class ClockReading(val wall: Long, val mono: Long, val boot: String) {
    constructor(json: Json) : this(json.member("wall").long(), json.member("mono").long(), json.member("boot").str()) {
        json.expectKeys(listOf("wall", "mono", "boot"))
    }
    fun jumped(since: ClockReading): Boolean = boot != since.boot ||
        kotlin.math.abs((wall - since.wall) - (mono - since.mono)) > Constants.CLOCK_JUMP_MS
    val json: Json get() = Json.objectOf("wall" to Json.of(wall), "mono" to Json.of(mono), "boot" to Json.of(boot))
}

class ServerOffset(val capacity: Int = Constants.OFFSET_SAMPLES) {
    data class Sample(val offset: Long, val rtt: Long) {
        val json: Json get() = Json.objectOf("offset" to Json.of(offset), "rtt" to Json.of(rtt))
    }
    var samples: List<Sample> = emptyList(); private set
    var clockReading: ClockReading? = null; private set
    init { require(capacity > 0) }
    val ms: Long get() = samples.asReversed().minByOrNull { it.rtt }?.offset ?: 0
    fun take(serverTime: Long, send: ClockReading, recv: ClockReading): Boolean {
        if (recv.jumped(send)) return false
        if (clockReading?.let { recv.jumped(it) } == true) samples = emptyList()
        val sample = Sample(serverTime - ((send.wall + recv.wall) shr 1), recv.mono - send.mono)
        samples = (samples + sample).takeLast(capacity)
        clockReading = recv
        return true
    }
}

object ContentClock {
    fun valid(stamp: Json): Boolean {
        return try {
            stamp.expectKeys(listOf("ms", "counter", "actor"))
            val ms = stamp.member("ms").long(0)
            val counter = stamp.member("counter").long(0)
            val actor = stamp.member("actor").str()
            ms < Stamp.MS_LIMIT && counter < Stamp.COUNTER_LIMIT && actor.length <= 64 &&
                actor.all { it.code in 32..126 } && (actor.isNotEmpty() || (ms == 0L && counter == 0L))
        } catch (_: JsonError) { false }
    }
    fun compare(a: Json, b: Json): Int {
        for (key in listOf("ms", "counter")) {
            val order = a.member(key).long().compareTo(b.member(key).long())
            if (order != 0) return order
        }
        return compareBytes(a.member("actor").str(), b.member("actor").str())
    }
    fun next(pair: Json?, observed: Json?, now: Long, actor: String): Json {
        var ms = pair?.get("ms")?.long(0) ?: 0
        var counter = pair?.get("counter")?.long(0) ?: 0
        require(ms < Stamp.MS_LIMIT && counter < Stamp.COUNTER_LIMIT)
        if (observed != null) {
            require(valid(observed))
            val otherMs = observed.member("ms").long()
            val otherCounter = observed.member("counter").long()
            if (otherMs > ms || (otherMs == ms && otherCounter > counter)) { ms = otherMs; counter = otherCounter }
        }
        if (now > ms) { ms = now; counter = 0 }
        else { counter++; if (counter == Stamp.COUNTER_LIMIT) { ms++; counter = 0 } }
        val result = Json.objectOf("ms" to Json.of(ms), "counter" to Json.of(counter), "actor" to Json.of(actor))
        require(actor.isNotEmpty() && valid(result))
        return result
    }
    fun pair(stamp: Json): Json = Json.objectOf("ms" to stamp.member("ms"), "counter" to stamp.member("counter"))
}

object Constants {
    const val HOLD_MS = 9_000L
    const val LEAVE_DEBOUNCE_MS = 500L
    const val SIGNOUT_FLUSH_MS = 5_000L
    const val MAX_SKEW_MS = 300_000L
    const val K_POISON = 3
    const val LOCK_TIMEOUT_MS = 2_000L
    const val PULL_FALLBACK_MS = 300_000L
    const val BACKOFF_BASE_MS = 1_000L
    const val BACKOFF_CEILING_MS = 300_000L
    const val BACKOFF_LIVE_CEILING_MS = 30_000L
    const val LIVE_PING_MS = 25_000L
    const val LIVE_PONG_MS = 10_000L
    const val REQUEST_TIMEOUT_MS = 60_000L
    const val WRITER_SLICE_MS = 25L
    const val OFFSET_SAMPLES = 8
    const val CLOCK_JUMP_MS = 1_000L
    const val REQUEST_LEASE_MS = 60_000L
    const val SCOPE_HORIZON_DAYS = 30
    const val REPLICA_GC_DAYS = 365
    const val REQUEST_RETENTION_DAYS = 90
    const val MAX_RECORD_BYTES = 1_048_576
    const val PUSH_MAX_INTENTS = 64
    const val PUSH_MAX_BYTES = 2_097_152
    const val PUSH_WORK_MS = 50L
    const val PULL_PAGE_BYTES = 1_048_576
    const val PULL_MAX_SCOPES = 64
    const val PULL_MAX_BYTES = 65_536
    const val LIVE_FRAME_BYTES = 131_072
    const val LIVE_INLINE_BYTES = 65_536
    const val KEEPALIVE_BYTES = 65_536
    const val MERGE_WORK_CELLS = 4_194_304
    const val ACCOUNT_ID_BYTES = 64
}
