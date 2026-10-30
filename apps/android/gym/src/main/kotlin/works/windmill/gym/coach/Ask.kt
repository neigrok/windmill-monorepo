package works.windmill.gym.coach

import works.windmill.gym.domain.Notes
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.RoutineEntry
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import works.windmill.platform.net.WindmillJson

// Request identities survive retries; generation snapshots retain completed actions.

// A step is drawn in the lifter's words or not at all: a tool this build cannot name prints NOTHING,
// and the receipt beside the list still says what was read. Only a turn that carries routine drafts says
// Coach drafted one; a turn from before drafts created its routine at once.
@Serializable
data class AskStep(val tool: String, val failed: Boolean = false) {
    fun phrase(drafted: Boolean = true): String? {
        if (tool == "save_note" && failed) return "could not confirm a note save"
        val said = (if (tool == "create_routine" && !drafted) Ask.createdRoutine else Ask.phrases[tool]) ?: return null
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
    val routineDrafts: List<CoachRoutineDraft> = emptyList(),
    val clarification: JsonElement? = null,
) {
    // A draft is saved once the log's turn or this phone's confirmation says so; neither unsaves it.
    fun confirmedBy(confirmation: AskGeneration?): AskAnswer {
        if (confirmation == null) return this
        val saved = confirmation.routineDrafts.filter { it.state == "saved" }.associateBy { it.operationId }
        return copy(routineDrafts = routineDrafts.map { saved[it.operationId] ?: it },
            results = (results + confirmation.results).distinctBy { it.kind to it.operationId })
    }
}

@Serializable
data class CoachResult(val kind: String, val operationId: String, val routineId: String, val routineName: String)

@Serializable
data class CoachRoutineDraft(
    val operationId: String,
    val routineId: String,
    val name: String,
    val position: Int,
    val entries: List<RoutineEntry>,
    val state: String,
)

@Serializable
data class CoachRoutineConfirmation(val thread: String, val generation: AskGeneration, val results: List<CoachResult> = emptyList())

@Serializable
data class CoachAttachment(val id: String, val mediaType: String, val width: Int, val height: Int, val bytes: Long)

@Serializable
data class CoachDraft(val text: String = "", val photo: CoachAttachment? = null, val setup: Boolean = false)

@Serializable
data class CoachClarification(val id: String, val question: String, val groups: List<Group>) {
    @Serializable data class Group(val id: String, val label: String, val multiple: Boolean, val options: List<Option>)
    @Serializable data class Option(val id: String, val label: String)

    fun choosing(selected: Map<String, List<String>>, groupId: String, optionId: String): Map<String, List<String>>? {
        val group = groups.firstOrNull { it.id == groupId } ?: return null
        if (group.options.none { it.id == optionId }) return null
        val prior = selected[groupId].orEmpty()
        val next = if (optionId in prior) prior - optionId else if (group.multiple) prior + optionId else listOf(optionId)
        return groups.associate { known -> known.id to known.options.map { it.id }.filter { it in if (known.id == groupId) next else selected[known.id].orEmpty() } }
    }

    fun text(selected: Map<String, List<String>>): String = groups.mapNotNull { group ->
        group.options.filter { it.id in selected[group.id].orEmpty() }.map { it.label }.takeIf { it.isNotEmpty() }
            ?.joinToString(", ")?.plus(".")
    }.joinToString(" ")

