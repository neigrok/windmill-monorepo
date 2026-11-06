package works.windmill.gym.coach.turn

import android.content.Context
import android.os.Build
import androidx.work.Configuration
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Job
import works.windmill.platform.telemetry.Telemetry

// §4.5 Background: while a turn runs, an expedited job keeps its process alive within the platform's allowance. Below API 31 an expedited job needs a foreground notification, so there is no lease there, and a killed turn ends `interrupted` at the next engine start. Out of quota the job is dropped and the turn goes on.
class TurnLease(private val context: Context, private val telemetry: Telemetry, private val sdk: Int = Build.VERSION.SDK_INT) {
    @Volatile private var turn: Job? = null

    // Off the main thread: the first hold starts WorkManager.
    fun hold(turn: Job) {
        if (sdk < Build.VERSION_CODES.S) return
        this.turn = turn
        try {
            WorkManager.getInstance(context).enqueueUniqueWork(workName, ExistingWorkPolicy.REPLACE, request())
        } catch (failure: Exception) {
            telemetry.failure("gym.coachTurn", failure, mapOf("failure_kind" to "lease"))
        }
    }

    suspend fun awaitTurn() {
        turn?.join()
    }

    companion object {
        const val workName = "windmill.coach.turn"

        fun request(): OneTimeWorkRequest = OneTimeWorkRequestBuilder<TurnLeaseWorker>().setExpedited(OutOfQuotaPolicy.DROP_WORK_REQUEST).build()
    }
}

// The application holds the turn's lease and starts WorkManager on demand: the first hold, or a job the system restarted in a new process, pays for it, and `Application.onCreate` never does.
interface TurnLeaseHost : Configuration.Provider {
    val turnLease: TurnLease
    override val workManagerConfiguration: Configuration get() = Configuration.Builder().build()
}

// A job restarted in a new process finds no turn there, and ends.
class TurnLeaseWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        (applicationContext as? TurnLeaseHost)?.turnLease?.awaitTurn()
        return Result.success()
    }
}
