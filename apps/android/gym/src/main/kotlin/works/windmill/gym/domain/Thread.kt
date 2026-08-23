package works.windmill.gym.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Both fields carry NO DEFAULT: encodeDefaults is off, so a thread id defaulted to "" would travel as
// an absent key. The thread id is this phone's to mint: a fresh one opens a conversation, a spent one
// continues it, and it is NOT a replay key.
@Serializable
data class AskQuestion(val thread: String, val question: String)

// Arrives on the DETAIL read only. `from` carries no default, and an absent `at` prints nothing.
@Serializable
data class AskTurn(val from: String, val text: String, @SerialName("at") val atMs: Long = 0) {
    val fromLifter: Boolean get() = from == Ask.fromLifter
}

@Serializable
data class ThreadProposal(
    val id: String,
    val state: ProposalState = ProposalState.Pending,
    val changeCount: Int = 0,
    val routineId: String = "",
    val routine: String = "",
    @SerialName("createdAt") val createdAtMs: Long = 0,
) {
    // Dated by when the proposal was WRITTEN; an absent instant drops the date and keeps the rest.
    fun line(nowMs: Long): String {
        val counted = if (changeCount == 1) "1 change" else "$changeCount changes"
        val about = routine.takeIf { it.isNotBlank() }?.let { "$counted to $it" } ?: counted
        val became = when (state) {
            ProposalState.Applied -> "applied"
            ProposalState.Dismissed -> "dismissed"
            ProposalState.Superseded -> "set aside"
            ProposalState.Pending -> "waiting"
        }
        val said = "$about · $became"
        if (createdAtMs <= 0) return said
        return "${Readout.shortDate(createdAtMs, nowMs)} · $said"
    }
}

// `kind` stays a String: an unknown word only decides whether a row draws a subtitle. `changes` is
// always present and zero is real. `routineId` and `routine` are absent when the changes spanned more
// than one routine.
@Serializable
data class ThreadOutcome(
    val kind: String = "",
    val changes: Int = 0,
    val routineId: String? = null,
    val routine: String? = null,
) {
    val label: String?
        get() = when (kind) {
            applied -> "applied"
            readOnly -> "read only"
            dismissed -> "dismissed"
            proposed -> "waiting"
            superseded -> "set aside"
            else -> null
        }

    val detail: String?
        get() = when (kind) {
            applied -> routine?.takeIf { it.isNotBlank() }?.let { "$counted → $it" } ?: counted
            readOnly -> "no changes proposed"
            dismissed -> "$counted dismissed"
            proposed -> "$counted waiting"
            superseded -> "$counted superseded"
            else -> null
        }

    val moved: Boolean get() = kind == applied

    private val counted: String get() = if (changes == 1) "1 change" else "$changes changes"

    companion object {
        const val applied = "applied"
        const val readOnly = "read-only"
        const val dismissed = "dismissed"
        const val proposed = "proposed"
        const val superseded = "superseded"
    }
}

// `title` is the lifter's first message VERBATIM: nothing on this phone summarises or truncates it.
@Serializable
data class AskThread(
    val id: String,
    val title: String = "",
    @SerialName("createdAt") val createdAtMs: Long = 0,
    @SerialName("askedAt") val askedAtMs: Long = 0,
    val outcome: ThreadOutcome = ThreadOutcome(),
    val proposals: List<ThreadProposal> = emptyList(),
    val turns: List<AskTurn> = emptyList(),
) {
    fun day(nowMs: Long): String? =
        askedAtMs.takeIf { it > 0 }?.let { Readout.briefDay(it, nowMs) }
}

// The label is NULL for the group the log gave no instant for; it sits last, under no heading.
data class ThreadMonth(val label: String?, val threads: List<AskThread>)

object Threads {
    const val title = "Threads"
    const val open = "Ask something new"

    const val door = "Threads"

    const val conversation = "Conversation"

    fun counted(threads: Int): String {
        val said = if (threads == 1) "1 conversation" else "$threads conversations"
        return "$said · yours to delete"
    }

    const val none = "Nothing here yet. Every conversation you have with Ask is kept until you delete it."

    const val outOfReach = "the log didn’t answer — your conversations are out of reach"

    const val deletes = "Delete this conversation"
    const val deleteRule =
        "Deleting the conversation keeps what it changed: an applied change stays in the routine's " +
            "history. There is no undoing the delete."

    const val past = "A conversation you had. Ask something new to start another."

    // Sorted by the SERVER's instants and never by arrival order.
    fun months(threads: List<AskThread>, nowMs: Long): List<ThreadMonth> =
        threads.sortedByDescending { it.askedAtMs }
            .groupBy { thread ->
                thread.askedAtMs.takeIf { it > 0 }?.let { Readout.month(it, nowMs) }
            }
            .map { (label, held) -> ThreadMonth(label, held) }
}
