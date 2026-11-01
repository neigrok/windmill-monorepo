package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.store.TrainingSeat.Companion.accountChanged
import works.windmill.platform.telemetry.Telemetry

// Deletes and their way back. A weigh-in is held by the engine; workout recovery holds on the store's own clock.
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
    private val clocks = mutableMapOf<String, Job>()
    // How long a delete stays takeable. The room that shows the Undo sets it to the system's
    // accessibility timeout; the store stamps every instant from its own clock.
    var undoWindowMs: Long = undoWindowMs
    var deleteRefused: String? by mutableStateOf(null)
        private set

    // A new seat keeps only the weigh-in holds of the same account's replica; every timed window closes.
    internal fun forgetSeat(sameWeightSeat: Boolean) {
        for (clock in clocks.values) clock.cancel()
        clocks.clear()
        held.withheld = if (sameWeightSeat) held.withheld.filter { it.receipt != null } else emptyList()
        deleteRefused = null
        held.deletedSets = emptySet()
    }

    // The engine refresh's weigh-in read, for the seat that asked: the series and the holds over it.
    internal suspend fun rereadWeighIns(owner: String?) = bodyweight.bodyweightWrite.withLock {
        if (owner != seat.owner) return@withLock
        bodyweight.loadBodyweight()
        refreshHeldWeights()
    }

    // The newest window still the lifter's — what the transient offers to take back. Null the
    // instant the newest delete is being written, which is what takes the transient down.
    val holding: WithheldDelete? get() = held.withheld.lastOrNull { it.takeable }

    // How long the newest way back has left. The store STAMPED that instant, so the store is what
    // subtracts from it: a room reaching for a clock of its own would measure a span against an
    // instant some other clock wrote.
    val wayBackLeftMs: Long
        get() = (holding?.untilMs ?: 0L) - now()

    suspend fun delete(deletion: Deletion): WriteFailure? {
        val screen = when (deletion) {
            is Deletion.Routine -> "routines"
            is Deletion.Set -> "session"
            is Deletion.Note -> deletion.origin.screen
            else -> error("this resource requires its recovery flow")
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
                    else -> error("this resource requires its recovery flow")
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

    // Weigh-ins are durable engine holds; workout recovery stays room-owned.
    fun withhold(deletion: Deletion.Recoverable) {
        if (!seat.workoutAuthorized) return
        if (deletion is Deletion.Bodyweight) {
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
                                WithheldDelete(deletion, offer.releaseAt, receipt = HeldWeightReceipt(replica, anonymous, offer.id, receipt.localIds, weight))
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
            return
        }
        val open = WithheldDelete(deletion, untilMs = now() + undoWindowMs)
        held.withheld = held.withheld.filterNot { it.subjectId == open.subjectId } + open
        armDelete(open)
    }

    private fun armDelete(open: WithheldDelete) {
        clocks.remove(open.subjectId)?.cancel()
        if (!open.takeable) return
        val owner = seat.owner
        clocks[open.subjectId] = scope.launch {
            delay((open.untilMs - now()).coerceAtLeast(0))
            clocks.remove(open.subjectId)
            val failed = settleWithheld(open.subjectId)
            if (owner == seat.owner) {
                open.deletion.stillThere?.let { tail -> failed?.let { deleteRefused = it.line(tail) } }
            }
        }
    }

    // Undo takes the newest available offer and reports only an actual restoration.
    fun keepWithheld(): WithheldDelete? {
        if (!seat.workoutAuthorized) return null
        val taking = held.withheld.lastOrNull { it.takeable } ?: return null
        taking.receipt?.let { receipt ->
            if (receipt.replica != training.engine.activeReplica() || receipt.anonymous != training.anonymous) {
                held.withheld = held.withheld - taking
                return null
            }
            val gesture = receipt.gestureId
            try {
                if (training.engine.undoOffers().none { it.id == gesture } || !training.engine.undo(gesture)) {
                    weightAction("undo", "closed")
                    refreshHeldWeights()
                    return null
                }
                bodyweight.restore(receipt.weighIn)
                held.withheld = held.withheld - taking
                weightAction("undo", "ok")
            } catch (failure: Exception) {
                weightAction("undo", "failed")
                seat.reportFailure("gym.deleteWeighIn", failure)
                deleteRefused = WriteFailure(failure).line("Undo could not restore that weigh-in")
                return null
            }
        }
        clocks.remove(taking.subjectId)?.cancel()
        held.withheld = held.withheld - taking
        return taking
    }

    // Navigation and recreation never abandon an engine-backed weight hold.
    fun abandonWithheld(): Boolean {
        val letting = held.withheld.filter { it.takeable && it.receipt == null }
        if (letting.isEmpty()) return false
        for (going in letting) clocks.remove(going.subjectId)?.cancel()
        held.withheld = held.withheld - letting.toSet()
        return true
    }

    // Explicit settlement releases only this receipt; background release belongs to the engine.
    suspend fun settleWithheld(subjectId: String): WriteFailure? {
        if (!seat.workoutAuthorized) return WriteFailure.Refused(accountChanged)
        val settling = held.withheld.firstOrNull { it.subjectId == subjectId } ?: return null
        settling.receipt?.let { receipt ->
            return bodyweight.bodyweightWrite.withLock {
                if (!seat.workoutAuthorized) return@withLock WriteFailure.Refused(accountChanged)
                if (receipt.replica != training.engine.activeReplica() || receipt.anonymous != training.anonymous) {
                    held.withheld = held.withheld - settling
                    return@withLock WriteFailure.Refused(accountChanged)
                }
                try {
                    receipt.localIds.forEach(training.engine::release)
                    refreshHeldWeights()
                    bodyweight.loadBodyweight()
                    null
                } catch (failure: Exception) {
                    weightAction("delete", "failed")
                    seat.reportFailure("gym.deleteWeighIn", failure)
                    WriteFailure(failure)
                }
            }
        }
        clocks.remove(subjectId)?.cancel()
        held.withheld = held.withheld.map { if (it.subjectId == subjectId) it.copy(sent = true) else it }
        val owner = seat.owner
        val failed = send(settling.deletion)
        if (owner != seat.owner) return failed
        held.withheld = held.withheld.filterNot { it.subjectId == subjectId && it.untilMs == settling.untilMs }
        return failed
    }

    internal fun refreshHeldWeights() {
        val replica = training.engine.activeReplica()
        val offers = training.engine.undoOffers().associateBy { it.id }
        held.withheld = held.withheld.mapNotNull { hold ->
            val receipt = hold.receipt ?: return@mapNotNull hold
            if (receipt.replica != replica || receipt.anonymous != training.anonymous) return@mapNotNull null
            val offer = offers[receipt.gestureId]
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

    // Workout recovery retains its settlement path.
    private suspend fun send(deletion: Deletion.Recoverable): WriteFailure? = when (deletion) {
        is Deletion.Session -> if (workout.discard(deletion.sessionId)) null else WriteFailure.NoAnswer
        is Deletion.Bodyweight -> error("weigh-in deletion requires its engine receipt")
    }
}
