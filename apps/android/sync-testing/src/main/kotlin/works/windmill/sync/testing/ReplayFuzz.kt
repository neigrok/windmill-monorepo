package works.windmill.sync.testing

import java.util.Random
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.RecordID
import works.windmill.sync.core.Command
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*
import works.windmill.sync.modelserver.Reply

// A ports driver: numbering, admission, reconciliation, recovery and lineage all run in production modules.
// The simulator retains only requests, snapshots and an external ledger of committed/ended local ids.
object ReplayFuzz {
    const val COVERAGE_SEEDS = 60
    const val COVERAGE_STEPS = 60
    val coverage = listOf("commit", "held", "undo", "retire", "supersede", "release", "rollback", "idle rollback",
        "reopen", "clone", "clock jump", "malformed", "request lost", "reply lost", "request duplicated", "delayed reply", "delivered out of order",
        "process death", "death between page chunks", "death between settling slices", "death between result batches",
        "page short of its head", "frame answered pull", "frame lost", "refused clock-skew", "reboot", "left the app", "second tab commit",
        "sign-in complete", "sign-in incomplete", "sign-in add", "sign-in discard", "sign-out keep", "sign-out discard",
        "http 401 unauthenticated", "pull served as anonymous", "pull served as another account", "frame served as anonymous", "frame served as another account",
        "http 409 account-mismatch", "refused internal", "epoch change", "server restored", "store restored", "http 409 gap", "http 409 replica-forked",
        "activeReplicaChanged announced", "ok with a joining write map", "refused cap", "http 413 request-too-large", "retry", "http 400 malformed", "ended refused by target-merged", "clock error +10min", "clock error -10min", "delayed across lineage")
    data class Report(val seed: Long, val steps: Int, val events: Map<String, Int>, val trace: String, val entriesChecked: Int)
    fun run(registry: Registry, seed: Long, steps: Int): Report = World(registry, seed).use { world ->
        try { world.run(steps) } catch (failure: Throwable) { throw IllegalStateException("replay seed=$seed step=${world.currentStep}", failure) }
    }

