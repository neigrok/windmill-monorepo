package works.windmill.gym.ui

import works.windmill.platform.design.WindmillSheetWindow
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import android.Manifest
import android.app.Activity
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import works.windmill.gym.notification.WorkoutNotifications
import works.windmill.gym.domain.WorkoutChange
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Notes
import works.windmill.gym.domain.Readout
import works.windmill.gym.domain.Units
import works.windmill.gym.store.Deletion
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    store: TrainingStore,
    isSignedIn: Boolean,
    backTo: String,
    onBack: () -> Unit,
    onNotes: () -> Unit,
    onConnectedLog: () -> Unit,
    say: (String?) -> Unit,
    accountEmail: String? = null,
    onAccount: () -> Unit = {},
    onClaimSignIn: (String) -> Unit = {},
    notifications: WorkoutNotifications? = null,
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val preferences = store.preferences
    var restOpen by rememberSaveable { mutableStateOf(false) }
    val workout by store.notification.collectAsState()

    LaunchedEffect(store.connectedLog.answered) { store.readConnectedLog() }
    ReadsAgainOnReturn { scope.launch { store.refreshConnectedLog() } }

    fun write(document: GymPreferences) {
        scope.launch {
            say(null)
            store.savePreferences(document)?.let { say(it.line("that setting stayed on this device")) }
        }
    }

    GymScreen(title = "Gym settings", onBack = onBack, backTo = backTo) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text("At the rack", style = WindmillFont.body(14, FontWeight.Bold).copy(lineHeight = 20.sp),
                color = skin.inkDim)
            UnitsRow(preferences.units) { write(preferences.copy(units = it)) }
            SettingsRow("Rest timer", preferences.restSeconds?.let { Readout.clock(it * 1000L) } ?: "Off") {
                restOpen = true
            }
            if (workout?.hidden == true) {
                SettingsRow("Workout hidden", "Show workout") {
                    val key = workout?.key ?: return@SettingsRow
                    val result = store.showWorkout(key, false)
                    if (result is WorkoutChange.Unavailable) say(result.reason)
                }
                Text("Rest alerts are paused for this workout.", style = WindmillFont.body(14), color = skin.inkDim)
            }
            store.workoutFailure?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk) }
            HorizontalDivider(color = skin.line)
            SettingsRow(Notes.title, "what you write for Coach", onNotes)
            SettingsRow(ConnectedLog.title, store.connectedLog.settingsMeta, onConnectedLog)
            HorizontalDivider(color = skin.line)
            SettingsRow("Account", accountEmail ?: "Not signed in", onAccount)
            store.consentFailure?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk) }
            UnattributedRow(store, isSignedIn, say, onClaimSignIn)
        }
    }
    if (restOpen) {
        RestTimerSheet(
            seconds = preferences.restSeconds,
            alerts = {
                if (notifications != null && (store.planEntry?.restSeconds ?: preferences.restSeconds ?: 0) > 0) {
                    RestAlerts(store, notifications, say)
                }
            },
            onDismiss = { restOpen = false },
            onSave = {
                write(preferences.copy(restSeconds = it))
                restOpen = false
            },
        )
    }
}

@Composable
private fun UnitsRow(units: Units, onPick: (Units) -> Unit) {
    val skin = LocalGymColors.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Units", style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp),
                color = skin.ink, modifier = Modifier.weight(1f))
            Row(
                Modifier.width(152.dp).clip(CircleShape).background(skin.raised)
                    .selectableGroup().padding(horizontal = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Units.entries.forEach { option ->
                    val selected = option == units
                    Box(
                        Modifier.weight(1f).heightIn(min = 48.dp).clip(CircleShape)
                            .background(if (selected) skin.surface else Color.Transparent)
                            .selectable(selected, role = Role.RadioButton, onClick = { onPick(option) }),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(option.wire, style = WindmillFont.body(16, FontWeight.Bold),
                            color = if (selected) skin.ink else skin.inkDim)
                    }
                }
            }
        }
        if (units == Units.Pounds) Caption(Bodyweight.kilogramsOnly)
    }
}

