package works.windmill.gym.coach

import androidx.annotation.StringRes
import kotlinx.serialization.Serializable
import works.windmill.gym.R
import works.windmill.gym.coach.onboarding.CoachOnboardingResponse
import works.windmill.gym.domain.coach.CoachRules
import works.windmill.gym.domain.coach.MessageState
import works.windmill.gym.presentation.RoutineEntry
import works.windmill.gym.presentation.SetTarget

@Serializable
data class CoachAttachment(val id: String, val mediaType: String, val width: Int, val height: Int, val bytes: Long)

@Serializable
data class CoachDraft(val text: String = "", val photo: CoachAttachment? = null) {
    val isEmpty: Boolean get() = text.isEmpty() && photo == null
    // Spaces alone hold nothing: they make no row in History and date none.
    val holdsSomething: Boolean get() = text.isNotBlank() || photo != null
}

@Serializable
data class KeptCoachDraft(val id: String, val draft: CoachDraft)

// A routine a retained onboarding answer drafted, as the card shows it before its Save.
data class CoachRoutineDraft(val operationId: String, val name: String, val entries: List<RoutineEntry>) {
    constructor(operationId: String, routine: CoachOnboardingResponse.Routine) : this(operationId, routine.name, routine.entries.mapIndexed { index, entry ->
        RoutineEntry(index + 1, entry.exerciseId, entry.sets.map { SetTarget(it.reps, it.weightKg) }, entry.restSeconds)
    })
}

object Ask {
    // The bound of one question, in bytes.
    const val maxQuestionBytes = CoachRules.maxQuestionBytes

    // How a turn ended short of a whole answer, under what arrived: an interruption speaks of what arrived only when words did.
    @StringRes
    fun ending(state: MessageState, truncated: Boolean, wordsArrived: Boolean): Int? = when (state) {
        MessageState.running -> null
        MessageState.completed -> if (truncated) R.string.gym_coach_ending_cut_short else null
        MessageState.stopped -> R.string.gym_coach_stopped
        MessageState.declined -> R.string.gym_coach_ending_declined
        MessageState.failed -> R.string.gym_coach_ending_failed
        MessageState.interrupted -> if (wordsArrived) R.string.gym_coach_ending_interrupted_kept else R.string.gym_coach_ending_interrupted
    }

    // `standing` null means unknown, not nobody: only a seat the room has read may take a thread.
    fun handedOver(saved: String, standing: String?, known: Boolean): Boolean {
        if (standing == null && !known) return false
        return (standing ?: "") != saved
    }
}
