package works.windmill.gym.ui

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import works.windmill.gym.domain.WorkoutChange
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import kotlinx.coroutines.CancellationException
import works.windmill.gym.domain.Bodyweight
import works.windmill.gym.domain.ConnectedLog
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Notes
import works.windmill.gym.domain.Readout
import works.windmill.gym.store.LocalGymEngineSession
import works.windmill.gym.store.LegacyGymMigration
import works.windmill.gym.store.LegacyMigrationRefusal
import works.windmill.gym.store.gymLineageCounts
import works.windmill.platform.net.ClientUpdate
import works.windmill.platform.LocalClientUpdateDestination
import works.windmill.platform.open
import works.windmill.platform.telemetry.LocalTelemetry
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import works.windmill.gym.domain.Units
import works.windmill.gym.store.LocalLog
import works.windmill.gym.store.TrainingStore
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

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
            UnitsRow(preferences.units) { write(preferences.copy(units = it)) }
            if (workout?.hidden == true) {
                SettingsRow("Workout hidden", "Show workout") {
                    val key = workout?.key ?: return@SettingsRow
                    val result = store.showWorkout(key, false)
                    if (result is WorkoutChange.Unavailable) say(result.reason)
                }
            }
            store.workoutFailure?.let { Text(it, style = WindmillFont.body(14), color = skin.alarmInk) }
            HorizontalDivider(color = skin.line)
            SettingsRow(Notes.title, "what you write for Coach", onNotes)
            SettingsRow(ConnectedLog.title, store.connectedLog.settingsMeta, onConnectedLog)
            HorizontalDivider(color = skin.line)
            SettingsRow("Account", accountEmail ?: "Not signed in", onAccount)
            DeviceTrainingRow(store, isSignedIn, onAccount, say)
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
private fun DeviceTrainingRow(store: TrainingStore, isSignedIn: Boolean, onAccount: () -> Unit, say: (String?) -> Unit) {
    val session = LocalGymEngineSession.current ?: return
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val status by session.engine.status.state.collectAsState()
    val telemetry = LocalTelemetry.current
    val retired by ClientUpdate.required.collectAsState()
    val uri = LocalUriHandler.current
    val update = LocalClientUpdateDestination.current
    var revision by remember(session) { mutableIntStateOf(0) }
    var fixing by remember(session) { mutableStateOf<LegacyMigrationRefusal?>(null) }
    var fixingKind by remember(session) { mutableStateOf<LegacyMigrationRefusal?>(null) }
    var inspecting by remember(session) { mutableStateOf<LegacyMigrationRefusal?>(null) }
    var updateFailure by remember(session) { mutableStateOf<String?>(null) }
    val refused = remember(session, revision, status) { LegacyGymMigration.refusals(session.engine) }
    if (status.upgradeRequired || retired) SettingCard {
        Text("Update required", style = WindmillFont.body(15, FontWeight.Bold), color = skin.alarmInk)
        Caption("Update Windmill to keep syncing. Your work is saved on this phone.")
        TextButton(onClick = {
            updateFailure = update.open(uri::openUri, telemetry)
        }) { Text(update.label) }
        updateFailure?.let { Caption(it) }
    }
    if (!isSignedIn && session.anonymousCounts.isNotEmpty()) SettingCard {
        Text("Saved on this phone", style = WindmillFont.body(15, FontWeight.Bold), color = skin.ink)
        Caption(gymLineageCounts(session.anonymousCounts))
        Caption("Sign in to sync this training. If the account already has training, you can Add or Discard this phone’s signed-out training.")
        TextButton(onClick = onAccount) { Text("Sign in") }
    }
    refused.forEach { refusal -> SettingCard {
        Text(refusal.session?.let { "Workout on ${Readout.date(it.startedAtMs)} stays on this phone" } ?: "Saved training stays on this phone",
            style = WindmillFont.body(15, FontWeight.Bold), color = skin.alarmInk)
        Caption(refusal.reason)
        if (refusal.session?.isOpen == true && refusal.code in setOf("session-open", "session-already-open"))
            Caption(if (refusal.sets.isEmpty()) "Keep this empty workout separately by finishing it at its start time."
                else "Keep this workout separately by finishing it at its last logged set.")
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (refusal.session != null) TextButton(onClick = {
                telemetry.event("gym_migration_recovery", mapOf("action" to "inspect", "state" to "opened")); inspecting = refusal
            }) { Text("Inspect workout") }
            if (refusal.session?.isOpen == true && refusal.code in setOf("session-open", "session-already-open"))
                TextButton(onClick = { scope.launch {
                    try {
                        LegacyGymMigration.keepWorkout(session.engine, refusal.id)
                        store.refreshEngine(); revision++; say(null)
                        telemetry.event("gym_migration_recovery", mapOf("action" to "keep", "outcome" to "completed"))
                    } catch (cancelled: CancellationException) { throw cancelled
                    } catch (failure: Exception) {
                        telemetry.failure("gym_migration_keep", failure)
                        say("The original workout is still saved on this phone. Keep could not be completed.")
                    }
                } }) { Text("Keep workout") }
            if (refusal.session != null && refusal.code != "source-needs-update") TextButton(onClick = {
                telemetry.event("gym_migration_recovery", mapOf("action" to "fix", "state" to "opened")); fixing = refusal
            }) { Text("Fix workout") }
            if (refusal.code == "identity-unresolved") TextButton(onClick = onAccount) { Text("Choose account") }
            if (refusal.code in setOf("source-unreadable", "source-needs-update")) TextButton(onClick = {
                say(update.open(uri::openUri, telemetry))
            }) { Text(update.label) }
            if (refusal.session == null && refusal.unrecognizedKindSetIds.isNotEmpty()) TextButton(onClick = {
                fixingKind = refusal
            }) { Text("Choose set kind") }
            TextButton(onClick = { scope.launch {
                telemetry.event("gym_migration_recovery", mapOf("action" to "retry", "state" to "started"))
                try {
                    LegacyGymMigration.retry(session.engine, refusal.id); revision++; say(null)
                    telemetry.event("gym_migration_recovery", mapOf("action" to "retry", "outcome" to "completed"))
                }
                catch (failure: Exception) {
                    telemetry.failure("gym_migration_retry", failure)
                    say("The workout is still saved on this phone. Retry could not be completed.")
                }
            } }) { Text("Retry") }
        }
    } }
    inspecting?.let { refusal -> AlertDialog(onDismissRequest = { inspecting = null },
        title = { Text("Saved workout") },
        text = { LazyColumn(Modifier.fillMaxWidth().height(420.dp).testTag("savedWorkoutSets"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            fun at(value: Long) = Instant.ofEpochMilli(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"))
            item { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val saved = requireNotNull(refusal.session)
                Text("Started ${at(saved.startedAtMs)}")
                saved.finishedAtMs?.let { Text("Finished ${at(it)}") }
                saved.plan?.let { Text(it.routine) }
            } }
            itemsIndexed(refusal.sets, key = { index, set -> "$index:${set.id}" }) { _, set -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(store.catalog.firstOrNull { it.id == set.exerciseId }?.name ?: set.exerciseId)
                Text("${set.weightKg} kg × ${set.reps} · ${if (set.id in refusal.unrecognizedKindSetIds) "Unrecognized set kind" else set.kind.name}")
                Text(at(set.completedAtMs))
                set.rpe?.let { Text("RPE $it") }
                if (set.note.isNotEmpty()) Text(set.note)
            } }
            if (refusal.sets.isEmpty()) item { Text("No sets logged.") }
        } },
        confirmButton = { TextButton(onClick = { inspecting = null }) { Text("Close") } }) }
    fixing?.let { refusal -> MigrationWorkoutEditor(refusal, store.catalog, onDismiss = {
        telemetry.event("gym_migration_recovery", mapOf("action" to "fix", "outcome" to "cancelled")); fixing = null
    }, onSave = { corrected, markFinished, correctedKinds ->
        try {
            if (corrected.session.isOpen) LegacyGymMigration.replaceStartAndRetry(session.engine, refusal.id, corrected.session,
                correctedKinds = corrected.sets.filter { it.id in correctedKinds }.associate { it.id to it.kind })
            else LegacyGymMigration.replaceAndRetry(session.engine, refusal.id, corrected,
                markFinished = markFinished, correctedKinds = correctedKinds)
            revision++
            fixing = null
            say(null)
            telemetry.event("gym_migration_recovery", mapOf("action" to "fix", "outcome" to "completed"))
        } catch (failure: Exception) {
            telemetry.failure("gym_migration_fix", failure)
            say("The original workout is still saved on this phone. The correction could not be saved.")
        }
    }) }
    fixingKind?.let { refusal -> AlertDialog(onDismissRequest = { fixingKind = null },
        title = { Text("Choose set kind") }, text = { Text("The original set stays saved. Choose its kind to retry the saved operation.") },
        confirmButton = { Column {
            works.windmill.gym.domain.SetKind.entries.forEach { kind -> TextButton(onClick = {
                try {
                    LegacyGymMigration.replaceOperationKindAndRetry(session.engine, refusal.id, kind)
                    revision++; fixingKind = null; say(null)
                    telemetry.event("gym_migration_recovery", mapOf("action" to "fix", "outcome" to "completed"))
                } catch (failure: Exception) {
                    telemetry.failure("gym_migration_fix", failure)
                    say("The original set is still saved on this phone. The correction could not be saved.")
                }
            }) { Text(kind.name) } }
        } }, dismissButton = { TextButton(onClick = { fixingKind = null }) { Text("Cancel") } }) }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
