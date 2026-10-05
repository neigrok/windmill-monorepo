package works.windmill.sync.testing

import java.io.File
import works.windmill.sync.core.*

object CoreCorpus {
    fun handlers(probe: Registry): Map<String, Handler> = linkedMapOf(
        "constants.json" to { constants() },
        "stamp/order.json" to { input -> Json.objectOf("order" to Json.of(Stamp(input.member("a").str()).compareTo(Stamp(input.member("b").str())).sign())) },
        "stamp/codec.json" to { input ->
            try {
                val stamp = Stamp(input.member("text").str())
                check(stamp.text == input.member("text").str())
                Json.objectOf("valid" to Json.of(true), "ms" to Json.of(stamp.ms), "counter" to Json.of(stamp.counter), "actor" to Json.of(stamp.actor))
            } catch (_: StampError) { Json.objectOf("valid" to Json.of(false)) }
        },
        "hlc/tick.json" to { input ->
            val clock = Hlc(input.member("clock"))
            val stamps = input.member("physNow").arr().map { clock.tick(it.long(), input.member("actor").str()).json }
            Json.objectOf("stamps" to Json.Arr(stamps), "clock" to clock.json)
        },
        "hlc/observe.json" to { input ->
            val clock = Hlc(input.member("clock"))
            val stamps = mutableListOf<Json>()
            for (op in input.member("ops").arr()) {
                if (op["observe"] != null) clock.observe(Stamp(op.member("observe").str()))
                else stamps.add(clock.tick(op.member("tick").long(), input.member("actor").str()).json)
            }
            Json.objectOf("stamps" to Json.Arr(stamps), "clock" to clock.json)
        },
        "hlc/offset.json" to { input ->
            val offset = ServerOffset()
            for (response in input.member("responses").arr()) offset.take(response.member("serverTime").long(), ClockReading(response.member("send")), ClockReading(response.member("recv")))
            Json.objectOf("samples" to Json.Arr(offset.samples.map { it.json }), "serverOffsetMs" to Json.of(offset.ms), "clockReading" to (offset.clockReading?.json ?: Json.Null))
        },
        "hlc/jump.json" to { input -> Json.objectOf("jumped" to Json.of(ClockReading(input.member("after")).jumped(ClockReading(input.member("before"))))) },
        "journal/content-clock.json" to { input -> Json.objectOf("stamp" to ContentClock.next(input["pair"], input["observed"], input.member("now").long(), input.member("actor").str())) },
        "jcs/values.json" to { input ->
            val json = input["bits"]?.let { Json.of(Double.fromBits(it.str().toULong(16).toLong())) } ?: Json.parse(input.member("json").str())
            Json.objectOf("jcs" to Json.of(json.jcs))
        },
        "join/lww.json" to { input -> registerJoin(input, Join::lww) },
        "join/fww.json" to { input -> registerJoin(input, Join::fww) },
        "join/ranked.json" to { input ->
            val rank = input.member("rank").obj().mapValues { it.value.long() }
            registerJoin(input) { a, b -> Join.ranked(a, b, rank) }
        },
        "join/life.json" to { input ->
            val a = input.member("a").orNull()?.let(::Life)
            val b = input.member("b").orNull()?.let(::Life)
            check(Join.life(a, b) == Join.life(b, a))
            Json.objectOf("join" to (Join.life(a, b)?.json ?: Json.Null))
        },
        "join/born.json" to { input ->
            val a = input.member("a").orNull()?.str()?.let(::Stamp)
            val b = input.member("b").orNull()?.str()?.let(::Stamp)
            check(Join.born(a, b) == Join.born(b, a))
            Json.objectOf("join" to (Join.born(a, b)?.json ?: Json.Null))
        },
        "join/record.json" to { input ->
            val type = probe.type(input.member("type").str())
            val a = Lattice(input.member("a")); val b = Lattice(input.member("b"))
            val result = Join.record(type, a, b)
            check(result == Join.record(type, b, a))
            Json.objectOf("join" to result.json)
        },
        "derive/slug.json" to { input -> Json.objectOf("id" to Json.of(DerivedId.from(input.member("label").str(), input.member("fallback").str(), input.member("taken").arr().map { it.str() }))) },
        "identity/seeded.json" to { input ->
            if (input.member("op").str() == "make") {
                Json.objectOf("id" to Json.of(SeededId.make(input.member("seed").str(), input.member("n").long(), probe.type(input.member("type").str())!!).id))
            } else {
                val parsed = SeededId.parse(input.member("id").str())
                Json.objectOf("parsed" to (parsed?.let { Json.objectOf("seed" to Json.of(it.seed), "n" to Json.of(it.ordinal)) } ?: Json.Null))
            }
        },
        "fracindex/between.json" to { input -> Json.objectOf("key" to Json.of(FractionalKey.between(input.member("a").orNull()?.str()?.let(::FractionalKey), input.member("b").orNull()?.str()?.let(::FractionalKey)).text)) },
        "fracindex/drop.json" to { input ->
            fun members(key: String) = input.member(key).arr().map { ListMember(it.member("id"), FractionalKey(it.member("key").str())) }
            val stored = members("stored"); val drawn = members("drawn"); val moved = input.member("moved")
            val key = FractionalKey.dropping(moved, input.member("above").orNull(), stored, drawn)
            fun order(list: List<ListMember>): Json = Json.Arr(list.map { if (it.id == moved) ListMember(moved, key) else it }.sorted().map { it.id })
            val after = if (drawn.any { it.id == moved }) drawn else drawn + ListMember(moved, key)
            Json.objectOf("key" to Json.of(key.text), "drawn" to order(after), "stored" to order(stored))
        },
        "digest/row.json" to { input -> Json.objectOf("hash" to Json.of(ScopeDigest.row(input.member("row")).hex)) },
        "digest/scope.json" to { input ->
            val rows = input["rows"]
            val digest = if (rows != null) ScopeDigest.rows(rows.arr()) else {
                var sum = ScopeDigest(input.member("start").str())
                for (change in input.member("changes").arr()) sum = sum.replacing(change.member("before").orNull(), change.member("after").orNull())
                sum
            }
            Json.objectOf("digest" to Json.of(digest.hex))
        },
        "machine/intent.json" to { input -> Json.objectOf("to" to Json.of(Machines.intent.transition(input.member("from").orNull()?.str(), input.member("event").str(), input["to"]?.str()))) },
        "machine/replica.json" to { input -> Json.objectOf("to" to Json.of(Machines.replica.transition(input.member("from").orNull()?.str(), input.member("event").str(), input["to"]?.str()))) },
    )
    fun Int.sign(): Int = if (this < 0) -1 else if (this > 0) 1 else 0
    fun registerJoin(input: Json, join: (Register?, Register?) -> Register?): Json {
        val a = input.member("a").orNull()?.let(::Register); val b = input.member("b").orNull()?.let(::Register)
        val result = join(a, b)
        check(result == join(b, a))
        return Json.objectOf("join" to (result?.json ?: Json.Null))
    }
    fun constants(): Json = Json.Obj(listOf(
        "HOLD_MS" to Constants.HOLD_MS, "LEAVE_DEBOUNCE_MS" to Constants.LEAVE_DEBOUNCE_MS, "SIGNOUT_FLUSH_MS" to Constants.SIGNOUT_FLUSH_MS,
        "MAX_SKEW_MS" to Constants.MAX_SKEW_MS, "K_POISON" to Constants.K_POISON, "LOCK_TIMEOUT_MS" to Constants.LOCK_TIMEOUT_MS,
        "PULL_FALLBACK_MS" to Constants.PULL_FALLBACK_MS, "BACKOFF_BASE_MS" to Constants.BACKOFF_BASE_MS, "BACKOFF_CEILING_MS" to Constants.BACKOFF_CEILING_MS,
        "BACKOFF_LIVE_CEILING_MS" to Constants.BACKOFF_LIVE_CEILING_MS, "LIVE_PING_MS" to Constants.LIVE_PING_MS, "LIVE_PONG_MS" to Constants.LIVE_PONG_MS,
        "REQUEST_TIMEOUT_MS" to Constants.REQUEST_TIMEOUT_MS, "OFFSET_SAMPLES" to Constants.OFFSET_SAMPLES, "CLOCK_JUMP_MS" to Constants.CLOCK_JUMP_MS,
        "REQUEST_LEASE_MS" to Constants.REQUEST_LEASE_MS, "SCOPE_HORIZON_DAYS" to Constants.SCOPE_HORIZON_DAYS, "REPLICA_GC_DAYS" to Constants.REPLICA_GC_DAYS,
        "REQUEST_RETENTION_DAYS" to Constants.REQUEST_RETENTION_DAYS, "MAX_RECORD_BYTES" to Constants.MAX_RECORD_BYTES, "PUSH_MAX_INTENTS" to Constants.PUSH_MAX_INTENTS,
        "PUSH_MAX_BYTES" to Constants.PUSH_MAX_BYTES, "PUSH_WORK_MS" to Constants.PUSH_WORK_MS, "PULL_PAGE_BYTES" to Constants.PULL_PAGE_BYTES,
        "PULL_MAX_SCOPES" to Constants.PULL_MAX_SCOPES, "PULL_MAX_BYTES" to Constants.PULL_MAX_BYTES, "LIVE_FRAME_BYTES" to Constants.LIVE_FRAME_BYTES,
        "LIVE_INLINE_BYTES" to Constants.LIVE_INLINE_BYTES, "KEEPALIVE_BYTES" to Constants.KEEPALIVE_BYTES, "MERGE_WORK_CELLS" to Constants.MERGE_WORK_CELLS,
        "ACCOUNT_ID_BYTES" to Constants.ACCOUNT_ID_BYTES,
    ).map { it.first to Json.of(it.second) })
}

fun main(args: Array<String>) {
    require(args.size in 1..2 && (args.size == 1 || args[1] in listOf("--all", "--subset")))
    val contract = File(args[0])
    val corpus = Corpus(File(contract, "sync/corpus"))
    val probe = Registry(Json.parse(File(contract, "sync/probe.registry.json").readBytes()))
    val handlers = CoreCorpus.handlers(probe) + ClientCorpus.handlers(probe) + NetworkCorpus.handlers(probe) + JournalCorpus.handlers(contract) + ProtocolCorpus.handlers(probe)
    val paths = corpus.clientPaths
    val supported = paths.filter { it in handlers }
    println("client corpus: ${supported.size}/${paths.size} files, ${supported.sumOf { corpus.vectors(it).size }}/${paths.sumOf { corpus.vectors(it).size }} vectors")
    corpus.run(handlers, if (args.getOrNull(1) == "--subset") supported else paths)
}
