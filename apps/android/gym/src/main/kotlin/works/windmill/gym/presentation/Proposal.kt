package works.windmill.gym.presentation

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import works.windmill.gym.R
import works.windmill.platform.i18n.Words

// A proposal does nothing until the lifter taps Apply.

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

// What a proposal changes: a routine, from its next workout on, or the workout open now.
@Serializable
enum class ProposalTarget { Routine, Workout }

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

    val named: Words
        get() = self?.let(Words::Plain)
            ?: Words.Message(if (door == askDoor) R.string.gym_proposal_source_coach else R.string.gym_proposal_source_connected_agent)

    // The prose is attributed by who wrote it: the agent by name, Coach for the room's own door, and
    // an agent that did not name itself is still the lifter's own. The same three on every surface.
    val wrote: Words
        get() = Words.Message(R.string.gym_proposal_wrote, listOf(self?.let(Words::Plain)
            ?: Words.Message(if (door == askDoor) R.string.gym_proposal_source_coach else R.string.gym_proposal_source_your_agent)))

    private val self: String?
        get() = agent?.takeIf { it.isNotBlank() } ?: connection?.takeIf { it.isNotBlank() }

    companion object {
        const val askDoor = "ask"
    }
}

// The absences: no `sets` is an open line, a set's missing reps is `max` and its missing load is
// last time. Which SIDE is missing is `kind`.
@Serializable
data class ProposalTargets(
    val sets: List<SetTarget> = emptyList(),
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
    // Its old and new place while the proposal waits, read against the routine or the workout's plan and never stored.
    @Transient val order: FieldMove? = null,
) {
    // Kept where it stood, so a count says it.
    val stands: Boolean get() = kind == ChangeKind.Kept && order == null

    // Zero is a real answer and an absent count says neither.
    fun removed(from: Words): Words {
        val kept = loggedSets ?: return Words.Message(R.string.gym_proposal_removed_from, listOf(from))
        if (kept == 0) return Words.Message(R.string.gym_proposal_removed_never_logged, listOf(from))
        return Words.Counted(R.plurals.gym_proposal_removed_kept, kept, listOf(from, kept.toString()))
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
    // A workout proposal's `routineId` names its session, and it carries no `baseName`.
    val target: ProposalTarget = ProposalTarget.Routine,
    // Why a workout proposal can no longer be applied, read with it so the two never disagree.
    val stale: Stale? = null,
) {
    val isPending: Boolean get() = state == ProposalState.Pending

    val drawn: List<ProposalChange> get() = changes.filterNot { it.stands }

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
                if (change.stands) kept += change
                else {
                    closeRun()
                    rows += DocumentRow.Changed(change)
                }
            }
            closeRun()
            return rows
        }

    // A workout's sheet reads what changes first: what only moved, what changes, what goes and what comes, then one count of what stands (08.55b).
    val changesFirst: List<DocumentRow>
        get() {
            val rank = listOf(ChangeKind.Kept, ChangeKind.Retargeted, ChangeKind.Removed, ChangeKind.Added)
            val kept = changes.filter { it.stands }
            return drawn.sortedBy { rank.indexOf(it.kind) }.map { DocumentRow.Changed(it) } +
                listOfNotNull(DocumentRow.Unchanged(kept).takeIf { kept.isNotEmpty() })
        }

    // Derived from the SERVER's reply and never from the model's prose: the name the routine now
    // carries and the server's own count of what changed, or that the routine is gone.
    val settledReceipt: ProposalReceipt?
        get() = when (state) {
            ProposalState.Applied -> ProposalReceipt(applied = true, words =
                if (intent == ProposalIntent.Remove) Words.Message(R.string.gym_proposal_receipt_removed, listOf(routineNamed))
                else Words.Message(R.string.gym_proposal_receipt_applied,
                    listOf(name.ifBlank { baseName }.takeIf { it.isNotBlank() }?.let(Words::Plain) ?: routineNamed, counting)))
            ProposalState.Dismissed -> ProposalReceipt(applied = false, words = Words.Message(R.string.gym_proposal_receipt_turned_down))
            else -> null
        }

    val renames: Boolean
        get() = name.isNotBlank() && baseName.isNotBlank() && name != baseName

    fun landsAfter(added: ProposalChange): String? {
        val run = changes.takeWhile { it.kind != ChangeKind.Removed }
        val at = run.indexOf(added)
        if (at <= 0) return null
        return run[at - 1].exerciseId
    }

    fun by(nowMs: Long): Words = Words.Message(R.string.gym_proposal_byline, listOf(source.named, Readout.loggedWhen(createdAtMs, nowMs)))

    fun summarized(routine: Words): Words {
        if (summary.isNotBlank()) return Words.Plain(summary)
        if (intent == ProposalIntent.Remove) return Words.Message(R.string.gym_proposal_summary_remove, listOf(routine))
        return Words.Message(R.string.gym_proposal_summary_changes, listOf(counting, routine))
    }

    val counting: Words
        get() {
            if (intent == ProposalIntent.Remove) return Words.Message(R.string.gym_proposal_a_removal)
            return Words.Counted(R.plurals.gym_proposal_changes, changeCount, listOf(changeCount.toString()))
        }

    // The count, which is what the sheet draws; apply is atomic against the document.
    val applying: Words
        get() = when {
            intent == ProposalIntent.Remove -> Words.Message(R.string.gym_proposal_remove_routine, listOf(routineNamed))
            changeCount == 1 -> Words.Message(R.string.gym_proposal_apply)
            else -> Words.Message(R.string.gym_proposal_apply_all, listOf(changeCount.toString()))
        }

    val atomic: Words
        get() {
            if (intent == ProposalIntent.Remove) return Words.Message(R.string.gym_proposal_atomic_remove)
            if (changeCount <= 1) return Words.Message(R.string.gym_proposal_atomic_one)
            return Words.Message(R.string.gym_proposal_atomic_all, listOf(Readout.spelledOut(changeCount)))
        }

    fun settled(nowMs: Long): Words? {
        val at = settledAtMs ?: return null
        val day = Readout.brief(at, nowMs)
        val time = Readout.time(at)
        return when (state) {
            ProposalState.Applied -> Words.Message(R.string.gym_proposal_settled_applied, listOf(routineNamed, day, time))
            ProposalState.Dismissed -> Words.Message(R.string.gym_proposal_settled_turned_down, listOf(day, time))
            ProposalState.Superseded -> Words.Message(R.string.gym_proposal_settled_superseded, listOf(routineNamed, day, time))
            ProposalState.Pending -> null
        }
    }

    val routineNamed: Words
        get() = when {
            target == ProposalTarget.Workout -> Words.Message(R.string.gym_proposal_this_workout)
            baseName.isBlank() -> Words.Message(R.string.gym_proposal_this_routine)
            else -> Words.Plain(baseName)
        }

    // What the card and the sheet are addressed by.
    val addressed: Words get() = if (target == ProposalTarget.Workout) Words.Message(R.string.gym_proposal_this_workout_heading) else routineNamed

    // Where its change lines land.
    val landsIn: Words get() = Words.Message(if (target == ProposalTarget.Workout) R.string.gym_proposal_this_workout else R.string.gym_proposal_the_routine)

    // Why it can no longer be applied (08.57): one cause, then that nothing was applied.
    val staleWhy: Words? get() = stale?.why

    companion object {
        // Loads are compared on the LADDER's grid and never on raw doubles. A scheme whose shape held
        // and whose one set moved prints that set — `set 4 · 100 × 1 → 102.5 × 1`; any other move
        // of the sets prints both schemes in the readout formula.
        fun moves(before: ProposalTargets, after: ProposalTargets): List<FieldMove> {
            val moved = mutableListOf<FieldMove>()
            if (!Scheme.same(before.sets, after.sets)) {
                val movedSets = if (before.sets.size != after.sets.size) emptyList()
                    else before.sets.indices.filterNot { Scheme.same(listOf(before.sets[it]), listOf(after.sets[it])) }
                moved += movedSets.singleOrNull()?.let { at ->
                    FieldMove(Words.Message(R.string.gym_proposal_set_n, listOf((at + 1).toString())),
                        Readout.setScheme(before.sets[at]), Readout.setScheme(after.sets[at]))
                } ?: FieldMove(Words.Message(R.string.gym_proposal_sets), Readout.scheme(before.sets), Readout.scheme(after.sets), scheme = true)
            }
            return moved
        }
    }
}

