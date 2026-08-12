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

// THIS SESSION, AS A LIST — and the list is the routine that gets offered at the end. §A2's whole
// idea lives here: nobody assembles a six-exercise program standing in a gym, but everybody
// performs one, so the session IS the assembly surface. A movement appended here, on the bench,
// mid-rest, is how a routine gets written in this product — not in an editor, before the first set,
// standing up.
//
// It is also the only thing that moves a lifter between movements. Nothing advances on its own: not
// when a plan's set count is reached, not when a rest lands. The list says where everything stands
// and the choice stays theirs.
//
// TWO GESTURES, AND THE RULE UNDER BOTH IS THAT NOTHING LOGGED CAN LEAVE. A drag moves the walk
// order and only the walk order — sets are keyed by movement, never by position — and a swipe is
// offered on a row with no sets in it and on no other row (`LiveOrder.droppable`). A movement a
// lifter has already lifted comes off a log through §G18's repair, at rest, behind a window, and
// never through a sideways flick at arm's length in a room with a rack in it.
@Composable
fun AssemblySheet(
    rows: List<LiveLines.MovementRow>,
    elapsedMs: Long,
    onJump: (String) -> Unit,
    onReorder: (from: Int, to: Int) -> Unit,
    // Answers whether the movement actually left. A row that could not go slides back rather than
    // sitting off the edge of a list it is still part of — the store is the one that decides, and
    // throwing its answer away is how a refusal becomes an invisible row.
    onDrop: (String) -> Boolean,
    onAdd: () -> Unit,
    onClose: () -> Unit,
) {
    val listState = rememberLazyListState()
    // The list as it stands RIGHT NOW, read from inside a gesture that outlives the composition it
    // started in: the drag detector is keyed on the row's own id so a reorder mid-drag does not
    // cancel the drag, which means the list it captured would otherwise be the one from before the
    // first swap.
    val standing by rememberUpdatedState(rows)
    var dragging by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    // A row leaves at roughly a thumb's width of travel. Far enough that a scroll that wanders
    // sideways never takes a movement off the session; near enough to be one deliberate flick.
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
            // HOW LONG THIS WORKOUT HAS BEEN RUNNING, which is the context line the design gives an
            // in-session list (§A2's own head carries it). It moved here in W9: the logger's one
            // clock is the rest, and two clocks in one strip is the lifter reading the wrong number
            // between sets.
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
                        // The dragged card rides above its neighbours and follows the finger; every
                        // other card sits where the list just put it.
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
                        // Only a row that CAN leave takes the gesture at all, so a movement with
                        // sets in it does not slide and spring back with nothing said.
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
                                    // ONE STEP AT A TIME, AND ONLY PAST A NEIGHBOUR'S MIDPOINT.
                                    // Anything looser oscillates, and this list is the one place
                                    // that shows: the cards are different heights — one holds four
                                    // logged sets and the next holds none — so a rule that swapped
                                    // as soon as the dragged card's centre entered the other card's
                                    // BOUNDS swapped, and then found itself inside the bounds it had
                                    // just made, and swapped back on the very next event. Watched on
                                    // a device it read as a row that would not move; in the log it
                                    // was a row moving twenty times a second.
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
                                        // The card stays under the finger across the swap, and where
                                        // it lands depends on which way it went: up, it takes the
                                        // neighbour's own top; down, it ends flush with the
                                        // neighbour's bottom, which is a different place whenever
                                        // the two are different heights.
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

        // Appending is a REST-TIME action and not a setup task, which is the whole of why this
        // button is here rather than on a screen a lifter would have to visit before training.
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

        // The one thing left to do about a movement that was just appended: log a set of it, which
        // is what starts it. It appears only while there is such a movement — a button naming the
        // movement already in hand would be a primary action for closing a sheet.
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

// The three bars the design puts on every row, and the only part of a card that answers a long
// press: the card itself is a tap that jumps, so a drag that could start anywhere on it would make
// every reach for a movement a coin toss. The bars are the design's 16 wide and the TARGET is
// twice that, for the reason every target in this room is bigger than it looks — chalked hands.
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
