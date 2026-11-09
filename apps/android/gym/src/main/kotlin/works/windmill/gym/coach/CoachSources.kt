package works.windmill.gym.coach

import works.windmill.platform.R as PlatformR
import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import works.windmill.platform.design.WindmillSheet
import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.ripple
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionOnScreen
import androidx.compose.ui.platform.testTag
import kotlin.math.roundToInt
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import works.windmill.platform.i18n.text
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import works.windmill.gym.R
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.gym.telemetry.coachAction
import androidx.compose.material3.BottomSheetDefaults

// What an ended answer read, under it: a door to What Coach read while the turn ran anything to list (08.36).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun CoachReadSources(line: String, rows: List<CoachCall>, withDetails: suspend (List<CoachCall>) -> List<CoachCall>, onSheetTop: (Int?) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val sourcesTitle = stringResource(R.string.gym_coach_sources_title)
    val telemetry = LocalTelemetry.current
    if (rows.isEmpty()) {
        Text(line, style = GymType.coachSourceLine, color = colors.onSurfaceVariant, modifier = Modifier.testTag("coach-read-sources").padding(start = 12.dp, top = 4.dp))
        return
    }
    var expanded by remember { mutableStateOf(false) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val pressing = remember { MutableInteractionSource() }
    // The line stands as drawn in its column with a touch of 48 dp or more around it. The touch ends in the 8 dp the thread keeps under its last line, which is all the thread's clip leaves, and reaches up over what stands above, which is drawn first and so yields.
    Box(Modifier.layout { measurable, constraints ->
            val touch = measurable.minIntrinsicHeight(constraints.maxWidth)
            val height = maxOf(touch, 48.dp.roundToPx())
            val placeable = measurable.measure(constraints.copy(minHeight = height, maxHeight = height))
            layout(placeable.width, touch - 8.dp.roundToPx()) { placeable.place(0, touch - height) }
        }.testTag("coach-read-sources")
        .clickable(pressing, indication = null, role = Role.Button, onClickLabel = sourcesTitle) {
            expanded = true
            telemetry.coachAction("read_sources")
        }.padding(bottom = 8.dp), contentAlignment = Alignment.BottomStart,
    ) {
        Row(Modifier.indication(pressing, ripple()).padding(start = 12.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(line, style = GymType.coachSourceLine, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false))
            Icon(painterResource(R.drawable.gym_coach_source_chevron), null, Modifier.size(18.dp).testTag("coach-read-chevron"), tint = colors.onSurfaceVariant)
        }
    }
    if (!expanded) return
    DisposableEffect(Unit) { onDispose { onSheetTop(null) } }
    // The sheet reads its rows' details as it opens, and again only for calls that changed. A row draws its title alone until they land.
    val shown by produceState(rows, rows) { value = withDetails(rows) }
    WindmillSheet(onDismissRequest = { expanded = false }, sheetState = sheet,
        containerColor = colors.surfaceContainer, scrimColor = colors.scrim,
        dragHandle = {
            Box(Modifier.onGloballyPositioned { onSheetTop(it.positionOnScreen().y.roundToInt()) }) { BottomSheetDefaults.DragHandle() }
        },
        contentWindowInsets = { WindowInsets(0, 0, 0, 0) },
    ) {
        // The board's 24 dp under Close holds the gesture bar; a taller bar takes what it needs.
        val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding().coerceAtLeast(24.dp)
        Column(Modifier.fillMaxWidth()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(top = 12.dp, bottom = bottom),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(sourcesTitle, style = GymType.coachSourcesTitle, color = colors.onSurface)
            Text(stringResource(R.string.gym_coach_sources_lead), style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                shown.forEach { row ->
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(row.title?.text().orEmpty(), style = GymType.coachSourceTitle, color = colors.onSurface)
                        row.detail?.let { Text(it.text(), style = GymType.coachSourceLine, color = colors.onSurfaceVariant) }
                    }
                }
            }
            Text(stringResource(R.string.gym_coach_sources_foot), style = GymType.coachSourceLine, color = colors.onSurfaceVariant)
            TextButton(onClick = { expanded = false }, modifier = Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(min = 56.dp)) {
                Text(stringResource(PlatformR.string.platform_close), style = GymType.button, color = colors.primary)
            }
        }
    }
}
