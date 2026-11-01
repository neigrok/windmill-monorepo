package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlin.math.abs
import works.windmill.gym.R
import works.windmill.gym.presentation.LiveLines
import works.windmill.gym.presentation.Readout
import works.windmill.platform.design.WindmillFont

@Composable
fun AssemblySheet(
    rows: List<LiveLines.MovementRow>,
    routine: String?,
    onJump: (String) -> Unit,
    onReorder: (from: Int, to: Int) -> Unit,
    onDrop: (String) -> Boolean,
    onAdd: () -> Unit,
    onHide: () -> Unit = {},
    notificationOff: Boolean = false,
    onShowNotification: () -> Unit = {},
) {
    val skin = LocalGymColors.current
    val list = rememberLazyListState()
    val currentRows by rememberUpdatedState(rows)
    val move by rememberUpdatedState(onReorder)
    val order = rows.map { it.id }
    var preview by remember(order) { mutableStateOf<List<String>?>(null) }
    var dragged by remember(order) { mutableStateOf<String?>(null) }
    var centre by remember(order) { mutableFloatStateOf(0f) }
    val drawn = preview?.mapNotNull { id -> rows.firstOrNull { it.id == id } } ?: rows
    val addedFocus = remember { FocusRequester() }
    val added = rows.firstOrNull { it.justAdded }?.id
    val edge = with(LocalDensity.current) { 56.dp.toPx() }
    val speed = with(LocalDensity.current) { 600.dp.toPx() }
    fun place() {
        val id = dragged ?: return
        val walk = preview ?: order
        val from = walk.indexOf(id)
        val to = list.layoutInfo.visibleItemsInfo.minByOrNull { abs(it.offset + it.size / 2f - centre) }?.index ?: return
        if (from >= 0 && to in walk.indices && from != to) {
            list.requestScrollToItem(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset)
            preview = walk.toMutableList().apply { add(to, removeAt(from)) }
        }
    }
    // Derived off the layout, so a drag recomposes when the edge it scrolls toward changes rather than every frame.
    val direction by remember(order, edge) {
        derivedStateOf {
            when {
                dragged == null -> 0f
                centre < list.layoutInfo.viewportStartOffset + edge -> -1f
                centre > list.layoutInfo.viewportEndOffset - edge -> 1f
                else -> 0f
            }
        }
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
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("This workout", style = WindmillFont.display(28, FontWeight.Bold).copy(lineHeight = 36.sp), color = skin.ink)
            Text("${Readout.setCount(rows.sumOf { it.sets.size })} logged · ${routine ?: Readout.noRoutine}",
                style = WindmillFont.body(16).copy(lineHeight = 21.sp), color = skin.inkDim)
        }
        LazyColumn(state = list, modifier = Modifier.weight(1f, fill = false).fillMaxWidth().heightIn(max = 420.dp)) {
            itemsIndexed(drawn, key = { _, row -> row.id }) { index, row ->
                val held = dragged == row.id
                var problem by remember(row.id) { mutableStateOf<String?>(null) }
                val actions = buildList {
                    if (index > 0) add(CustomAccessibilityAction("Move up") { onReorder(index, index - 1); true })
                    if (index < drawn.lastIndex) add(CustomAccessibilityAction("Move down") { onReorder(index, index + 1); true })
                }
                DeleteSwipeRow(actionLabel = "Remove movement", onDelete = {
                    val accepted = onDrop(row.id)
                    problem = if (accepted) null else "The movement could not be removed. Check the current workout."
                    accepted
                }, enabled = row.canDrop && dragged == null,
                    modifier = Modifier.zIndex(if (held) 1f else 0f).graphicsLayer {
                        val item = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == row.id }
                        translationY = if (held && item != null) centre - item.offset - item.size / 2f else 0f
                    }) {
                    Box {
                        ListItem(
                            headlineContent = { Text(row.name, style = WindmillFont.body(17, FontWeight.Bold).copy(lineHeight = 24.sp)) },
                            supportingContent = { Text(problem ?: row.metadata, style = WindmillFont.body(14).copy(lineHeight = 20.sp),
                                color = if (problem == null) skin.inkDim else skin.error,
                                modifier = Modifier.semantics { if (problem != null) liveRegion = LiveRegionMode.Polite }) },
                            leadingContent = { Icon(painterResource(R.drawable.gym_list_reorder), null, Modifier.size(20.dp)) },
                            trailingContent = { Icon(painterResource(R.drawable.gym_forward), null, Modifier.size(20.dp)) },
                            colors = ListItemDefaults.colors(containerColor = if (held) skin.raised else skin.surface,
                                headlineColor = skin.ink, supportingColor = skin.inkDim, leadingIconColor = skin.inkDim, trailingIconColor = skin.inkDim),
                            modifier = Modifier.fillMaxWidth()
                                .then(if (row.id == added) Modifier.focusRequester(addedFocus) else Modifier)
                                .clickable(role = Role.Button, onClickLabel = "walk to ${row.name}") { onJump(row.id) }
                                .semantics {
                                    customActions = actions
                                    selected = row.isCurrent
                                    stateDescription = listOfNotNull(if (row.justAdded) "Just added" else null,
                                        if (row.isCurrent) "Current movement" else null).joinToString(", ")
                                },
                        )
                        Box(Modifier.align(Alignment.CenterStart).offset(x = 2.dp).size(48.dp)
                            .semantics { contentDescription = "Reorder ${row.name}" }
                            .pointerInput(row.id, order) {
                                awaitEachGesture {
                                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                                    if (down.isConsumed) return@awaitEachGesture
                                    down.consume()
                                    var started = false
                                    var cancelled = false
                                    try {
                                        do {
                                            val event = awaitPointerEvent(PointerEventPass.Initial)
                                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                            if (change.isConsumed) break
                                            event.changes.forEach { it.consume() }
                                            if (!change.pressed) {
                                                val to = preview?.indexOf(row.id) ?: index
                                                if (started && !cancelled && to != index && currentRows.map { it.id } == order) move(index, to)
                                                break
                                            }
                                            if (!started && !cancelled) {
                                                if (change.uptimeMillis - down.uptimeMillis >= viewConfiguration.longPressTimeoutMillis) {
                                                    val item = list.layoutInfo.visibleItemsInfo.firstOrNull { it.key == row.id } ?: break
                                                    started = true
                                                    dragged = row.id
                                                    centre = item.offset + item.size / 2f
                                                } else if ((change.position - down.position).getDistance() > viewConfiguration.touchSlop) cancelled = true
                                            }
                                            if (started) {
                                                centre += change.position.y - change.previousPosition.y
                                                place()
                                            }
                                        } while (true)
                                    } finally {
                                        dragged = null
                                        preview = null
                                    }
                                }
                            })
                    }
                }
                if (index < drawn.lastIndex) HorizontalDivider(color = skin.line)
            }
        }
        Box(Modifier.fillMaxWidth().heightIn(min = 64.dp).clip(RoundedCornerShape(16.dp))
            .background(skin.raised).clickable(role = Role.Button, onClick = onAdd), contentAlignment = Alignment.Center) {
            Text("Add movement", style = WindmillFont.body(16, FontWeight.Bold), color = skin.ink)
        }
        Column {
            ListItem(
                headlineContent = { Text("Hide workout", style = WindmillFont.body(17, FontWeight.Bold)) },
                leadingContent = { Icon(Icons.Rounded.KeyboardArrowDown, null, Modifier.size(20.dp)) },
                colors = ListItemDefaults.colors(containerColor = skin.surface, headlineColor = skin.ink, leadingIconColor = skin.inkDim),
                modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onHide),
            )
            if (notificationOff) ListItem(
                headlineContent = { Text("Notification off", style = WindmillFont.body(17, FontWeight.Bold)) },
                leadingContent = { Icon(Icons.Outlined.Notifications, null, Modifier.size(20.dp)) },
                trailingContent = { TextButton(onClick = onShowNotification) { Text("Show", style = WindmillFont.body(16, FontWeight.Bold), color = skin.accent) } },
                colors = ListItemDefaults.colors(containerColor = skin.surface, headlineColor = skin.ink, leadingIconColor = skin.inkDim),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
