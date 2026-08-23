package works.windmill.gym.domain

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

// Every type here is read-only on the wire: nothing on this phone mints a proposal, and one does
// nothing until the lifter taps Apply.

@Serializable(with = ProposalIntentSerializer::class)
enum class ProposalIntent(val wire: String) {
    Revise("revise"), Remove("remove");

    companion object {
        fun parse(raw: String?): ProposalIntent = entries.firstOrNull { it.wire == raw } ?: Revise
    }
}

object ProposalIntentSerializer : KSerializer<ProposalIntent> {
    override val descriptor = PrimitiveSerialDescriptor("ProposalIntent", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ProposalIntent) = encoder.encodeString(value.wire)
    override fun deserialize(decoder: Decoder): ProposalIntent = ProposalIntent.parse(decoder.decodeString())
}

// An unknown word reads as `Superseded`, never as `Pending`; an absent state takes `Pending`.
@Serializable(with = ProposalStateSerializer::class)
enum class ProposalState(val wire: String) {
    Pending("pending"), Applied("applied"), Dismissed("dismissed"), Superseded("superseded");

    companion object {
        fun parse(raw: String?): ProposalState = entries.firstOrNull { it.wire == raw } ?: Superseded
    }
}

object ProposalStateSerializer : KSerializer<ProposalState> {
    override val descriptor = PrimitiveSerialDescriptor("ProposalState", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ProposalState) = encoder.encodeString(value.wire)
    override fun deserialize(decoder: Decoder): ProposalState = ProposalState.parse(decoder.decodeString())
}

// `door` stays a String where `state` and `kind` are enums; `thread` is absent where there is no
// conversation to open.
@Serializable
data class ProposalSource(
    val door: String = "mcp",
    val connection: String? = null,
    val agent: String? = null,
    val thread: String? = null,
) {
    val conversation: String? get() = thread?.takeIf { it.isNotBlank() && door == askDoor }

    val name: String
        get() = agent?.takeIf { it.isNotBlank() }
            ?: connection?.takeIf { it.isNotBlank() }
            ?: if (door == askDoor) "Ask" else "your connected agent"

    companion object {
        const val askDoor = "ask"
    }
}

// The absences: no reps is `max`, no weight is last time, no rest is the global dial, no sets is an
// open line. Which SIDE is missing is `kind`.
@Serializable
data class ProposalTargets(
    val sets: Int? = null,
    val reps: Int? = null,
    val weightKg: Double? = null,
    val restSeconds: Int? = null,
)

@Serializable(with = ChangeKindSerializer::class)
enum class ChangeKind(val wire: String) {
    Kept("kept"), Added("added"), Removed("removed"), Retargeted("retargeted");

    companion object {
        // An unknown kind reads as `Retargeted`, never as `Kept`, so no row is hidden from the count.
        fun parse(raw: String?): ChangeKind = entries.firstOrNull { it.wire == raw } ?: Retargeted
    }
}

object ChangeKindSerializer : KSerializer<ChangeKind> {
    override val descriptor = PrimitiveSerialDescriptor("ChangeKind", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ChangeKind) = encoder.encodeString(value.wire)
    override fun deserialize(decoder: Decoder): ChangeKind = ChangeKind.parse(decoder.decodeString())
}

// `before` is absent on an added line, `after` on a removed one. `loggedSets` rides on a removed line
// only, and a zero there is a real answer.
@Serializable
data class ProposalChange(
    val position: Int = 0,
    val kind: ChangeKind = ChangeKind.Retargeted,
    val exerciseId: String,
    val before: ProposalTargets? = null,
    val after: ProposalTargets? = null,
    val loggedSets: Int? = null,
) {
    fun addedLine(follows: String?): String {
        val said = mutableListOf("added")
        after?.let { said += Proposal.asks(it) }
        said += follows?.let { "after $it" } ?: "first in the routine"
        return said.joinToString(" · ")
    }

    // Zero is a real answer and an absent count says neither.
    val removedLine: String
        get() {
            val kept = loggedSets ?: return "removed from the routine"
            if (kept == 0) return "removed from the routine · never logged"
            val sets = if (kept == 1) "1 logged set" else "$kept logged sets"
            return "removed from the routine · $sets kept"
        }

    val compactLine: String
        get() {
            if (kind == ChangeKind.Added) return after?.let { "+ added · ${Proposal.asks(it)}" } ?: "+ added"
            if (kind == ChangeKind.Removed) return "− $removedLine"
            // A retarget, and any kind this build cannot name: read off whichever side arrived.
            val moved = before?.let { was -> after?.let { now -> Proposal.moves(was, now) } }.orEmpty()
            if (moved.isNotEmpty()) return moved.joinToString(" · ") { "${it.before} → ${it.after}" }
            return (after ?: before)?.let { Proposal.asks(it) } ?: "no targets"
        }
}

