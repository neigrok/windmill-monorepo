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
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionOnScreen
import androidx.compose.ui.platform.testTag
import kotlin.math.roundToInt
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import works.windmill.gym.R
import works.windmill.platform.telemetry.LocalTelemetry

// The line stands 22 dp in the column, 4 of them above its words, and its touch target is the platform's 48 dp, reaching over what is around it.
private fun Modifier.readLineTarget(): Modifier = layout { measurable, constraints ->
    val target = measurable.measure(constraints.copy(minHeight = 48.dp.roundToPx()))
    val stands = 22.dp.roundToPx()
    layout(target.width, stands) { target.place(0, 4.dp.roundToPx() + (18.dp.roundToPx() - target.height) / 2) }
}

// What an ended answer read, under it: a door to What Coach read while the turn ran anything to list (08.36).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CoachReadSources(line: String, rows: List<CoachCall>, onSheetTop: (Int?) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    if (rows.isEmpty()) {
        Text(line, style = GymType.coachSourceLine, color = colors.onSurfaceVariant, modifier = Modifier.testTag("coach-read-sources").padding(start = 12.dp, top = 4.dp))
        return
    }
    var expanded by remember { mutableStateOf(false) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp),
        modifier = Modifier.readLineTarget().testTag("coach-read-sources").clickable(role = Role.Button, onClickLabel = Ask.sourcesTitle) {
            expanded = true
            telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "read_sources", "outcome" to "ok"))
        }.padding(start = 12.dp),
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
            Text(Ask.sourcesTitle, style = GymType.coachSourcesTitle, color = colors.onSurface)
            Text(Ask.sourcesLead, style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                rows.forEach { row ->
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(row.title.orEmpty(), style = GymType.coachSourceTitle, color = colors.onSurface)
                        row.detail?.let { Text(it, style = GymType.coachSourceLine, color = colors.onSurfaceVariant) }
                    }
                }
            }
            Text(Ask.sourcesFoot, style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
            TextButton(onClick = { expanded = false }, modifier = Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(min = 56.dp)) {
                Text("Close", style = GymType.button, color = colors.primary)
            }
        }
    }
}
