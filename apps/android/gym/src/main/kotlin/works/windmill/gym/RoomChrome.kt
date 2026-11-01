package works.windmill.gym

import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlin.math.ceil
import works.windmill.gym.presentation.Session
import works.windmill.gym.ui.GymSnackbarHost
import works.windmill.gym.ui.WorkoutBar

// One frame of the room: its screen and the chrome that frame owns. `transient` is the room's, held here
// when this frame stands and its screen does not host it; `workout` is the session the rail may offer.
@Composable
internal fun FrameChrome(
    frame: Frame,
    transient: SnackbarHostState?,
    line: String?,
    workout: Session?,
    onOpenWorkout: () -> Unit,
    recoveryCount: Int,
    onPick: (Tab) -> Unit,
    content: @Composable () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val coachRoom = frame is Frame.Root && frame.tab == Tab.Coach ||
        frame is Frame.Pushed && (frame.away is Away.Coach || frame.away is Away.Thread)
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = colors.surface,
        bottomBar = {
            if (frame.railStands || line != null || frame !is Frame.Workout) {
                Column(Modifier.fillMaxWidth().background(colors.surface)) {
                    // Reserve the transient's measured height below screen-owned actions.
                    transient?.let { GymSnackbarHost(it) }
                    line?.let {
                        Text(
                            it,
                            style = GymType.statusLine,
                            color = colors.onSurfaceVariant,
                            maxLines = 2,
                            // Said as it changes, so TalkBack hears the line the eye reads.
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 4.dp)
                                .semantics { liveRegion = LiveRegionMode.Polite },
                        )
                    }
                    if (frame.railStands) {
                        if (frame is Frame.Root && workout != null) WorkoutBar(session = workout, onOpen = onOpenWorkout)
                        TabRail(
                            current = if (coachRoom) Tab.Coach else frame.tab,
                            recoveryCount = recoveryCount,
                            onPick = onPick,
                        )
                    } else {
                        Box(Modifier.fillMaxWidth().navigationBarsPadding())
                    }
                }
            }
        },
    ) { inner ->
        // Consumed as well as applied: a screen inside that pads itself for the keyboard would
        // otherwise count the navigation bar twice and leave a gap above the keys.
        Box(Modifier.fillMaxSize().padding(inner).consumeWindowInsets(inner)) {
            content()
        }
    }
}

// 00.7: a navigation label stays whole. It keeps one line while it clears each neighbouring label by
// `gap` and stays inside the bar; otherwise it wraps at its spaces. It is never shrunk or cut, and it
// may spill past its own item into the width a neighbour leaves.
internal object RailLabels {
    val gap = 8.dp

    // In px: `pitch` between neighbouring item centres, `edge` from the bar's side to an outer centre,
    // and for each label its one-line width and its widest word. Answers the width each label takes.
    fun widths(pitch: Float, edge: Float, gap: Float, line: List<Float>, word: List<Float>): List<Float> {
        val taken = line.toMutableList()
        fun wraps(at: Int) = word[at] < taken[at]
        fun crowded(left: Int) = taken[left] / 2 + taken[left + 1] / 2 + gap > pitch
        listOf(0, taken.lastIndex).filter { taken[it] / 2 > edge && wraps(it) }.forEach { taken[it] = word[it] }
        while (true) {
            val left = (0 until taken.lastIndex).firstOrNull { crowded(it) && (wraps(it) || wraps(it + 1)) } ?: return taken
            val wrapping = listOf(left, left + 1).filter(::wraps).maxBy { taken[it] }
            taken[wrapping] = word[wrapping]
        }
    }
}

@Composable
internal fun TabRail(current: Tab, recoveryCount: Int, onPick: (Tab) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    Column(Modifier.fillMaxWidth().background(colors.surfaceContainer)) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val barWidth = constraints.maxWidth
            val labelWidths = remember(barWidth, density) {
                with(density) {
                    fun width(text: String) = measurer.measure(text, GymType.navigationLabel, softWrap = false).size.width.toFloat()
                    val side = 12.dp.toPx()
                    // NavigationBar's own spacing between its items.
                    val spacing = 8.dp.toPx()
                    val slot = (barWidth - 2 * side - spacing * Tab.entries.lastIndex) / Tab.entries.size
                    RailLabels.widths(pitch = slot + spacing, edge = side + slot / 2, gap = RailLabels.gap.toPx(),
                        line = Tab.entries.map { width(it.title) },
                        word = Tab.entries.map { tab -> tab.title.split(' ').maxOf(::width) },
                    ).map { ceil(it).toInt().toDp() }
                }
            }
            NavigationBar(
                containerColor = colors.surfaceContainer,
                tonalElevation = 0.dp,
                // The 12 dp sides are the bar's own inset, inside its surface, so a long label may spill into them.
                windowInsets = WindowInsets(left = 12.dp, right = 12.dp),
            ) {
                Tab.entries.forEachIndexed { index, entry ->
                    NavigationBarItem(
                        selected = entry == current,
                        onClick = { onPick(entry) },
                        icon = { BadgedBox(badge = {
                            if (entry == Tab.Log && recoveryCount > 0) Badge { Text(recoveryCount.toString()) }
                        }) { Icon(painterResource(railIcon(entry)), contentDescription = null, modifier = Modifier.size(24.dp)) } },
                        label = {
                            Text(entry.title, style = GymType.navigationLabel, textAlign = TextAlign.Center,
                                modifier = Modifier.requiredWidth(labelWidths[index]))
                        },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = colors.primary,
                            selectedTextColor = colors.onSurface,
                            indicatorColor = colors.surfaceContainerHighest,
                            unselectedIconColor = colors.onSurfaceVariant,
                            unselectedTextColor = colors.onSurfaceVariant,
                        ),
                    )
                }
            }
        }
        Box(Modifier.fillMaxWidth().background(colors.surface).navigationBarsPadding())
    }
}

@DrawableRes
internal fun railIcon(tab: Tab): Int = when (tab) {
    Tab.Routines -> R.drawable.gym_nav_routines
    Tab.Log -> R.drawable.gym_nav_log
    Tab.Coach -> R.drawable.gym_nav_coach
}
