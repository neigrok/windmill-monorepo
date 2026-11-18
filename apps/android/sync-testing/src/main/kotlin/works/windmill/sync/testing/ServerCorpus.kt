package works.windmill.sync.testing

import java.io.File
import works.windmill.sync.core.*
import works.windmill.sync.modelserver.*

object ServerCorpus {
    fun handlers(root: File): Map<String, Handler> {
        val corpus = Corpus(File(root, "sync/corpus"))
        val probe = Registry(Json.parse(File(root, "sync/probe.registry.json").readBytes()))
        fun registry(product: String) = Registry(Json.parse(File(root, "sync/$product.registry.json").readBytes()))
        fun credential(input: Json): Credential = if (input["credential"] == Json.of("unresolved")) Credential.Unresolved else input.member("account").orNull()?.str()?.let(Credential::Account) ?: Credential.Absent
        fun server(input: Json) = ModelServer(probe, ProbeServerRules(), ServerState(input.member("state")), ServerLimits(input["limits"]))
        fun admit(input: Json, registry: Registry = probe, rules: ServerRules = ProbeServerRules()): Json {
            val origin = input.member("origin"); val account = origin.member("account").str()
            val from = if (origin.member("kind").str() == "replica") IntentOrigin(account, origin.member("replica").str(), origin.member("n").long()) else IntentOrigin(account)
            val state = ServerState(input.member("state"))
            val binding = input["effectPlan"]?.let(::EffectPlanRules) ?: rules
            try {
                val (after, answer) = Admission(registry, binding, ServerLimits(input["limits"])).admit(input.member("intent"), from, input.member("serverNow").long(), state)
                return Json.objectOf("result" to answer.result, "state" to after.json)
            } catch (fault: AdmissionFault) {
                if (input["effectPlan"]?.get("fault") != Json.of(true)) throw fault
                return Json.objectOf("fault" to Json.of(true), "state" to state.json)
            }
        }
        val handlers = corpus.paths.filter { it.startsWith("admit/") && it != "admit/requests.json" }.associateWith { { input: Json -> admit(input) } }.toMutableMap<String, Handler>()
        handlers += mapOf(
            "identity/table.json" to { input ->
                val type = probe.type(input.member("type").str())!!; val delta = input.member("delta")
                val life = delta["life"]?.let(::Life)?.let { PlannedLife(it.state, it.stamp) }; val born = delta["born"]?.str()?.let(::Stamp)
                val op = IdentityRules.op(type, life, born)
                if (op == null) Json.objectOf("op" to Json.of("invalid"), "verdict" to Json.of("refuse"), "code" to Json.of("invalid")) else {
                    val idState = input.member("idState"); val row = Row(RecordKey(type.name, RecordID("x")), Lattice(born = idState["born"]?.str()?.let(::Stamp)), seq = 0)
                    val state = IdState(idState.member("state").str(), row.takeIf { idState.member("state").str() in listOf("alive", "dead") })
                    val verdict = IdentityRules.verdict(op, state, born, type.json["revivable"]?.bool() == true)
                    Json.objectOf("op" to Json.of(op), "verdict" to Json.of(if (verdict in listOf("apply", "ok")) verdict else "refuse")).with("code" to verdict.takeUnless { it in listOf("apply", "ok") }?.let(Json::of))
                }
            },
            "machine/scope.json" to { input ->
                val from = input.member("from").str(); val event = input.member("event").str()
                val to = when { from == "absent" && event in listOf("first-write", "governing-create") -> "alive"; from == "alive" && event == "governing-delete" || from == "dead" && event == "horizon" -> "dead"; else -> throw IllegalArgumentException("scope-transition") }
                require(input["to"] == null || input["to"] == Json.of(to)); Json.objectOf("to" to Json.of(to))
            },
            "text/tokens.json" to { input -> Json.objectOf("tokens" to Json.Arr(TextMerge.tokens(input.member("text").str()).map(Json::of))) },
            "text/script.json" to { input -> Json.objectOf("script" to Json.Arr(TextMerge.script(TextMerge.tokens(input.member("a").str()), TextMerge.tokens(input.member("b").str())).map { Json.array(Json.of(it.first.name), Json.of(it.second)) })) },
            "text/diff3.json" to { input -> TextMerge.diff3(input.member("base").str(), input.member("head").str(), input.member("mine").str()).let { Json.objectOf("text" to Json.of(it.text), "conflict" to Json.of(it.conflict)) } },
            "text/merge.json" to { input ->
                try {
                    val merged = TextMerge.merge(TextState(input.member("stored")), TextBase.fromJson(input.member("base")), input.member("mine").str()) { rev -> input.member("revisions").arr().firstOrNull { it.member("rev").long() == rev }?.member("text")?.str() }
                    Json.objectOf("text" to Json.of(merged.text), "conflict" to Json.of(merged.conflict), "merged" to Json.of(merged.merged), "baseText" to Json.of(merged.baseText))
                } catch (refusal: Refusal) { Json.objectOf("refuse" to Json.of(refusal.code)) }
            },
            "envelope/credentials.json" to { input ->
                val c = Credential.resolve(input.member("headers").arr().map { it.arr().let { pair -> require(pair.size == 2); pair[0].str() to pair[1].str() } }, input.member("sessions").obj().mapValues { it.value.str() })
                Json.objectOf("principal" to Json.objectOf("account" to (c.account?.let(Json::of) ?: Json.Null)).with("credential" to if (c == Credential.Unresolved) Json.of("unresolved") else null))
            },
            "gym/admit.json" to { input -> admit(input, registry("gym"), GymServerRules()) },
            "journal/admit.json" to { input -> admit(input, registry("journal"), JournalServerRules()) },
            "journal/revisions.json" to { input ->
                val rows = input.member("revisions").arr().map { row -> Json.objectOf("t" to Json.of("page"), "id" to row.member("day"), "field" to Json.of("body"), "rev" to row.member("rev"), "text" to Json.of("x".repeat(row.member("bytes").long().toInt())), "archivedAt" to row.member("archivedAt")) }
                Json.objectOf("kept" to Json.Arr(JournalServerRules.prune(rows, input.member("days").arr().map(::RecordID).toSet(), input.member("serverNow").long()).map { it.member("rev") }))
            },
            "admit/requests.json" to { input ->
                val s = server(input); val results = input.member("calls").arr().map { call ->
                    s.call(ServerCall(call.member("account").str(), call["requestId"]?.str(), call.member("tool").str(), call.member("args"), call.member("intents").arr()), call.member("serverNow").long(), CallFaults(call["crashAfter"]?.long()?.toInt(), call["transientAt"]?.long()?.toInt(), call["faultAt"]?.long()?.toInt())) ?: Json.Null
                }
                Json.objectOf("results" to Json.Arr(results), "state" to s.state.json)
            },
            "push/serve.json" to { input ->
                val s = server(input); val faults = input["faults"]?.arr()?.associate { it.member("n").long() to it.member("kind").str() }.orEmpty()
                val reply = s.push(input.member("request"), credential(input), input.member("serverNow").long(), PushFaults(input["budget"]?.long()?.toInt(), faults))
                Json.objectOf("response" to reply.json, "state" to s.state.json, "frames" to Json.Arr(reply.events.map { it.json }))
            },
            "pull/serve.json" to { input ->
                val s = server(input); val before = s.state.json; val reply = s.pull(input.member("request"), credential(input), input.member("serverNow").long())
                Json.objectOf("response" to reply.json).with("state" to s.state.json.takeIf { it != before }, "live" to Json.Arr(reply.events.map { it.json }).takeIf { s.state.json != before })
            },
            "pull/hello.json" to { input -> Json.objectOf("response" to server(input).hello(credential(input), input.member("serverTime").long()).json) },
            "live/death.json" to { input -> Json.objectOf("frame" to (server(input).deathFrame(ScopeRef(input.member("scope")), input.member("account").orNull()?.str()) ?: Json.Null)) }
        )
        for (path in corpus.paths.filter { it.startsWith("protocol/") }) handlers[path] = { lines ->
            val list = lines.arr(); val s = ModelServer(probe, ProbeServerRules(), ServerState(list.first().member("server")))
            val published = mutableListOf<LiveEvent>(); val accounts = mutableMapOf<String, String>()
            for (line in list.drop(1)) {
                when {
                    line["end"] != null -> check(line.member("server").jcs == s.state.json.jcs) { "$path end: ${s.state.json.jcs}" }
                    line["server"] == Json.of("load") -> s.restore(ServerState(line.member("state")))
                    line["http"] != null -> {
                        val c = credential(line); val now = line.member("serverNow").long(); val request = line["request"]
                        val reply = when (line.member("http").str()) {
                            "push" -> s.push(request!!, c, now, PushFaults(line["inject"]?.get("budget")?.long()?.toInt(), line["inject"]?.get("fault")?.arr()?.associate { it.long() to "fault" }.orEmpty()))
                            "pull" -> s.pull(request!!, c, now); "hello" -> s.hello(c, now); else -> error("http")
                        }
                        check(reply.json.jcs == line.member("response").jcs) { "$path step ${line["step"]}: expected ${line.member("response").jcs}; actual ${reply.json.jcs}" }
                        published.addAll(reply.events); if (line["device"] != null && c.account != null) accounts[line.member("device").str()] = c.account!!
                    }
                    line["frame"] != null -> {
                        val account = accounts[line.member("device").str()]; val frame = line.member("frame")
                        check(published.any { event -> (!event.dead || ScopeKey.resolve(event.key.ref, account) == event.key) && s.frame(event, account) == frame }) { "$path unpublished frame ${frame.jcs}" }
                    }
                }
            }
            Json.Null
        }
        return handlers
    }
}