internal fun MigrationWorkoutEditor(refusal: LegacyMigrationRefusal, catalog: List<works.windmill.gym.domain.Exercise>, onDismiss: () -> Unit,
    onSave: (LocalLog.FinishedSession, Boolean, Set<String>) -> Unit) {
    val session = requireNotNull(refusal.session)
    val zone = remember(refusal.id) { ZoneId.systemDefault() }
    val format = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    fun display(at: Long) = Instant.ofEpochMilli(at).atZone(zone).format(format)
    var start by remember(refusal.id) { mutableStateOf(display(session.startedAtMs)) }
    var finish by remember(refusal.id) { mutableStateOf(display(session.finishedAtMs ?: session.startedAtMs)) }
    var sets by remember(refusal.id) { mutableStateOf(refusal.sets) }
    var times by remember(refusal.id) { mutableStateOf(refusal.sets.associate { it.id to display(it.completedAtMs) }) }
    var weights by remember(refusal.id) { mutableStateOf(refusal.sets.associate { it.id to it.weightKg.toString() }) }
    var reps by remember(refusal.id) { mutableStateOf(refusal.sets.associate { it.id to it.reps.toString() }) }
    var effort by remember(refusal.id) { mutableStateOf(refusal.sets.associate { it.id to (it.rpe?.toString() ?: "") }) }
    var notes by remember(refusal.id) { mutableStateOf(refusal.sets.associate { it.id to it.note }) }
    var movementMenu by remember(refusal.id) { mutableStateOf<String?>(null) }
    var kindMenu by remember(refusal.id) { mutableStateOf<String?>(null) }
    var correctedKinds by remember(refusal.id) { mutableStateOf<Set<String>>(emptySet()) }
    var unlink by remember(refusal.id) { mutableStateOf(false) }
    var renumber by remember(refusal.id) { mutableStateOf(false) }
    var manualFinish by remember(refusal.id) { mutableStateOf(false) }
    var error by remember(refusal.id) { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Fix saved workout", style = androidx.compose.material3.MaterialTheme.typography.headlineSmall)
        LazyColumn(Modifier.fillMaxWidth().height(420.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Your original workout stays saved. These corrections are used only when you tap Save and retry.")
            OutlinedTextField(start, { start = it; error = null }, label = { Text("Started (yyyy-MM-dd HH:mm)") }, singleLine = true)
            if (!session.isOpen) OutlinedTextField(finish, { finish = it; error = null }, label = { Text("Finished (yyyy-MM-dd HH:mm)") }, singleLine = true)
            if (session.routineId != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(unlink, { unlink = it })
                Text("Remove the routine link and saved plan")
            }
            if (refusal.code == "source-numbering") Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(renumber, { renumber = it })
                Text("Renumber sets for import")
            }
            if (refusal.code == "source-auto-closed") Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(manualFinish, { manualFinish = it })
                Text("Mark as finished")
            }
            Text(if (session.isOpen) "Pending sets stay saved with this workout." else "${sets.size} sets · import limit 200")
            } }
            itemsIndexed(sets.filter { !session.isOpen || it.id in refusal.unrecognizedKindSetIds }, key = { _, set -> set.id }) { index, set -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Set ${index + 1}", Modifier.weight(1f))
                    if (!session.isOpen) TextButton(onClick = { sets = sets.filter { it.id != set.id } }) { Text("Remove set") }
                }
                if (!session.isOpen) Box {
                    TextButton(onClick = { movementMenu = set.id }) { Text(Readout.movement(set.exerciseId, catalog)) }
                    DropdownMenu(expanded = movementMenu == set.id, onDismissRequest = { movementMenu = null }) {
                        catalog.forEach { movement -> DropdownMenuItem(text = { Text(movement.name) }, onClick = {
                            sets = sets.map { if (it.id == set.id) it.copy(exerciseId = movement.id) else it }; movementMenu = null
                        }) }
                    }
                }
                Column {
                    val needsKind = set.id in refusal.unrecognizedKindSetIds && set.id !in correctedKinds
                    TextButton(onClick = { kindMenu = set.id }) {
                        Text(if (needsKind) "Choose set kind" else "Kind: ${set.kind.name}")
                    }
                    if (kindMenu == set.id) Column {
                        works.windmill.gym.domain.SetKind.entries.forEach { option ->
                            TextButton(onClick = {
                                sets = sets.map { if (it.id == set.id) it.copy(kind = option) else it }
                                correctedKinds = correctedKinds + set.id
                                kindMenu = null
                                error = null
                            }) { Text(option.name) }
                        }
                    }
                }
                if (!session.isOpen) {
                    OutlinedTextField(times[set.id].orEmpty(), { times = times + (set.id to it); error = null }, label = { Text("Logged (yyyy-MM-dd HH:mm)") }, singleLine = true)
                    OutlinedTextField(weights[set.id].orEmpty(), { weights = weights + (set.id to it); error = null }, label = { Text("Kilograms") }, singleLine = true)
                    OutlinedTextField(reps[set.id].orEmpty(), { reps = reps + (set.id to it); error = null }, label = { Text("Repetitions") }, singleLine = true)
                    OutlinedTextField(effort[set.id].orEmpty(), { effort = effort + (set.id to it); error = null }, label = { Text("Effort (optional, RPE 6–10)") }, singleLine = true)
                    OutlinedTextField(notes[set.id].orEmpty(), { notes = notes + (set.id to it); error = null }, label = { Text("Set note") })
                }
            } }
        }
        error?.let { Text(it, color = androidx.compose.material3.MaterialTheme.colorScheme.error) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        TextButton(onClick = {
        if (refusal.code == "source-auto-closed" && !manualFinish) {
            error = "Choose Mark as finished to remove the automatic finish marker, or Cancel to keep it."
            return@TextButton
        }
        if (sets.any { it.id in refusal.unrecognizedKindSetIds && it.id !in correctedKinds }) {
            error = "Choose a kind for each unrecognized set, or remove that set explicitly."
            return@TextButton
        }
        val startedAt = if (start == display(session.startedAtMs)) session.startedAtMs
            else runCatching { LocalDateTime.parse(start, format).atZone(zone).toInstant().toEpochMilli() }.getOrNull()
        val finishedAt = if (session.isOpen) null else if (finish == display(session.finishedAtMs ?: session.startedAtMs)) session.finishedAtMs
            else runCatching { LocalDateTime.parse(finish, format).atZone(zone).toInstant().toEpochMilli() }.getOrNull()
        if (startedAt == null || (!session.isOpen && (finishedAt == null || startedAt >= finishedAt))) {
            error = if (session.isOpen) "Enter a valid start date and time." else "Enter valid start and finish dates and times."
            return@TextButton
        }
        val correctedSets = if (session.isOpen) sets else sets.map { set ->
            val at = if (times[set.id] == display(set.completedAtMs)) set.completedAtMs
                else runCatching { LocalDateTime.parse(times[set.id], format).atZone(zone).toInstant().toEpochMilli() }.getOrNull()
            val kg = weights[set.id]?.toDoubleOrNull()
            val repetitions = reps[set.id]?.toIntOrNull()
            val rating = effort[set.id]?.takeIf { it.isNotBlank() }?.toDoubleOrNull()
            if (at == null || at !in startedAt..(finishedAt ?: Long.MAX_VALUE) || kg == null || !kg.isFinite() || kg !in -500.0..500.0 || repetitions == null || repetitions !in 1..100) {
                error = "Check each set’s time, kilograms and repetitions."; return@TextButton
            }
            if ((effort[set.id]?.isNotBlank() == true && (rating == null || !rating.isFinite() || rating !in 6.0..10.0 || rating * 2 % 1 != 0.0)) || notes[set.id].orEmpty().toByteArray().size > 4000) {
                error = "Use RPE 6–10 in half steps and a note of 4,000 bytes or fewer."; return@TextButton
            }
            set.copy(completedAtMs = at, weightKg = kg, reps = repetitions, rpe = rating, note = notes[set.id].orEmpty())
        }
        val positions = mutableMapOf<String, Int>()
        val numberedSets = if (renumber) correctedSets.map { set ->
            val number = (positions[set.exerciseId] ?: 0) + 1
            positions[set.exerciseId] = number
            set.copy(setNumber = number)
        } else correctedSets
        onSave(LocalLog.FinishedSession(session.copy(startedAtMs = startedAt, finishedAtMs = finishedAt,
            routineId = if (unlink) null else session.routineId, plan = if (unlink) null else session.plan), numberedSets,
            (refusal.deletedSetIds + refusal.sets.filter { old -> sets.none { it.id == old.id } }.map { it.id }).distinct()),
            manualFinish, correctedKinds)
        }) { Text("Save and retry") }
        TextButton(onClick = onDismiss) { Text("Cancel") }
        }
        }
    }
}

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
