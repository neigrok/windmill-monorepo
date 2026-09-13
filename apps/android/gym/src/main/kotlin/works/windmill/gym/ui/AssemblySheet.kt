package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import works.windmill.gym.R
import kotlin.math.abs
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Nothing advances a lifter on its own. A drag moves the walk order only (sets are keyed by movement,
// never by position), and a swipe is offered only on a row with no sets (`LiveOrder.droppable`).
// The sheet draws no Close: back, the scrim and the drag handle are the platform's, and every walk
// edit made here has already landed, so putting the sheet down loses nothing.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssemblySheet(
    rows: List<LiveLines.MovementRow>,
    routine: String?,
    onJump: (String) -> Unit,
    onReorder: (from: Int, to: Int) -> Unit,
    onDrop: (String) -> Boolean,
    onAdd: () -> Unit,
) {
    val skin = LocalGymColors.current
    val list = rememberLazyListState()
    val currentRows by rememberUpdatedState(rows)
    val move by rememberUpdatedState(onReorder)
    val addedFocus = remember { FocusRequester() }
    val added = rows.firstOrNull { it.justAdded }?.id
    var dragged by remember { mutableStateOf<String?>(null) }
    var centre by remember { mutableFloatStateOf(0f) }
    val edge = with(LocalDensity.current) { 56.dp.toPx() }
    val speed = with(LocalDensity.current) { 600.dp.toPx() }
    fun place() {
        val id = dragged ?: return
        val from = currentRows.indexOfFirst { it.id == id }
        val to = list.layoutInfo.visibleItemsInfo.minByOrNull { abs(it.offset + it.size / 2f - centre) }?.index ?: return
        if (from >= 0 && from != to) move(from, to)
    }
    val direction = when {
        dragged == null -> 0f
        centre < list.layoutInfo.viewportStartOffset + edge -> -1f
        centre > list.layoutInfo.viewportEndOffset - edge -> 1f
        else -> 0f
    }
    LaunchedEffect(dragged, direction) {
        if (direction == 0f) return@LaunchedEffect
        var before = withFrameNanos { it }
        while (dragged != null) {
            val frame = withFrameNanos { it }
            val seconds = ((frame - before) / 1_000_000_000f).coerceAtMost(0.032f)
            before = frame
            if (list.scrollBy(direction * speed * seconds) == 0f) break
            place()
        }
    }
    LaunchedEffect(added) {
        val index = rows.indexOfFirst { it.id == added }
        if (index < 0 || dragged != null) return@LaunchedEffect
        list.scrollToItem(index)
        withFrameNanos {}
        addedFocus.requestFocus()
    }
    Column(Modifier.fillMaxWidth().background(skin.surface).padding(horizontal = 20.dp)
        .padding(bottom = GymLayout.sheetBottom), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("This session", style = WindmillFont.display(26, FontWeight.ExtraBold), color = skin.ink)
        Text("${Readout.setCount(rows.sumOf { it.sets.size })} logged" + (routine?.let { " · $it" } ?: " · Free session"),
            style = WindmillFont.body(14), color = skin.inkDim)
        LazyColumn(state = list, modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
            itemsIndexed(rows, key = { _, row -> row.id }) { index, row ->
                val held = dragged == row.id
                val actions = buildList {
                    if (index > 0) add(CustomAccessibilityAction("Move up") { onReorder(index, index - 1); true })
                    if (index < rows.lastIndex) add(CustomAccessibilityAction("Move down") { onReorder(index, index + 1); true })
                    if (row.canDrop) add(CustomAccessibilityAction("Remove") { onDrop(row.id) })
                }
                val content: @Composable () -> Unit = {
                    Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).zIndex(if (held) 1f else 0f)
                        .graphicsLayer {
                            val item = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == row.id }
                            translationY = if (held && item != null) centre - item.offset - item.size / 2f else 0f
                        }.background(if (held) skin.raised else skin.surface)
                        .then(if (row.id == added) Modifier.focusRequester(addedFocus) else Modifier)
                        .clickable(role = Role.Button, onClickLabel = "walk to ${row.name}") { onJump(row.id) }
                        .semantics {
                            customActions = actions
                            selected = row.isCurrent
                            stateDescription = listOfNotNull(if (row.justAdded) "Just added" else null,
                                if (row.isCurrent) "Current movement" else null).joinToString(", ")
                        }
                        .padding(horizontal = 8.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(painterResource(R.drawable.gym_reorder), "Reorder ${row.name}", tint = skin.inkDim,
                            modifier = Modifier.size(48.dp).pointerInput(row.id) {
                                detectDragGesturesAfterLongPress(
                                    onDragStart = {
                                        val item = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == row.id }
                                        if (item != null) { dragged = row.id; centre = item.offset + item.size / 2f }
                                    },
                                    onDragCancel = { dragged = null }, onDragEnd = { dragged = null },
                                    onDrag = { change, delta -> change.consume(); centre += delta.y; place() },
                                )
                            })
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(row.name, style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
                            Text(row.metadata, style = WindmillFont.body(13), color = skin.inkDim)
                        }
                        Icon(painterResource(R.drawable.gym_forward), null, tint = skin.inkDim, modifier = Modifier.size(20.dp))
                    }
                }
                if (row.canDrop) {
                    val swipe = rememberRowDismiss(settling = { it != SwipeToDismissBoxValue.Settled }) {
                        if (!onDrop(row.id)) reset()
                    }
                    SwipeToDismissBox(state = swipe, backgroundContent = { DropGround() }, content = { content() })
                } else content()
                if (index < rows.lastIndex) HorizontalDivider(color = skin.line)
            }
        }
        Box(Modifier.fillMaxWidth().heightIn(min = 64.dp).clip(RoundedCornerShape(16.dp))
            .background(skin.raised).clickable(role = Role.Button, onClick = onAdd), contentAlignment = Alignment.Center) {
            Text("Add movement", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
        }
    }
}

// What the swipe uncovers: the row is coming off the walk, and nothing about it is logged.
@Composable
private fun DropGround() {
    val skin = LocalGymColors.current
    Row(
        Modifier
            .fillMaxSize()
            .clip(RoundedCornerShape(WindmillRadius.lg))
            .background(skin.raised)
            .padding(horizontal = WindmillSpace.x4),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text("Remove", style = GymType.numeral(12, FontWeight.Bold), color = skin.alarmInk)
        Text("Remove", style = GymType.numeral(12, FontWeight.Bold), color = skin.alarmInk)
    }
}

// Shared with the notes list, which drags the same way.
@Composable
internal fun GrabRail(lit: Boolean, modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    Column(
        modifier.size(width = 32.dp, height = GymTap.minimum),
        verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
    ) {
        repeat(3) {
            Box(
                Modifier
                    .width(16.dp)
                    .height(2.dp)
                    .clip(RoundedCornerShape(WindmillRadius.sm))
                    .background(if (lit) skin.accent else skin.inkFaint),
            )
        }
    }
}