    private class World(val registry: Registry, val seed: Long) : AutoCloseable {
        val random = Random(seed)
        val clock = SimClock(1_800_000_000_000)
        val serverClock = SimClock(clock.now())
        val model = ModelServer(registry, ProbeServerRules(), limits = ServerLimits(Json.objectOf("PULL_PAGE_BYTES" to Json.of(512))))
        val handle = ModelServerHandle(model, serverClock)
        var transport = InMemoryTransport(handle, clock)
        val scope = ScopeRef.product("probe")
        val events = linkedMapOf<String, Int>()
        val ledger = mutableSetOf<String>()
        val terminal = mutableSetOf<String>()
        val skewRefusals = mutableMapOf<String, Int>()
        val skewAdmissions = mutableSetOf<Triple<String, Long, String>>()
        val trace = java.security.MessageDigest.getInstance("SHA-256")
        var identities = 0
        var checked = 0
        var eventIndex = 0
        var endedIndex = 0
        var lastActive = ""
        var ordinal = 0
        var currentStep = -1
        var engine = open()
        init { lastActive = engine.activeReplica(); engine.start(Json.of("original-copy")); engine.signIn("A", emptyMap()); checkStep() }
        fun count(event: String, n: Int = 1) { if (n > 0) events[event] = (events[event] ?: 0) + n }
        fun open(snapshot: Json? = null) = Engine.memory(registry, snapshot, clock, object : IdentitySource {
            override fun opaqueID() = "seed-$seed-g${++identities}"
            override fun draw(bound: Int) = random.nextInt(bound)
        }, actor = "r_aaaaaaaaaaaa")
        fun active(snapshot: Json = engine.snapshot()) = snapshot.member("replicas").arr().single { it.member("meta").member("replica") == snapshot.member("active") }
        fun outbox(snapshot: Json = engine.snapshot()) = snapshot.member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }
        fun account() = active().member("meta")["account"]?.orNull()?.str()
        fun credential() = account()?.let { Credential.Account(it) } ?: Credential.Absent
        fun timing() = RequestTiming(clock.reading(), clock.reading())
        fun pulled() = active().let { Json.objectOf("confirmed" to (it["confirmed"] ?: Json.objectOf()), "spent" to (it["spentIds"] ?: Json.objectOf()), "staging" to (it["staging"] ?: Json.objectOf())) }
        fun day(index: Int = random.nextInt(8)) = RecordID("2026-10-${(index + 1).toString().padStart(2, '0')}")
        fun id(prefix: String = "card") = RecordID("$prefix${(++ordinal).toString().padStart(8, '0')}")
        fun commit(gesture: Gesture): CommitOutcome {
            return engine.commit(scope, gesture).also { result ->
                if (result is CommitOutcome.Committed) {
                    ledger.addAll(result.receipt.localIds); count("commit")
                    if (gesture.hold) count("held")
                    count("retire", result.receipt.retired.size); count("supersede", result.receipt.superseded.size)
                } else if (result is CommitOutcome.Refused) count("refused ${result.code.text}")
            }
        }
        fun put(hold: Boolean = false, target: RecordID = day()): CommitOutcome {
            val before = engine.read(scope) { it.drawn("day", target) }?.values?.get("score")
            var value = random.nextInt(11)
            if (before == Json.of(value)) value = (value + 1) % 11
            return commit(Gesture(listOf(Change.put("day", target, true, mapOf("score" to Json.of(value)))), hold = hold))
        }
        fun answerPush(request: Json, reply: Reply, dieAfter: Int = Int.MAX_VALUE) {
            val before = pulled(); val wrong = account() != null && reply.body["as"] != Json.of(account()!!)
            val error = reply.body["error"]?.str()
            if (reply.status == 401) count("http 401 unauthenticated")
            if (reply.status == 409 && error in setOf("account-mismatch", "gap", "replica-forked")) count("http 409 $error")
            if (reply.status == 413) count("http 413 request-too-large")
            if (reply.status == 400) count("http 400 malformed")
            for (result in reply.body["results"]?.arr().orEmpty()) {
                if (result["code"] == Json.of("clock-skew")) {
                    val intent = request.member("intents").arr().single { it["n"] == result["n"] }
                    val digest = Sha256.hex(intent.jcs.encodeToByteArray())
                    val seat = engine.snapshot().member("replicas").arr().firstOrNull { it.member("meta").member("replica") == request.member("replica") }
                    val entry = seat?.get("outbox")?.arr()?.firstOrNull { it["n"] == result["n"] && it["state"] == Json.of("sent") && it["digest"] == Json.of(digest) }
                    if (entry != null && skewAdmissions.add(Triple(request.member("replica").str(), result.member("n").long(), digest))) {
                        count("refused clock-skew")
                        val id = entry.member("localId").str()
                        skewRefusals[id] = (skewRefusals[id] ?: 0) + 1
                        check(skewRefusals.getValue(id) == 1) { "seed=$seed entry=$id refused clock-skew twice under distinct admissions: request=${request.jcs} entry=${entry.jcs}" }
                    }
                }
                if (result["code"] == Json.of("internal")) count("refused internal")
                if (result["code"] == Json.of("cap")) count("refused cap")
                if (result["write"]?.arr()?.any { it["from"] != null } == true) count("ok with a joining write map")
            }
            if (reply.body["retry"]?.orNull() != null) count("retry")
            engine.onPushResponse(request, SyncResponse(reply.status, reply.body), timing(), dieAfter)
            if (wrong) check(before == pulled()) { "wrong-principal push changed pulled rows" }
            checkStep()
        }
        fun push(faults: PushFaults = PushFaults(), credential: Credential = credential(), dieAfter: Int = Int.MAX_VALUE): Reply? {
            val held = outbox().filter { it["state"] == Json.of("held") }.map { it.member("gestureId").str() }
            val request = engine.nextPush() ?: return null
            check(request.member("intents").arr().none { it["gestureId"]?.str() in held }) { "held gesture sent" }
            val reply = model.push(request, credential, serverClock.now(), faults)
            answerPush(request, reply, dieAfter)
            return reply
        }
        fun requestPull(): Json? { val scopes = engine.subscriptions(listOf("probe")); engine.reconcile(scopes); return engine.pullRequest(scopes) }
        fun answerPull(request: Json, reply: Reply, slicing: PullSlicing? = null) {
            val before = pulled(); val wrong = account() != null && reply.body["as"] != Json.of(account()!!)
            if (wrong && reply.status == 200) count(if (reply.body["as"] === Json.Null) "pull served as anonymous" else "pull served as another account")
            if (reply.status == 401) count("http 401 unauthenticated")
            if (reply.body["pages"]?.arr()?.any { it["more"] == Json.of(true) } == true) count("page short of its head")
            engine.onPullResponse(request, SyncResponse(reply.status, reply.body), timing(), slicing)
            if (wrong) check(before == pulled()) { "wrong-principal pull changed pulled rows" }
            checkStep()
        }
        fun pull(slicing: PullSlicing? = null, credential: Credential = credential()): Reply? {
            val request = requestPull() ?: return null
            return model.pull(request, credential, serverClock.now()).also { answerPull(request, it, slicing) }
        }
        fun frame(frame: Json, replicaID: String = engine.activeReplica()): String {
            val before = pulled(); val wrong = account() != null && frame["as"] != Json.of(account()!!)
            val outcome = engine.onFrame(frame, replicaID = replicaID)
            if (wrong) {
                count(if (frame["as"] === Json.Null) "frame served as anonymous" else "frame served as another account")
                check(before == pulled()) { "wrong-principal frame changed pulled rows" }
            }
            if (outcome == "applied") count("frame answered pull")
            checkStep(); return outcome
        }
        fun recoverAuthentication() = engine.reauthenticate()
        fun settle() {
            if (account() == null) { engine.signIn("A", mapOf("probe" to false)); checkStep() }
            recoverAuthentication(); engine.releaseHeld(true)
            repeat(512) {
                push(); val reply = pull()
                val active = active()
                val more = reply?.body?.get("pages")?.arr()?.any { it["more"] == Json.of(true) || it["kind"] == Json.of("reset") } == true
                if (active["outbox"]?.arr().isNullOrEmpty() && !more) {
                    check(active["staging"]?.obj().isNullOrEmpty())
                    check(engine.diagnostics().none { it["event"] == Json.of("sync-digest-mismatch") })
                    checkRows(); checkStep(); return
                }
            }
            error("seed=$seed network did not quiesce: ${engine.snapshot().jcs}")
        }
        fun checkRows() {
            val principal = account()!!
            val state = model.state
            for ((scopeKey, rows) in state.rows) for (type in registry.types.filter { it.cap != null }) {
                check(rows.values.map(::Row).count { it.isAlive && it.key.type == type.name } <= type.cap!!) { "seed=$seed scope=$scopeKey server cap exceeded" }
            }
            for ((known, kind) in active()["known"]?.obj().orEmpty()) if (kind == Json.of("not-found")) {
                val key = ScopeKey.resolve(ScopeRef(known), principal)
                check(key == null || state.scopes[key.text]?.let { it.state == "alive" && it.owner == principal } != true) { "owned alive scope marked not-found" }
            }
            for (sub in engine.subscriptions(listOf("probe"))) {
                val key = ScopeKey.resolve(sub, principal)!!
                val expected = state.rows[key.text].orEmpty().values.map(::Row).filter { it.isAlive }.sortedBy { it.key }
                for (type in registry.types.filter { registry.lives(it.name, sub) }) {
                    val wanted = expected.filter { it.key.type == type.name }
                    val actual = engine.read(sub) { it.drawn(type.name) }.sortedBy { it.id }
                    check(wanted.map { it.key.id } == actual.map { it.id }) { "seed=$seed type=${type.name} row identities diverged" }
                    for ((row, drawn) in wanted.zip(actual)) {
                        check(row.lattice.fields.mapValues { it.value.value } == drawn.values) { "seed=$seed key=${row.key} values diverged" }
                        check(row.lattice.life == drawn.life && row.lattice.born == drawn.born) { "seed=$seed key=${row.key} stamps diverged" }
                    }
                }
                val stored = active()["confirmed"]?.get(sub.text)?.arr().orEmpty()
                val digest = stored.fold(ScopeDigest.ZERO) { value, row -> value.replacing(null, row) }
                val recorded = active()["cursors"]?.get(sub.text)?.get("digest")
                if (recorded != null) check(recorded == Json.of(digest.hex)) { "seed=$seed incremental digest diverged" }
                val status = active()["known"]?.get(sub.text)
                check(status != Json.of("not-found") || sub.kind is ScopeRef.Kind.Tree && state.scopes[key.text]?.owner != principal) { "owned alive scope marked not-found" }
            }
        }
        fun checkStep() {
            val stream = engine.events()
            for (event in stream.drop(eventIndex).filter { it["event"] == Json.of("activeReplicaChanged") }) {
                check(event["previous"] == Json.of(lastActive)) { "seed=$seed unannounced previous active id $lastActive: ${event.jcs}" }
                lastActive = event.member("replica").str(); count("activeReplicaChanged announced")
            }
            eventIndex = stream.size
            check(lastActive == engine.activeReplica()) { "seed=$seed active id changed without an announcement" }
            val ended = engine.ended()
            val freshEnds = ended.drop(endedIndex)
            val notices = engine.snapshot().member("replicas").arr().flatMap { it["notices"]?.arr().orEmpty() }.map { it.member("id").str() }.toSet()
            for (end in freshEnds.filter { it["outcome"] == Json.of("refused") }) {
                val origin = end["orphanOf"]?.str() ?: end.member("localId").str()
                check("notice:$origin" in notices) { "seed=$seed refused content missing notice" }
            }
            count("ended refused by target-merged", freshEnds.count { it["event"] == Json.of("target-merged") })
            terminal.addAll(freshEnds.map { it.member("localId").str() }); endedIndex = ended.size
            val entries = outbox(); checked += entries.size
            check(ledger.all { id -> id in terminal || entries.any { it.member("localId").str() == id } }) { "seed=$seed lost committed local id" }
            for (entry in entries.filter { it.member("state") == Json.of("sent") }) {
                check(entry.member("digest") == Json.of(Sha256.hex(entry.member("intent").jcs.encodeToByteArray()))) { "numbered intent mutated" }
            }
        }
        fun reopen(snapshot: Json = engine.snapshot(), cloned: Boolean = false) {
            checkStep(); transport.close(); engine.close()
            transport = InMemoryTransport(handle, clock); engine = open(snapshot)
            eventIndex = 0; endedIndex = 0; lastActive = engine.activeReplica()
            check(engine.snapshot() == snapshot)
            if (cloned) {
                val previous = engine.activeReplica(); val result = engine.start(Json.of("different-copy"))
                check(result.member("reidentified").bool() && previous != engine.activeReplica())
                count("clone")
            } else { engine.start(); count("reopen") }
            checkStep(); count("process death")
        }
        fun networkFault(kind: Int) {
            engine.releaseHeld(true)
            put(); val request = engine.nextPush() ?: error("bound sender failed")
            transport.next = when (kind) {
                0 -> InMemoryTransport.Fault(drop = true)
                1 -> InMemoryTransport.Fault(loseReply = true)
                2 -> InMemoryTransport.Fault(duplicate = true)
                else -> InMemoryTransport.Fault(delayMs = 20)
            }
            val beforeDelivery = model.state.json
            val old = transport.request("push", request, credential(), 50)
            if (kind <= 1) {
                clock.advance(50)
                try { old.get(); error("lost request unexpectedly answered") } catch (error: ExecutionException) { check(error.cause is TimeoutException) }
                count(if (kind == 0) "request lost" else "reply lost")
                if (kind == 0) check(beforeDelivery == model.state.json)
                val admitted = model.state.json
                val retry = transport.request("push", request, credential()).get()
                if (kind == 1) check(admitted == model.state.json) { "lost reply retry admitted twice" }
                answerPush(request, retry)
            } else if (kind == 2) {
                val reply = old.get(); val admitted = model.state.json
                transport.request("push", request, credential()).get()
                check(admitted == model.state.json) { "duplicated request admitted twice" }
                answerPush(request, reply); count("request duplicated")
            } else {
                check(!old.isDone); put(); val newer = engine.nextPush()!!
                answerPush(newer, transport.request("push", newer, credential()).get())
                clock.advance(20); answerPush(request, old.get()); count("delayed reply"); count("delivered out of order")
            }
            check(transport.inFlight == 0 && clock.sleeping == 0)
        }
        fun shortPagesAndFrames() {
            settle(); repeat(8) { put(target = day(it)) }; admitPending()
            // Force boot over the multi-page scope while preserving confirmed rows until the final swap.
            engine.reidentify(); engine.epochChange(model.state.epoch)
            val first = pull()!!
            check(first.body.member("pages").arr().any { it["more"] == Json.of(true) }) { "acknowledged boot fixture lacked a short page: ${first.json.jcs}" }
            val target = day(); put(target = target)
            val reply = push()!!
            val event = reply.events.firstOrNull { it.key.ref == scope }
            event?.let { model.frame(it, account())?.let { frame ->
                // A frame arriving between boot pages asks for pull, and never advances a boot cursor.
                val before = active()["cursors"]; check(this.frame(frame) == "pull"); check(before == active()["cursors"])
            } }
            settle()
            put(target = target); val inline = push()!!.events.first { it.key.ref == scope }
            check(frame(model.frame(inline, account())!!) == "applied")
            put(target = target); val lost = push()!!.events.first { it.key.ref == scope }
            check(model.frame(lost, account()) != null); count("frame lost")
        }
        fun crashBoundary(kind: Int) {
            settle()
            if (kind == 0) {
                repeat(3) { put(target = day(it)) }; val request = engine.nextPush()!!
                val reply = model.push(request, credential(), serverClock.now())
                answerPush(request, reply, 1)
                check(outbox().any { it["state"] == Json.of("sent") }); count("death between result batches"); reopen()
            } else if (kind == 1) {
                repeat(4) { put(target = day(it)) }; admitPending()
                val before = pulled(); val reply = pull(PullSlicing(chunkRows = 1, settle = 1, dieAfter = 1))!!
                check(reply.body.member("pages").arr().any { it.member("rows").arr().size >= 2 })
                check(before != pulled()); count("death between page chunks"); reopen()
            } else {
                repeat(5) { put(target = day(0)) }; admitPending()
                pull(PullSlicing(chunkRows = 32, settle = 1, dieAfter = 1))
                check(outbox().any { it["state"] == Json.of("acked") }) { "settling slice did not leave an acknowledged entry" }
                count("death between settling slices"); reopen()
            }
        }
        fun admitPending() {
            // A prior clock error can require recovery before these entries are acknowledged. Do not pull:
            // the crash scenario needs real acknowledged entries still waiting for the settling transaction.
            repeat(64) {
                if (active()["outbox"]?.arr().orEmpty().all { it["state"] == Json.of("acked") }) return
                check(push() != null) { "prepared crash entries could not be sent" }
            }
            error("seed=$seed crash scenario entries did not reach acknowledgment")
        }
        fun wrongCredentials() {
            settle(); put()
            push(credential = Credential.Unresolved); recoverAuthentication()
            push(credential = Credential.Account("B")); recoverAuthentication()
            pull(credential = Credential.Absent); recoverAuthentication()
            pull(credential = Credential.Account("B")); recoverAuthentication()
            val synthetic = Json.objectOf("op" to Json.of("change"), "scope" to scope.json, "epoch" to Json.of(model.state.epoch),
                "seq" to Json.of(999), "digest" to Json.of(ScopeDigest.ZERO.hex), "rows" to Json.array())
            frame(synthetic.with("as" to Json.Null)); recoverAuthentication()
            frame(synthetic.with("as" to Json.of("B"))); recoverAuthentication()
        }
        fun delayedAcrossLineage() {
            settle(); val original = engine.activeReplica(); val originalAccount = account()!!
            put(); val request = engine.nextPush()!!
            transport.next = InMemoryTransport.Fault(delayMs = 20)
            val delayed = transport.request("push", request, credential())
            engine.signOut("keep"); count("sign-out keep"); checkStep()
            val other = if (originalAccount == "A") "B" else "A"
            engine.signIn(other, mapOf("probe" to false)); count("sign-in complete"); checkStep()
            put(); push(); pull()
            val before = pulled()
            clock.advance(20)
            val reply = delayed.get(); answerPush(request, reply)
            check(before == pulled()) { "late push crossed account lineage" }
            for (event in reply.events) model.frame(event, originalAccount)?.let { check(frame(it, original) == "outside") }
            settle()
            engine.signOut("discard"); count("sign-out discard"); checkStep()
            engine.signIn(originalAccount, mapOf("probe" to false)); count("sign-in complete"); checkStep()
            settle(); count("delayed across lineage")
            check(transport.inFlight == 0 && clock.sleeping == 0)
        }
        fun lineage() {
            settle(); put(); engine.signOut("keep"); count("sign-out keep"); checkStep()
            put(); val incomplete = engine.signIn("A", mapOf("probe" to true)); check(!incomplete.member("complete").bool()); count("sign-in incomplete"); checkStep()
            val answer = if (random.nextBoolean()) "add" else "discard"
            val completed = engine.signIn("A", mapOf("probe" to true), mapOf("probe" to answer)); check(completed.member("complete").bool())
            count("sign-in $answer"); count("sign-in complete"); checkStep()
            put(); engine.signOut("discard"); count("sign-out discard"); checkStep()
            put(); check(engine.signIn("A", mapOf("probe" to false)).member("complete").bool()); count("sign-in complete"); checkStep()
        }
        fun serverFaults(kind: Int) {
            settle(); put(); val request = engine.nextPush()!!
            if (kind == 0) {
                val n = request.member("intents").arr().first().member("n").long()
                repeat(Constants.K_POISON) { answerPush(request, model.push(request, credential(), serverClock.now(), PushFaults(byN = mapOf(n to "fault")))) }
            } else if (kind == 1) {
                answerPush(request, model.push(request, credential(), serverClock.now(), PushFaults(budget = 0)))
            } else if (kind == 2) {
                val tooSmall = ModelServer(registry, ProbeServerRules(), limits = ServerLimits(Json.objectOf("PUSH_MAX_BYTES" to Json.of(10))))
                answerPush(request, tooSmall.push(request, credential(), serverClock.now()))
            } else {
                // Wire corruption is a transport fault. Feed the answer to the real sender for the original request.
                answerPush(request, model.push(Json.objectOf(), credential(), serverClock.now()))
            }
        }
        fun joinAndCap() {
            settle()
            repeat(2) { iteration ->
                val run = id("run")
                commit(Gesture(emptyList(), command = Command("probe.start", Json.objectOf("id" to run.json, "startedAt" to Json.of(serverClock.now()), "join" to Json.of(true))),
                    predict = listOf(Change.create("run", NewID.Given(run), mapOf("startedAt" to Json.of(serverClock.now()))))))
                if (iteration == 1) commit(Gesture(listOf(Change.delete("run", run)), hold = true))
                push(); pull()
            }
            repeat(5) { commit(Gesture(listOf(Change.create("card", NewID.Given(id()), mapOf("title" to Json.of("cap")))))); push(); pull() }
        }
        fun restoredOrForked(kind: Int) {
            settle(); put()
            if (kind == 0) {
                val snapshot = model.state.copy(); snapshot.epoch = "restored-$seed-${++ordinal}"
                model.restore(snapshot); count("server restored"); val before = engine.activeReplica(); push(); pull()
                check(before != engine.activeReplica()); count("epoch change")
            } else if (kind == 1) {
                val request = engine.nextPush()!!; val state = model.state.copy()
                state.replicas[engine.activeReplica()] = Json.objectOf("account" to Json.of(account()!!), "lastN" to Json.of(999))
                model.restore(state); answerPush(request, model.push(request, credential(), serverClock.now()))
            } else {
                val request = engine.nextPush()!!; val state = model.state.copy()
                state.replicas.remove(engine.activeReplica()); state.results.remove(engine.activeReplica())
                model.restore(state)
                val intents = request.member("intents").arr()
                val changed = request.with("intents" to Json.Arr(intents.map { it.with("n" to Json.of(it.member("n").long() + 5)) }))
                answerPush(request, model.push(changed, credential(), serverClock.now()))
            }
        }
        fun nonResurrection() {
            settle()
            var key = model.state.rows["acct:${account()}/probe"].orEmpty().values.map(::Row).firstOrNull { it.key.type == "card" && it.isAlive }?.key
            if (key == null) {
                val card = id(); commit(Gesture(listOf(Change.create("card", NewID.Given(card), mapOf("title" to Json.of("dead")))))); settle()
                key = RecordKey("card", card)
            }
            val alive = model.state.rows.getValue("acct:${account()}/probe").getValue(key).let(::Row)
            commit(Gesture(listOf(Change.delete("card", key.id)))); settle()
            check(model.state.idState(key, ScopeKey("acct:${account()}/probe"), registry).state == "dead")
            check(engine.read(scope) { it.drawn("card", key.id) } == null)
            try { commit(Gesture(listOf(Change.update("card", key.id, mapOf("title" to Json.of("zombie")))))); error("client composed update of spent id") }
            catch (failure: CommitFailure) { check(failure.kind == CommitFailure.Kind.malformed) }
            model.call(ServerCall(account()!!, null, "stale-create", Json.objectOf(), listOf(Intent(scope, deltas = listOf(Delta(key, alive.lattice))).json)), serverClock.now())
            settle()
            check(model.state.idState(key, ScopeKey("acct:${account()}/probe"), registry).state == "dead") { "admitted delete resurrected without revive" }
            check(engine.read(scope) { it.drawn("card", key.id) } == null)
        }
        fun privateScopeIsolation() {
            settle()
            val board = RecordID("b_" + (++ordinal).toString(16).padStart(8, '0'))
            commit(Gesture(listOf(Change.create("board", NewID.Given(board)))))
            settle()
            val privateScope = ScopeRef.tree(board.string!!)
            val missingScope = ScopeRef.tree("b_ffffffff")
            val request = Json.objectOf("scopes" to Json.array(Json.objectOf("scope" to privateScope.json, "cursor" to Json.Null)))
            val missing = Json.objectOf("scopes" to Json.array(Json.objectOf("scope" to missingScope.json, "cursor" to Json.Null)))
            for (credential in listOf(Credential.Absent, Credential.Account("B"))) {
                val denied = model.pull(request, credential, serverClock.now()).body.member("pages").arr().single()
                val absent = model.pull(missing, credential, serverClock.now()).body.member("pages").arr().single()
                check(denied.member("kind") == Json.of("not-found"))
                check(denied.with("scope" to Json.Null) == absent.with("scope" to Json.Null)) { "private scope existence leaked" }
                answerPull(request, Reply(200, model.pull(request, credential, serverClock.now()).body))
                recoverAuthentication()
            }
        }
        fun secondTab() {
            settle(); val tab = open(); val target = day()
            try {
                tab.start(); tab.signIn(account()!!, emptyMap())
                val hello = model.hello(credential(), serverClock.now())
                tab.onHello(SyncResponse(hello.status, hello.body), timing())
                val result = tab.commit(scope, Gesture(listOf(Change.put("day", target, true, mapOf("score" to Json.of(7))))))
                check(result is CommitOutcome.Committed); count("second tab commit")
                var attempts = 0
                var more: Boolean
                do {
                    check(attempts++ < 64) { "second tab did not quiesce" }
                    tab.nextPush()?.let { request ->
                        val reply = model.push(request, credential(), serverClock.now())
                        tab.onPushResponse(request, SyncResponse(reply.status, reply.body), timing())
                    }
                    val request = tab.pullRequest(listOf(scope))!!
                    val reply = model.pull(request, credential(), serverClock.now())
                    tab.onPullResponse(request, SyncResponse(reply.status, reply.body), timing())
                    more = reply.body.member("pages").arr().any { it["more"] == Json.of(true) }
                } while (tab.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }.isNotEmpty() || more)
                check(tab.snapshot().member("replicas").arr().flatMap { it["outbox"]?.arr().orEmpty() }.isEmpty())
                pull()
            } finally { tab.close() }
        }
        fun run(steps: Int): Report {
            repeat(steps) { step ->
                currentStep = step
                when (random.nextInt(30)) {
                    0, 1 -> put()
                    2 -> put(hold = true)
                    3 -> {
                        var held = outbox().filter { it["state"] == Json.of("held") }
                        if (held.isEmpty()) { put(hold = true); held = outbox().filter { it["state"] == Json.of("held") } }
                        check(engine.undo(held[random.nextInt(held.size)].member("gestureId").str())); count("undo")
                    }
                    4 -> { val target = day(); commit(Gesture(listOf(Change.put("day", target, false)), hold = true)); commit(Gesture(listOf(Change.put("day", target, true, mapOf("score" to Json.of(1)))), retire = listOf(RecordRef("day", target)))) }
                    5 -> {
                        engine.signOut("keep"); count("sign-out keep"); checkStep()
                        val prior = put(hold = true) as CommitOutcome.Committed
                        commit(Gesture(listOf(Change.put("day", day(), true, mapOf("score" to Json.of(3)))), supersede = listOf(prior.receipt.gestureId)))
                        engine.signIn("A", mapOf("probe" to false)); count("sign-in complete"); checkStep()
                    }
                    6 -> { put(hold = true); clock.advance(Constants.HOLD_MS); if (engine.releaseHeld().isNotEmpty()) count("release") }
                    7 -> {
                        val before = engine.snapshot(); engine.failNextCommit(); val idle = random.nextBoolean()
                        try { if (idle) engine.commit(scope) { null to Unit } else put(); error("transaction failure not injected") }
                        catch (error: CommitFailure) { check(error.kind == CommitFailure.Kind.storeFailure); check(before == engine.snapshot()); count("rollback"); if (idle) count("idle rollback") }
                    }
                    8 -> {
                        engine.crashAfterTransactions(1)
                        try { put(); error("post-commit crash not injected") }
                        catch (_: EngineCrash) { ledger.addAll(outbox().map { it.member("localId").str() }); checkStep(); reopen() }
                    }
                    9 -> { val snapshot = engine.snapshot(); reopen(snapshot, cloned = true); count("store restored") }
                    10 -> {
                        clock.jump(if (random.nextBoolean()) 600_000 else -600_000); count("clock jump"); clock.reboot(); count("reboot")
                        val before = engine.snapshot()
                        try { commit(Gesture(listOf(Change.write("day", RecordID("bad"), mapOf("score" to Json.of(1)))))); error("malformed accepted") }
                        catch (_: CommitFailure) { check(before == engine.snapshot()); count("malformed") }
                    }
                    11, 12, 13, 14 -> networkFault((step + seed).toInt().mod(4))
                    15 -> shortPagesAndFrames()
                    16 -> crashBoundary(random.nextInt(3))
                    17 -> wrongCredentials()
                    18 -> lineage()
                    19 -> serverFaults(random.nextInt(4))
                    20 -> joinAndCap()
                    21 -> restoredOrForked(random.nextInt(3))
                    22 -> secondTab()
                    23 -> {
                        put(hold = true)
                        EngineIntegration.factory.create(engine, transport, clock).use { it.leave() }
                        check(outbox().none { it["state"] == Json.of("held") }); count("left the app")
                    }
                    24 -> {
                        val error = if (random.nextBoolean()) 600_000L else -600_000L
                        clock.skew(error); count(if (error > 0) "clock error +10min" else "clock error -10min")
                        put(); push(); clock.skew(0)
                    }
                    25 -> { settle(); val snapshot = engine.snapshot(); reopen(snapshot); count("store restored") }
                    26 -> { push(); pull() }
                    27 -> privateScopeIsolation()
                    28 -> nonResurrection()
                    else -> delayedAcrossLineage()
                }
                checkStep()
                trace.update(engine.snapshot().jcs.encodeToByteArray()); trace.update(10.toByte())
            }
            // Resume every dormant binding as well as the active seat, then prove each outbox drains.
            for (dormant in engine.dormantReplicas()) {
                engine.signOut("keep"); checkStep()
                engine.signIn(dormant.account, mapOf("probe" to false)); checkStep(); settle()
            }
            settle(); check(outbox().isEmpty())
            trace.update(model.state.json.jcs.encodeToByteArray())
            return Report(seed, steps, events, trace.digest().joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }, checked)
        }
        override fun close() { transport.close(); engine.close(); clock.close(); serverClock.close() }
    }
}
