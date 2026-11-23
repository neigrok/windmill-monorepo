package works.windmill.agent.coach

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.sync.core.Json

class TurnRunner(private val host: ToolHost, private val ai: AiClient, private val telemetry: Telemetry, private val runtime: Runtime) {
    private class Turn(val input: TurnInput, val profile: Profile, val start: Long) {
        val wait = StopSignal()
        var lease: HostLease? = null
        var text = ""
        var rounds = 0
        var abilities = 0
        var writes = 0
        var refusals = 0
        val groups = mutableMapOf<String, Int>()
        val identities = mutableSetOf<CallIdentity>()
        @Volatile var seatChanged = false
        @Volatile var done = false
        var end: TurnEnd? = null
    }
    private val admission = Any()
    private val mutations = Mutex()
    @Volatile private var active: Turn? = null

    fun stop() { active?.wait?.stop() }

    suspend fun seatWillChange() {
        val turn = synchronized(admission) {
            val turn = active?.also { it.seatChanged = true; it.wait.invalidate() }
            ai.clearPass()
            turn
        } ?: return
        try {
            mutations.withLock {
                if (!turn.done && turn.lease != null) finishInside(turn, EndState.interrupted)
            }
        } catch (_: HostUnavailable) { abandon(turn) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { observe { failure(FailureOperation.host, failure) }; throw failure }
        finally { synchronized(admission) { if (active === turn) active = null } }
    }

    suspend fun run(input: TurnInput, profile: Profile, recover: Boolean = false): TurnEnd? {
        val turn = Turn(input, profile, runtime.now())
        synchronized(admission) { check(active == null) { "turn-active" }; active = turn }
        try {
            return runtime.withLease(input.turnId, recover) { acquired ->
                if (!acquired) return@withLease null
                if (turn.seatChanged) { abandon(turn); return@withLease null }
                if (recover) return@withLease recover(turn)
                val opened = mutations.withLock { host.open(input).also { turn.lease = it.lease } }
                if (turn.seatChanged) return@withLease finish(turn, EndState.interrupted)
                val words = profile.firstContent
                val parts = mutableListOf<Json>()
                if (opened.history.isNotEmpty()) parts += Json.objectOf("text" to Json.of(words.member("historyPrefix").str() + opened.history))
                opened.context.filter(String::isNotEmpty).forEach { parts += Json.objectOf("text" to Json.of(words.member("contextPrefix").str() + it)) }
                opened.pictures.forEach { parts += Json.objectOf("image" to Json.objectOf("picture" to Json.of(it.pictureId))) }
                parts += Json.objectOf("text" to Json.of(if (input.question.isEmpty()) words.member("emptyQuestion").str() else words.member("questionPrefix").str() + input.question))
                val messages = mutableListOf(Json.objectOf("role" to Json.of("user"), "parts" to Json.Arr(parts)))
                var round = 0L
                while (round++ < profile.modelCalls) {
                    if (turn.done) return@withLease turn.end
                    if (turn.seatChanged) return@withLease finish(turn, EndState.interrupted)
                    if (turn.wait.stopped) return@withLease finish(turn, EndState.stopped)
                    if (round == 1L && !ai.connected()) return@withLease finish(turn, EndState.interrupted, withdraw = true)
                    val callId = runtime.newId()
                    mutations.withLock {
                        if (turn.done || turn.seatChanged) return@withLock
                        host.beginRound(turn.lease!!, turn.text, Mark(input.turnId, callId, turn.text.encodeToByteArray().size))
                    }
                    if (turn.done || turn.seatChanged) return@withLease finish(turn, EndState.interrupted)
                    if (turn.wait.stopped) return@withLease finish(turn, EndState.stopped)
                    turn.rounds++
                    val request = Json.objectOf("model" to Json.of(profile.model), "system" to Json.Arr(profile.system.map(Json::of)),
                        "tools" to Json.Arr(profile.tools.map { it.wire }), "messages" to Json.Arr(messages),
                        "output" to Json.Obj(profile.output.obj().toList() + ("schema" to Json.Null)), "effort" to Json.of(profile.effort), "cache" to Json.of(true))
                    val answer = ai.text(callId, request, opened.pictures, profile.label, profile.name, profile.version, turn.wait) { append(turn, it) }
                    if (turn.done) return@withLease turn.end
                    if (turn.seatChanged) return@withLease finish(turn, EndState.interrupted)
                    if (answer is AiAnswer.Failure) {
                        val failure = answer.failure
                        if (failure.code == "stopped") return@withLease finish(turn, EndState.stopped)
                        return@withLease finish(turn, if (failure.code == null) EndState.interrupted else EndState.failed, code = failure.code,
                            withdraw = round == 1L && failure.admission == Admission.none)
                    }
                    answer as AiAnswer.Terminal
                    if (answer.event == "failed") return@withLease finish(turn, EndState.failed, code = answer.data.member("code").str())
                    when (answer.data.member("stop").str()) {
                        "completed", "truncated" -> return@withLease finish(turn, EndState.completed, truncated = answer.data.member("stop").str() == "truncated")
                        "declined" -> return@withLease finish(turn, EndState.declined)
                    }
                    if (turn.wait.stopped) return@withLease finish(turn, EndState.stopped)
                    val message = answer.data.member("message")
                    val calls = message.member("parts").arr().mapNotNull { it["toolCall"]?.let(::ToolCall) }
                    if (calls.map { it.id }.distinct().size != calls.size) {
                        observe { failure(FailureOperation.aiCall, code = "invalid-answer") }
                        return@withLease finish(turn, EndState.failed, code = "invalid-answer")
                    }
                    messages += message
                    val results = mutableListOf<Json>()
                    for (call in calls) {
                        if (turn.seatChanged) return@withLease finish(turn, EndState.interrupted)
                        if (turn.wait.stopped) return@withLease finish(turn, EndState.stopped)
                        val identity = CallIdentity(input.turnId, callId, call.id)
                        check(turn.identities.add(identity)) { "duplicate-dispatch" }
                        val tool = profile.tools.find { it.name == call.name }
                        var code: String? = if (tool == null) "not-offered" else null
                        if (code == null) code = host.check(turn.lease!!, "seat", call)
                        if (code == null) code = host.check(turn.lease!!, "shape", call)
                        if (code == null) code = profile.groups.find { call.name in it.tools && (turn.groups[it.name] ?: 0) >= it.maxSuccesses }?.code
                        if (code == null && (turn.abilities >= profile.abilityCalls || tool!!.countsAsWrite && turn.writes >= profile.writes)) code = "coach-turn-volume"
                        if (code == null) code = host.check(turn.lease!!, "product", call)
                        if (turn.done || turn.seatChanged) return@withLease finish(turn, EndState.interrupted)
                        if (code == null && turn.wait.stopped) code = "stopped"
                        val outcome = if (code != null) {
                            turn.refusals++
                            host.refused(call.id, code)
                            ToolOutcome.Refused(code)
                        } else {
                            mutations.withLock {
                                if (turn.done || turn.seatChanged) return@withLease finishInside(turn, EndState.interrupted)
                                if (turn.wait.stopped) return@withLease finishInside(turn, EndState.stopped)
                                turn.abilities++
                                if (tool!!.countsAsWrite) turn.writes++
                                host.execute(turn.lease!!, identity, call)
                            }.also { if (it is ToolOutcome.Ok) profile.groups.filter { group -> call.name in group.tools }.forEach { group -> turn.groups[group.name] = (turn.groups[group.name] ?: 0) + 1 } }
                        }
                        val boundedCode = (outcome as? ToolOutcome.Refused)?.code?.let { if (it in profile.refusals) it else "product-refused" }
                        observe { ability(AbilityReport(tool?.name ?: "unoffered", if (outcome is ToolOutcome.Ok) "ok" else "refused", boundedCode)) }
                        val content = if (outcome is ToolOutcome.Ok) outcome.content else Json.objectOf("code" to Json.of(boundedCode!!), "message" to Json.of(profile.refusals[boundedCode] ?: "")).jcs
                        results += Json.objectOf("id" to Json.of(call.id), "content" to Json.of(content), "isError" to Json.of(outcome !is ToolOutcome.Ok))
                    }
                    messages += Json.objectOf("role" to Json.of("tool"), "results" to Json.Arr(results))
                }
                finish(turn, if (turn.wait.stopped) EndState.stopped else EndState.failed, code = if (turn.wait.stopped) null else "model-call-limit")
            }
        } catch (_: HostUnavailable) {
            // A host that let go because the seat is changing leaves the end to `seatWillChange`, which writes it through what the change still allows.
            if (!turn.seatChanged) abandon(turn)
            return turn.end
        }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            observe { failure(FailureOperation.host, failure) }
            if (turn.lease != null && !turn.done) return finish(turn, EndState.failed, code = "host")
            throw failure
        } finally { synchronized(admission) { if (active === turn) active = null } }
    }

