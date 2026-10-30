package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Notes
import works.windmill.gym.domain.Units
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont

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

    LaunchedEffect(store, store.accountKey, store.isLoading, store.connectedLogGeneration) {
        if (!store.isLoading) store.readConnectedLog()
    }
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
            UnitsRow(preferences.units) { write(preferences.copy(units = it)) }
            store.workoutFailure?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk) }
            HorizontalDivider(color = skin.line)
            SettingsRow(Notes.title, "what you write for Coach", onNotes)
            SettingsRow(ConnectedLog.title, store.connectedLog.settingsMeta, onConnectedLog)
            HorizontalDivider(color = skin.line)
            SettingsRow("Account", accountEmail ?: "Not signed in", onAccount)
        }
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
        Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button, onClick = onOpen)
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

@Composable
private fun Caption(line: String) {
    val skin = LocalGymColors.current
    Text(line, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = skin.inkDim)
}
