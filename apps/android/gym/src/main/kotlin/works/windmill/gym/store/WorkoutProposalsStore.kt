package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.presentation.ProposalState
import works.windmill.gym.store.TrainingSeat.Companion.accountChanged
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.schema.Gym

// Coach's changes to the open workout: the ones this phone holds, each with why it can no longer be applied, and the lifter's decision on one. A decision is the domain's action on the replica, so the running plan moves at once and the log confirms it; what the log refuses comes back as a notice, and the proposal stands as it stood.
class WorkoutProposalsStore(
    private val seat: TrainingSeat,
    private val training: EngineTraining,
    private val telemetry: Telemetry,
    private val refresh: suspend () -> Unit,
) {
    var held: Map<String, Proposal> by mutableStateOf(emptyMap())
        private set

    // The decisions this phone made that still wait on the log; each is told once the answer reaches it.
    private val awaited = mutableMapOf<String, Boolean>()

    internal suspend fun read() {
        val (proposals, waiting) = seat.readTraining { training.workoutProposals() to training.workoutDecisionsWaiting() }
        held = proposals.associateBy { it.id }
        for ((id, applying) in awaited.filterKeys { it !in waiting }) {
            awaited.remove(id)
            report(applying, if (held[id]?.state == if (applying) ProposalState.Applied else ProposalState.Dismissed) "decided" else "failed")
        }
    }

    internal fun forgetSeat() {
        held = emptyMap()
        awaited.clear()
    }

    fun proposal(id: String): ProposalRead = held[id]?.let { ProposalRead.Found(it) } ?: ProposalRead.Gone

    suspend fun apply(id: String): ProposalOutcome = decide(id, applying = true)

    suspend fun dismiss(id: String): ProposalOutcome = decide(id, applying = false)

    private suspend fun decide(id: String, applying: Boolean): ProposalOutcome {
        val outcome = deciding(id, applying)
        if (outcome is ProposalOutcome.Decided && id in training.workoutDecisionsWaiting()) awaited[id] = applying
        else report(applying, outcome.label)
        return outcome
    }

    private suspend fun deciding(id: String, applying: Boolean): ProposalOutcome {
        if (!seat.workoutAuthorized) return ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
        val owner = seat.owner
        return try {
            training.decideWorkoutProposal(id, applying)
            if (owner != seat.owner) return ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
            refresh()
            held[id]?.let { ProposalOutcome.Decided(it) } ?: ProposalOutcome.Gone("that proposal is no longer on the log")
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            seat.reportFailure(if (applying) "gym.applyWorkoutProposal" else "gym.dismissWorkoutProposal", refusing)
            if (owner != seat.owner) return ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
            refused(id, refusing)
        }
    }

    // A refusal means this room's picture is stale, so the proposals are read again before the sentence is said, and a proposal out of date says why in its own words.
    private suspend fun refused(id: String, error: Exception): ProposalOutcome {
        val refusal = error as? TrainingRefused
        if (refusal == null || refusal.code == "sign-in") return ProposalOutcome.Failed(WriteFailure(error))
        if (seat.tried("gym.refreshWorkout") { read(); true } != true) return ProposalOutcome.Failed(WriteFailure.NoAnswer)
        return when (refusal.code) {
            Gym.Codes.proposalSuperseded -> ProposalOutcome.Moved(held[id]?.outOfDate ?: refusal.line)
            "unknown-record" -> ProposalOutcome.Gone("that proposal is no longer on the log")
            Gym.Codes.proposalSettled -> ProposalOutcome.Settled(refusal.line)
            else -> ProposalOutcome.Refused(refusal.line)
        }
    }

    private fun report(applying: Boolean, outcome: String) {
        telemetry.event("gym_proposal_outcome", mapOf("target" to "workout", "action" to if (applying) "apply" else "dismiss", "outcome" to outcome))
    }
}
