package works.windmill.gym.store

import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import works.windmill.platform.Account
import works.windmill.gym.domain.LogSetAcceptance
import works.windmill.gym.domain.LogSetCommand
import works.windmill.gym.domain.WorkoutChange
import works.windmill.gym.domain.WorkoutKey
import works.windmill.gym.domain.WorkoutNotification

interface WorkoutCommands {
    val notification: StateFlow<WorkoutNotification?>
    suspend fun restoreLocal()
    suspend fun logSet(command: LogSetCommand): LogSetAcceptance
    suspend fun setHidden(key: WorkoutKey, hidden: Boolean): WorkoutChange
    suspend fun openWorkout(key: WorkoutKey): Boolean
}

class GymRuntime(
    val store: TrainingStore,
    private val cachedOwner: () -> String?,
    private val authorityAvailable: () -> Boolean,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val cachedAccount: () -> Account? = { null },
    private val authorityRevision: () -> Long = { 0 },
) : WorkoutCommands {
    override val notification: StateFlow<WorkoutNotification?> get() = store.notification
    private var restored = false
    private var authority: Triple<String?, Boolean, Long>? = null

    override suspend fun restoreLocal() = withContext(dispatcher) {
        val current = Triple(cachedOwner(), authorityAvailable(), authorityRevision())
        if (!restored) {
            store.restoreWorkout(current.first, current.second, cachedAccount())
            restored = true
        } else if (current != authority) store.revokeWorkoutAuthority()
        authority = current
        store.authorizeWorkout(current.second && store.accountKey == Seat.of(current.first))
        store.reconcileWorkoutTime()
    }

    override suspend fun logSet(command: LogSetCommand): LogSetAcceptance = withContext(dispatcher) {
        restoreLocal()
        store.acceptSet(command)
    }

    override suspend fun setHidden(key: WorkoutKey, hidden: Boolean): WorkoutChange = withContext(dispatcher) {
        restoreLocal()
        store.showWorkout(key, hidden)
    }

    override suspend fun openWorkout(key: WorkoutKey): Boolean = withContext(dispatcher) {
        restoreLocal()
        if (notification.value?.key != key) return@withContext false
        store.requestWorkout()
        true
    }

}
