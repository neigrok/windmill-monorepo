package works.windmill.gym.store

import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withContext
import works.windmill.platform.Account
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.ScopeRef

// A read that met a replica, seat or revision other than the one it started on; the observer reads again.
internal class TrainingReadChanged : Exception()

// A record of this kind that this build cannot decode. The kind is a schema's word, and it says nothing of what the record holds.
private class TrainingRecordUndecoded(kind: String) : Exception(kind)

// Whose training is in hand, whether this phone may write it, and the one guarded read every feature store reads
// the replica through. A superseded read never publishes into a different seat.
class TrainingSeat(
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val telemetry: Telemetry,
    private val readDispatcher: CoroutineDispatcher,
    private val workoutAuthority: (String?) -> Boolean,
) {
    // The account `connect` last seated, and whose the replica in hand is: the account id, or null signed out.
    internal var account: Account? = null
    internal var owner: String? = null
    internal var pendingConnection: Account? by mutableStateOf(null)
    internal var workoutReady by mutableStateOf(false)
    internal var localWorkoutAuthorized by mutableStateOf(true)
    var isLoading: Boolean by mutableStateOf(true)
        internal set
    var replicaReadRevision by mutableLongStateOf(-1L)
        internal set
    internal var refreshes: Channel<Unit>? = null
    private val undecodedTold = mutableSetOf<String>()

    internal val workoutAuthorized: Boolean get() = workoutReady && pendingConnection == null && localWorkoutAuthorized &&
        workoutAuthority(owner) && controls.engineReplica == training.engine.activeReplica()
    internal fun authorityFor(owner: String?): Boolean = workoutAuthority(owner)
    val accountKey: String get() = Seat.of(owner)
    val accountReady: Boolean get() = workoutAuthorized && !isLoading
    val replica: String? get() = controls.engineReplica

    fun askRefresh() { refreshes?.trySend(Unit) }

    internal suspend fun <T> readTraining(body: () -> T): T {
        val replica = training.engine.activeReplica()
        val seat = account
        val holder = owner
        fun changed(): Nothing {
            askRefresh()
            throw TrainingReadChanged()
        }
        repeat(3) {
            val (revision, value) = withContext(readDispatcher) {
                training.engine.read(ScopeRef.product("gym")) {
                    if (replica != training.engine.activeReplica()) changed()
                    training.engine.readRevision() to body()
                }
            }
            if (replica != training.engine.activeReplica() || account != seat || owner != holder) changed()
            // One record this build cannot decode cost that record: the read stands, and each kind is reported once.
            training.undecoded.filter(undecodedTold::add).forEach { telemetry.failure("gym.refreshWorkout", TrainingRecordUndecoded(it)) }
            if (revision == training.engine.readRevision()) return value
        }
        changed()
    }

    // A refusal is an answer the screen says, never a failure to report.
    internal fun reportFailure(operation: String, error: Exception) {
        if (error !is TrainingReadChanged) telemetry.unexpected(operation, error)
    }

    // A cancellation is not a failed read: it passes through, or a room being torn down would read as
    // a log that went quiet.
    internal suspend fun <T> tried(operation: String, ask: suspend () -> T): T? = try {
        ask()
    } catch (interrupted: CancellationException) {
        throw interrupted
    } catch (failed: Exception) {
        reportFailure(operation, failed)
        null
    }

    internal companion object {
        val accountChange: Words = Words.Message(R.string.gym_store_account_changed)
    }
}
