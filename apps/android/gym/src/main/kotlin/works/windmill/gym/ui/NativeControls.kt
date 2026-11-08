package works.windmill.gym.ui

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import works.windmill.gym.R
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.ui.semantics.disabled
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.graphics.graphicsLayer

@Composable
fun GymSnackbarHost(state: SnackbarHostState, modifier: Modifier = Modifier) {
    MaterialTheme(typography = MaterialTheme.typography.withStockSnackbar()) {
        SnackbarHost(state, modifier.padding(horizontal = 4.dp))
    }
}

@Composable
fun GymFab(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    FloatingActionButton(onClick, modifier.size(56.dp).semantics { contentDescription = label },
        containerColor = colors.primaryContainer.compositeOver(colors.surfaceContainer), contentColor = colors.primary) {
        Icon(painterResource(R.drawable.gym_native_add), null, Modifier.size(24.dp))
    }
}

// Collapsed to its icon while the list beneath it is scrolled; the label stays its accessible name.
@Composable
fun GymExtendedFab(label: String, onClick: () -> Unit, icon: Painter, modifier: Modifier = Modifier, expanded: Boolean = true,
    enabled: Boolean = true) {
    val colors = MaterialTheme.colorScheme
    // Material's FAB has no disabled state; a disabled one fades to Material's 38 % and does nothing, and says so.
    ExtendedFloatingActionButton(
        text = { Text(label, style = GymType.extendedFabLabel) },
        icon = { Icon(icon, null, Modifier.size(24.dp)) },
        onClick = { if (enabled) onClick() },
        modifier = modifier.graphicsLayer { alpha = if (enabled) 1f else .38f }
            .semantics { contentDescription = label; if (!enabled) disabled() },
        expanded = expanded,
        containerColor = colors.primaryContainer.compositeOver(colors.surfaceContainer),
        contentColor = colors.primary,
    )
}

@Composable
fun GymErrorButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(onClick, modifier.heightIn(min = 56.dp), enabled = enabled,
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error,
            contentColor = MaterialTheme.colorScheme.onError)) {
        Text(label, style = GymType.button)
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun GymErrorTextButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, minimumHeight: Dp = 56.dp) {
    val error = MaterialTheme.colorScheme.error
    CompositionLocalProvider(LocalRippleConfiguration provides RippleConfiguration(color = error,
        rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.08f, hoveredAlpha = 0.08f, pressedAlpha = 0.12f))) {
        TextButton(onClick, modifier.heightIn(min = minimumHeight), enabled = enabled,
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = error)) {
            Text(label, style = GymType.button)
        }
    }
}

@Composable
fun GymMenu(expanded: Boolean, onDismissRequest: () -> Unit, modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit) {
    DropdownMenu(expanded, onDismissRequest, modifier,
        containerColor = MaterialTheme.colorScheme.surfaceContainer, tonalElevation = 0.dp, content = content)
}

@Composable
fun GymMenuItem(label: String, icon: Painter, onClick: () -> Unit, modifier: Modifier = Modifier,
    destructive: Boolean = false, enabled: Boolean = true) {
    val ink = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    DropdownMenuItem(text = {
        Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(20.dp))
            Text(label, style = GymType.nativeSupporting)
        }
    }, onClick = onClick, modifier = modifier.heightIn(min = 48.dp), enabled = enabled,
        contentPadding = PaddingValues(horizontal = 16.dp),
        colors = MenuDefaults.itemColors(textColor = ink))
}

// A list row's drag handle: Material's 24 dp mark in the ListItem's leading slot, standing in the 48 dp target that
// carries the reorder gesture and its spoken label, a TalkBack stop of its own inside the row.
@Composable
fun GymDragHandle(label: String, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Box(Modifier.size(24.dp).wrapContentSize(unbounded = true)) {
        Box(Modifier.size(GymTap.minimum).semantics(mergeDescendants = true) { contentDescription = label; if (!enabled) disabled() }.then(modifier),
            contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.gym_drag_handle), null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// A sheet's one commit: a full-width stock pill at the sheet's foot, in thumb reach, 56 dp tall because the thumb finds
// it there. While the write is in flight it says so.
@Composable
fun GymSheetCommit(label: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, busy: Boolean = false) {
    Button(onClick, modifier.fillMaxWidth().heightIn(min = GymTap.primary), enabled = enabled) {
        Text(if (busy) "Saving…" else label)
    }
}
