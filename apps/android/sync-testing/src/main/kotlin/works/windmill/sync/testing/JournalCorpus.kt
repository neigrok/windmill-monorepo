package works.windmill.sync.testing

import java.io.File
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.core.Command
import works.windmill.sync.core.RecordID
import works.windmill.sync.engine.*
import works.windmill.sync.modelserver.*

// Product choreography from the Swift JournalHandlers worked example. All durable mutations use Engine.
object JournalCorpus {
    private val scope = ScopeRef.product("journal")
    fun handlers(root: File): Map<String, Handler> {
        val registry = Registry(Json.parse(File(root, "sync/journal.registry.json").readBytes()))
        return mapOf("journal/client.json" to { input -> client(registry, input) },
            "journal/claim-edit.json" to { input -> claimEdit(registry, input) })
    }
    private fun client(registry: Registry, input: Json): Json {
        var answer = NetworkCorpus.handlers(registry).getValue("commit/grouping.json")(input)
        answer = answer.with("events" to (answer["events"] ?: Json.array()), "telemetry" to (answer["telemetry"] ?: Json.array()))
        val steps = input.member("steps").arr(); val returns = answer.member("returns").arr()
        if (steps.last()["op"] == Json.of("push") && returns.last() !== Json.Null) {
            val server = ModelServer(registry, JournalServerRules(), ServerState(input.member("server")))
            val response = server.push(returns.last(), Credential.Account("A"), input.member("serverNow").long())
            answer = answer.with("server" to server.state.json, "response" to response.json)
        }
        return answer
    }

    private val resultWrites: CommandResultDeviceWrites = { command, result, epoch, rows ->
        val key = command.args["claimId"]?.str()?.let { "pendingClaim:$it" }
        val pending = key?.let(rows::get)
        if (command.name != "journal.claimPage" || key == null || pending == null) emptyList()
        else {
            val updated = when (val verdict = result.verdict) {
                is PushResult.Verdict.Ok -> pending.with("claimResult" to Json.objectOf("seq" to Json.of(verdict.seq), "epoch" to Json.of(epoch)))
                is PushResult.Verdict.Refused -> if (verdict.code in listOf(RefusalCode.clockSkew, RefusalCode.baseUnknown)) pending else pending.with("refusal" to verdict.code.json)
            }
            listOf(DeviceWrite(key, updated))
        }
    }
    private val pendingWork: PendingDeviceWork = { product, rows ->
        if (product != "journal") emptyList() else rows.filter { (key, value) ->
            key.startsWith("pendingClaim:") && ((value["touched"]?.arr()?.size ?: 0) > 0 || (value["retirements"]?.obj()?.size ?: 0) > 0)
        }.keys.toList()
    }
    private fun prediction(args: Json, full: Boolean = true) = listOf(Change("page", Change.Operation.Write(RecordID(args.member("day"))),
        if (full) listOf("mood", "energy", "source").associateWith { args.member(it) } else emptyMap(),
        mapOf("body" to TextEdit(args.member("body").str()))))

