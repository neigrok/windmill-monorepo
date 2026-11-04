package works.windmill.gym.coach.turn

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.work.ListenableWorker
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.impl.WorkManagerImpl
import androidx.work.testing.TestListenableWorkerBuilder
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.platform.telemetry.Telemetry

class LeaseApplication : Application(), TurnLeaseHost {
    override val turnLease: TurnLease by lazy { TurnLease(this, Telemetry.None, sdk = 35) }
}

// §4.5 Background: the job is expedited and dropped out of quota, starts WorkManager on demand, awaits the turn, finds no turn in a new process, and below API 31 does not exist.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = LeaseApplication::class)
class TurnLeaseTests {
    private val application get() = ApplicationProvider.getApplicationContext<LeaseApplication>()

    // WorkManager holds one instance per process, and the tests share a process.
    @Before fun noWorkManagerYet() {
        WorkManagerImpl.setDelegate(null)
        WorkManagerImpl::class.java.getDeclaredField("sDefaultInstance").apply { isAccessible = true }.set(null, null)
    }

    @Test fun theLeaseIsAnExpeditedJobDroppedOutOfQuota() {
        val request = TurnLease.request().workSpec
        assertTrue(request.expedited)
        assertEquals(OutOfQuotaPolicy.DROP_WORK_REQUEST, request.outOfQuotaPolicy)
        assertEquals(TurnLeaseWorker::class.java.name, request.workerClassName)
    }

    @Test fun belowApi31ThereIsNoLeaseAndWorkManagerNeverStarts() {
        assertFalse(WorkManager.isInitialized())
        TurnLease(application, Telemetry.None, sdk = 30).hold(Job())
        assertFalse(WorkManager.isInitialized())
    }

    @Test fun theFirstHoldStartsWorkManagerOnDemandAndAnotherTurnReplacesTheJob() = runBlocking {
        assertFalse(WorkManager.isInitialized())
        withContext(Dispatchers.IO) { application.turnLease.hold(Job()) }
        assertTrue(WorkManager.isInitialized())
        val manager = WorkManager.getInstance(application)
        val first = withContext(Dispatchers.IO) { manager.getWorkInfosForUniqueWork(TurnLease.workName).get() }.single()
        assertFalse(first.state.isFinished)
        withContext(Dispatchers.IO) { application.turnLease.hold(Job()) }
        val second = withContext(Dispatchers.IO) { manager.getWorkInfosForUniqueWork(TurnLease.workName).get() }.single()
        assertFalse(second.id == first.id)
        assertFalse(second.state.isFinished)
        assertTrue(withContext(Dispatchers.IO) { manager.getWorkInfoById(first.id).get() }?.state?.isFinished ?: true)
    }

    @Test fun theWorkerAwaitsTheTurnAndEnds() = runBlocking {
        val turn = CompletableDeferred<Unit>()
        application.turnLease.hold(turn)
        val worker = TestListenableWorkerBuilder<TurnLeaseWorker>(application).build()
        val working = async(start = CoroutineStart.UNDISPATCHED) { worker.doWork() }
        assertFalse(working.isCompleted)
        turn.complete(Unit)
        assertEquals(ListenableWorker.Result.success(), withTimeout(5_000) { working.await() })
    }

    @Test fun aJobRestartedInANewProcessFindsNoTurnAndEnds() = runBlocking {
        val worker = TestListenableWorkerBuilder<TurnLeaseWorker>(application).build()
        assertEquals(ListenableWorker.Result.success(), withTimeout(5_000) { worker.doWork() })
    }
}
