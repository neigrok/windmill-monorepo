package works.windmill.gym.coach

import kotlinx.serialization.Serializable
import works.windmill.gym.coach.onboarding.CoachOnboardingResponse
import works.windmill.gym.coach.turn.CoachTurnFault
import works.windmill.gym.domain.coach.CoachRules
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.RoutineEntry
import works.windmill.gym.presentation.SetTarget

@Serializable
data class CoachAttachment(val id: String, val mediaType: String, val width: Int, val height: Int, val bytes: Long)

@Serializable
data class CoachDraft(val text: String = "", val photo: CoachAttachment? = null)

@Serializable
data class KeptCoachDraft(val id: String, val draft: CoachDraft)

// A routine a retained onboarding answer drafted, as the card shows it before its Save.
data class CoachRoutineDraft(val operationId: String, val name: String, val entries: List<RoutineEntry>) {
    constructor(operationId: String, routine: CoachOnboardingResponse.Routine) : this(operationId, routine.name, routine.entries.mapIndexed { index, entry ->
        RoutineEntry(index + 1, entry.exerciseId, entry.sets.map { SetTarget(it.reps, it.weightKg) }, entry.restSeconds)
    })
}

object Ask {
    const val title = "Coach"
    const val placeholder = "Ask about your training"

    // The bound of one question, in bytes.
    const val maxQuestionBytes = CoachRules.maxQuestionBytes

    const val promise =
        "Nothing changes until you confirm the proposal. Your logged sets are never part of a proposal."

    // A retained draft's Save. A draft that cannot be written takes Save away.
    const val draftGone = "This draft is no longer available."
    const val draftInvalid = "This draft can’t be saved. Ask Coach for a new one."
    const val draftRetry = "Couldn’t save the routine. Try again."

    const val stopped = "Response stopped."
    const val couldNotTake = "Coach couldn’t take that one"

    const val accessNeedsSignIn = "Coach needs your workout log. Please sign in."

    const val notHere = "This Windmill does not have Coach. You can still read your log."
    const val accountRequired = "I need your account to change a routine. Sign in, then ask again."

    // How a turn ended short of a whole answer, under what arrived.
    fun ending(state: MessageState): String? = when (state) {
        MessageState.running, MessageState.completed -> null
        MessageState.stopped -> stopped
        MessageState.declined -> couldNotTake
        MessageState.failed, MessageState.interrupted -> CoachTurnFault.noAnswer.sentence
    }

    // `standing` null means unknown, not nobody: only a seat the room has read may take a thread.
    fun handedOver(saved: String, standing: String?, known: Boolean): Boolean {
        if (standing == null && !known) return false
        return (standing ?: "") != saved
    }

    fun sendable(typed: String): Boolean {
        val asked = typed.trim()
        return asked.isNotEmpty() && asked.encodeToByteArray().size <= maxQuestionBytes
    }

    fun receipt(read: ReadTally): String {
        val parts = buildList {
            if (read.sets > 0) add(Readout.setCount(read.sets))
            if (read.weeks > 0) add(Readout.weekCount(read.weeks))
            if (read.sessions > 0) add(if (read.sessions == 1) "1 session" else "${read.sessions} sessions")
        }
        if (parts.isEmpty()) return "read nothing from your log"
        return "read ${parts.joinToString(" · ")}"
    }
}