    private fun claimEdit(registry: Registry, input: Json): Json {
        val now = input.member("now").long(); val day = input.member("day").str()
        val claim = input.member("claim"); val edit = input.member("edit")
        val key = "pendingClaim:${claim.member("claimId").str()}"
        val claimAt = input.member("claimAt").long(); val editAt = input.member("editAt").long(); val saveAt = input.member("saveAt").long()
        val eager = input["strategy"] == Json.of("eager"); val skew = input["skewMs"]?.long() ?: 0
        var wall = now; var gestures = 0
        val actor = "r_aaaaaaaaaaaa"
        val clock = object : EngineClock { override fun now() = wall; override fun reading() = ClockReading(wall, wall, "boot-1") }
        val identities = object : IdentitySource {
            override fun opaqueID() = "g${++gestures}"
            override fun draw(bound: Int): Int = error("journal vector needs no random draw")
            override fun replicaID() = "rp_00000000000000000000000000000002"
            override fun actorID() = actor
        }
        val replica = Json.objectOf("meta" to Json.objectOf("replica" to input.member("replica"), "state" to Json.of("anon"),
            "nextN" to Json.of(1), "hlc" to Hlc().json, "hlcHigh" to Stamp.UNSET.json, "admittedHigh" to Stamp.UNSET.json,
            "serverOffsetMs" to Json.of(0), "offsetSamples" to Json.array(), "serverEpoch" to Json.Null, "ackThrough" to Json.of(0), "authPaused" to Json.of(false)))
        fun make(snapshot: Json, limit: Int = Constants.PUSH_MAX_BYTES) = Engine.memory(registry, snapshot, clock, identities, actor, limit,
            commandResultWrites = resultWrites, pendingDeviceWork = pendingWork)
        var engine = make(Json.objectOf("active" to input.member("replica"), "replicas" to Json.array(replica)))
        val server = ModelServer(registry, JournalServerRules(), ServerState(input.member("server")))
        val trace = mutableListOf<Json>()
        fun at(relative: Long) { wall = now + relative + skew }
        fun snapshot(op: String, value: Json = Json.Null) { trace.add(Json.objectOf("op" to Json.of(op), "value" to value, "device" to engine.snapshot())) }
        fun commit(gesture: Gesture, relative: Long): Json { at(relative); return ClientCorpus.outcome(engine.commit(scope, gesture)) }
        fun restart(limit: Int = Constants.PUSH_MAX_BYTES) { val state = engine.snapshot(); engine.close(); engine = make(state, limit) }
        fun active(): Json { val state = engine.snapshot(); return state.member("replicas").arr().single { it.member("meta").member("replica") == state.member("active") } }
        fun deviceRows() = active()["device"]?.get("journal")?.obj().orEmpty()
        fun push(relative: Long): Json? { at(relative); return engine.nextPush() }
        fun result(response: Json, request: Json, relative: Long) {
            at(relative); engine.onPushResponse(request, SyncResponse(response.member("status").long().toInt(), response["body"]), RequestTiming(clock.reading(), clock.reading()))
        }
        fun pull(relative: Long) {
            at(relative); val request = checkNotNull(engine.pullRequest(listOf(scope)))
            val reply = server.pull(request, Credential.Account("A"), now + relative)
            snapshot("pull", Json.Arr(engine.onPullResponse(request, SyncResponse(reply.status, reply.body), RequestTiming(clock.reading(), clock.reading()), PullSlicing(Int.MAX_VALUE, Int.MAX_VALUE))))
        }
        fun leaveAndReturn(choice: String, relative: Long) {
            at(relative); snapshot("signOutQuestion", engine.signOut()); snapshot("signOut", engine.signOut(choice)); restart(); snapshot("signedOutRestart")
            if (choice == "keep") { at(relative + 1); snapshot("signIn", engine.signIn("A", mapOf("journal" to input.member("occupied").bool()))) }
        }
        fun reconcile(relative: Long, fail: Boolean = false): Json {
            val pending = deviceRows()[key] ?: return Json.Null
            if (pending["refusal"]?.orNull() != null) return Json.Null
            val claimResult = pending["claimResult"]?.orNull() ?: return Json.Null
            val state = active(); val meta = state.member("meta"); val resultEpoch = claimResult.member("epoch")
            if (meta.member("serverEpoch") !== Json.Null && meta.member("serverEpoch") != resultEpoch) {
                val outstanding = state["outbox"]?.arr().orEmpty().any { it["intent"]?.get("cmd")?.get("args")?.get("claimId") == claim.member("claimId") }
                return commit(Gesture(emptyList(), command = if (outstanding) null else Command("journal.claimPage", claim),
                    local = listOf(DeviceWrite(key, pending.with("claimResult" to Json.Null)))), relative)
            }
            val cursorState = state["cursors"]?.get(scope.text) ?: return Json.Null
            val cursor = cursorState["cursor"]?.orNull()?.str()?.let(WireCursor::decode) ?: return Json.Null
            if (meta.member("serverEpoch") != resultEpoch || cursor.epoch != resultEpoch.str() || cursor.mode != "live" || cursor.key != null ||
                cursorState["behind"] == Json.of(true) || cursorState["mismatchReset"] == Json.of(true) || cursorState["digestStop"] != null ||
                state["staging"]?.get(scope.text) != null || cursor.seq < claimResult.member("seq").long()) return Json.Null
            val row = state["confirmed"]?.get(scope.text)?.arr()?.firstOrNull { it["t"] == Json.of("page") && it["id"] == Json.of(day) } ?: return Json.Null
            val retirements = pending.member("retirements").obj()
            val changes = if (retirements.isEmpty()) emptyList() else listOf(Change("journalState", Change.Operation.Write(RecordID("journalState")), retirements))
            val touched = pending.member("touched").arr().map(Json::str)
            if (touched.isEmpty()) return commit(Gesture(changes, local = listOf(DeviceWrite(key, null))), relative)
            val latest = pending.member("latest"); val base = pending.member("base")
            val joined = row.member("x").member("body").member("text").str()
            val old = base.member("body").str(); val new = latest.member("body").str()
            val suffix = "\n\n" + TextMerge.trimmed(old, true)
            val body = when {
                "body" !in touched -> joined
                joined == old -> new
                TextMerge.trimmed(TextMerge.trimmed(old, true), false).isNotEmpty() && joined.endsWith(suffix) -> JournalServerRules.claimBody(joined.dropLast(suffix.length), new)
                else -> JournalServerRules.claimBody(joined, new)
            }
            at(relative)
            val stamp = ContentClock.next(deviceRows()["contentClock"], row.member("f").member("documentStamp").arr()[0], engine.physNow(), engine.actor)
            val args = Json.Obj(listOf("day" to Json.of(day), "body" to Json.of(body), "stamp" to stamp) +
                listOf("mood", "energy", "source").map { it to if (it in touched) latest.member(it) else row.member("f").member(it).arr()[0] })
            val gesture = Gesture(changes, command = Command("journal.savePage", args), predict = prediction(args), local = listOf(DeviceWrite(key, null), DeviceWrite("contentClock", ContentClock.pair(stamp))))
            if (fail) restart(1)
            val answer = commit(gesture, relative)
            if (fail) restart()
            return answer
        }
        try {
            val base = Json.Obj(listOf("body", "mood", "energy", "source").map { it to claim.member(it) })
            var pending = Json.objectOf("day" to Json.of(day), "claimId" to claim.member("claimId"), "base" to base, "latest" to base,
                "touched" to Json.array(), "retirements" to Json.objectOf(), "claimResult" to Json.Null, "refusal" to Json.Null)
            val claimChanges = if (skew == 0L) emptyList() else listOf(Change("journalState", Change.Operation.Write(RecordID("journalState")), mapOf("firstPage" to Json.of("retired"))))
            if (skew != 0L) pending = pending.with("retirements" to Json.objectOf("firstPage" to Json.of("retired")))
            snapshot("claimCommit", commit(Gesture(claimChanges, command = Command("journal.claimPage", claim), predict = prediction(claim, !eager), local = if (eager) emptyList() else listOf(DeviceWrite(key, pending))), 0))
            at(1); engine.signIn("A", mapOf("journal" to input.member("occupied").bool()), if (input.member("occupied").bool()) mapOf("journal" to "add") else emptyMap())
            var request = checkNotNull(push(2)); snapshot("claimSent", request)
            if (eager) {
                val stamp = ContentClock.next(null, null, now + editAt, engine.actor)
                val args = Json.Obj((claim.obj() - "claimId" + edit.obj() + ("stamp" to stamp)).toList())
                snapshot("editCommit", commit(Gesture(emptyList(), command = Command("journal.savePage", args), predict = prediction(args, false), local = listOf(DeviceWrite("contentClock", ContentClock.pair(stamp)))), editAt))
            } else {
                pending = pending.with("latest" to Json.Obj((base.obj() + edit.obj()).toList()), "touched" to Json.Arr(listOf("body", "mood", "energy", "source").filter { edit[it] != null }.map(Json::of)),
                    "retirements" to Json.Obj((pending.member("retirements").obj() + input["retirements"]?.obj().orEmpty()).toList()))
                snapshot("editCommit", commit(Gesture(emptyList(), local = listOf(DeviceWrite(key, pending))), editAt))
                snapshot("beforeConfirmation", reconcile(editAt))
            }
            if (input["restart"] == Json.of(true)) { restart(); snapshot("restart") }
            input["signOut"]?.str()?.let { choice ->
                leaveAndReturn(choice, editAt + 1)
                if (choice == "discard") return Json.objectOf("trace" to Json.Arr(trace), "device" to engine.snapshot(), "server" to server.state.json,
                    "claimResponse" to Json.Null, "saveRequest" to Json.Null, "saveResponse" to Json.Null, "pending" to Json.Null)
                request = checkNotNull(push(editAt + 2)); snapshot("claimRetriedAfterSignIn", request)
            }
            var response = server.push(request, Credential.Account("A"), now + claimAt).json
            if (skew != 0L) {
                result(response, request, claimAt); snapshot("skewResult", response); restart()
                request = checkNotNull(push(claimAt + 1)); snapshot("skewRetry", request)
                response = server.push(request, Credential.Account("A"), now + claimAt + 1).json
            }
            if (input["pullFirst"] == Json.of(true)) { pull(claimAt + 1); snapshot("pullBeforeResult", reconcile(claimAt + 1)); restart() }
            result(response, request, claimAt + 2); snapshot("claimResult", response)
            if (input["pullFirst"] != Json.of(true)) { if (!eager) snapshot("resultBeforePull", reconcile(claimAt + 2)); pull(claimAt + 2) }
            if (input["restart"] == Json.of(true)) restart()
            if (input["signOutAfterResult"] == Json.of(true)) { leaveAndReturn("keep", saveAt - 2); pull(saveAt - 1) }
            if (input["epochChange"] == Json.of(true)) {
                server.restore(ServerState(server.state.json.with("epoch" to Json.of("ep-2"))))
                at(saveAt); engine.epochChange("ep-2"); snapshot("epochReplayCommit", reconcile(saveAt)); restart()
                val replay = checkNotNull(push(saveAt)); val replayed = server.push(replay, Credential.Account("A"), now + saveAt).json
                result(replayed, replay, saveAt); snapshot("epochReplayResult", replayed); pull(saveAt)
            }
            if (!eager) {
                if (input["failCommit"] == Json.of(true)) { snapshot("failedReconciliation", reconcile(saveAt, true)); restart() }
                snapshot("reconcile", reconcile(saveAt))
            }
            val saveRequest = push(saveAt)
            var saveResponse: Json = Json.Null
            if (saveRequest != null) {
                saveResponse = server.push(saveRequest, Credential.Account("A"), now + saveAt).json
                result(saveResponse, saveRequest, saveAt); snapshot("saveResult", saveResponse); pull(saveAt + 1)
            }
            return Json.objectOf("trace" to Json.Arr(trace), "device" to engine.snapshot(), "server" to server.state.json,
                "claimResponse" to response, "saveRequest" to (saveRequest ?: Json.Null), "saveResponse" to saveResponse, "pending" to (deviceRows()[key] ?: Json.Null))
        } finally { engine.close() }
    }
}