@Composable
private fun SettingsRow(title: String, meta: String, onOpen: () -> Unit) {
    val skin = LocalGymColors.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 70.dp).clickable(role = Role.Button, onClick = onOpen)
            .padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp), color = skin.ink)
            Text(meta, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
        }
        Chevron()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RestTimerSheet(seconds: Int?, onDismiss: () -> Unit, onSave: (Int?) -> Unit, alerts: @Composable () -> Unit = {}) {
    val skin = LocalGymColors.current
    var text by rememberSaveable { mutableStateOf(seconds?.toString().orEmpty()) }
    val value = text.toIntOrNull()
    val valid = value != null && value in 15..900
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = skin.surface,
        scrimColor = skin.scrim,
    ) {
            WindmillSheetWindow()
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Rest timer", style = WindmillFont.display(24), color = skin.ink)
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("Seconds") },
                supportingText = { Text("15–900 seconds") },
                isError = text.isNotEmpty() && !valid,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                colors = gymFieldColours(),
                modifier = Modifier.fillMaxWidth(),
            )
            alerts()
            Button(
                onClick = { onSave(value) }, enabled = valid,
                shape = RoundedCornerShape(WindmillRadius.lg),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) { Text("Save", style = WindmillFont.body(16, FontWeight.Bold)) }
            TextButton(onClick = { onSave(null) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text("Turn off", style = WindmillFont.body(16, FontWeight.Bold))
            }
        }
    }
}

@Composable
private fun RestAlerts(store: TrainingStore, notifications: WorkoutNotifications, say: (String?) -> Unit) {
    val telemetry = LocalTelemetry.current
    val context = LocalContext.current
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val capabilities by notifications.capabilities.collectAsState()
    val prompt = remember(context) { context.getSharedPreferences("workout-notifications", 0) }
    var explainAlarm by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val enabled = store.preferences.restSound
    val gates = capabilities
    val posting = gates?.let { it.postGranted && it.appEnabled && it.channelEnabled } == true
    val state = when {
        !enabled -> "Off"
        !posting -> "Needs setup"
        gates?.channelAudible != true -> "Muted"
        gates.exactAlarms -> "On"
        else -> "Needs setup"
    }
    fun settings(alarm: Boolean) {
        try { context.startActivity(if (alarm) notifications.alarmSettings() else notifications.notificationSettings()) }
        catch (error: Exception) {
            telemetry.failure("gym.openAndroidSettings", error)
            say("Android settings could not be opened.")
        }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        notifications.refreshCapabilities()
        if (granted && notifications.capabilities.value?.exactAlarms != true) explainAlarm = true
    }
    fun setup() {
        val current = notifications.capabilities.value ?: return
        if (!current.postGranted && Build.VERSION.SDK_INT >= 33) {
            val activity = context as? Activity
            if (prompt.getBoolean("requested", false) && activity?.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) == false) {
                settings(false)
                return
            }
            prompt.edit().putBoolean("requested", true).apply()
            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        if (!current.appEnabled || !current.channelEnabled || !current.channelAudible) { settings(false); return }
        if (!current.exactAlarms) explainAlarm = true
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Rest alerts · $state", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
        Text("Uses your notification sound. Android may delay alerts while idle.",
            style = WindmillFont.body(14), color = skin.inkDim)
        TextButton(enabled = !busy && gates != null, onClick = {
            if (!enabled || state == "On") {
                busy = true
                val owner = store.accountKey
                scope.launch {
                    try {
                        store.savePreferences(store.preferences.copy(restSound = !enabled))?.let { say(it.line("that setting stayed on this device")) }
                        if (store.accountKey == owner && store.preferences.restSound && !enabled) setup()
                    } finally { busy = false }
                }
            } else setup()
        }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(when { busy -> "Saving…"; !enabled -> "Enable"; state == "On" -> "Turn off alerts"; state == "Muted" -> "Sound settings"; else -> "Set up" })
        }
    }
    if (explainAlarm) AlertDialog(onDismissRequest = { explainAlarm = false },
        title = { Text("Allow rest alerts") },
        text = { Text("Android needs alarm access to schedule a rest alert. Android may delay it while idle.") },
        confirmButton = { TextButton(onClick = { explainAlarm = false; settings(true) }) { Text("Open settings") } },
        dismissButton = { TextButton(onClick = { explainAlarm = false }) { Text("Not now") } })
}

