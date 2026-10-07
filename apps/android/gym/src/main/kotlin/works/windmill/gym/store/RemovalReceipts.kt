package works.windmill.gym.store

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import works.windmill.domain.kit.*
import works.windmill.gym.domain.Proposal
import works.windmill.gym.domain.ProposalState
import works.windmill.gym.domain.sync.ApplyProposal
import works.windmill.gym.domain.sync.GymRefusal
import works.windmill.gym.domain.sync.Proposal as EngineProposal
import works.windmill.platform.net.WindmillJson
import works.windmill.sync.api.*
import works.windmill.sync.core.*
import works.windmill.sync.engine.Engine
import works.windmill.sync.schema.Gym

internal class RemovalReceipts(private val engine: Engine) {
    private val shown = mutableMapOf<Pair<String, String>, Proposal>()
    fun contains(id: String): Boolean = engine.read(EngineProposal.scope) { it.device(key)?.get(id) != null }
    fun begin(id: String, replica: String, zone: Zone, snapshot: (Reader) -> Proposal?): GymRefusal? {
        val (outcome, refused) = engine.commit(EngineProposal.scope) { context ->
            if (context.replica != replica) throw TrainingRefused("account-changed", "The account changed. Open this again.")
            val read = Reader(context, EngineProposal.scope, Moment(Instant(context.now), zone), engine.registry)
            val rows = context.device(key)?.obj().orEmpty()
            val existing = rows[id]
            val queued = context.commands().firstOrNull {
                it.command.name == Gym.Commands.applyProposal && it.command.args["proposalId"] == Json.of(id)
            }
            if (existing?.get("state") == Json.of("accepted") || existing != null && queued?.gestureId == existing["gestureId"]?.str())
                return@commit null to null
            val proposal = snapshot(read)
            if (queued != null && proposal != null) {
                val row = pending(proposal, queued.gestureId)
                return@commit Gesture(emptyList(), local = listOf(DeviceWrite(key, Json.Obj((rows + (id to row)).toList())))) to null
            }
            val action = ApplyProposal(Id(id, EngineProposal))
            when (val decision = action.decision(action.load(read), IDSource(context))) {
                is Decision.Refuse -> null to decision.refusal
                is Decision.Unchanged -> null to null
                is Decision.Write -> {
                    val gesture = decision.plan.gesture(EngineProposal.scope, engine.registry)
                    if (proposal != null) {
                        val gestureId = context.opaqueID()
                        gesture.gestureId = gestureId
                        gesture.local += DeviceWrite(key, Json.Obj((rows + (id to pending(proposal, gestureId))).toList()))
                    }
                    gesture to null
                }
            }
        }
        if (outcome is CommitOutcome.Refused) {
            outcome.notice?.let(engine::dismissNotice)
            return GymRefusal.of(Refused(outcome.code, Id(id, EngineProposal).ref, outcome.detail, Refused.Path.predicted))
        }
        return refused
    }

    fun proposals(): Map<String, Proposal> = engine.read(EngineProposal.scope) { source ->
        val queued = (source as CommitContext).commands().map { it.gestureId }.toSet()
        source.device(key)?.obj().orEmpty().filterValues {
            it["state"] in setOf(Json.of("pending"), Json.of("accepted"))
        }.mapValues { (_, row) ->
            val snapshot = proposal(row)
            if (row["state"] == Json.of("accepted") && row["gestureId"]?.str() !in queued)
                snapshot.copy(state = ProposalState.Applied, settledAtMs = null) else snapshot
        }
    }
    fun confirmed(): Map<String, Proposal> = proposals().filterValues { !it.isPending }
    fun result(id: String, replica: String): Proposal? = engine.read(EngineProposal.scope) { source ->
        val context = source as CommitContext
        if (context.replica != replica) throw TrainingRefused("account-changed", "The account changed. Open this again.")
        val row = source.device(key)?.get(id)
        if (row?.get("state") == Json.of("accepted") && context.commands().none { it.gestureId == row["gestureId"]?.str() })
            proposal(row).copy(state = ProposalState.Applied, settledAtMs = null)
        else synchronized(shown) { shown[replica to id] }
    }

