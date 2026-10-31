package works.windmill.platform.design

import androidx.activity.OnBackPressedDispatcherOwner
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.SheetState
import androidx.compose.material3.SheetValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.util.lerp
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

// The one modal sheet every room raises, over Material's own.
//
// Back belongs to the sheet's window and runs through that window's dispatcher, so a handler the
// content registers later — a nested route stepping back, a busy `BackHandler(busy) {}` — answers
// first and the sheet never previews a close it will not make. Otherwise the gesture shrinks the
// sheet toward 90 %, anchored at its bottom, and a release means `onBack`: by default Material's own
// close, which slides the sheet down and then asks `onDismissRequest`.
//
// Its window's bars follow the appearance.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WindmillSheet(
    onDismissRequest: () -> Unit,
    sheetState: SheetState,
    containerColor: Color = BottomSheetDefaults.ContainerColor,
    scrimColor: Color = BottomSheetDefaults.ScrimColor,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    shape: Shape = BottomSheetDefaults.ExpandedShape,
    dragHandle: (@Composable () -> Unit)? = { BottomSheetDefaults.DragHandle() },
    contentWindowInsets: @Composable () -> WindowInsets = { BottomSheetDefaults.windowInsets },
    content: @Composable ColumnScope.() -> Unit,
) {
    val scope = rememberCoroutineScope()
    val preview = remember { Animatable(0f) }
    val animate = animationsOn()
    LaunchedEffect(sheetState.isVisible) { if (!sheetState.isVisible) preview.snapTo(0f) }
    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        sheetState = sheetState,
        modifier = modifier
            .graphicsLayer {
                val progress = preview.value
                if (progress > 0f) {
                    val scale = lerp(1f, NavigationMotion.backScale, progress)
                    scaleX = scale
                    scaleY = scale
                    transformOrigin = TransformOrigin(0.5f, (sheetState.requireOffset() + size.height) / size.height)
                }
            },
        shape = shape,
        containerColor = containerColor,
        scrimColor = scrimColor,
        dragHandle = dragHandle,
        contentWindowInsets = contentWindowInsets,
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
    ) {
        val view = LocalView.current
        val dark = LocalWindmillDark.current
        val window = checkNotNull(generateSequence(view.parent) { it.parent }
            .filterIsInstance<DialogWindowProvider>().firstOrNull()?.window) { "A sheet draws in its own window." }
        val owner = checkNotNull(window.callback as? OnBackPressedDispatcherOwner) {
            "The sheet window must own its Back dispatcher."
        }
        SideEffect {
            view.post {
                val bars = WindowInsetsControllerCompat(window, view)
                bars.isAppearanceLightStatusBars = !dark
                bars.isAppearanceLightNavigationBars = !dark
            }
        }
        CompositionLocalProvider(LocalOnBackPressedDispatcherOwner provides owner) {
            PredictiveBackHandler { gesture ->
                try {
                    gesture.collect { if (animate) preview.snapTo(NavigationMotion.backProgress(it.progress)) }
                } catch (cancelled: CancellationException) {
                    scope.launch { preview.animateTo(0f, tween(NavigationMotion.durationMs / 2, easing = NavigationMotion.emphasized)) }
                    throw cancelled
                }
                if (onBack == null) {
                    sheetState.hide()
                    onDismissRequest()
                    return@PredictiveBackHandler
                }
                onBack()
                withFrameNanos { }
                if (sheetState.targetValue != SheetValue.Hidden) {
                    preview.animateTo(0f, tween(NavigationMotion.durationMs / 2, easing = NavigationMotion.emphasized))
                }
            }
            content()
        }
    }
}
