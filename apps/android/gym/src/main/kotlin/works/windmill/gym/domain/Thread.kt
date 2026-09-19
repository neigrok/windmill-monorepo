package works.windmill.gym.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// The conversation ID locates the history; the request ID identifies one retryable question.
@Serializable
data class AskQuestion(val thread: String, val question: String, val requestId: String? = null, val attachmentIds: List<String> = emptyList())

// Arrives on the DETAIL read only. `from` carries no default, and an absent `at` prints nothing.
@Serializable
data class AskTurn(
    val from: String,
    val text: String,
    @SerialName("at") val atMs: Long = 0,
    val receipt: AnswerReceipt? = null,
    val position: Long = 0,
    val generationId: String? = null,
    val results: List<CoachResult> = emptyList(),
    val status: String = "completed",
    val requestId: String? = null,
    val attachments: List<CoachAttachment> = emptyList(),
) {
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
    val counted: String get() = if (changeCount == 1) "1 change" else "$changeCount changes"

    // The card's summary where the thread read carries no prose: the same shape the routines-home
    // card falls back to. The conversation's own detail read replaces it with the model's words.
    val summaryLine: String
        get() = routine.takeIf { it.isNotBlank() }?.let { "$counted to $it." } ?: "$counted."

    // Dated by when the proposal was WRITTEN; an absent instant drops the date and keeps the rest.
    // `stillWaiting` is a review opened and closed with nothing decided.
    fun line(nowMs: Long, stillWaiting: Boolean = false): String {
        val about = routine.takeIf { it.isNotBlank() }?.let { "$counted to $it" } ?: counted
        val became = when (state) {
            ProposalState.Applied -> "applied"
            ProposalState.Dismissed -> "turned down"
            ProposalState.Superseded -> "set aside"
            ProposalState.Pending -> if (stillWaiting) Proposal.stillWaiting else "waiting"
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
            created -> "created"
            dismissed -> "turned down"
            proposed -> "waiting"
            superseded -> "set aside"
            else -> null
        }

    val detail: String?
        get() = when (kind) {
            applied -> routine?.takeIf { it.isNotBlank() }?.let { "$counted → $it" } ?: counted
            created -> if (changes == 1) routine?.takeIf { it.isNotBlank() }?.let { "created $it" }
                ?: "1 routine created" else "$changes routines created"
            dismissed -> "$counted turned down"
            proposed -> "$counted waiting"
            superseded -> "$counted superseded"
            else -> null
        }

    val moved: Boolean get() = kind == applied

    private val counted: String get() = if (changes == 1) "1 change" else "$changes changes"

    companion object {
        const val applied = "applied"
        const val readOnly = "read-only"
        const val created = "created"
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
    val nextCursor: String? = null,
    val generation: AskGeneration? = null,
) {
    fun day(nowMs: Long): String? =
        askedAtMs.takeIf { it > 0 }?.let { Readout.briefDay(it, nowMs) }

    fun exchanges(): List<AskExchange> {
        val exchanges = mutableListOf<AskExchange>()
        turns.forEach { turn ->
            if (turn.fromLifter) exchanges += AskExchange(turn.text, requestId = turn.requestId.orEmpty(), attachments = turn.attachments)
            else {
                val previous = if (exchanges.isNotEmpty() && exchanges.last().answer == null) exchanges.removeAt(exchanges.lastIndex) else AskExchange("")
                if (turn.status == "failed" || turn.status == "stopped") {
                    val request = turn.requestId ?: generation?.takeIf { it.id == turn.generationId }?.requestId.orEmpty()
                    exchanges += previous.copy(requestId = request, trouble = if (turn.status == "stopped") Ask.stopped else Ask.interrupted,
                        again = turn.status == "failed" && request.isNotEmpty(),
                        generation = AskGeneration(turn.generationId.orEmpty(), request, previous.question, turn.status,
                            turn.text, turn.atMs, turn.receipt?.steps.orEmpty(), turn.receipt, turn.results, attachments = previous.attachments))
                } else exchanges += previous.copy(answer = AskAnswer(turn.text, turn.receipt?.read ?: ReadTally(),
                    turn.receipt?.steps.orEmpty(), turn.receipt?.proposals.orEmpty(), turn.receipt, results = turn.results))
            }
        }
        generation?.let { current ->
            val index = exchanges.indexOfFirst { it.requestId == current.requestId }
            if (index >= 0) exchanges[index] = current.exchange()
            else if (turns.none { it.generationId == current.id }) exchanges += current.exchange()
        }
        return exchanges
    }
}

@Serializable
data class ThreadPage(val threads: List<AskThread> = emptyList(), val nextCursor: String? = null)

// The label is NULL for the group the log gave no instant for; it sits last, under no heading.
data class ThreadMonth(val label: String?, val threads: List<AskThread>)

object Threads {
    const val title = "History"
    const val open = "Ask something new"

    const val door = "History"

    const val conversation = "Conversation"

    fun counted(threads: Int): String {
        val said = if (threads == 1) "1 conversation" else "$threads conversations"
        return "$said · yours to delete"
    }

    const val none = "Nothing here yet. Every conversation you have with Coach is kept until you delete it."

    const val outOfReach = "the log didn’t answer — your conversations are out of reach"

    const val past = "A conversation you had. Ask something new to start another."

    // Sorted by the SERVER's instants and never by arrival order.
    fun months(threads: List<AskThread>, nowMs: Long): List<ThreadMonth> =
        threads.sortedByDescending { it.askedAtMs }
            .groupBy { thread ->
                thread.askedAtMs.takeIf { it > 0 }?.let { Readout.month(it, nowMs) }
            }
            .map { (label, held) -> ThreadMonth(label, held) }
}
