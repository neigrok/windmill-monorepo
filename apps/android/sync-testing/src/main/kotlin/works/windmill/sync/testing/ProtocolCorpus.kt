package works.windmill.sync.testing

import works.windmill.sync.api.CommitFailure
import works.windmill.sync.core.*
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*

// The client half generates every request and applies every server answer using the production engine.
// ModelServer separately validates the server half; no line's expected response is used as an implementation.
object ProtocolCorpus {
    private val paths = listOf("hello", "join", "live", "pull", "push", "skew", "whole").map { "protocol/$it.jsonl" }
    fun handlers(registry: Registry): Map<String, Handler> = paths.associateWith { path -> { input -> replay(path, registry, input.arr()) } }

    private fun replay(path: String, registry: Registry, lines: List<Json>): Json {
        val header = lines.first()
        require(lines.size > 1 && lines.last()["end"] == Json.of(true)) { "$path must end with an end line" }
        val server = ModelServer(registry, ProbeServerRules(), ServerState(header.member("server")))
        var gestures = 0
        class Device(val name: String, state: Json) : AutoCloseable {
            var wall = 0L
            val ids = header["ids"]?.get(name)?.arr().orEmpty(); var idIndex = 0
            val actors = header.member("actors").member(name).arr(); var actorIndex = 1
            val clock = object : EngineClock { override fun now() = wall; override fun reading() = ClockReading(wall, wall, "boot-1") }
            val identities = object : IdentitySource {
                override fun opaqueID() = "g${++gestures}"
                override fun draw(bound: Int): Int = error("$path $name unexpected draw")
                override fun replicaID() = ids.getOrNull(idIndex++)?.str() ?: error("$path $name exhausted ids")
                override fun actorID() = actors.getOrNull(actorIndex++)?.str() ?: error("$path $name exhausted actors")
            }
            var engine = Engine.memory(registry, state, clock, identities, actors.first().str())
            val ended = mutableListOf<Json>()
            fun load(state: Json) { val actor = engine.actor; ended.addAll(engine.ended()); engine.close(); engine = Engine.memory(registry, state, clock, identities, actor) }
            override fun close() = engine.close()
        }
        val devices = header.member("devices").obj().mapValues { (name, state) -> Device(name, state) }
        val published = mutableListOf<LiveEvent>()
        val accounts = mutableMapOf<String, String>()
        fun equal(actual: Json, expected: Json, place: String) {
            if (actual != expected) throw AssertionError("$path $place\nexpected ${expected.jcs}\nactual   ${actual.jcs}")
        }
        fun credential(line: Json): Credential = if (line["credential"] == Json.of("unresolved")) Credential.Unresolved
            else line["account"]?.orNull()?.str()?.let(Credential::Account) ?: Credential.Absent
        try {
            for (line in lines.drop(1)) {
                val place = "step ${line["step"]?.jcs ?: "?"}"
                if (line["end"] != null) {
                    equal(server.state.json, line.member("server"), "$place server")
                    check(line.member("devices").obj().keys == devices.keys && line.member("ended").obj().keys == devices.keys) { "$path $place device inventory" }
                    for ((name, device) in devices) {
                        equal(device.engine.snapshot(), line.member("devices").member(name), "$place $name store")
                        equal(Json.Arr(device.ended + device.engine.ended()), line.member("ended").member(name), "$place $name ended")
                    }
                    continue
                }
                if (line["server"] == Json.of("load")) { server.restore(ServerState(line.member("state"))); continue }
                val name = line.member("device").str(); val device = devices.getValue(name)
                device.wall = line["deviceNow"]?.long() ?: 0
                val engine = device.engine
                if (line["do"] != null) {
                    val args = line.member("args")
                    val returned = when (line.member("do").str()) {
                        "commit" -> try { ClientCorpus.outcome(engine.commit(ScopeRef(args.member("scope")), ClientCorpus.gesture(args["changes"] ?: Json.array(), args["opts"] ?: Json.objectOf()))) }
                            catch (_: CommitFailure) { Json.objectOf("throws" to Json.of(true)) }
                        "release" -> Json.of(engine.release(args.member("localId").str()))
                        "releaseAll" -> { engine.releaseHeld(true); Json.Null }
                        "signIn" -> engine.signIn(args.member("account").str(), args.member("holdsRecords").obj().mapValues { it.value.bool() },
                            args["decisions"]?.obj()?.mapValues { it.value.str() }.orEmpty(), args["counted"]?.obj()?.mapValues { it.value.arr().map(Json::str) }.orEmpty())
                        "signOut" -> engine.signOut(args["choice"]?.str(), args["counted"]?.arr()?.map(Json::str))
                        "reconcile" -> { engine.reconcile(args.member("scopes").arr().map(::ScopeRef).toSet()); Json.Null }
                        "load" -> { device.load(args.member("device")); Json.Null }
                        else -> error("$path $place unknown action")
                    }
                    equal(returned, line.member("returns"), "$place ${line.member("do").str()} returned")
                    continue
                }
                if (line["http"] != null) {
                    val call = line.member("http").str()
                    val c = credential(line); val now = line.member("serverNow").long()
                    val timing = RequestTiming(device.clock.reading(), device.clock.reading())
                    val generated = when (call) {
                        "hello" -> Json.objectOf()
                        "push" -> checkNotNull(engine.nextPush()) { "$path $place sender has no request" }
                        "pull" -> {
                            val scopes = line.member("request").member("scopes").arr().map { ScopeRef(it.member("scope")) }
                            scopes.filter { it.kind !is ScopeRef.Kind.Product }.forEach { engine.subscribe(it) }
                            checkNotNull(engine.pullRequest(scopes)) { "$path $place puller has no request" }
                        }
                        else -> error("$path $place unknown HTTP")
                    }
                    equal(generated, line.member("request"), "$place $call generated request")
                    val response = when (call) {
                        "hello" -> server.hello(c, now)
                        "pull" -> server.pull(generated, c, now)
                        else -> server.push(generated, c, now, PushFaults(line["inject"]?.get("budget")?.long()?.toInt(),
                            line["inject"]?.get("fault")?.arr()?.associate { it.long() to "fault" }.orEmpty()))
                    }
                    equal(response.json, line.member("response"), "$place $call server response")
                    published.addAll(response.events)
                    c.account?.let { accounts[name] = it }
                    if (line["lost"] != Json.of(true)) {
                        val received = SyncResponse(response.status, response.body)
                        when (call) {
                            "hello" -> engine.onHello(received, timing)
                            "push" -> engine.onPushResponse(generated, received, timing)
                            "pull" -> equal(Json.Arr(engine.onPullResponse(generated, received, timing, PullSlicing(Int.MAX_VALUE, Int.MAX_VALUE))), line.member("returns"), "$place pull returned")
                        }
                    }
                    continue
                }
                if (line["frame"] != null) {
                    val frame = line.member("frame"); val account = accounts[name]
                    check(published.any { (!it.dead || ScopeKey.resolve(it.key.ref, account) == it.key) && server.frame(it, account) == frame }) { "$path $place frame was not published" }
                    equal(Json.of(engine.onFrame(frame)), line.member("returns"), "$place frame returned")
                    continue
                }
                error("$path $place unclaimed transcript line")
            }
        } finally { devices.values.forEach(Device::close) }
        return Json.Null
    }
}
