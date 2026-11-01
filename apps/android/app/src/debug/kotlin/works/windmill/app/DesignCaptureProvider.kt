package works.windmill.app

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.view.ViewTreeObserver
import androidx.compose.runtime.snapshotFlow
import androidx.lifecycle.lifecycleScope
import java.io.File
import java.net.URI
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONArray

class DesignCaptureProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val application = context?.applicationContext as? Application ?: return false
        if (!designCaptureAllowed()) return false
        val expected = runCatching {
            val values = JSONArray(File(application.filesDir, "design-capture-profile").readText())
            List(values.length()) { values.get(it) as String }
                .takeIf { it.none(String::isBlank) && it.distinct().size == it.size }?.toSet()
        }.getOrNull() ?: return false
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                if (activity !is MainActivity) return
                val result = File(application.filesDir, "design-capture-ready")
                result.delete()
                activity.lifecycleScope.launch {
                    val store = (application as WindmillApplication).gym.store
                    snapshotFlow { !store.seat.isLoading && store.routines.all.map { it.id }.toSet() == expected }
                        .first { it }
                    val view = activity.window.decorView
                    val listener = object : ViewTreeObserver.OnDrawListener {
                        var recorded = false
                        override fun onDraw() {
                            if (recorded) return
                            recorded = true
                            val frame = SystemClock.elapsedRealtime()
                            view.post {
                                view.viewTreeObserver.removeOnDrawListener(this)
                                result.writeText("${Process.getStartElapsedRealtime()} $frame")
                            }
                        }
                    }
                    view.viewTreeObserver.addOnDrawListener(listener)
                    view.invalidate()
                }
            }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        return true
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, arguments: Array<out String>?, order: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, arguments: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, arguments: Array<out String>?): Int = 0
}

internal fun designCaptureAllowed(): Boolean {
    val origin = runCatching { URI(BuildConfig.WM_API_BASE_URL) }.getOrNull() ?: return false
    return BuildConfig.DEBUG && origin.scheme == "http" &&
        origin.host in setOf("10.0.2.2", "127.0.0.1", "localhost") && origin.port in 1024..65535 &&
        origin.userInfo == null && origin.query == null && origin.fragment == null && origin.path in setOf("", "/")
}
