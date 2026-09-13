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
) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val preferences = store.preferences
    var restOpen by remember { mutableStateOf(false) }

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
            HorizontalDivider(color = skin.line)
            SettingsRow(Notes.title, "what you write for Coach", onNotes)
            SettingsRow(ConnectedLog.title, store.connectedLog.settingsMeta, onConnectedLog)
            HorizontalDivider(color = skin.line)
            SettingsRow("Account", accountEmail ?: "Not signed in", onAccount)
            UnattributedRow(store, isSignedIn, say)
        }
    }
    if (restOpen) {
        RestTimerSheet(
            seconds = preferences.restSeconds,
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
private fun RestTimerSheet(seconds: Int?, onDismiss: () -> Unit, onSave: (Int?) -> Unit) {
    val skin = LocalGymColors.current
    var text by remember { mutableStateOf(seconds?.toString().orEmpty()) }
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

// What this phone is holding for nobody: a shelf with no name on it, neither handed over nor deleted.
//
// The WHOLE row goes while a discard is held: the store keeps the shelf for the length of the window,
// so a row left drawing would leave `These are mine` tappable over training a pending discard wipes
// nine seconds later.
@Composable
private fun UnattributedRow(store: TrainingStore, isSignedIn: Boolean, say: (String?) -> Unit) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    if (Deletion.Unattributed.subjectId in store.withheldIds) return
    val held = store.unattributed ?: return
    val live = store.unattributedIsLive
    if (held.sessions == 0 && held.routines == 0 && held.movements == 0 && !live) return

    SettingCard {
        Text("Saved on this phone, unclaimed", style = WindmillFont.body(15, FontWeight.Bold),
            color = skin.ink)
        Caption("Logged before any sign-in. Nothing joins an account until you say it is yours.")
        Column(verticalArrangement = Arrangement.spacedBy(GymLayout.pair)) {
            Text(heldLine(held, live), style = GymType.numeral(13), color = skin.inkDim)
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
                    .clickable(role = Role.Button) {
                        scope.launch {
                            say(null)
                            store.releaseUnattributed()?.let { say(it) }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text("These are mine", style = GymType.numeral(13, FontWeight.Bold),
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
            else "Sign in first to claim it. Nobody signed in can say whose training this is, " +
                "and it will not be handed to the next account on its own.")
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
