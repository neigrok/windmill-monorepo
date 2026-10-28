package works.windmill.gym.store

import android.content.SharedPreferences
import works.windmill.platform.telemetry.Telemetry

class FinishReceipts(private val phone: SharedPreferences, private val telemetry: Telemetry) {
    fun suggestsKeep(sessionId: String, anonymous: Boolean): Boolean {
        if (!anonymous) return false
        return try {
            val first = phone.getString("first-anonymous-receipt", null)
            if (first != null) return first == sessionId
            check(phone.edit().putString("first-anonymous-receipt", sessionId).commit())
            true
        } catch (failure: Exception) {
            telemetry.failure("gym.finishReceipt", failure)
            false
        }
    }
}
