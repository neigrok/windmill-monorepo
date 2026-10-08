package works.windmill.sync.testing

import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.engine.*

object NetworkCorpus {
    val paths = listOf("commit/grouping.json", "commit/retire.json", "commit/throws.json", "hold/release.json", "hold/undo.json",
        "lineage/signin.json", "lineage/signout.json", "lineage/start.json", "pull/pages.json", "refusal/base-unknown.json",
        "refusal/fold.json", "refusal/restamp.json", "refusal/transport.json", "write/map.json")

    fun handlers(registry: Registry): Map<String, Handler> = paths.associateWith { { input: Json -> run(registry, input) } }

    private fun run(registry: Registry, input: Json): Json {
        var wall = 0L
        var gestures = 0
        val queues = listOf("ids", "actors", "forkGuards", "draws").associateWith { input[it]?.arr().orEmpty() }
        val consumed = queues.mapValues { 0 }.toMutableMap()
        fun take(name: String): Json {
            val index = consumed.getValue(name)
            val next = queues.getValue(name).getOrNull(index) ?: error("vector exhausted $name")
            consumed[name] = index + 1
            return next
        }
        var current = input["actor"]?.str() ?: "r_aaaaaaaaaaaa"
        val clock = object : EngineClock {
            override fun now() = wall
            override fun reading() = ClockReading(wall, wall, "boot-1")
        }
        val identities = object : IdentitySource {
            override fun opaqueID() = "g${++gestures}"
            override fun draw(bound: Int) = take("draws").long(0).toInt().also { check(it in 0 until bound) }
            override fun replicaID() = take("ids").str()
            override fun actorID() = take("actors").str()
            override fun forkGuard() = take("forkGuards").str()
        }
        Engine.memory(registry, input.member("device"), clock, identities, current,
            input["limits"]?.get("PUSH_MAX_BYTES")?.long(1)?.toInt() ?: Constants.PUSH_MAX_BYTES).use { engine ->
            var lastPush: Json? = null
            var lastPull: Json? = null
            var pulledFor: String? = null
            val returns = input.member("steps").arr().map { step ->
                wall = step["deviceNow"]?.long() ?: 0
                val beforeGestures = gestures
                val beforeConsumed = consumed.toMap()
                val beforeActor = current
                val stepActor = step["actor"]?.str() ?: current
                engine.actor = stepActor
                val appVersion = step["appVersion"]?.str() ?: "1"
                val send = step["send"]?.let(::ClockReading) ?: (step["tSend"]?.long() ?: wall).let { ClockReading(it, it, "boot-1") }
                val recv = step["recv"]?.let(::ClockReading) ?: (step["tRecv"]?.long() ?: wall).let { ClockReading(it, it, "boot-1") }
                val timing = RequestTiming(send, recv)
                fun response(): SyncResponse {
                    val response = step.member("response")
                    return SyncResponse(response.member("status").long().toInt(), response["body"])
                }
                try {
                    val value = when (step.member("op").str()) {
                        "commit" -> if (step["changes"] === Json.Null) {
                            engine.commit(ScopeRef(step.member("scope"))) { null to Unit }; Json.Null
                        } else ClientCorpus.outcome(engine.commit(ScopeRef(step.member("scope")),
                            ClientCorpus.gesture(step["changes"] ?: Json.array(), step["opts"] ?: Json.objectOf())))
                        "release" -> Json.of(engine.release(step.member("localId").str()))
                        "releaseAll" -> { engine.releaseHeld(true); Json.Null }
                        "releaseDue" -> { engine.releaseHeld(); Json.Null }
                        "undo" -> Json.of(engine.undo(step.member("gestureId").str()))
                        "dismiss" -> { engine.dismissNotice(step.member("id").str()); Json.Null }
                        "push" -> engine.nextPush(step["limit"]?.long(1)?.toInt() ?: Constants.PUSH_MAX_INTENTS).also { lastPush = it } ?: Json.Null
                        "pushResponse" -> engine.onPushResponse(checkNotNull(lastPush) { "response without push" }, response(), timing,
                            step["dieAfter"]?.long(0)?.toInt() ?: Int.MAX_VALUE) ?: Json.Null
                        "hello" -> { engine.onHello(response(), timing); Json.Null }
                        "engineStart" -> engine.start(step["backupGuard"])
                        "pull" -> engine.pullRequest(step.member("scopes").arr().map(::ScopeRef)).also {
                            lastPull = it; pulledFor = engine.activeReplica()
                        } ?: Json.Null
                        "pullResponse" -> if (pulledFor != engine.activeReplica()) Json.Null else Json.Arr(engine.onPullResponse(
                            checkNotNull(lastPull) { "response without pull" }, response(), timing,
                            PullSlicing(step["chunk"]?.long(1)?.toInt() ?: 128, step["settle"]?.long(1)?.toInt() ?: 64,
                                step["dieAfter"]?.long(0)?.toInt() ?: Int.MAX_VALUE), appVersion))
                        "frame" -> Json.of(engine.onFrame(step.member("frame"), appVersion))
                        "subscribe" -> engine.subscribe(ScopeRef(step.member("scope")))?.let(Json::of) ?: Json.Null
                        "reconcile" -> {
                            engine.reconcile(step["scopes"]?.arr()?.map(::ScopeRef)?.toSet() ?: engine.subscriptions(registry.products.keys.toList()))
                            Json.Null
                        }
                        "signIn" -> engine.signIn(step.member("account").str(), step.member("holdsRecords").obj().mapValues { it.value.bool() },
                            step["decisions"]?.obj()?.mapValues { it.value.str() }.orEmpty(),
                            step["counted"]?.obj()?.mapValues { it.value.arr().map(Json::str) }.orEmpty())
                        "signOut" -> engine.signOut(step["choice"]?.str(), step["counted"]?.arr()?.map(Json::str))
                        "discardUnsent" -> { engine.discardUnsent(step.member("replica").str()); Json.Null }
                        "reidentify" -> { engine.reidentify(); Json.Null }
                        "epochChange" -> { engine.epochChange(step.member("epoch").str()); Json.Null }
                        "anonCount" -> engine.anonCount(step.member("replica").str(), step.member("product").str())
                        "view" -> {
                            val scope = ScopeRef(step.member("scope"))
                            val shown = engine.materialized(scope, if (step.member("withHeld").bool()) ViewMode.drawn else ViewMode.stored)
                            val caps = registry.types.filter { registry.lives(it.name, scope) && it.cap != null }.map { type ->
                                type.name to Json.of(engine.read(scope) { it.stored(type.name).size })
                            }
                            Json.objectOf("records" to shown.member("records"), "capCount" to Json.Obj(caps))
                        }
                        else -> error("unsupported network vector step ${step.member("op").str()}")
                    }
                    if (engine.actor != stepActor) current = engine.actor
                    value
                } catch (_: CommitFailure) {
                    gestures = beforeGestures; consumed.putAll(beforeConsumed); current = beforeActor
                    Json.objectOf("throws" to Json.of(true))
                } catch (_: TransitionError) {
                    gestures = beforeGestures; consumed.putAll(beforeConsumed); current = beforeActor
                    Json.objectOf("throws" to Json.of(true))
                } catch (_: JsonError) {
                    gestures = beforeGestures; consumed.putAll(beforeConsumed); current = beforeActor
                    Json.objectOf("throws" to Json.of(true))
                } finally { engine.actor = current }
            }
            return Json.Obj(buildList {
                add("returns" to Json.Arr(returns)); add("device" to engine.snapshot()); add("ended" to Json.Arr(engine.ended()))
                engine.diagnostics().takeIf { it.isNotEmpty() }?.let { add("telemetry" to Json.Arr(it)) }
                engine.events().takeIf { it.isNotEmpty() }?.let { add("events" to Json.Arr(it)) }
            })
        }
    }
}
