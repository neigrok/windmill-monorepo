package works.windmill.sync.engine

import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import works.windmill.sync.core.ClockReading

class AndroidClock(context: Context) : EngineClock {
    private val boot = Settings.Global.getString(context.contentResolver, Settings.Global.BOOT_COUNT)
        ?: "process:${java.util.UUID.randomUUID()}"
    override fun now() = System.currentTimeMillis()
    override fun reading() = ClockReading(now(), SystemClock.elapsedRealtime(), boot)
}
