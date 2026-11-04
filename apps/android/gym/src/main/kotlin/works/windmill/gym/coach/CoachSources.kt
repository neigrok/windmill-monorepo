package works.windmill.gym.coach

import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import works.windmill.platform.design.WindmillSheet
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionOnScreen
import androidx.compose.ui.platform.testTag
import kotlin.math.roundToInt
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import works.windmill.domain.kit.AbilityClass
import works.windmill.gym.R
import works.windmill.gym.domain.coach.ReadTally
import works.windmill.gym.presentation.Readout
import works.windmill.gym.presentation.SessionSummary
import works.windmill.platform.telemetry.LocalTelemetry

internal object CoachSources {
    fun readOnly(calls: List<CoachCall>, proposals: Boolean, routines: Boolean, drafts: Boolean): Boolean =
        !proposals && !routines && !drafts && calls.all { it.kind == AbilityClass.read }

    fun tally(read: ReadTally): String {
        val parts = buildList {
            if (read.sessions > 0) add(if (read.sessions == 1) "1 workout" else "${read.sessions} workouts")
            if (read.weeks > 0) add(Readout.weekCount(read.weeks))
            if (isEmpty() && read.sets > 0) add(Readout.setCount(read.sets))
        }
        return parts.joinToString(" · ")
    }

    fun facts(workout: SessionSummary): String {
        val date = DateTimeFormatter.ofPattern("EEE, MMM d").format(Instant.ofEpochMilli(workout.startedAtMs).atZone(ZoneId.systemDefault()))
        val sets = Readout.setCount(workout.workingSetCount ?: workout.setCount)
        val volume = workout.tonnageKg?.let { "${Readout.weight(it)} kg" } ?: "—"
        return "$date · $sets · $volume"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CoachReadSources(
    tally: ReadTally,
    workouts: List<SessionSummary>,
    calls: List<CoachCall>,
    onOpenWorkout: ((String) -> Unit)?,
    onSheetTop: (Int?) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    var expanded by remember { mutableStateOf(false) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val counted = CoachSources.tally(tally)
    val notesRead = calls.any { it.name == "list_notes" && it.ran && !it.context }
    val line = if (counted.isNotEmpty()) "Read $counted" else if (notesRead) "Read your notes" else "Read nothing from your log"
    // The line keeps its 13 sp size; its touch target is the platform's 48 dp.
    Row(verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.testTag("coach-read-sources").clickable(role = Role.Button, onClickLabel = "What Coach read") {
            expanded = true
            telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "read_sources", "outcome" to "ok"))
        }.heightIn(min = 48.dp).padding(start = 12.dp),
    ) {
        Text(line, style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
        Icon(painterResource(R.drawable.gym_coach_source_chevron), null, Modifier.size(18.dp), tint = colors.onSurfaceVariant)
    }
    if (!expanded) return
    DisposableEffect(Unit) { onDispose { onSheetTop(null) } }
    WindmillSheet(onDismissRequest = { expanded = false }, sheetState = sheet,
        containerColor = colors.surfaceContainer, scrimColor = colors.scrim,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        dragHandle = {
            Box(Modifier.fillMaxWidth().height(24.dp).onGloballyPositioned { onSheetTop(it.positionOnScreen().y.roundToInt()) }, contentAlignment = Alignment.Center) {
                Box(Modifier.width(32.dp).height(4.dp).background(colors.onSurfaceVariant, RoundedCornerShape(2.dp)))
            }
        },
    ) {
        Column(Modifier.fillMaxWidth()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(top = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("What Coach read", style = GymType.coachSourcesTitle, color = colors.onSurface)
            if (counted.isNotEmpty()) Text(counted, style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
            workouts.forEach { workout ->
                Row(verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().clickable(enabled = onOpenWorkout != null, role = Role.Button) {
                        expanded = false
                        onOpenWorkout?.invoke(workout.id)
                    }.padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(workout.plan?.routine?.takeIf { it.isNotBlank() } ?: Readout.noRoutine,
                            style = GymType.coachSourceTitle, color = colors.onSurface)
                        Text(CoachSources.facts(workout), style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
                    }
                    Icon(painterResource(R.drawable.gym_coach_source_chevron), null, Modifier.size(18.dp), tint = colors.onSurfaceVariant)
                }
            }
            if (notesRead) Text("Also read your notes.", style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
            TextButton(onClick = { expanded = false }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text("Close", style = GymType.coachTitle, color = colors.primary)
            }
        }
    }
}
