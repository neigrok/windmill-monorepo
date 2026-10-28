package works.windmill.gym.coach

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionOnScreen
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
import works.windmill.gym.domain.Readout
import works.windmill.gym.ui.LocalGymColors
import works.windmill.platform.design.WindmillSheetWindow
import works.windmill.platform.telemetry.LocalTelemetry

internal object CoachSources {
    private val readTools = setOf("list_sessions", "get_session", "last_time", "list_exercises", "list_routines", "get_stats", "list_notes", "list_bodyweight")

    fun readOnly(steps: List<AskStep>, proposals: Boolean, results: Boolean, drafts: Boolean): Boolean =
        !proposals && !results && !drafts && steps.all { it.tool in readTools }

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
        val sets = if (workout.workingSetCount == 1) "1 working set" else "${workout.workingSetCount} working sets"
        return "$date · $sets · ${Readout.weight(workout.tonnageKg)} kg"
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
    val skin = LocalGymColors.current
    val telemetry = LocalTelemetry.current
    var expanded by remember { mutableStateOf(false) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val counted = CoachSources.tally(tally)
    val notesRead = steps.any { it.tool == "list_notes" && !it.failed }
    val line = if (counted.isNotEmpty()) "Read $counted" else if (notesRead) "Read your notes" else "Read nothing from your log"
    Row(verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.clickable(role = Role.Button, onClickLabel = "What Coach read") {
            expanded = true
            telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "read_sources", "outcome" to "ok"))
        }.padding(start = 12.dp, top = 4.dp),
    ) {
        Text(line, style = CoachType.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
        Icon(painterResource(R.drawable.gym_coach_source_chevron), null, Modifier.size(18.dp), tint = skin.inkDim)
    }
    if (!expanded) return
    DisposableEffect(Unit) { onDispose { onSheetTop(null) } }
    ModalBottomSheet(onDismissRequest = { expanded = false }, sheetState = sheet,
        containerColor = skin.surface, scrimColor = skin.scrim,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        dragHandle = {
            Box(Modifier.fillMaxWidth().height(24.dp).onGloballyPositioned { onSheetTop(it.positionOnScreen().y.roundToInt()) }, contentAlignment = Alignment.Center) {
                Box(Modifier.width(32.dp).height(4.dp).background(skin.inkDim, RoundedCornerShape(2.dp)))
            }
        },
    ) {
        WindmillSheetWindow()
        Column(Modifier.fillMaxWidth()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(top = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("What Coach read", style = CoachType.body(28, FontWeight.ExtraBold).copy(lineHeight = 36.sp), color = skin.ink)
            if (counted.isNotEmpty()) Text(counted, style = CoachType.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
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
                            style = CoachType.body(15, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.ink)
                        Text(CoachSources.facts(observation), style = CoachType.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
                    }
                    Icon(painterResource(R.drawable.gym_coach_source_chevron), null, Modifier.size(18.dp), tint = skin.inkDim)
                }
            }
            if (notesRead) Text("Also read your notes.", style = CoachType.body(13).copy(lineHeight = 18.sp), color = skin.inkDim)
            TextButton(onClick = { expanded = false }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text("Close", style = CoachType.body(16, FontWeight.Bold).copy(lineHeight = 24.sp), color = skin.accent)
            }
        }
    }
}
