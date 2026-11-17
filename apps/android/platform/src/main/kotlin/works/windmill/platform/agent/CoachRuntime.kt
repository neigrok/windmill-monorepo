package works.windmill.platform.agent

import android.content.Context
import android.os.PowerManager
import java.security.SecureRandom
import java.util.Base64
import kotlinx.coroutines.sync.Mutex
import works.windmill.agent.coach.Runtime

fun interface CoachBackgroundLease {
    fun acquire(): AutoCloseable
}

class AndroidCoachBackgroundLease(context: Context) : CoachBackgroundLease {
    private val power = context.applicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
    override fun acquire(): AutoCloseable {
        val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "windmill:coach")
        lock.setReferenceCounted(false)
        lock.acquire(1_200_000)
        return AutoCloseable { if (lock.isHeld) lock.release() }
    }
}

class CoachRuntime(private val background: CoachBackgroundLease, private val clock: () -> Long = { System.nanoTime() / 1_000_000 }) : Runtime {
    override fun now() = clock()
    override fun newId(): String {
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
    override suspend fun <T> withLease(turnId: String, ifAvailable: Boolean, body: suspend (Boolean) -> T): T {
        val entry = synchronized(locks) { locks.getOrPut(turnId) { Entry() }.also { it.users++ } }
        var acquired = false
        try {
            acquired = if (ifAvailable) entry.lock.tryLock() else { entry.lock.lock(); true }
            if (!acquired) return body(false)
            return background.acquire().use { body(true) }
        } finally {
            if (acquired) entry.lock.unlock()
            synchronized(locks) { if (--entry.users == 0) locks.remove(turnId) }
        }
    }
    private class Entry { val lock = Mutex(); var users = 0 }
    private companion object { val random = SecureRandom(); val locks = mutableMapOf<String, Entry>() }
}
