package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxDefaults
import androidx.compose.material3.SwipeToDismissBoxState
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import works.windmill.gym.R

// A returning row starts settled; saving its dismissal state would repeat deletion after Undo.
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
    val maySettle by rememberUpdatedState(settling)
    val swipe = remember {
        SwipeToDismissBoxState(SwipeToDismissBoxValue.Settled, density,
            { it == SwipeToDismissBoxValue.Settled || maySettle(it) }, threshold)
    }
    val settle by rememberUpdatedState(onSettle)
    LaunchedEffect(swipe) {
        snapshotFlow { swipe.currentValue }.collect { standing ->
            if (standing != SwipeToDismissBoxValue.Settled) swipe.settle(standing)
        }
    }
    return swipe
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeleteSwipeRow(
    actionLabel: String,
    onDelete: suspend () -> Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(16.dp),
    // False when the content is its own TalkBack stop and declares the action there: an action on this box is
    // offered only while the box itself holds focus.
    declaresAction: Boolean = true,
    content: @Composable () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val haptics = rememberGymHaptics()
    val delete by rememberUpdatedState(onDelete)
    val swipe = rememberRowDismiss(settling = { it == SwipeToDismissBoxValue.EndToStart }) {
        if (!delete()) reset()
    }
    val pastThreshold = swipe.targetValue == SwipeToDismissBoxValue.EndToStart
    LaunchedEffect(pastThreshold) {
        if (pastThreshold) haptics.revealed()
    }
    val scale by animateFloatAsState(if (pastThreshold) 1.2f else 1f, label = "Delete threshold")
    SwipeToDismissBox(state = swipe, enableDismissFromStartToEnd = false, enableDismissFromEndToStart = enabled,
        modifier = modifier.clip(shape).semantics {
            if (enabled && declaresAction) customActions = listOf(CustomAccessibilityAction(actionLabel) {
                scope.launch { delete() }
                true
            })
        }, backgroundContent = {
            if (swipe.dismissDirection != SwipeToDismissBoxValue.Settled) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.error).padding(end = 20.dp),
                    contentAlignment = Alignment.CenterEnd) {
                    Icon(painterResource(R.drawable.gym_native_delete), null,
                        Modifier.size(24.dp).graphicsLayer { scaleX = scale; scaleY = scale },
                        tint = MaterialTheme.colorScheme.onError)
                }
            }
        }) { content() }
}

