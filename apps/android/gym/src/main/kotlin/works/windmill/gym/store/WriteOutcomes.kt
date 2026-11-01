package works.windmill.gym.store

import works.windmill.gym.presentation.Blocker
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.presentation.Session
import works.windmill.gym.presentation.SessionDetail
import works.windmill.gym.presentation.TrainingSet
import works.windmill.platform.net.WindmillApiException

sealed interface MovementCreateOutcome {
    data class Added(val movement: Exercise) : MovementCreateOutcome
    data class Failed(val why: WriteFailure, val created: Exercise? = null) : MovementCreateOutcome
}

sealed interface GymResult<out T> {
    data class Ok<T>(val value: T) : GymResult<T>
    data class Failed(val why: WriteFailure) : GymResult<Nothing>
}

// A log that answered with a REASON is not a log that went quiet: the lifter can act on the first and
// can only wait out the second.
sealed interface WriteFailure {
    data class Refused(val said: String) : WriteFailure   // the log answered, in its own words
    data object NoAnswer : WriteFailure                   // no reply, or one this build couldn't read
    data object UnconfirmedDelete : WriteFailure

    // `subject` is read only when there is no sentence from the log to say instead.
    fun line(subject: String): String = when (this) {
        is Refused -> said
        NoAnswer -> "the log didn’t answer — $subject"
        UnconfirmedDelete -> "The delete could not be confirmed. Reopen this screen to check."
    }
}

fun WriteFailure(refusing: Throwable): WriteFailure = when (refusing) {
    is TrainingDeleteUnconfirmed -> WriteFailure.UnconfirmedDelete
    is TrainingRefused -> WriteFailure.Refused(refusing.line)
    is WindmillApiException.Refused -> WriteFailure.Refused(refusing.line)
    else -> WriteFailure.NoAnswer
}

enum class FixOrigin(val screen: String) { Workout("workout"), Session("session") }

// A row the log no longer holds is not a fix that can be tried again: the row leaves the screen,
// where a `Failed` leaves it standing with the sentence beside it.
sealed interface FixOutcome {
    data class Corrected(val set: TrainingSet) : FixOutcome
    data class Gone(val said: String) : FixOutcome
    data class Failed(val why: WriteFailure) : FixOutcome
}

// `Decided` is the answer either tap gets, including the REPLAY of a decision already taken. `Moved`
// is the routine having changed under the diff; `Settled` is the other decision having been taken
// first; `Refused` is a decision the rules refuse, as a target under its movement's load floor; `Gone`
// leaves nothing to draw. Only `Failed` is worth another tap.
sealed interface ProposalOutcome {
    data class Decided(val proposal: Proposal) : ProposalOutcome
    data class Moved(val said: String) : ProposalOutcome
    data class Settled(val said: String) : ProposalOutcome
    data class Refused(val said: String) : ProposalOutcome
    data class Gone(val said: String) : ProposalOutcome
    data class Failed(val why: WriteFailure) : ProposalOutcome
}

sealed interface ProposalRead {
    data class Found(val proposal: Proposal) : ProposalRead
    data object Gone : ProposalRead {
        const val line = "This proposal is no longer available."
    }
}

// `Failed` carries the log's answer the way every other write does, including "that workout is no
// longer on the log", after which the room is standing over no session.
sealed interface FinishOutcome {
    data class Closed(val detail: SessionDetail) : FinishOutcome {
        val session: Session get() = detail.session
    }
    data class Failed(val why: WriteFailure) : FinishOutcome
}

// What is said when a write is refused for good.
sealed interface RefusedWrite {
    // The id of the thing that was refused, so a list can key by it: a row keyed by its POSITION
    // hands the next row its predecessor's swipe state, and a dismissed one never comes back.
    val id: String
    val reason: String
}

// The last copy of the set, so the movement and numbers travel with the reason.
data class RefusedSet(
    override val id: String,
    val exerciseId: String,
    val weightKg: Double,
    val reps: Int,
    override val reason: String,
) : RefusedWrite {
    constructor(set: TrainingSet, reason: String) :
        this(set.id, set.exerciseId, set.weightKg, set.reps, reason)
}

// Any other refused write, named for the banner. The id is the engine notice's, so a dismissal
// sticks and two passes over the same refusal are one loss on the banner.
data class RefusedWorkout(override val id: String, val startedAtMs: Long?, override val reason: String) : RefusedWrite

data class RefusedChange(override val id: String, val name: String, override val reason: String) : RefusedWrite

// How a write reports itself. Silence is a state: a room that has just opened says nothing.
sealed class SaveState {
    data object Idle : SaveState()
    data object OnTheLog : SaveState()          // the account has it
    data object OnThisDevice : SaveState()      // held on purpose: nobody signed in, or the account has not confirmed it yet
    data class Blocked(val by: Blocker) : SaveState()   // signed in, and this is what stops it landing
    data class Refused(val reason: String) : SaveState()

    // "offline" is said only when the transport failed; a 500 and a lapsed session get their own words.
    val line: String?
        get() = when (this) {
            Idle -> null
            OnTheLog -> "on the log"
            OnThisDevice -> "saved on this device"
            is Blocked -> when (by) {
                Blocker.Offline -> "offline · saved here"
                Blocker.LogFailed -> "the log didn’t answer · saved here"
                Blocker.SignInLapsed -> "sign in again · saved here"
            }
            is Refused -> reason
        }
}
