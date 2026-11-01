package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.store.TrainingSeat.Companion.accountChanged
import works.windmill.platform.telemetry.Telemetry

// Deletes and their way back. A set, routine or note goes at once; a weigh-in is held by the engine until its Undo
// offer is released.
class DeletionsStore(
    private val seat: TrainingSeat,
    private val held: HeldDeletes,
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val bodyweight: BodyweightStore,
    private val routines: RoutinesStore,
    private val notes: NotesStore,
    private val workout: WorkoutSession,
    private val scope: CoroutineScope,
    private val telemetry: Telemetry,
    private val now: () -> Long,
    undoWindowMs: Long,
) {
    // How long a weigh-in's Undo is offered. The room that shows the Undo sets it to the system's
    // accessibility timeout; the engine stamps each release from its own clock.
    var undoWindowMs: Long = undoWindowMs
    var deleteRefused: String? by mutableStateOf(null)
        private set

    // A new seat keeps the weigh-in holds only when it is the same account's replica.
    internal fun forgetSeat(sameWeightSeat: Boolean) {
        if (!sameWeightSeat) held.withheld = emptyList()
        deleteRefused = null
        held.deletedSets = emptySet()
    }

    // The engine refresh's weigh-in read, for the seat that asked: the series and the holds over it.
    internal suspend fun rereadWeighIns(owner: String?) = bodyweight.bodyweightWrite.withLock {
        if (owner != seat.owner) return@withLock
        bodyweight.loadBodyweight()
        refreshHeldWeights()
    }

    // The newest hold: what the transient offers to take back.
    val holding: WithheldDelete? get() = held.withheld.lastOrNull()

    // How long the newest way back has left, on the store's clock, so the room never measures a span against
    // an instant another clock wrote.
    val wayBackLeftMs: Long
        get() = (holding?.untilMs ?: 0L) - now()

    suspend fun delete(deletion: Deletion): WriteFailure? {
        val screen = when (deletion) {
            is Deletion.Routine -> "routines"
            is Deletion.Set -> "session"
            is Deletion.Note -> deletion.origin.screen
            is Deletion.Bodyweight -> error("a weigh-in is withheld, never deleted at once")
        }
        val owner = seat.owner
        val replica = controls.engineReplica
        val anonymous = owner == null
        return scope.async(start = CoroutineStart.UNDISPATCHED) {
            val failure = try {
                if (owner != seat.owner || replica == null) WriteFailure.Refused(accountChanged)
                else when (deletion) {
                    is Deletion.Routine -> routines.dropRoutine(deletion.routineId, replica, anonymous)
                    is Deletion.Set -> workout.deleteSet(deletion.sessionId, deletion.set.id, replica, anonymous)
                    is Deletion.Note -> notes.deleteNote(deletion.noteId, replica, anonymous)
                    is Deletion.Bodyweight -> error("a weigh-in is withheld, never deleted at once")
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                seat.reportFailure(when (deletion) {
                    is Deletion.Routine -> "gym.dropRoutine"
                    is Deletion.Set -> "gym.deleteSet"
                    else -> "gym.deleteNote"
                }, error)
                WriteFailure(error)
            }
            telemetry.event("gym_action", mapOf("screen" to screen, "action" to "delete",
                "outcome" to when (failure) {
                    null -> "ok"
                    is WriteFailure.Refused -> "refused"
                    else -> "failed"
                }))
            failure
        }.await()
    }

    // A weigh-in's delete is a durable engine hold, released when its Undo window closes.
    fun withhold(deletion: Deletion.Bodyweight) {
        if (!seat.workoutAuthorized) return
        val owner = seat.owner
        val replica = controls.engineReplica ?: return
        val anonymous = owner == null
        val window = undoWindowMs
        scope.launch {
            bodyweight.bodyweightWrite.withLock {
                if (!seat.workoutAuthorized || owner != seat.owner || replica != training.engine.activeReplica()) return@withLock
                try {
                    val weight = training.weighins(deletion.dateLocal, deletion.dateLocal).singleOrNull()
                        ?: return@withLock
                    val receipt = training.holdBodyweight(deletion.dateLocal, window, replica, anonymous) ?: return@withLock
                    if (!seat.workoutAuthorized || owner != seat.owner || replica != training.engine.activeReplica()) return@withLock
                    val offer = training.engine.undoOffers().firstOrNull { it.id == receipt.gestureId }
                    if (offer != null) {
                        held.withheld = held.withheld.filterNot { it.subjectId == deletion.subjectId } +
                            WithheldDelete(deletion, offer.releaseAt, HeldWeightReceipt(replica, anonymous, offer.id, receipt.localIds, weight))
                        weightAction("delete", "held")
                    } else weightAction("delete", "closed")
                    bodyweight.forget(deletion.dateLocal)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    seat.reportFailure("gym.deleteWeighIn", failure)
                    if (owner == seat.owner && replica == training.engine.activeReplica()) {
                        weightAction("delete", if (WriteFailure(failure) is WriteFailure.Refused) "refused" else "failed")
                        deleteRefused = WriteFailure(failure).line("that weigh-in is still on the log")
                    }
                }
            }
        }
    }

    // Undo takes the newest available offer and reports only an actual restoration.
    fun keepWithheld(): WithheldDelete? {
        if (!seat.workoutAuthorized) return null
        val taking = held.withheld.lastOrNull() ?: return null
        val receipt = taking.receipt
        if (receipt.replica != training.engine.activeReplica() || receipt.anonymous != training.anonymous) {
            held.withheld = held.withheld - taking
            return null
        }
        try {
            if (training.engine.undoOffers().none { it.id == receipt.gestureId } || !training.engine.undo(receipt.gestureId)) {
                weightAction("undo", "closed")
                refreshHeldWeights()
                return null
            }
            bodyweight.restore(receipt.weighIn)
            held.withheld = held.withheld - taking
            weightAction("undo", "ok")
            return taking
        } catch (failure: Exception) {
            weightAction("undo", "failed")
            seat.reportFailure("gym.deleteWeighIn", failure)
            deleteRefused = WriteFailure(failure).line("Undo could not restore that weigh-in")
            return null
        }
    }

    // Each hold follows the engine's offer: a closed offer is a released delete.
    internal fun refreshHeldWeights() {
        val replica = training.engine.activeReplica()
        val offers = training.engine.undoOffers().associateBy { it.id }
        held.withheld = held.withheld.mapNotNull { hold ->
            if (hold.receipt.replica != replica || hold.receipt.anonymous != training.anonymous) return@mapNotNull null
            val offer = offers[hold.receipt.gestureId]
            if (offer == null) weightAction("delete", "closed")
            offer?.let { hold.copy(untilMs = it.releaseAt) }
        }
    }

    private fun weightAction(action: String, outcome: String) {
        telemetry.event("gym_action", mapOf("screen" to "bodyweight", "action" to action, "outcome" to outcome))
    }

    fun clearDeleteRefused() {
        deleteRefused = null
    }
}
