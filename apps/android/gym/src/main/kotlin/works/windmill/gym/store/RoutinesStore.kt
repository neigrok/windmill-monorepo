package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.presentation.Exercise
import works.windmill.gym.presentation.ExerciseWrite
import works.windmill.gym.presentation.Program
import works.windmill.gym.presentation.Proposal
import works.windmill.gym.presentation.ProposalDecision
import works.windmill.gym.presentation.ProposalIntent
import works.windmill.gym.presentation.ProposalState
import works.windmill.gym.presentation.Routine
import works.windmill.gym.presentation.RoutineDraft
import works.windmill.gym.store.TrainingSeat.Companion.accountChanged
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.schema.Gym

// The program of the seat in hand: its routines, the movement catalogue and the proposals against them.
class RoutinesStore(
    private val seat: TrainingSeat,
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val scope: CoroutineScope,
    private val telemetry: Telemetry,
    private val mintRoutine: () -> String,
    private val mintExercise: () -> String,
) {
    // Read from the replica of the seat now asking: a name is per-account the moment a rename exists.
    var catalog: List<Exercise> by mutableStateOf(emptyList())
        private set

    private val proposalWrite = Mutex()

    // Every proposal this room settled, as the log's receipt said it: a card minted in a conversation
    // reads off this before the copy it was minted with, so a settled one never keeps saying waiting.
    var settledProposals: Map<String, Proposal> by mutableStateOf(emptyMap())
        private set
    private var removalProposals: Map<String, Proposal> by mutableStateOf(emptyMap())
    val unseenRemovalReceipts: Map<String, Proposal> get() = removalProposals.filterValues { !it.isPending }
    private var program: List<Routine> by mutableStateOf(emptyList())
    val all: List<Routine> get() = program
    // The proposals the log would refuse to apply: the domain's rule over the routine as the engine holds and
    // confirms it, read with the program so the two never disagree.
    var outOfDateProposals: Set<String> by mutableStateOf(emptySet())
        private set
    internal suspend fun readProgram() {
        val (read, outdated) = seat.readTraining { training.program() to training.outOfDateProposals() }
        program = read
        outOfDateProposals = outdated
    }

    internal fun readCatalogue() { catalog = training.catalogue() }

    // On a seat's arrival the receipts not yet shown are all this room has settled.
    internal fun adoptReceipts() {
        removalProposals = training.removalProposals()
        settledProposals = unseenRemovalReceipts
    }

    internal fun readReceipts() {
        removalProposals = training.removalProposals()
        settledProposals = settledProposals + unseenRemovalReceipts
    }

    internal fun forgetSeat() {
        catalog = emptyList()
        program = emptyList()
        removalProposals = emptyMap()
        settledProposals = emptyMap()
    }

    // A pending removal remains reviewable even when pull gets ahead of its command receipt.
    val pendingProposals: List<Proposal>
        get() = (program.mapNotNull { it.pendingProposal } + removalProposals.values.filter { it.isPending })
            .distinctBy { it.id }.sortedByDescending { it.createdAtMs }

    fun routine(id: String): Routine? = program.firstOrNull { it.id == id }

    suspend fun saveRoutine(draft: RoutineDraft, expectedAccountKey: String = seat.accountKey,
        expectedReplica: String? = seat.replica): GymResult<Routine> {
        val owner = seat.owner
        val replica = expectedReplica
        return scope.async(start = CoroutineStart.UNDISPATCHED) {
            val result = try {
                if (!seat.workoutAuthorized) throw TrainingRefused("account-changed", accountChanged)
                if (Program.nameProblem(draft.name) == Program.nameTooLong) throw TrainingRefused("invalid", Program.nameTooLong)
                if (Program.named(draft.name) == null) throw TrainingRefused("invalid", "a routine needs a name")
                if (draft.entries.isEmpty()) throw TrainingRefused("invalid", "a routine needs at least one movement")
                if (draft.id != null && draft.original?.expectedRevision == null)
                    throw TrainingRefused("stale", "reopen this routine before saving — its original revision is missing")
                if (expectedAccountKey != seat.accountKey || owner != seat.owner || replica == null || replica != controls.engineReplica)
                    throw TrainingRefused("account-changed", accountChanged)
                val prepared = if (draft.id == null && draft.creationId == null) draft.copy(creationId = mintRoutine()) else draft
                GymResult.Ok(training.saveRoutinePlan(prepared, replica, owner == null))
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (failure: Exception) {
                seat.reportFailure("gym.saveRoutine", failure)
                GymResult.Failed(WriteFailure(failure))
            }
            val outcome = when (result) {
                is GymResult.Ok -> "ok"
                is GymResult.Failed -> if (result.why is WriteFailure.Refused) "refused" else "failed"
            }
            telemetry.event("gym_action", mapOf("screen" to "routine_editor", "action" to "save", "outcome" to outcome))
            when (result) {
                is GymResult.Failed -> result
                is GymResult.Ok -> {
                    val accepted = result.value
                    telemetry.event("gym_routine_saved", mapOf("action" to if (draft.id == null) "create" else "update"))
                    if (owner == seat.owner && replica == controls.engineReplica && replica == training.engine.activeReplica() &&
                        training.anonymous == (owner == null)) {
                        program = program.filterNot { it.id == accepted.routine.id } + accepted.routine
                        catalog = (catalog.filterNot { existing -> accepted.movements.any { it.id == existing.id } } + accepted.movements)
                            .sortedWith(compareBy({ it.pattern }, { it.name }, { it.id }))
                    }
                    GymResult.Ok(accepted.routine)
                }
            }
        }.await()
    }

    // The sessions that named it keep every set and their frozen plan: a snapshot is a copy, not a
    // reference. A routine already gone is a deletion that succeeded.
    suspend fun dropRoutine(id: String, replica: String? = controls.engineReplica, anonymous: Boolean = seat.owner == null): WriteFailure? {
        if (!seat.workoutAuthorized) return WriteFailure.Refused(accountChanged)
        val owner = seat.owner
        return try {
            training.deleteRoutine(id, replica ?: return WriteFailure.Refused(accountChanged), anonymous)
            if (owner != seat.owner) return WriteFailure.Refused(accountChanged)
            program = program.filterNot { it.id == id }
            null
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            seat.reportFailure("gym.dropRoutine", refusing)
            if (owner != seat.owner) return WriteFailure.Refused(accountChanged)
            if (refusing is TrainingDeleteUnconfirmed) seat.tried("gym.readProgram") { readProgram() }
            if ((refusing as? TrainingRefused)?.code == "unknown-record") {
                program = program.filterNot { it.id == id }
                null
            } else {
                WriteFailure(refusing)
            }
        }
    }

    val caughtUpTo: Long? get() = training.caughtUpTo
    fun proposalRecorded(id: String): Boolean = training.proposalRecorded(id)

    // Pending removals and unshown receipts remain readable after their synced rows disappear.
    suspend fun proposal(id: String): ProposalRead {
        return (training.proposal(id) ?: training.removalReceipts()[id] ?: settledProposals[id])?.let { ProposalRead.Found(it) } ?: ProposalRead.Gone
    }

    fun removalPending(id: String): Boolean = training.removalPending(id)

    fun proposalReceiptShown(proposal: Proposal, seatKey: String) {
        if (seatKey != seat.accountKey) return
        try {
            if (training.removalReceiptShown(proposal, controls.engineReplica ?: return)) {
                settledProposals = settledProposals + (proposal.id to proposal)
                telemetry.event("gym_proposal_receipt_shown", mapOf("outcome" to "applied"))
            }
            removalProposals = training.removalProposals()
        } catch (failure: Exception) {
            seat.reportFailure("gym.proposal_receipt_shown", failure)
        }
    }

    // Atomic against the base the diff was written on. Nothing here merges, retries or applies part
    // of a diff; the decision is drawn only from the log's receipt.
    suspend fun applyProposal(id: String): ProposalOutcome = decide(id, applying = true)

    suspend fun dismissProposal(id: String): ProposalOutcome = decide(id, applying = false)

    private suspend fun decide(id: String, applying: Boolean): ProposalOutcome {
        if (!seat.workoutAuthorized) return ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
        val owner = seat.owner
        return proposalWrite.withLock {
            if (owner != seat.owner) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
            try {
                val decision = if (applying) training.applyProposal(id) else training.dismissProposal(id)
                if (owner != seat.owner) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                decided(decision)
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refusing: Exception) {
                seat.reportFailure(if (applying) "gym.applyProposal" else "gym.dismissProposal", refusing)
                if (owner != seat.owner) return@withLock ProposalOutcome.Failed(WriteFailure.Refused(accountChanged))
                refused(refusing)
            }
        }.also { reportProposal(if (applying) "apply" else "dismiss", it) }
    }

    private fun reportProposal(action: String, outcome: ProposalOutcome) {
        val result = when (outcome) {
            is ProposalOutcome.Decided -> "decided"
            is ProposalOutcome.Moved -> "moved"
            is ProposalOutcome.Gone -> "gone"
            is ProposalOutcome.Settled -> "settled"
            is ProposalOutcome.Refused -> "refused"
            is ProposalOutcome.Failed -> "failed"
        }
        telemetry.event("gym_proposal_outcome", mapOf("action" to action, "outcome" to result))
    }

    // Drawn from the log's own receipt and never from the request. The card is dropped BY ID rather
    // than blanked, because a newer proposal may already be standing in that slot.
    private fun decided(decision: ProposalDecision): ProposalOutcome {
        val settled = decision.proposal
        val moved = decision.routine
        program = when {
            moved != null -> program.map { if (it.id == moved.id) moved else it }
            settled.state == ProposalState.Applied && settled.intent == ProposalIntent.Remove ->
                program.filterNot { it.id == settled.routineId }
            else -> program.map { held ->
                if (held.id != settled.routineId) held
                else held.copy(pendingProposal = held.pendingProposal?.takeIf { it.id != settled.id })
            }
        }
        settledProposals = settledProposals + (settled.id to settled)
        removalProposals = training.removalProposals()
        return ProposalOutcome.Decided(settled)
    }

    // A refusal means this room's picture is stale, so the routines are re-read before the sentence
    // is said. A decision the log did not answer, or one that needs a fresh sign-in, leaves the list
    // alone, because nothing was decided.
    private suspend fun refused(error: Throwable): ProposalOutcome {
        val refusal = error as? TrainingRefused
        if (refusal == null || refusal.code == "sign-in") return ProposalOutcome.Failed(WriteFailure(error))
        if (seat.tried("gym.refreshWorkout") { readProgram(); true } != true) return ProposalOutcome.Failed(WriteFailure.NoAnswer)
        return when (refusal.code) {
            Gym.Codes.proposalSuperseded -> ProposalOutcome.Moved(refusal.line)
            "unknown-record" -> ProposalOutcome.Gone("that proposal is no longer on the log")
            Gym.Codes.proposalSettled -> ProposalOutcome.Settled(refusal.line)
            else -> ProposalOutcome.Refused(refusal.line)
        }
    }

    // The equipment is the CALLER's and is never guessed. The pattern is the domain's value for "we
    // did not ask": nothing on this surface reads it, because the ladder is taken off the MAGNITUDE
    // of the load.
    suspend fun create(name: String, equipment: String, id: String = mintExercise(), loadCount: Int? = null,
        expectedReplica: String? = controls.engineReplica, expectedSession: String? = null): GymResult<Exercise> {
        if (!seat.workoutAuthorized) return GymResult.Failed(WriteFailure.Refused(accountChanged))
        val named = Program.named(name)
            ?: return GymResult.Failed(WriteFailure.Refused("a movement needs a name"))
        if (Program.length(named) > Program.maxNameLength || equipment !in Exercise.loadings + "other" ||
            loadCount != null && (loadCount !in 1..2 || equipment != "dumbbell" && loadCount != 1)) {
            return GymResult.Failed(WriteFailure.Refused("check the movement name and equipment"))
        }
        val write = ExerciseWrite(id, named, Exercise.unclassified, equipment, loadCount = loadCount)
        val owner = seat.owner
        return try {
            val made = training.createExercise(write, expectedReplica ?: return GymResult.Failed(WriteFailure.Refused(accountChanged)),
                owner == null, expectedSession)
            if (owner != seat.owner || expectedReplica != controls.engineReplica || expectedReplica != training.engine.activeReplica()) return GymResult.Failed(WriteFailure.Refused("the account changed while creating"))
            catalog = catalog.filterNot { it.id == made.id } + made
            if (made.id != write.id || made.name != works.windmill.gym.domain.sync.ExerciseRules.name.apply(write.name, works.windmill.domain.kit.Path("name")) || made.equipment != write.equipment || made.pattern != write.pattern ||
                write.loadCount != null && made.loadCount != write.loadCount) {
                return GymResult.Failed(WriteFailure.Refused("already saved as ${made.name} (${made.equipment}) — choose it from the movement list"))
            }
            GymResult.Ok(made)
        } catch (interrupted: CancellationException) {
            throw interrupted
        } catch (refusing: Exception) {
            seat.reportFailure("gym.create", refusing)
            if (owner != seat.owner) return GymResult.Failed(WriteFailure.Refused("the account changed while creating"))
            GymResult.Failed(WriteFailure(refusing))
        }
    }
}
