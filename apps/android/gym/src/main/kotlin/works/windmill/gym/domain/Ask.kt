package works.windmill.gym.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Coach requests retain their identity across retries; generations record durable actions.
// The wire still says `ask` and its verdict codes stay `ask-*`; the room a lifter sees is Coach.
// No outgoing field may carry a default: encodeDefaults is off, so a defaulted field travels absent.

// A step is drawn in the lifter's words or not at all: a tool this build cannot name prints NOTHING,
// and the receipt beside the list still says what was read.
@Serializable
data class AskStep(val tool: String, val failed: Boolean = false) {
    val phrase: String?
        get() {
            val said = Ask.phrases[tool] ?: return null
            return if (failed) "$said (nothing came back)" else said
        }
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
    val receipt: AnswerReceipt? = null,
    val generation: AskGeneration? = null,
    val results: List<CoachResult> = emptyList(),
)

@Serializable
data class CoachResult(val kind: String, val operationId: String, val routineId: String, val routineName: String)

@Serializable
data class CoachAttachment(val id: String, val mediaType: String, val width: Int, val height: Int, val bytes: Long)

@Serializable
data class CoachDraft(val text: String = "", val photo: CoachAttachment? = null)

@Serializable
data class AskGeneration(
    val id: String,
    val requestId: String,
    val question: String,
    val status: String,
    val answer: String = "",
    @SerialName("at") val atMs: Long = 0,
    val steps: List<AskStep> = emptyList(),
    val receipt: AnswerReceipt? = null,
    val results: List<CoachResult> = emptyList(),
    val revision: Long = 0,
    val stopRequested: Boolean = false,
    val attachments: List<CoachAttachment> = emptyList(),
) {
    val terminal: Boolean get() = status in setOf("completed", "failed", "stopped")
    fun response(): AskAnswer = AskAnswer(answer, receipt?.read ?: ReadTally(), steps, receipt?.proposals.orEmpty(), receipt, this, results)

    fun exchange(): AskExchange = AskExchange(
        question = question,
        requestId = requestId,
        generation = this,
        answer = if (status == "completed") response() else null,
        trouble = when (status) { "failed" -> Ask.interrupted; "stopped" -> Ask.stopped; else -> null },
        again = status == "failed",
        attachments = attachments,
    )
}

@Serializable
data class WorkoutObservation(
    val workingSetCount: Int,
    val tonnageKg: Double,
    val durationMs: Long? = null,
) {
    val valid: Boolean get() = workingSetCount >= 0 && tonnageKg.isFinite() && tonnageKg >= 0 &&
        (durationMs == null || durationMs >= 0)
}

@Serializable
data class SessionObservation(
    val sessionId: String,
    @SerialName("startedAt") val startedAtMs: Long,
    val tool: String,
    val coverage: String,
    val setsRead: Int,
    @SerialName("finishedAt") val finishedAtMs: Long? = null,
    val routine: String? = null,
    val exerciseId: String? = null,
    val workout: WorkoutObservation? = null,
) {
    val wholeWorkout: Boolean get() = coverage in listOf("summary", "session") &&
        exerciseId == null && workout?.valid == true
    val valid: Boolean get() = sessionId.isNotBlank() && startedAtMs > 0 && setsRead >= 0 &&
        coverage in listOf("summary", "session", "movement") &&
        (coverage != "movement" || !exerciseId.isNullOrBlank())
}

@Serializable
data class AnswerReceipt(
    val version: Int,
    val read: ReadTally,
    val steps: List<AskStep> = emptyList(),
    val proposals: List<String> = emptyList(),
    val observations: List<SessionObservation> = emptyList(),
) {
    val supported: Boolean get() = version == 1
    val observed: List<SessionObservation> get() = if (supported) observations.filter { it.valid } else emptyList()
    val workouts: List<SessionObservation> get() = observed.filter { it.wholeWorkout && it.coverage == "session" }
        .groupBy { it.sessionId }.values.map { it.last() }
}

// Which ceiling took the composer down. ONE state serves both, because the connect door beneath it
// is unrationed under either; which one it is decides only what is said and which door leads. Read
// off the CODE and never off the sentence. `wordless` is what the room says for a reply that carried
// no words of its own — and the two may never say the same thing, or an account at its 30-day
// ceiling is told the next question comes back in a couple of hours.
enum class AskCap(val wordless: String) {
    Daily(Ask.capReached),
    Ceiling(Ask.ceilingReached),
}

// `again` marks trouble worth a second tap; a cap, a malformed thread or an open workout are not.
@Serializable
data class AskExchange(
    val question: String,
    val answer: AskAnswer? = null,
    val trouble: String? = null,
    val again: Boolean = false,
    val needsNew: Boolean = false,
    val requestId: String = "",
    val generation: AskGeneration? = null,
    val attachments: List<CoachAttachment> = emptyList(),
) {
    val pending: Boolean get() = answer == null && trouble == null
}

object Ask {
    const val title = "Coach"
    const val subtitle = "reads your log · helps with your routines"
    const val placeholder = "Ask about your training"

    // The server's own ceiling on one turn.
    const val maxTurnBytes = 1000

    const val fromLifter = "lifter"

    // The rest is said where it counts: the subtitle says what Coach reads, `promise` on every
    // proposal card says what it cannot touch.
    const val whatItIs = "Ask about your training. Coach can create routines and propose changes — you decide on the diff."

    const val allowance = "Ten questions a day, three back to back."
    const val capReached = "The next question frees up in a couple of hours."

    // The account's 30-day ceiling. A different fact from the daily bucket and never the same
    // sentence: nothing frees up in a couple of hours under this one.
    const val ceilingReached =
        "This account has reached its AI ceiling for the last 30 days. Coach will answer again as " +
            "that window rolls on."

    fun needsNew(thread: List<AskExchange>): Boolean = thread.lastOrNull()?.needsNew == true

    const val threadFull = "This conversation is unavailable. Start a new one."

    const val kept = "Every conversation is kept so you can read it back, and yours to delete."

    const val freeDoor =
        "If you already use Claude — or Cursor, Codex, any tool of yours that speaks MCP — connect " +
            "it instead. It’s free, and it reaches what Coach can’t: it knows the rest of your life."

    const val connect = "Connect your own"

    const val notesDoor = "Notes"

    const val promise =
        "Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal."

    const val waiting = "reading your log…"

    const val interrupted = "Response interrupted. Retry to continue this response."
    const val stopped = "Response stopped."

    const val signedOut = "Coach reads your log, so it needs you signed in."

    const val notHere = "Coach isn’t part of this Windmill. Your log is still yours to read."

    val openers = listOf("What’s stalled?", "Which lifts are moving?", "Is my week too light?")

    // One phrase per tool the catalog offers Coach, in the lifter's words — the same table the web
    // draws from. A tool absent here is dropped from the step list, never printed by name.
    val phrases = mapOf(
        "list_sessions" to "read your recent workouts",
        "get_session" to "read one workout",
        "last_time" to "read the last time you trained a movement",
        "list_exercises" to "read your movement list",
        "list_routines" to "read your program",
        "get_stats" to "read your movement history",
        "list_notes" to "read your notes",
        "list_bodyweight" to "read your bodyweight",
        "propose_routine_change" to "wrote a proposal for one of your routines",
        "propose_routine_removal" to "wrote a proposal to remove a routine",
    )

    // In call order, each phrase once, the nameless dropped.
    fun steps(steps: List<AskStep>): List<String> = steps.mapNotNull { it.phrase }.distinct()

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
