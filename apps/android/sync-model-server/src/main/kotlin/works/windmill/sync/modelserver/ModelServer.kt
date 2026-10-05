package works.windmill.sync.modelserver

import works.windmill.sync.core.*

data class Reply(val status: Int, val body: Json, val events: List<LiveEvent> = emptyList()) {
    val json get() = Json.objectOf("status" to Json.of(status), "body" to body)
}
data class PushFaults(val budget: Int? = null, val byN: Map<Long, String> = emptyMap(), val transientAtBind: Boolean = false)
data class CallFaults(val crashAfter: Int? = null, val transientAt: Int? = null, val faultAt: Int? = null)
data class ServerCall(val account: String, val requestId: String?, val tool: String, val args: Json, val intents: List<Json>)

class ModelServer(val registry: Registry, val rules: ServerRules = NoServerRules(), state: ServerState = ServerState(), val limits: ServerLimits = ServerLimits()) {
    private var tables = state.copy()
    val state: ServerState get() = tables.copy()
    private val admission = Admission(registry, rules, limits)
    private val feed = Feed(registry, limits)
    private var greatestNow = Long.MIN_VALUE
    private val scripted = ArrayDeque<Refusal>()
    private data class Socket(val account: String?, val scopes: MutableSet<ScopeKey> = mutableSetOf(), val frames: MutableList<Json> = mutableListOf())
    private val sockets = linkedMapOf<Int, Socket>(); private var opened = 0
    fun restore(snapshot: ServerState) { tables = snapshot.copy() }
    fun refuse(next: Int = 1, code: String, detail: Json? = null) { require(next >= 0); repeat(next) { scripted.addLast(Refusal(code, detail)) } }
    private fun now(wall: Long): Long { greatestNow = maxOf(wall, greatestNow); return greatestNow }
    private fun base(account: String?, now: Long) = Json.objectOf("serverTime" to Json.of(now), "epoch" to Json.of(tables.epoch), "as" to (account?.let(Json::of) ?: Json.Null))
    private fun failure(status: Int, error: String, account: String?, now: Long) = Reply(status, base(account, now).with("error" to Json.of(error)))
    fun hello(credential: Credential, at: Long): Reply {
        val now = now(at); if (credential.fails) return failure(401, "unauthenticated", null, now)
        return Reply(200, base(credential.account, now).with("schema" to Json.of(registry.version), "minSchema" to Json.of(registry.minVersion), "holdsRecords" to credential.account?.let { feed.holdsRecords(it, tables) }))
    }
    fun push(request: Json, credential: Credential, at: Long, faults: PushFaults = PushFaults()) = push(request.jcs.encodeToByteArray(), credential, at, faults)
    fun push(received: ByteArray, credential: Credential, at: Long, faults: PushFaults = PushFaults()): Reply {
        val now = now(at); val account = credential.account
        if (credential.fails || account == null) return failure(401, "unauthenticated", null, now)
        if (received.size > limits.pushMaxBytes) return failure(413, "request-too-large", account, now)
        val request: Json; val replica: String; val intents: List<Json>; val ack: Long
        try {
            request = Json.parse(received); request.expectKeys(listOf("account", "ackThrough", "intents", "replica"))
            replica = request.member("replica").str(); require(replica.matches(Regex("rp_[0-9a-f]{32}")))
            request.member("account").str(); ack = request.member("ackThrough").long(0)
            intents = request.member("intents").arr().onEach { it.obj(); it.member("n").long(1) }.sortedBy { it.member("n").long() }
        } catch (_: IllegalArgumentException) { return failure(400, "malformed", account, now) }
        if (intents.size > limits.pushMaxIntents) return failure(413, "request-too-large", account, now)
        if (request.member("account").str() != account) return failure(409, "account-mismatch", account, now)
        if (faults.transientAtBind) return Reply(503, base(account, now).with("error" to Json.of("unavailable"), "retryAfterMs" to Json.of(1000)))
        val binding = tables.replicas[replica]
        if (binding != null && binding.member("account").str() != account) return failure(409, "replica-foreign", account, now)
        val bound = binding == null
        if (bound) tables.replicas[replica] = Json.objectOf("account" to Json.of(account), "lastN" to Json.of(0))
        val results = mutableListOf<Json>(); val events = mutableListOf<LiveEvent>(); var retry: Json? = null; var admissions = 0
        fun lastN() = tables.replicas.getValue(replica).member("lastN").long()
        fun stop(error: String): Reply {
            if (bound && lastN() == 0L && tables.results[replica] == null) tables.replicas.remove(replica)
            return failure(409, error, account, now).copy(events = events.toList())
        }
        for (intent in intents) {
            val n = intent.member("n").long(); val digest = Sha256.hex(intent.jcs.encodeToByteArray())
            if (n <= lastN()) {
                val stored = tables.results[replica]?.get(n)
                if (stored == null || stored.member("digest").str() != digest || stored.member("result") === Json.Null) return stop("replica-forked")
                results.add(stored.member("result").with("n" to Json.of(n))); continue
            }
            if (n != lastN() + 1) return stop("gap")
            if (faults.budget != null && admissions >= faults.budget) { retry = Json.objectOf("n" to Json.of(n), "retryAfterMs" to Json.of(0)); break }
            admissions++
            if (faults.byN[n] == "transient") { retry = Json.objectOf("n" to Json.of(n), "retryAfterMs" to Json.of(1000)); break }
            val stored = tables.results[replica]?.get(n); val beforeFaults = if (stored?.get("digest") == Json.of(digest)) stored.member("faults").long().toInt() else 0
            val admitted: Admitted; val counted: Int
            try {
                if (faults.byN[n] != null) throw AdmissionFault()
                admitted = if (scripted.isNotEmpty()) scripted.removeFirst().let { Admitted(refused(it.code, it.detail)) }
                else admission.admit(intent, IntentOrigin(account, replica, n), now, tables).let { (next, answer) -> tables = next; answer }
                counted = beforeFaults
            } catch (_: AdmissionFault) {
                val count = beforeFaults + 1; val poisoned = count >= Constants.K_POISON
                tables.results.getOrPut(replica) { mutableMapOf() }[n] = storedResult(n, digest, if (poisoned) refused("internal") else Json.Null, count)
                if (!poisoned) { retry = Json.objectOf("n" to Json.of(n), "retryAfterMs" to Json.of(0)); break }
                tables.replicas[replica] = tables.replicas.getValue(replica).with("lastN" to Json.of(n))
                results.add(refused("internal").with("n" to Json.of(n))); continue
            }
            tables.results.getOrPut(replica) { mutableMapOf() }[n] = storedResult(n, digest, admitted.result, counted)
            tables.replicas[replica] = tables.replicas.getValue(replica).with("lastN" to Json.of(n))
            publish(admitted.events); events.addAll(admitted.events); results.add(admitted.result.with("n" to Json.of(n)))
        }
        val last = lastN(); tables.results[replica]?.keys?.removeAll { it <= minOf(ack, last) }
        if (tables.results[replica]?.isEmpty() == true) tables.results.remove(replica)
        return Reply(200, base(account, now).with("lastN" to Json.of(last), "results" to Json.Arr(results), "retry" to retry), events)
    }
    private fun storedResult(n: Long, digest: String, result: Json, faults: Int) = Json.objectOf("n" to Json.of(n), "digest" to Json.of(digest), "result" to result, "faults" to Json.of(faults))
    fun call(call: ServerCall, at: Long, faults: CallFaults = CallFaults()): Json? {
        val now = now(at); val id = call.requestId
        fun admit(intent: Json, k: Int): Json {
            if (faults.faultAt == k) throw AdmissionFault()
            val (next, answer) = admission.admit(intent, IntentOrigin(call.account, requestId = id), now, tables)
            tables = next; publish(answer.events); return answer.result
        }
        if (id == null) {
            var result: Json? = null
            for ((i, intent) in call.intents.withIndex()) { result = try { admit(intent, i + 1) } catch (_: AdmissionFault) { return refused("internal") }; if (result["s"] == Json.of("refused")) break }
            return result
        }
        if (id.isEmpty() || '#' in id || '\u0000' in id) return refused("invalid")
        val digest = Sha256.hex(Json.objectOf("tool" to Json.of(call.tool), "args" to call.args).jcs.encodeToByteArray())
        val existing = tables.requests[call.account]?.get(id)
        if (existing != null) {
            if (existing.member("digest") != Json.of(digest)) return refused("request-conflict")
            if (existing.member("state") == Json.of("done")) return existing["result"]
            if (now - existing.member("startedAt").long() < Constants.REQUEST_LEASE_MS) return refused("request-running")
        }
        val before = tables.copy()
        var row = (existing ?: Json.objectOf("requestId" to Json.of(id), "digest" to Json.of(digest), "state" to Json.of("running"), "parts" to Json.array())).with("startedAt" to Json.of(now))
        fun save() { tables.requests.getOrPut(call.account) { mutableMapOf() }[id] = row }
        save(); val first = row.member("parts").arr().size + 1; var result: Json? = null
        for ((i, intent) in call.intents.withIndex()) {
            val k = i + 1; val part = row.member("parts").arr().firstOrNull { it.member("k").long() == k.toLong() }
            if (part != null) result = part.member("result") else {
                if (faults.transientAt == k) { if (k == first) tables = before; return null }
                val tagged = try { intent.with("gestureId" to Json.of(id)) } catch (_: IllegalArgumentException) { Json.objectOf("gestureId" to Json.of(id)) }
                var faulted = false
                try { result = admit(tagged, k); faulted = false } catch (_: AdmissionFault) { result = refused("internal"); faulted = true }
                row = row.with("parts" to Json.Arr(row.member("parts").arr() + Json.objectOf("k" to Json.of(k), "result" to result!!)))
                if (!faulted) row = row.with("startedAt" to Json.of(now))
                save(); if (!faulted && faults.crashAfter == k) return null
                if (faulted) break
            }
            if (result?.get("s") == Json.of("refused")) break
        }
        row = row.with("state" to Json.of("done"), "result" to result); save(); return result
    }
    fun pull(request: Json, credential: Credential, at: Long) = pull(request.jcs.encodeToByteArray(), credential, at)
    fun pull(received: ByteArray, credential: Credential, at: Long): Reply {
        val now = now(at); val account = credential.account
        if (credential.fails) return failure(401, "unauthenticated", null, now)
        if (received.size > limits.pullMaxBytes) return failure(413, "request-too-large", account, now)
        val scopes = try {
            val request = Json.parse(received); request.expectKeys(listOf("scopes"))
            request.member("scopes").arr().also { require(it.size <= limits.pullMaxScopes) }.map { entry -> entry.expectKeys(listOf("scope", "cursor")); entry.member("scope").str() to entry.member("cursor").orNull()?.str() }
        } catch (_: IllegalArgumentException) { return failure(400, "malformed", account, now) }
        val events = mutableListOf<LiveEvent>()
        val pages = scopes.map { (requested, cursor) ->
            val ref = try { ScopeRef(requested) } catch (_: IllegalArgumentException) { null }
            val key = ref?.let { ScopeKey.resolve(it, account) }
            if (key != null && tables.scopes[key.text]?.state == "alive" && tables.canRead(key, account, registry)) {
                for (command in registry.commands.map(::CommandDef).filter { it.beforePull && it.scope == registry.scopeKind(ref) }) {
                    try {
                        val intent = Json.objectOf("scope" to key.ref.json, "cmd" to Json.objectOf("name" to Json.of(command.name), "args" to Json.objectOf()))
                        val (next, answer) = admission.admit(intent, IntentOrigin(tables.scopes.getValue(key.text).owner), now, tables)
                        tables = next; events.addAll(answer.events); publish(answer.events)
                    } catch (_: AdmissionFault) { /* beforePull faults leave its transaction untouched */ }
                }
            }
            feed.page(requested, cursor, account, tables)
        }
        return Reply(200, base(account, now).with("pages" to Json.Arr(pages)), events)
    }
    fun connect(credential: Credential): Int? { if (credential.fails) return null; opened++; sockets[opened] = Socket(credential.account); return opened }
    fun close(socket: Int) { sockets.remove(socket) }
    fun isOpen(socket: Int) = socket in sockets
    fun subscribe(socket: Int, scopes: List<ScopeRef>) {
        val subscriber = sockets[socket] ?: return
        for (ref in scopes) {
            val key = if (registry.scopeKind(ref) == null) null else ScopeKey.resolve(ref, subscriber.account)
            val access = key?.let { tables.access(it, subscriber.account, registry) } ?: "not-found"
            if (access in listOf("gone", "not-found")) subscriber.frames.add(endFrame(access, ref, subscriber.account)) else subscriber.scopes.add(key!!)
        }
    }
    fun unsubscribe(socket: Int, scopes: List<ScopeRef>) { val sub = sockets[socket] ?: return; scopes.mapNotNull { ScopeKey.resolve(it, sub.account) }.forEach(sub.scopes::remove) }
    fun frames(socket: Int): List<Json> = sockets[socket]?.frames?.let { it.toList().also { _ -> it.clear() } } ?: emptyList()
    fun deathFrame(scope: ScopeRef, account: String?): Json? {
        val key = ScopeKey.resolve(scope, account) ?: return null
        if (key.text !in tables.scopes) return null
        return endFrame(if (tables.access(key, account, registry) == "gone") "gone" else "not-found", scope, account)
    }
    fun frame(event: LiveEvent, account: String?): Json? = if (event.dead) deathFrame(event.key.ref, account) else event.frame!!.with("as" to (account?.let(Json::of) ?: Json.Null))
    private fun endFrame(op: String, ref: ScopeRef, account: String?) = Json.objectOf("op" to Json.of(op), "scope" to ref.json, "as" to (account?.let(Json::of) ?: Json.Null))
    private fun publish(events: List<LiveEvent>) {
        if (events.isEmpty()) return
        for (sub in sockets.values) {
            for (event in events.filter { it.key in sub.scopes }) {
                if (event.dead) { frame(event, sub.account)?.let(sub.frames::add); sub.scopes.remove(event.key) }
                else if (tables.canRead(event.key, sub.account, registry)) sub.frames.add(frame(event, sub.account)!!)
            }
            for (key in sub.scopes.sorted().filter { !tables.canRead(it, sub.account, registry) }) {
                sub.scopes.remove(key)
                if (key.tree == null || tables.scopes["tree:${key.tree}"]?.state == "alive") sub.frames.add(endFrame("not-found", key.ref, sub.account))
            }
        }
    }
}