// What this phone is holding for nobody: a shelf with no name on it, neither handed over nor deleted.
//
// The WHOLE row goes while a discard is held: the store keeps the shelf for the length of the window,
// so a row left drawing would leave `These are mine` tappable over training a pending discard wipes
// nine seconds later.
@Composable
private fun UnattributedRow(store: TrainingStore, isSignedIn: Boolean, say: (String?) -> Unit, onSignIn: (String) -> Unit) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    if (Deletion.Unattributed.subjectId in store.withheldIds) return
    val held = store.unattributed ?: return
    val live = store.unattributedIsLive
    val batch = store.localDataBatch ?: return

    SettingCard {
        Text("Saved on this phone, unclaimed", style = WindmillFont.body(15, FontWeight.Bold),
            color = skin.ink)
        Caption("Logged before any sign-in. Nothing joins an account until you say it is yours.")
        Column(verticalArrangement = Arrangement.spacedBy(GymLayout.pair)) {
            Text((listOf(heldLine(held, live)).filter { it.isNotEmpty() } +
                listOfNotNull(batch.weighIns.takeIf { it > 0 }?.let { count(it, "weigh-in") },
                    "Settings".takeIf { batch.preferences > 0 })).joinToString(" · "), style = GymType.numeral(13), color = skin.inkDim)
            held.days.take(4).forEach {
                Text(Readout.date(it), style = GymType.numeral(12), color = skin.inkDim)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(if (isSignedIn) skin.accent else skin.canvas)
                    .clickable(enabled = !store.claimBusy, role = Role.Button) {
                        scope.launch {
                            say(null)
                            if (isSignedIn) store.releaseUnattributed()?.let { say(it) }
                            else store.requestClaimSignIn()?.let(onSignIn)
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(if (store.claimBusy) "Adding…" else "These are mine", style = GymType.numeral(13, FontWeight.Bold),
                    color = if (isSignedIn) skin.onAccent else skin.inkDim)
            }
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = GymTap.minimum)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .border(1.dp, skin.lineStrong, RoundedCornerShape(WindmillRadius.md))
                    // One tap, nothing sent, and nine seconds of Undo on the room's transient. The
                    // arm-and-relabel it replaces had no cancel and no timeout: once armed, the only
                    // resets were leaving the screen or tapping the button that CLAIMS the shelf.
                    .clickable(role = Role.Button) {
                        say(null)
                        store.withhold(Deletion.Unattributed)
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Not mine",
                    style = GymType.numeral(13, FontWeight.Bold),
                    color = skin.inkDim,
                )
            }
        }
        Caption(
            if (isSignedIn) "Claiming adds it to the account you are signed in as."
            else "These are mine opens sign-in for this local training.")
    }
}

private fun heldLine(held: LocalLog.Unattributed, live: Boolean): String {
    val parts = buildList {
        if (live) add("a workout that was still open")
        if (held.sessions > 0) add(count(held.sessions, "finished workout"))
        if (held.routines > 0) add(count(held.routines, "routine"))
        if (held.movements > 0) add(count(held.movements, "movement"))
    }
    return parts.joinToString(" · ")
}

private fun count(n: Int, noun: String): String = if (n == 1) "1 $noun" else "$n ${noun}s"

@Composable
private fun SettingCard(content: @Composable () -> Unit) {
    val skin = LocalGymColors.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(skin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, skin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(GymLayout.cardInset),
    ) {
        content()
    }
}

@Composable
private fun Caption(line: String) {
    val skin = LocalGymColors.current
    Text(line, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
}