// Two sizes on one type: a HEAD carries everything above `baseRevision` and no diff. `changeCount` is
// the server's own count of what Apply does.
@Serializable
data class Proposal(
    val id: String,
    val routineId: String,
    val intent: ProposalIntent = ProposalIntent.Revise,
    val state: ProposalState = ProposalState.Pending,
    val summary: String = "",
    val changeCount: Int = 0,
    @SerialName("createdAt") val createdAtMs: Long = 0,
    @SerialName("settledAt") val settledAtMs: Long? = null,
    val source: ProposalSource = ProposalSource(),
    // Absent on a head, which is what tells the two sizes apart. Nullable and never 0.
    val baseRevision: Int? = null,
    val baseName: String = "",
    val name: String = "",
    val changes: List<ProposalChange> = emptyList(),
) {
    val isPending: Boolean get() = state == ProposalState.Pending

    val drawn: List<ProposalChange> get() = changes.filterNot { it.kind == ChangeKind.Kept }

    val renames: Boolean
        get() = name.isNotBlank() && baseName.isNotBlank() && name != baseName

    fun landsAfter(added: ProposalChange): String? {
        val run = changes.takeWhile { it.kind != ChangeKind.Removed }
        val at = run.indexOf(added)
        if (at <= 0) return null
        return run[at - 1].exerciseId
    }

    // Only a routine that has moved PAST the base counts. A head answers no — it carries no base.
    fun supersededBy(routine: Routine?): Boolean {
        val base = baseRevision ?: return false
        val held = routine ?: return false
        return held.revision > base
    }

    fun byline(nowMs: Long): String = "from ${source.name} · ${Readout.whenLogged(createdAtMs, nowMs)}"

    fun summaryLine(routineName: String): String {
        if (summary.isNotBlank()) return summary
        if (intent == ProposalIntent.Remove) return "A proposal to remove $routineName."
        return "$counted to $routineName."
    }

    val counted: String
        get() {
            if (intent == ProposalIntent.Remove) return "a removal"
            return if (changeCount == 1) "1 change" else "$changeCount changes"
        }

    val reviewLabel: String
        get() = if (intent == ProposalIntent.Remove) "Review the removal" else "Review $counted"

    // The server's count, never the rows this build drew: apply is atomic against the document.
    val applyLabel: String
        get() = if (intent == ProposalIntent.Remove) "Remove $routineName" else "Apply all $changeCount"

    val atomicLine: String
        get() {
            if (intent == ProposalIntent.Remove) {
                return "The routine goes and your logged sets stay. Nothing is removed until you tap."
            }
            if (changeCount <= 1) return "Nothing is applied until you tap."
            return "All ${Readout.spelled(changeCount)} or none. Nothing is applied until you tap."
        }

    fun historyLine(nowMs: Long): String {
        val on = Readout.shortDate(settledAtMs ?: createdAtMs, nowMs)
        return when (state) {
            ProposalState.Applied -> "$on · applied $counted from ${source.name}"
            ProposalState.Dismissed -> "$on · dismissed $counted from ${source.name}"
            ProposalState.Superseded -> "$on · set aside $counted from ${source.name}"
            ProposalState.Pending -> "$on · $counted from ${source.name}, waiting"
        }
    }

    fun settledNote(nowMs: Long): String? {
        val at = settledAtMs ?: return null
        val on = "${Readout.briefDay(at, nowMs)} at ${Readout.time(at)}"
        return when (state) {
            ProposalState.Applied ->
                "Applied to $routineName $on. Kept on the routine as a dated record — the program's history, not a toast that disappears."
            ProposalState.Dismissed ->
                "Dismissed $on. No reason asked for, nothing changed, and it stays in the routine's history in case you want it back."
            ProposalState.Superseded ->
                "$routineName changed after this was written, so it was set aside $on. None of it was applied, and it stays in the routine's history."
            ProposalState.Pending -> null
        }
    }

    val routineName: String get() = baseName.ifBlank { "this routine" }

    companion object {
        // The load is compared on the LADDER's grid and never on raw doubles.
        fun moves(before: ProposalTargets, after: ProposalTargets): List<FieldMove> {
            val moved = mutableListOf<FieldMove>()
            if (before.sets != after.sets || before.reps != after.reps) {
                moved += FieldMove("sets", countOf(before), countOf(after))
            }
            if (!sameLoad(before.weightKg, after.weightKg)) {
                moved += FieldMove("weight", loadOf(before.weightKg), loadOf(after.weightKg))
            }
            if (before.restSeconds != after.restSeconds) {
                moved += FieldMove("rest", restOf(before.restSeconds), restOf(after.restSeconds))
            }
            return moved
        }

        fun asks(targets: ProposalTargets): String =
            Readout.target(targets.sets, targets.reps, targets.weightKg)

        fun countOf(targets: ProposalTargets): String {
            val sets = targets.sets ?: return Readout.openTarget
            return "$sets × ${Readout.repTarget(targets.reps)}"
        }

        fun loadOf(weightKg: Double?): String =
            weightKg?.let { Readout.weight(it) } ?: "last time"

        fun restOf(seconds: Int?): String = seconds?.let { "${it}s" } ?: "the dial"

        private fun sameLoad(before: Double?, after: Double?): Boolean {
            if (before == null || after == null) return before == null && after == null
            return Ladder.round(before) == Ladder.round(after)
        }
    }
}

// The routine is absent when the intent was to remove it.
@Serializable
data class ProposalDecision(val proposal: Proposal, val routine: Routine? = null)

data class FieldMove(val label: String, val before: String, val after: String)