fun runServerCorpus(root: File) {
    val corpus = Corpus(File(root, "sync/corpus"))
    val handlers = ServerCorpus.handlers(root)
    val server = corpus.paths.filter { Corpus.role(it) == CorpusRole.SERVER }
    val protocols = corpus.paths.filter { it.startsWith("protocol/") }
    val cases = corpus.run(handlers, server)
    val transcripts = corpus.run(handlers, protocols)
    println("model server: ${server.size} server-role files / $cases cases; ${protocols.size} protocol files / $transcripts transcripts")
}

fun main(args: Array<String>) = runServerCorpus(File(args.single()))

internal class EffectPlanRules(val plan: Json) : ServerRules {
    val probe = ProbeServerRules()
    override val localCheckTypes get() = plan["legacyTypes"]?.arr()?.map { it.str() }?.toSet() ?: probe.localCheckTypes
    override fun check(changes: List<RecordChange>, context: RuleContext) = probe.check(changes, context)
    override fun replays(command: CheckedCommand, context: RuleContext) = probe.replays(command, context)
    override fun discoverEffectScopes(context: RuleContext, command: CheckedCommand?) =
        probe.discoverEffectScopes(context, command) + plan["declared"]?.arr().orEmpty().map { ScopeKey(it.str()) }
    override fun run(command: CheckedCommand, context: RuleContext): CommandOutcome {
        val result = probe.run(command, context)
        val into = result.into.toMutableMap()
        for ((scope, deltas) in effects("command", context)) into[scope] = into[scope].orEmpty() + deltas
        return result.copy(into = into, detail = if ("detail" in plan.obj()) plan["detail"] else result.detail)
    }
    override fun effects(changes: List<RecordChange>, context: RuleContext): Effects {
        val byScope = super<ServerRules>.effects(changes, context).byScope.toMutableMap()
        for ((scope, deltas) in effects("check", context)) byScope[scope] = byScope[scope].orEmpty() + deltas
        return Effects(byScope)
    }
    fun effects(stage: String, context: RuleContext) = plan[stage]?.obj().orEmpty().map { (key, values) ->
        val scope = ScopeKey(key)
        scope to values.arr().map { IntentShape.effect(it, scope, stage, context.registry) }
    }.toMap()
    override fun pruneRevisions(revisions: List<Json>, archived: List<Json>, now: Long, scope: ScopeKey, context: ServerState) =
        probe.pruneRevisions(revisions, archived, now, scope, context)
}
