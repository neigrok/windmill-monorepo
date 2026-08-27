package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SwipeToDismissBoxDefaults
import androidx.compose.material3.SwipeToDismissBoxState
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// Every row in this room that a stroke destroys takes its dismiss state from here, and the reason
// is one word in it: `remember`, never `rememberSaveable`.
//
// It is the withheld window that makes the difference load-bearing. A deleted row LEAVES its list
// and comes back — put back by a log that refused the settle, or taken back by an Undo — and
// `rememberSwipeToDismissBoxState` is a `rememberSaveable`: a LazyColumn keeps what an item was
// holding under the item's own key and hands it straight back when that key returns. So the row
// returned already `EndToStart`, drawn off its own leading edge, and the settle effect spent the act
// again on a stroke nobody made. A refused delete re-fired on its own clock, every nine seconds, for
// as long as the screen stood; an Undo re-deleted what it had just taken back, which is the way back
// this whole pattern exists to provide. And the row could never be swiped again either: a state
// already sitting at `EndToStart` cannot travel there.
//
// A returning row is a NEW row, settled, with its own anchors. The state is built here rather than
// asked for, because the saver is exactly what has to go.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun rememberRowDismiss(
    // A predicate, and Compose consults it more than once per gesture — so it decides which
    // directions settle and nothing else. The act is the settled value's own effect, which runs once.
    settling: (SwipeToDismissBoxValue) -> Boolean,
    // Suspending, over the state itself: a row whose act is refused puts itself back with `reset()`.
    onSettle: suspend SwipeToDismissBoxState.(SwipeToDismissBoxValue) -> Unit,
): SwipeToDismissBoxState {
    val density = LocalDensity.current
    val threshold = SwipeToDismissBoxDefaults.positionalThreshold
    val swipe = remember {
        SwipeToDismissBoxState(SwipeToDismissBoxValue.Settled, density, settling, threshold)
    }
    val settle by rememberUpdatedState(onSettle)
    LaunchedEffect(swipe.currentValue) {
        val standing = swipe.currentValue
        if (standing == SwipeToDismissBoxValue.Settled) return@LaunchedEffect
        swipe.settle(standing)
    }
    return swipe
}

// The lane behind a row whose one trailing action is Delete. Brick is the destroy hue and nothing
// else in this room wears it.
@Composable
internal fun RowDeleteGround() {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = GymTap.minimum + 12.dp)
            .background(GymSkin.alarmInk.copy(alpha = 0.18f), RoundedCornerShape(WindmillRadius.lg))
            .padding(horizontal = WindmillSpace.x4),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Delete", style = GymType.numeral(13, FontWeight.Bold), color = GymSkin.alarmInk)
    }
}
