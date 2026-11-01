package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import works.windmill.platform.Account
import works.windmill.platform.telemetry.Telemetry

data class RecoveryRead(val origin: String, val userId: String, val identityRevision: Long, val replica: String,
    val workouts: List<ImportRecovery>) {
    fun belongsTo(account: Account): Boolean = account.resolved && account.locallyTrusted && origin == account.origin && userId == account.user?.id && identityRevision == account.identityRevision
}

data class RecoveryDraft(val read: RecoveryRead, val row: ImportRecovery, val copy: SavedWorkout, val markFinished: Boolean = false)

enum class RecoveryAction(val wire: String) { Keep("keep"), Retry("retry"), Fix("fix"), Discard("discard") }
sealed interface RecoveryResult {
    data object Accepted : RecoveryResult
    data class Refused(val line: String) : RecoveryResult
    data object Failed : RecoveryResult
}

// Workouts this phone could not hand to the account — imports and On this phone — read for the seat in hand, and the
// one recovery action each may run at a time.
class RecoveryStore(
    private val seat: TrainingSeat,
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val scope: CoroutineScope,
    private val telemetry: Telemetry,
    private val readDispatcher: CoroutineDispatcher,
    private val now: () -> Long,
    // The room's engine refresh, which re-reads the log after an accepted action.
    private val refresh: suspend () -> Unit,
) {
    var latest: RecoveryRead? by mutableStateOf(null)
        private set
    var fixDraft: RecoveryDraft? by mutableStateOf(null)
        private set
    var busy: Boolean by mutableStateOf(false)
        private set
    @Volatile private var ownerVersion = 0L
    private var runningAction: Any? = null

    internal fun forgetSeat() {
        ownerVersion += 1
        latest = null
        fixDraft = null
        runningAction = null
        busy = false
    }

    internal suspend fun reread() {
        val account = seat.account ?: return
        val user = account.user ?: return
        val read = seat.readTraining { RecoveryRead(account.origin, user.id, account.identityRevision,
            training.engine.activeReplica(), training.imports.reviewWorkouts()) }
        if (seat.account?.let(read::belongsTo) == true) latest = read
    }

    private fun seatHolds(read: RecoveryRead): Boolean = seat.workoutReady && seat.pendingConnection == null && seat.localWorkoutAuthorized &&
        seat.account?.let(read::belongsTo) == true && controls.engineReplica == read.replica

    fun beginFix(read: RecoveryRead, row: ImportRecovery): Boolean {
        if (busy || !seatHolds(read)) return false
        val copy = row.workout ?: return false
        fixDraft = RecoveryDraft(read, row, copy)
        return true
    }

    fun changeFix(opening: RecoveryDraft, copy: SavedWorkout, markFinished: Boolean = opening.markFinished) {
        if (busy || fixDraft !== opening) return
        fixDraft = opening.copy(copy = copy, markFinished = markFinished)
    }

    fun closeFix() { if (!busy) fixDraft = null }

    suspend fun fixRefusal(draft: RecoveryDraft): String? = try {
        seat.readTraining { training.imports.preview(draft.row.openings.single(), draft.copy, draft.markFinished, now()) }
    } catch (_: TrainingReadChanged) { "account-changed" }
    catch (refused: TrainingRefused) { refused.code }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (failure: Exception) {
        seat.reportFailure("gym_import_fix", failure)
        "recovery-unavailable"
    }

    suspend fun recover(read: RecoveryRead, row: ImportRecovery, action: RecoveryAction,
        draft: RecoveryDraft? = null, currentOwner: () -> Boolean = { true }): RecoveryResult? {
        if (busy || row.adding) return null
        if (action == RecoveryAction.Discard && (row.operationsOnly || row.workout == null || row.refusals.any { it.code in setOf("source-unreadable", "source-needs-update") })) return RecoveryResult.Refused("This copy cannot be discarded here.")
        val version = ownerVersion
        fun owns(): Boolean = ownerVersion == version && currentOwner() && seatHolds(read)
        fun allowed(): Boolean = owns() && seat.authorityFor(seat.owner)
        if (!owns()) return null
        val token = Any()
        runningAction = token
        busy = true
        return scope.async {
            try {
                if (!allowed()) return@async null
                withContext(readDispatcher) {
                    when (action) {
                        RecoveryAction.Discard -> row.openings.single().let { training.imports.discardRefusal(it.id, it, ::allowed) }
                        RecoveryAction.Retry -> row.openings.forEach { if (row.operationsOnly) training.imports.retryOperation(it, ::allowed) else training.imports.retry(it.id, it, ::allowed) }
                        RecoveryAction.Keep -> training.imports.keepWorkout(row.id, row.openings.single(), ::allowed)
                        RecoveryAction.Fix -> {
                            val fixed = requireNotNull(draft)
                            check(fixed.read == read && fixed.row == row)
                            val opening = row.openings.single()
                            val refused = training.imports.preview(opening, fixed.copy, fixed.markFinished, now())
                            if (refused != null) throw TrainingRefused(refused, WorkoutImports.reason(refused))
                            if (row.workout?.session?.isOpen == true) {
                                if (fixed.copy.session.isOpen) training.imports.replaceOpenAndRetry(row.id, fixed.copy, opening, ::allowed)
                                else training.imports.keepWorkout(row.id, opening, ::allowed, fixed.copy)
                            } else training.imports.replaceAndRetry(row.id, fixed.copy, fixed.markFinished, opening = opening, allowed = ::allowed)
                        }
                    }
                    if (action != RecoveryAction.Discard) training.imports.refusals().firstOrNull { failure ->
                        row.openings.any { it.id == failure.id }
                    }?.let { throw TrainingRefused(it.code, it.reason) }
                }
                if (!owns()) return@async null
                telemetry.event("gym_import_recovery", mapOf("action" to action.wire, "outcome" to if (action == RecoveryAction.Discard) "ok" else "completed"))
                if (action == RecoveryAction.Fix) fixDraft = null
                seat.tried("gym.loadLog") { refresh() }
                if (!owns()) return@async null
                RecoveryResult.Accepted
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (refused: TrainingRefused) {
                if (!owns()) return@async null
                telemetry.event("gym_import_recovery", mapOf("action" to action.wire, "outcome" to "refused"))
                RecoveryResult.Refused(refused.line)
            } catch (failure: Exception) {
                seat.reportFailure("gym_import_${action.wire}", failure)
                if (!owns()) return@async null
                telemetry.event("gym_import_recovery", mapOf("action" to action.wire, "outcome" to "failed"))
                RecoveryResult.Failed
            } finally {
                if (runningAction === token) { runningAction = null; busy = false }
            }
        }.await()
    }
}