    private suspend fun append(turn: Turn, delta: String, prefix: String? = null) = mutations.withLock {
        if (turn.done || turn.seatChanged) return@withLock
        if (prefix != null) turn.text = prefix
        turn.text += delta
        host.text(turn.lease!!, turn.text)
    }

    private suspend fun recover(turn: Turn): TurnEnd? {
        val record = mutations.withLock {
            host.recover(turn.input.turnId, turn.input.seat).also {
                if (it?.state == "running") { turn.lease = it.lease; turn.text = it.text }
            }
        } ?: return null
        if (record.state != "running") return null
        if (record.mark.callId == null || turn.seatChanged) return finish(turn, EndState.interrupted)
        val data = record.text.encodeToByteArray()
        require(record.mark.textBytesBeforeRound <= data.size)
        val prefix = data.copyOfRange(0, record.mark.textBytesBeforeRound).decodeToString(throwOnInvalidSequence = true)
        var first = true
        val answer = ai.result(record.mark.callId, turn.profile.name, turn.profile.version, turn.wait) {
            append(turn, it, if (first) prefix else null)
            first = false
        }
        if (turn.done) return turn.end
        if (turn.seatChanged || answer is AiAnswer.Failure) return finish(turn, EndState.interrupted)
        answer as AiAnswer.Terminal
        if (answer.event == "failed") return finish(turn, EndState.failed, code = answer.data.member("code").str())
        val stop = answer.data.member("stop").str()
        if (stop == "tool_calls") return finish(turn, EndState.interrupted)
        return finish(turn, if (stop == "declined") EndState.declined else EndState.completed, truncated = stop == "truncated")
    }

    private fun abandon(turn: Turn) {
        if (turn.done) return
        turn.done = true
        turn.end = null
        report(turn, EndState.interrupted, null)
    }
    private fun report(turn: Turn, state: EndState, code: String?) = observe {
        turn(TurnReport(state, turn.input.seat.kind, code, turn.rounds, turn.abilities, turn.refusals, turn.text.encodeToByteArray().size, maxOf(0, runtime.now() - turn.start)))
    }
    private fun observe(block: Telemetry.() -> Unit) { try { telemetry.block() } catch (_: Exception) { } }
    private suspend fun finish(turn: Turn, state: EndState, code: String? = null, truncated: Boolean = false, withdraw: Boolean = false): TurnEnd? =
        mutations.withLock { finishInside(turn, state, code, truncated, withdraw) }
    private suspend fun finishInside(turn: Turn, state: EndState, code: String? = null, truncated: Boolean = false, withdraw: Boolean = false): TurnEnd? {
        if (turn.done) return turn.end
        val end = TurnEnd(state, turn.text, truncated, code)
        if (withdraw) host.withdraw(turn.lease!!) else host.end(turn.lease!!, end)
        turn.done = true
        turn.end = end
        report(turn, state, code)
        return end
    }
}