// What a settled proposal's receipt says, and whether it says it was applied.
data class ProposalReceipt(val applied: Boolean, val words: Words)

// Why a workout proposal was set aside: the domain's reason, and the movement a set was logged on.
@Serializable
data class Stale(val reason: String, val movement: String? = null) {
    val why: Words
        get() = Words.Message(R.string.gym_proposal_stale, listOf(when (reason) {
            "replaced" -> Words.Message(R.string.gym_proposal_stale_replaced)
            "workout-finished" -> Words.Message(R.string.gym_proposal_stale_finished)
            "workout-moved" -> Words.Message(R.string.gym_proposal_stale_moved, listOf(movement?.let(Words::Plain) ?: Words.Message(R.string.gym_proposal_stale_a_movement)))
            else -> Words.Message(R.string.gym_proposal_stale_changed)
        }))
}

// The routine is absent when the intent was to remove it.
data class ProposalDecision(val proposal: Proposal, val routine: Routine? = null)

sealed interface DocumentRow {
    data class Changed(val change: ProposalChange) : DocumentRow
    data class Unchanged(val kept: List<ProposalChange>) : DocumentRow {
        val said: Words get() = Words.Counted(R.plurals.gym_proposal_unchanged, kept.size, listOf(kept.size.toString()))
    }
}

// One field's move. `scheme` is the whole scheme's, which the review sheet prints without its label.
data class FieldMove(val field: Words, val was: Words, val becomes: Words, val scheme: Boolean = false)
