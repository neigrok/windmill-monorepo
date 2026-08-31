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
        get() = named ?: if (door == askDoor) "Coach" else "your connected agent"

    // The prose is attributed by who wrote it: the agent by name, Coach for the room's own door, and
    // an agent that did not name itself is still the lifter's own. The same three on every surface.
    val kicker: String
        get() = "${named ?: if (door == askDoor) "Coach" else "Your agent"} wrote:"

    private val named: String?
        get() = agent?.takeIf { it.isNotBlank() } ?: connection?.takeIf { it.isNotBlank() }

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

    // The rows ARE the document as well as the diff: a kept row keeps its place in the run the routine
    // takes on, and a run of them collapses to one counted row that expands where it stands.
    val document: List<DocumentRow>
        get() {
            val rows = mutableListOf<DocumentRow>()
            var kept = mutableListOf<ProposalChange>()
            fun closeRun() {
                if (kept.isEmpty()) return
                rows += DocumentRow.Unchanged(kept.toList())
                kept = mutableListOf()
            }
            changes.forEach { change ->
                if (change.kind == ChangeKind.Kept) kept += change
                else {
                    closeRun()
                    rows += DocumentRow.Changed(change)
                }
            }
            closeRun()
            return rows
        }

    // Derived from the SERVER's reply and never from the model's prose: the name the routine now
    // carries and the server's own count of what moved, or that the routine is gone.
    val receipt: String?
        get() = when (state) {
            ProposalState.Applied -> {
                if (intent == ProposalIntent.Remove) "Applied · $routineName · routine removed"
                else "Applied · ${name.ifBlank { baseName }.ifBlank { "this routine" }} · $counted"
            }
            ProposalState.Dismissed -> turnedDownReceipt
            else -> null
        }

    val kicker: String get() = source.kicker

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

    // One affordance on a card, and it is Review; the card's counted line says how much.
    val reviewLabel: String get() = review

    fun cardLine(routineName: String, stillWaiting: Boolean): String {
        val waiting = if (stillWaiting) Proposal.stillWaiting else "waiting"
        return "$routineName · $counted · $waiting"
    }

    // The server's count, never the rows this build drew: apply is atomic against the document.
    val applyLabel: String
        get() = when {
            intent == ProposalIntent.Remove -> "Remove $routineName"
            changeCount == 1 -> "Apply"
            else -> "Apply all $changeCount"
        }

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
            ProposalState.Dismissed -> "$on · turned down $counted from ${source.name}"
            ProposalState.Superseded -> "$on · set aside $counted from ${source.name}"
            ProposalState.Pending -> "$on · $counted from ${source.name}, waiting"
        }
    }

    fun settledNote(nowMs: Long): String? {
        val at = settledAtMs ?: return null
        val on = "${Readout.briefDay(at, nowMs)} at ${Readout.time(at)}"
        return when (state) {
            ProposalState.Applied ->
                "Applied to $routineName $on. Kept on the routine as a dated record — the program’s history, not a toast that disappears."
            ProposalState.Dismissed ->
                "Turned down $on. Nothing changed, and it stays in the routine’s history as a record."
            ProposalState.Superseded ->
                "$routineName changed after this was written, so it was set aside $on. None of it was applied, and it stays in the routine’s history."
            ProposalState.Pending -> null
        }
    }

    val routineName: String get() = baseName.ifBlank { "this routine" }

    companion object {
        const val review = "Review"
        const val apply = "Apply"

        // Why Apply is shut, said on the screen and on the semantics channel, and it names the way
        // out. Read off `seen` ALONE: bound to the disabled predicate it would say this while the
        // apply request is already on the wire.
        const val applyHint = "Read the changes to the end to apply them."
        const val stillWaiting = "still waiting"
        const val turnedDownReceipt = "Turned down · nothing changed."

        // Turning a proposal down is settled for good — the wire has no path back — so it is confirmed,
        // in the same words on every surface.
        const val turnDownVerb = "Turn this down"
        const val turnDownAsk = "Turn this down?"
        const val turnDownBody = "Nothing changes, and it stays in the routine’s history as a record."
        const val turnDown = "Turn down"

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

sealed interface DocumentRow {
    data class Changed(val change: ProposalChange) : DocumentRow
    data class Unchanged(val kept: List<ProposalChange>) : DocumentRow {
        val label: String
            get() = if (kept.size == 1) "and 1 line unchanged" else "and ${kept.size} lines unchanged"
    }
}

data class FieldMove(val label: String, val before: String, val after: String)
