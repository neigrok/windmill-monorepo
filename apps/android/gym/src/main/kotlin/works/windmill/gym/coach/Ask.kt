package works.windmill.gym.coach

import kotlinx.serialization.Serializable
import works.windmill.gym.coach.onboarding.CoachOnboardingResponse
import works.windmill.gym.domain.coach.CoachRules
import works.windmill.gym.domain.coach.MessageState
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

    const val stopped = "Stopped."
    const val couldNotTake = "Coach couldn’t take that one"

    const val accessNeedsSignIn = "Coach needs your workout log. Please sign in."

    const val notHere = "This Windmill does not have Coach. You can still read your log."
    const val accountRequired = "I need your account to change a routine. Sign in, then ask again."

    // The line under a running answer another device writes.
    const val answeringElsewhere = "Answering on another device"
    // The band while this phone's turn finds its stream again.
    const val reconnecting = "Reconnecting…"
    // Where a sent picture stands on a phone that does not hold it (Coach §9.3).
    const val pictureElsewhere = "Held on the phone\nthat sent it"

    // Under the routines a signed-out turn created: they live on this phone until the lifter keeps them with an account.
    const val onlyOnThisPhone = "Only on this phone ·"
    const val keepIt = "Keep it"

    const val readNothing = "Read nothing from your log"
    const val readMovementHistory = "Read your movement history"

    const val sourcesTitle = "What Coach read"
    const val sourcesLead = "What Coach used, in order"
    const val sourcesFoot = "A workout read twice counts once."

    // How a turn ended short of a whole answer, under what arrived: an interruption speaks of what arrived only when words did.
    fun ending(state: MessageState, truncated: Boolean, wordsArrived: Boolean): String? = when (state) {
        MessageState.running -> null
        MessageState.completed -> if (truncated) "Cut short. Ask Coach to go on." else null
        MessageState.stopped -> stopped
        MessageState.declined -> "Coach declined to answer this."
        MessageState.failed -> "Coach couldn’t finish. Ask again."
        MessageState.interrupted -> if (wordsArrived) "Interrupted. What arrived is kept." else "Interrupted."
    }

    // `standing` null means unknown, not nobody: only a seat the room has read may take a thread.
    fun handedOver(saved: String, standing: String?, known: Boolean): Boolean {
        if (standing == null && !known) return false
        return (standing ?: "") != saved
    }
}
