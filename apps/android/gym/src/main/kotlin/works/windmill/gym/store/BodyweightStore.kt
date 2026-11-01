package works.windmill.gym.store

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import works.windmill.gym.presentation.Bodyweight
import works.windmill.gym.presentation.WeighIn
import works.windmill.gym.store.TrainingSeat.Companion.accountChanged
import works.windmill.platform.telemetry.Telemetry

// The weigh-in series of the seat in hand, and the series as every reader draws it.
class BodyweightStore(
    private val seat: TrainingSeat,
    private val held: HeldDeletes,
    private val controls: WorkoutControls,
    private val training: EngineTraining,
    private val telemetry: Telemetry,
    private val now: () -> Long,
) {
    // The replica's series for the seat in hand, ascending by date.
    private var series: List<WeighIn> by mutableStateOf(emptyList())
    // A weigh-in inside its undo window is off the DRAWN series for every reader — the chart's dots
    // and the log's head reading both — so one of them can never draw a day the other has dropped.
    // Writes go to `series`, which is the whole of it.
    val drawn: List<WeighIn>
        get() = series.filterNot { it.dateLocal in held.withheldIds }
    // A held last row keeps the chart's existing stance while Undo remains available.
    val allWeighIns: List<WeighIn> get() = (series + held.withheld.map { it.receipt.weighIn })
        .distinctBy { it.dateLocal }.sortedBy { it.dateLocal }
    // An unread account replica is not an empty series.
    var bodyweightRead by mutableStateOf(false)
        private set
    // One write at a time to the series: a weigh-in, and a hold or release of one.
    internal val bodyweightWrite = Mutex()

    internal fun forgetSeat() {
        series = emptyList()
        bodyweightRead = false
    }

    // The series as the replica holds it, without deciding whether it has been read for the account.
    internal fun readSeries() { series = training.weighins() }

    internal fun forget(dateLocal: String) { series = series.filterNot { it.dateLocal == dateLocal } }

    internal fun restore(weighIn: WeighIn) {
        series = (series.filterNot { it.dateLocal == weighIn.dateLocal } + weighIn).sortedBy { it.dateLocal }
    }

    // The newest day that has happened: a row dated past this phone's today is not a reading (B2).
    val latestWeighIn: WeighIn? get() = Bodyweight.latest(drawn, Bodyweight.today(now()))

    fun loadBodyweight() {
        series = training.weighins()
        bodyweightRead = training.anonymous || training.firstPullComplete || series.isNotEmpty()
    }

    suspend fun weighIn(dateLocal: String, weightKg: Double): WriteFailure? {
        if (!seat.workoutAuthorized) return WriteFailure.Refused(accountChanged)
        if (!weightKg.isFinite() || weightKg !in Bodyweight.minKg..Bodyweight.maxKg)
            return WriteFailure.Refused(Bodyweight.outOfRange)
        val date = runCatching { java.time.LocalDate.parse(dateLocal) }.getOrNull()
            ?: return WriteFailure.Refused("Choose a date.")
        Bodyweight.dated(date, Bodyweight.today(now()))?.let { return WriteFailure.Refused(it) }
        val owner = seat.owner
        val replica = controls.engineReplica
        val anonymous = owner == null
        return bodyweightWrite.withLock {
            if (!seat.workoutAuthorized || owner != seat.owner || replica == null) return@withLock WriteFailure.Refused(accountChanged)
            try {
                val saved = training.putBodyweight(dateLocal, weightKg, replica, anonymous)
                if (owner != seat.owner) return@withLock WriteFailure.Refused(accountChanged)
                // A successful whole-record rewrite retires this day's receipt projection.
                held.release(dateLocal)?.let {
                    telemetry.event("gym_action", mapOf("screen" to "bodyweight", "action" to "cancel", "outcome" to "rewritten"))
                }
                series = (series.filterNot { it.dateLocal == dateLocal } + saved).sortedBy { it.dateLocal }
                bodyweightRead = true
                telemetry.event("gym_bodyweight_saved")
                null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { seat.reportFailure("gym.weighIn", failure); WriteFailure(failure) }
        }
    }
}
