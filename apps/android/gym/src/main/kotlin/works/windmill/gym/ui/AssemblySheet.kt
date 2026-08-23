package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlin.math.abs
import works.windmill.gym.domain.LiveLines
import works.windmill.gym.domain.Readout
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Nothing advances a lifter on its own. A drag moves the walk order only (sets are keyed by movement,
// never by position), and a swipe is offered only on a row with no sets (`LiveOrder.droppable`).
@Composable
fun AssemblySheet(
    rows: List<LiveLines.MovementRow>,
    elapsedMs: Long,
    onJump: (String) -> Unit,
    onReorder: (from: Int, to: Int) -> Unit,
    onDrop: (String) -> Boolean,
    onAdd: () -> Unit,
    onClose: () -> Unit,
) {
    val listState = rememberLazyListState()
    // Read from inside a gesture that outlives its composition: the drag detector is keyed on the row id.
    val standing by rememberUpdatedState(rows)
    var dragging by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    val dropAt = with(LocalDensity.current) { 108.dp.toPx() }

    Column(
        Modifier
            .fillMaxWidth()
            .background(GymSkin.surface)
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("This session", style = WindmillFont.display(20), color = GymSkin.ink)
            Spacer(Modifier.width(WindmillSpace.x3))
            Text(Readout.clock(elapsedMs), style = GymType.numeral(13), color = GymSkin.inkFaint)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Text("Close", style = WindmillFont.body(16), color = GymSkin.inkDim)
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
            verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        ) {
            items(rows, key = { it.id }) { row ->
                val held = dragging == row.id
                var swipe by remember { mutableFloatStateOf(0f) }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .zIndex(if (held) 1f else 0f)
                        .graphicsLayer {
                            translationY = if (held) dragOffset else 0f
                            translationX = swipe
                            alpha = 1f - (abs(swipe) / (dropAt * 2f)).coerceAtMost(0.6f)
                        }
                        .clip(RoundedCornerShape(WindmillRadius.lg))
                        .background(if (row.justAdded) GymSkin.raised else GymSkin.surface)
                        .border(
                            1.dp,
                            if (row.justAdded || row.isCurrent) GymSkin.accent else GymSkin.line,
                            RoundedCornerShape(WindmillRadius.lg),
                        )
                        .pointerInput(row.id, row.canDrop) {
                            if (!row.canDrop) return@pointerInput
                            detectHorizontalDragGestures(
                                onDragEnd = {
                                    if (abs(swipe) < dropAt || !onDrop(row.id)) swipe = 0f
                                },
                                onDragCancel = { swipe = 0f },
                                onHorizontalDrag = { change, amount ->
                                    change.consume()
                                    swipe += amount
                                },
                            )
                        }
                        .clickable { onJump(row.id) }
                        .padding(WindmillSpace.x3),
                    verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
                    ) {
                        GrabRail(
                            lit = held || row.justAdded,
                            modifier = Modifier.pointerInput(row.id) {
                                detectDragGesturesAfterLongPress(
                                    onDragStart = {
                                        dragging = row.id
                                        dragOffset = 0f
                                    },
                                    onDragEnd = {
                                        dragging = null
                                        dragOffset = 0f
                                    },
                                    onDragCancel = {
                                        dragging = null
                                        dragOffset = 0f
                                    },
                                    // One step at a time, past a neighbour's MIDPOINT: the cards are
                                    // different heights, so swapping on bounds oscillates.
                                    onDrag = { change, amount ->
                                        change.consume()
                                        dragOffset += amount.y
                                        val from = standing.indexOfFirst { it.id == row.id }
                                        val visible = listState.layoutInfo.visibleItemsInfo
                                        val card = visible.firstOrNull { it.index == from }
                                            ?: return@detectDragGesturesAfterLongPress
                                        val centre = card.offset + card.size / 2f + dragOffset
                                        val above = visible.firstOrNull { it.index == from - 1 }
                                        val below = visible.firstOrNull { it.index == from + 1 }
                                        val over = when {
                                            above != null && centre < above.offset + above.size / 2f -> above
                                            below != null && centre > below.offset + below.size / 2f -> below
                                            else -> return@detectDragGesturesAfterLongPress
                                        }
                                        onReorder(from, over.index)
                                        val landed = if (over.index < from) over.offset
                                            else over.offset + over.size - card.size
                                        dragOffset += (card.offset - landed)
                                    },
                                )
                            },
                        )
                        Text(
                            row.name,
                            style = WindmillFont.body(16, FontWeight.Bold),
                            color = if (row.isCurrent) GymSkin.accent else GymSkin.ink,
                            modifier = Modifier.weight(1f),
                        )
                        row.tag?.let {
                            Text(
                                it,
                                style = GymType.numeral(11),
                                color = if (row.justAdded) GymSkin.accent else GymSkin.inkFaint,
                            )
                        }
                    }

                    row.line?.let {
                        Text(it, style = WindmillFont.body(13), color = GymSkin.inkFaint)
                    }
                    row.sets.forEach { set ->
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                if (set.isWarmup) "w" else "✓",
                                style = GymType.numeral(12),
                                color = if (set.isWarmup) GymSkin.warmupInk else GymSkin.setDone,
                                modifier = Modifier.width(14.dp),
                            )
                            Text(
                                set.value,
                                style = GymType.numeral(13),
                                color = if (set.isWarmup) GymSkin.warmupInk else GymSkin.inkDim,
                            )
                            Text(
                                set.note,
                                style = GymType.numeral(11),
                                color = if (set.isOnThisDevice) GymSkin.unsyncedInk else GymSkin.inkFaint,
                            )
                        }
                    }
                }
            }
        }

        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 8.dp)
                .dashedEdge(GymSkin.lineStrong, WindmillRadius.md)
                .clickable(onClick = onAdd),
            contentAlignment = Alignment.Center,
        ) {
            Text("+ Add next movement", style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.accent)
        }

        rows.firstOrNull { it.justAdded }?.let { added ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.primary)
                    .clip(RoundedCornerShape(WindmillRadius.lg))
                    .background(GymSkin.accent)
                    .clickable { onJump(added.id) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Log a set of ${added.name}",
                    style = WindmillFont.body(17, FontWeight.Bold),
                    color = GymSkin.onAccent,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun GrabRail(lit: Boolean, modifier: Modifier = Modifier) {
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
                    .background(if (lit) GymSkin.accent else GymSkin.inkFaint),
            )
        }
    }
}
