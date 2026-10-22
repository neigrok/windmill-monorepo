package works.windmill.gym.domain.sync

import works.windmill.domain.kit.Id
import works.windmill.domain.kit.Nfc

// A proposal as its card reads it: each change a block of field lines, in the card's order — a new name, movements that
// only moved, changed movements, removals, additions — and how many movements it leaves as they were. Moves are read
// against the routine while the proposal waits; once it settled, the routine no longer holds the order it replaced.
class ProposalDiff(proposal: Proposal, routine: Routine?, units: GymUnits = GymUnits.kg, each: Set<Id<Exercise>> = emptySet()) {
    enum class Kind { renamed, moved, changed, removed, added }
    enum class State { changed, same, new, gone }

    // One line of a block: *Load  82.5 kg → 90 kg*. A new line has no before, a gone line no after. Two sides that differ only
    // in Unicode form read the same.
    data class Field(val label: String, val before: String?, val after: String?) {
        val state: State get() = when {
            before == null -> State.new
            after == null -> State.gone
            Nfc.normalise(before) == Nfc.normalise(after) -> State.same
            else -> State.changed
        }
    }

    data class Block(val kind: Kind, val exerciseId: Id<Exercise>?, val fields: List<Field>)

    val blocks: List<Block>
    val unchanged: Int

    init {
        val pending = proposal.state == "pending"
        val moves = if (pending && routine != null) moves(proposal, routine) else emptyMap()
        val blocks = mutableListOf<Block>()
        val name = proposal.baseName ?: routine?.name?.takeIf { pending }
        val rename = Field("Name", name, proposal.proposedName)
        if (rename.state == State.changed) blocks += Block(Kind.renamed, null, listOf(rename))
        var unchanged = 0
        proposal.changes.forEachIndexed { index, change ->
            val order = moves[index]?.let { listOf(Field("Order", ordinal(it.from), ordinal(it.to))) } ?: emptyList()
            val fields = fields(change.before, change.after, units, change.exerciseId in each)
            when {
                change.kind == "kept" && order.isEmpty() -> unchanged += 1
                change.kind == "kept" -> blocks += Block(Kind.moved, change.exerciseId, order)
                change.kind == "retargeted" -> blocks += Block(Kind.changed, change.exerciseId, order + fields)
                change.kind == "removed" -> blocks += Block(Kind.removed, change.exerciseId, fields)
                else -> blocks += Block(Kind.added, change.exerciseId, fields)
            }
        }
        val removing = proposal.intent == "remove"
        this.blocks = if (removing) emptyList() else blocks.sortedBy { it.kind.ordinal }
        this.unchanged = if (removing) 0 else unchanged
    }

    companion object {
        // A movement's targets, before and after, as lines: *Sets*, *Reps* and *Load* while every set is the same, one line per
        // set once they differ, *Target* when one side is open, and *Rest* when it changed. A side that is absent — an added or
        // a removed movement — leaves every line new or gone, its rest unsaid.
        fun fields(before: EntryTargets?, after: EntryTargets?, units: GymUnits = GymUnits.kg, each: Boolean = false): List<Field> {
            val sides = listOfNotNull(before, after).map { it.sets ?: emptyList() }
            fun line(label: String, read: (EntryTargets) -> String?) = Field(label, before?.let(read), after?.let(read))
            fun load(kg: Double?) = kg?.let { Readout.weight(it, units) + " " + units.name + (if (each) " each" else "") }
            fun scheme(target: SetTarget) =
                if (target.weightKg == null) reps(target.reps) + " reps" else reps(target.reps) + " × " + load(target.weightKg)
            val lines = mutableListOf<Field>()
            if (sides.any { it.isEmpty() }) {
                if (!(sides.size == 2 && sides.all { it.isEmpty() })) lines += line("Target") { targets ->
                    val sets = targets.sets
                    when {
                        sets.isNullOrEmpty() -> "None"
                        !uniform(sets) -> sets.joinToString(", ") { scheme(it) }
                        else -> "${sets.size} × " + reps(sets[0].reps) + (load(sets[0].weightKg)?.let { " at $it" } ?: "")
                    }
                }
            } else if (sides.all(::uniform)) {
                lines += line("Sets") { it.sets?.size?.toString() }
                lines += line("Reps") { targets -> targets.sets?.let { reps(it[0].reps) } }
                if (sides.any { it[0].weightKg != null }) lines += line("Load") { targets -> targets.sets?.let { load(it[0].weightKg) ?: "Last time" } }
            } else {
                for (index in 0 until sides.map { it.size }.max()) {
                    val read = { targets: EntryTargets? -> targets?.sets?.getOrNull(index)?.let { scheme(it) } }
                    lines += Field("Set ${index + 1}", read(before), read(after))
                }
            }
            if (before != null && after != null && before.restSeconds != after.restSeconds) {
                lines += line("Rest") { targets -> targets.restSeconds?.let { if (it >= 120 && it % 60 == 0) "${it / 60} min" else "$it s" } ?: "Default" }
            }
            return lines
        }

        private fun reps(reps: Int?): String = reps?.toString() ?: "Max"
        private fun uniform(sets: List<SetTarget>): Boolean = sets.all { it == sets[0] }

        private fun ordinal(place: Int): String {
            val suffix = if (place % 100 in 11..13) "th" else mapOf(1 to "st", 2 to "nd", 3 to "rd")[place % 10] ?: "th"
            return "$place$suffix"
        }

        private data class Kept(val change: Int, val from: Int, val to: Int)

        // The movements a pending proposal moves, by change index, each with its place in the routine and in the proposal. A
        // movement whose place is the same in both never moved; of the rest, those in the longest run that keeps the routine's
        // order stand — of equal runs, the one whose places come first — and every other one moved.
        private fun moves(proposal: Proposal, base: Routine): Map<Int, Kept> {
            val unmatched = base.entries.indices.toMutableList()
            val kept = mutableListOf<Kept>()
            proposal.changes.withIndex().filter { it.value.kind != "removed" }.forEachIndexed { to, (index, change) ->
                if (change.kind != "kept" && change.kind != "retargeted") return@forEachIndexed
                val at = unmatched.indexOfFirst { base.entries[it].exerciseId == change.exerciseId }
                if (at < 0) return@forEachIndexed
                val from = unmatched.removeAt(at)
                if (from != to) kept += Kept(index, from, to)
            }
            val longest = MutableList(kept.size) { 1 }
            for (i in kept.indices.reversed()) {
                for (j in kept.indices) if (j > i && kept[j].from > kept[i].from) longest[i] = maxOf(longest[i], longest[j] + 1)
            }
            val standing = mutableSetOf<Int>()
            var previous = -1
            var length = longest.maxOrNull() ?: 0
            var start = 0
            while (length > 0) {
                val next = kept.indices.filter { it >= start && kept[it].from > previous && longest[it] == length }.minByOrNull { kept[it].from }!!
                standing += next; previous = kept[next].from; start = next + 1; length -= 1
            }
            return kept.withIndex().filter { it.index !in standing }.associate { (_, entry) -> entry.change to entry.copy(from = entry.from + 1, to = entry.to + 1) }
        }
    }
}