    fun pending(id: String): Boolean = engine.read(EngineProposal.scope) { source ->
        val row = source.device(key)?.get(id) ?: return@read false
        row["state"] == Json.of("pending") || row["state"] == Json.of("accepted") &&
            (source as CommitContext).commands().any { it.gestureId == row["gestureId"]?.str() }
    }

    fun refusal(id: String, replica: String): GymRefusal? = engine.read(EngineProposal.scope) { source ->
        if ((source as CommitContext).replica != replica) return@read null
        val row = source.device(key)?.get(id) ?: return@read null
        if (row["state"] != Json.of("refused")) return@read null
        GymRefusal.of(Refused(RefusalCode(row.member("code").str()), Id(id, EngineProposal).ref,
            row["detail"]?.takeUnless { it === Json.Null }, Refused.Path.notice))
    }

    fun shown(proposal: Proposal, replica: String): Boolean {
        val acknowledged = engine.commit(EngineProposal.scope) { context ->
            if (context.replica != replica) return@commit null to false
            val rows = context.device(key)?.obj().orEmpty()
            val row = rows[proposal.id] ?: return@commit null to false
            if (row["state"] != Json.of("accepted") || proposal(row).copy(state = ProposalState.Applied, settledAtMs = null) != proposal ||
                context.commands().any { it.gestureId == row["gestureId"]?.str() }) return@commit null to false
            val remaining = rows - proposal.id
            Gesture(emptyList(), local = listOf(DeviceWrite(key, remaining.takeIf { it.isNotEmpty() }?.let { Json.Obj(it.toList()) }))) to true
        }.second
        if (acknowledged) synchronized(shown) { shown[replica to proposal.id] = proposal }
        return acknowledged
    }

    fun dismissRefused(ids: Set<String>) {
        engine.commit(EngineProposal.scope) { context ->
            val rows = context.device(key)?.obj().orEmpty()
            val remaining = rows.filterNot { (id, row) -> id in ids && row["state"] == Json.of("refused") }
            if (remaining == rows) return@commit null to Unit
            Gesture(emptyList(), local = listOf(DeviceWrite(key, remaining.takeIf { it.isNotEmpty() }?.let { Json.Obj(it.toList()) }))) to Unit
        }
    }

    companion object {
        const val key = "rack:removalReceipts"
        private fun proposal(row: Json): Proposal = WindmillJson.decodeFromString(row.member("proposal").toString())
        private fun pending(proposal: Proposal, gestureId: String) = Json.objectOf(
            "proposal" to Json.parse(WindmillJson.encodeToString(proposal)), "gestureId" to Json.of(gestureId), "state" to Json.of("pending"))
        val intentResultWrites: IntentResultDeviceWrites = { intent, result, _, gestureId, values ->
            val command = intent.command
            val id = command?.args?.get("proposalId")?.str()
            val rows = values[key]?.obj().orEmpty()
            val row = rows[id]
            if (command?.name != Gym.Commands.applyProposal || row?.get("gestureId") != Json.of(gestureId)) emptyList()
            else {
                val changes = when (val verdict = result.verdict) {
                    is PushResult.Verdict.Ok -> mapOf("state" to Json.of("accepted"))
                    is PushResult.Verdict.Refused -> if (verdict.code.text in setOf("clock-skew", "base-unknown")) emptyMap()
                        else mapOf("state" to Json.of("refused"), "code" to Json.of(verdict.code.text), "detail" to (result.detail ?: Json.Null))
                }
                if (changes.isEmpty()) emptyList() else listOf(DeviceWrite(key,
                    Json.Obj((rows + (requireNotNull(id) to Json.Obj((row!!.obj() + changes).toList()))).toList())))
            }
        }
    }
}