    companion object {
        fun from(value: JsonElement?): CoachClarification? {
            if (value == null) return null
            val result = try { WindmillJson.decodeFromJsonElement(serializer(), value) } catch (_: IllegalArgumentException) { return null }
            fun text(value: String, limit: Int): Boolean = value.isNotBlank() && '\u0000' !in value &&
                value.toByteArray(Charsets.UTF_8).size <= limit && value.codePoints().noneMatch { it in 0xD800..0xDFFF }
            if (!result.id.matches(Regex("[A-Za-z0-9_-]{8,64}")) || !text(result.question, 500) || result.groups.size !in 1..2 ||
                result.groups.map { it.id }.distinct().size != result.groups.size) return null
            for (group in result.groups) {
                if (group.id !in setOf("days", "equipment") || group.id == "days" && group.multiple || !text(group.label, 80) ||
                    group.options.size !in 1..6 || group.options.map { it.id }.distinct().size != group.options.size) return null
                if (group.options.any { !it.id.matches(Regex("[a-z0-9_-]{1,32}")) || !text(it.label, 80) }) return null
            }
            return result
        }
    }
}

@Serializable
data class KeptCoachDraft(val id: String, val draft: CoachDraft)

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
    val routineDrafts: List<CoachRoutineDraft> = emptyList(),
    val clarification: JsonElement? = null,
) {
    val terminal: Boolean get() = status in setOf("completed", "failed", "stopped")
    fun response(): AskAnswer = AskAnswer(answer, receipt?.read ?: ReadTally(), steps, receipt?.proposals.orEmpty(), receipt, this, results, routineDrafts, clarification)

    fun exchange(): AskExchange = AskExchange(
        question = question,
        requestId = requestId,
        generation = this,
        answer = if (status == "completed") response() else null,
        trouble = when (status) { "failed" -> Ask.interrupted; "stopped" -> Ask.stopped; else -> null },
        again = status == "failed",
        attachments = attachments,
        atMs = atMs,
    )
}

@Serializable
data class WorkoutObservation(
    val workingSetCount: Int,
    val tonnageKg: Double?,
    val durationMs: Long? = null,
) {
    val valid: Boolean get() = workingSetCount >= 0 && (tonnageKg == null || tonnageKg.isFinite() && tonnageKg >= 0) &&
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

// The typed cap chooses its notice while the refused input remains editable.
enum class AskCap(val wordless: String) {
    Daily(Ask.capReached),
    Ceiling(Ask.ceilingReached),
    Allowance("You have used all of your AI allowance."),
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
    val atMs: Long = 0,
    val position: Long = 0,
    val retryAtMs: Long? = null,
    val refusalCode: String? = null,
    val terminalRefusal: Boolean = false,
) {
    val pending: Boolean get() = answer == null && trouble == null
}

object Ask {
    const val title = "Coach"
    const val placeholder = "Ask about your training"

    // The server's own ceiling on one turn.
    const val maxTurnBytes = 8000

    const val fromLifter = "lifter"

    const val allowance = "Ten questions a day, three back to back."
    const val capReached = "Coach cannot take another question yet. Try again later."

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

    // A routine draft's Save. A draft the log no longer holds, or cannot write, takes Save away.
    const val draftGone = "This draft is no longer available."
    const val draftInvalid = "This draft can’t be saved. Ask Coach for a new one."
    const val draftRetry = "Couldn’t save the routine. Try again."
    const val draftSignIn = "Sign in again to save this routine."


    const val interrupted = "Response interrupted. Retry to continue this response."
    const val stopped = "Response stopped."

    const val accessNeedsSignIn = "Coach needs your workout log. Please sign in."

    const val notHere = "This Windmill does not have Coach. You can still read your log."
    const val accountRequired = "I need your account to change a routine. Sign in, then ask again."


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
        "save_note" to "saved a note",
        "list_bodyweight" to "read your bodyweight",
        "create_routine" to "drafted a routine for your review",
        "update_exercise" to "updated a movement",
        "propose_routine_change" to "wrote a proposal for one of your routines",
        "propose_routine_removal" to "wrote a proposal to remove a routine",
    )

    const val createdRoutine = "created a routine"

    // In call order, each phrase once, the nameless dropped.
    fun steps(steps: List<AskStep>, drafted: Boolean): List<String> = steps.mapNotNull { it.phrase(drafted) }.distinct()

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
        if (read.sessions > 0) parts += if (read.sessions == 1) "1 session" else "${read.sessions} sessions"
        return "read ${parts.joinToString(" · ")}"
    }
}
