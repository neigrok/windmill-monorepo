package works.windmill.gym.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class WorkoutNotificationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val adapter = (context.applicationContext as? WorkoutNotificationHost)?.workoutNotifications ?: return
        val result = goAsync()
        adapter.dispatch(intent, result::finish)
    }
}
