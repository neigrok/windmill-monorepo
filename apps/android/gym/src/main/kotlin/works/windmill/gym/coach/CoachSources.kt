package works.windmill.gym.coach

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import works.windmill.gym.R
import works.windmill.gym.presentation.Readout
import works.windmill.platform.telemetry.LocalTelemetry

internal object CoachSources {
    private val readTools = setOf("list_sessions", "get_session", "last_time", "list_exercises", "list_routines", "get_stats", "list_notes", "list_bodyweight")

    fun readOnly(steps: List<AskStep>, proposals: Boolean, results: Boolean, drafts: Boolean): Boolean =
        !proposals && !results && !drafts && steps.all { it.tool in readTools }

    // Choices that read nothing from the log stand alone: a sources row would only say so.
    fun choicesAlone(steps: List<AskStep>, read: ReadTally, acted: Boolean): Boolean =
        !acted && !read.anything && steps.all { it.tool in readTools || it.tool == "ask_setup_details" } &&
            steps.none { it.tool == "list_notes" && !it.failed }

    fun tally(read: ReadTally): String {
        val parts = buildList {
            if (read.sessions > 0) add(if (read.sessions == 1) "1 workout" else "${read.sessions} workouts")
            if (read.weeks > 0) add(Readout.weekCount(read.weeks))
            if (isEmpty() && read.sets > 0) add(Readout.setCount(read.sets))
        }
        return parts.joinToString(" · ")
    }

    fun facts(observation: SessionObservation): String {
        val date = DateTimeFormatter.ofPattern("EEE, MMM d").format(Instant.ofEpochMilli(observation.startedAtMs).atZone(ZoneId.systemDefault()))
        val workout = observation.workout?.takeIf { observation.wholeWorkout }
            ?: return "$date · ${Readout.setCount(observation.setsRead)} read"
        val sets = Readout.setCount(workout.workingSetCount)
        val volume = workout.tonnageKg?.let { "${Readout.weight(it)} kg" } ?: "—"
        return "$date · $sets · $volume"
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CoachReadSources(
    tally: ReadTally,
    receipt: AnswerReceipt?,
    steps: List<AskStep>,
    onOpenWorkout: ((String) -> Unit)?,
    onSheetTop: (Int?) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    var expanded by remember { mutableStateOf(false) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val counted = CoachSources.tally(tally)
    val notesRead = steps.any { it.tool == "list_notes" && !it.failed }
    val line = if (counted.isNotEmpty()) "Read $counted" else if (notesRead) "Read your notes" else "Read nothing from your log"
    // The line keeps its 13 sp size; its touch target is the platform's 48 dp.
    Row(verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.testTag("coach-read-sources").clickable(role = Role.Button, onClickLabel = "What Coach read") {
            expanded = true
            telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "read_sources", "outcome" to "ok"))
        }.heightIn(min = 48.dp).padding(start = 12.dp),
    ) {
        Text(line, style = CoachType.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
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
            Text("What Coach read", style = CoachType.body(28, FontWeight.ExtraBold).copy(lineHeight = 36.sp), color = colors.onSurface)
            if (counted.isNotEmpty()) Text(counted, style = CoachType.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
            receipt?.observed.orEmpty().groupBy { it.sessionId }.values.forEach { observations ->
                val observation = observations.lastOrNull { it.wholeWorkout } ?: observations.last()
                Row(verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().clickable(enabled = onOpenWorkout != null, role = Role.Button) {
                        expanded = false
                        onOpenWorkout?.invoke(observation.sessionId)
                    }.padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(observation.routine?.takeIf { it.isNotBlank() } ?: Readout.noRoutine,
                            style = CoachType.body(15, FontWeight.Bold).copy(lineHeight = 20.sp), color = colors.onSurface)
                        Text(CoachSources.facts(observation), style = CoachType.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
                    }
                    Icon(painterResource(R.drawable.gym_coach_source_chevron), null, Modifier.size(18.dp), tint = colors.onSurfaceVariant)
                }
            }
            if (notesRead) Text("Also read your notes.", style = CoachType.body(13).copy(lineHeight = 18.sp), color = colors.onSurfaceVariant)
            TextButton(onClick = { expanded = false }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text("Close", style = CoachType.body(16, FontWeight.Bold).copy(lineHeight = 24.sp), color = colors.primary)
            }
        }
    }
}
