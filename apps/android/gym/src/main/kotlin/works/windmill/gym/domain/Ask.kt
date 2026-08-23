package works.windmill.gym.domain

import kotlinx.serialization.Serializable

// POST /v1/gym/ask, owner-scoped: { thread, question } → { answer, steps, read, proposals, thread }.
// No outgoing field may carry a default: encodeDefaults is off, so a defaulted field travels absent.

@Serializable
data class AskStep(val tool: String, val failed: Boolean = false) {
    val line: String get() = if (failed) "$tool · no answer" else tool
}

// Server-counted. Nothing on this phone may compute, sum or infer it.
@Serializable
data class ReadTally(val sets: Int = 0, val sessions: Int = 0, val weeks: Int = 0) {
    val anything: Boolean get() = sets > 0 || sessions > 0 || weeks > 0
}

@Serializable
data class AskAnswer(
    val answer: String,
    val read: ReadTally,
    val steps: List<AskStep> = emptyList(),
    val proposals: List<String> = emptyList(),
)

// `again` marks trouble worth a second tap; a cap, a malformed thread or an open workout are not.
@Serializable
data class AskExchange(
    val question: String,
    val answer: AskAnswer? = null,
    val trouble: String? = null,
    val again: Boolean = false,
) {
    val pending: Boolean get() = answer == null && trouble == null
}

object Ask {
    const val title = "Ask"
    const val subtitle = "reads your log · proposes only"
    const val placeholder = "Ask about your training"

    // The server's own ceiling on one turn.
    const val maxTurnBytes = 1000

    const val fromLifter = "lifter"

    const val whatItIs =
        "Ask reads the log you already keep and answers questions about it. It can propose a change " +
            "to a routine — you decide on the diff. It cannot edit or delete a set you logged: that " +
            "one is yours."

    const val dailyCap =
        "It answers about ten questions a day, three back to back — the cap that keeps Ask open to " +
            "everyone. There is nothing to buy here."

    const val kept = "Every conversation is kept so you can read it back, and yours to delete."

    const val freeDoor =
        "If you already use Claude — or Cursor, Codex, any tool of yours that speaks MCP — connect " +
            "it instead: it's free, and it's better, because it knows the rest of your life."

    const val connect = "Connect your own"

    const val promise =
        "Nothing changes until you tap Apply on the diff. Your logged sets are never part of a proposal."

    const val waiting = "reading your log…"

    const val interrupted =
        "Ask didn't finish that one. The log heard the question, so it may have counted against " +
            "today's — and anything it proposed is on the routine either way. If it did answer, " +
            "the conversation is in Threads."

    const val notHere = "Ask isn't part of this Windmill. Your log is still yours to read."

    val openers = listOf("What's stalled?", "Which lifts are moving?", "Is my week too light?")

    // Run on the way in: a pending exchange was in flight when the room went down.
    fun settled(thread: List<AskExchange>): List<AskExchange> {
        if (thread.none { it.pending }) return thread
        return thread.map { exchange ->
            if (!exchange.pending) exchange
            else exchange.copy(trouble = interrupted, again = true)
        }
    }

    // `standing` null means unknown, not nobody: only a seat the room has read may take a thread.
    fun handedOver(saved: String, standing: String?, known: Boolean): Boolean {
        if (standing == null && !known) return false
        return (standing ?: "") != saved
    }

    fun sendable(typed: String): Boolean {
        val asked = typed.trim()
        return asked.isNotEmpty() && asked.toByteArray(Charsets.UTF_8).size <= maxTurnBytes
    }

    fun receipt(read: ReadTally): String {
        if (!read.anything) return "read nothing from your log"
        val parts = mutableListOf<String>()
        if (read.sets > 0) parts += Readout.setCount(read.sets)
        if (read.weeks > 0) parts += Readout.weekCount(read.weeks)
        if (read.sessions > 0) parts += Readout.sessionCount(read.sessions)
        return "read ${parts.joinToString(" · ")}"
    }
}
