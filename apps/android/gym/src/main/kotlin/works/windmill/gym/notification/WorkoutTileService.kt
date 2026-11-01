package works.windmill.gym.notification

import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.WorkoutKey
import works.windmill.gym.store.WorkoutCommands
import works.windmill.platform.telemetry.Telemetry

interface WorkoutTileHost {
    val workoutTile: WorkoutTile
}

class WorkoutTile(
    private val commands: WorkoutCommands,
    private val activity: ComponentName,
    private val openRoutines: () -> Unit,
    private val telemetry: Telemetry = Telemetry.None,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    suspend fun listen(tile: Tile) {
        try {
            commands.restoreLocal()
            commands.notification.collectLatest { current ->
                do {
                    val subtitle = current?.let { "${it.title} · ${Readout.clock(nowMs() - it.sinceSetAtMs)}" } ?: "Off"
                    tile.label = "Workout"
                    tile.icon = Icon.createWithResource(activity.packageName, R.drawable.gym_workout_notification)
                    tile.state = if (current == null) Tile.STATE_INACTIVE else Tile.STATE_ACTIVE
                    tile.contentDescription = "Workout, $subtitle"
                    if (Build.VERSION.SDK_INT >= 29) tile.subtitle = subtitle
                    if (Build.VERSION.SDK_INT >= 30) tile.stateDescription = subtitle
                    tile.updateTile()
                    if (current == null) return@collectLatest
                    delay(1_000)
                } while (true)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            telemetry.failure("gym.tile", error)
        }
    }

    suspend fun launch(start: (Intent) -> Unit) {
        var action = "routines"
        try {
            commands.restoreLocal()
            val workout = commands.notification.value
            val uri = Uri.Builder().scheme("windmill-workout-tile").authority("route")
            if (workout == null) uri.appendPath("routines") else {
                action = "open"
                uri.appendPath("open").appendPath(workout.key.ownerKey).appendPath(workout.key.sessionId)
            }
            start(Intent(ACTION).setComponent(activity).setData(uri.build())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            telemetry.failure("gym.tile", error)
            telemetry.event("gym_action", mapOf("screen" to "tile", "action" to action, "outcome" to "failed"))
        }
    }

    fun handles(intent: Intent): Boolean {
        val uri = intent.data ?: return false
        if (intent.component != activity || intent.action != ACTION || uri.scheme != "windmill-workout-tile" ||
            uri.authority != "route" || uri.query != null || uri.fragment != null) return false
        val parts = uri.pathSegments
        return parts == listOf("routines") || (parts.size == 3 && parts[0] == "open" && parts.drop(1).all { it.isNotEmpty() })
    }

    suspend fun open(intent: Intent) {
        if (!handles(intent)) return
        val parts = intent.data!!.pathSegments
        val action = parts.first()
        val accepted = try {
            commands.restoreLocal()
            if (action == "routines") {
                openRoutines()
                true
            } else commands.openWorkout(WorkoutKey(parts[1], parts[2]))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            telemetry.failure("gym.tile", error)
            false
        }
        telemetry.event("gym_action", mapOf("screen" to "tile", "action" to action,
            "outcome" to if (accepted) "ok" else "failed"))
    }

    private companion object {
        const val ACTION = "works.windmill.gym.workout.TILE"
    }
}

class WorkoutTileService : TileService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var listener: Job? = null
    private val adapter get() = (application as WorkoutTileHost).workoutTile

    override fun onStartListening() {
        super.onStartListening()
        listener?.cancel()
        val tile = qsTile ?: return
        listener = scope.launch { adapter.listen(tile) }
    }

    override fun onStopListening() {
        listener?.cancel()
        listener = null
        super.onStopListening()
    }

    override fun onClick() {
        super.onClick()
        scope.launch {
            adapter.launch { intent ->
                val state = packageManager.getComponentEnabledSetting(intent.component!!)
                if ((state != PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && state != PackageManager.COMPONENT_ENABLED_STATE_ENABLED) ||
                    packageManager.resolveActivity(intent, 0)?.activityInfo == null) throw ActivityNotFoundException()
                if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this@WorkoutTileService,
                    0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                else {
                    @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
                    startActivityAndCollapse(intent)
                }
            }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
