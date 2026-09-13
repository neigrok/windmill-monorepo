package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import works.windmill.gym.R
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import works.windmill.platform.LocalShellActions
import works.windmill.platform.design.WindmillFont

// A screen that reads the account again when the app comes back from elsewhere: ON_RESUME after an
// ON_STOP, which is the browser a door opened closing over a tool just connected. A dialog or a
// permission sheet only pauses, and the first ON_RESUME on the way in is not a return. Nothing
// fires while the screen is not showing, because the observer leaves with it.
@Composable
fun ReadsAgainOnReturn(onReturn: () -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        var stopped = false
        val watcher = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> stopped = true
                Lifecycle.Event.ON_RESUME -> if (stopped) {
                    stopped = false
                    onReturn()
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(watcher)
        onDispose { lifecycleOwner.lifecycle.removeObserver(watcher) }
    }
}

// The room owns system insets; each screen owns its native title and actions.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GymScreen(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    backTo: String? = null,
    navigation: (@Composable () -> Unit)? = null,
    sessionBar: Boolean = false,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable BoxScope.() -> Unit,
) {
    val skin = LocalGymColors.current
    Scaffold(
        modifier = modifier,
        containerColor = skin.canvas,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            if (sessionBar) {
                CenterAlignedTopAppBar(
                    title = {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = WindmillFont.body(20, FontWeight.Bold), color = skin.ink,
                            modifier = Modifier.semantics { heading() })
                    },
                    navigationIcon = { navigation?.invoke() },
                    actions = actions,
                    expandedHeight = 64.dp,
                    windowInsets = WindowInsets(0, 0, 0, 0),
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = skin.canvas),
                )
            } else Row(
                Modifier.fillMaxWidth().heightIn(min = 64.dp)
                    .padding(start = if (navigation != null || onBack != null) 12.dp else 20.dp, end = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (navigation != null) navigation()
                else onBack?.let { back ->
                    IconButton(onClick = back, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = backTo?.let { "Back to $it" } ?: "Back",
                            tint = skin.ink, modifier = Modifier.size(24.dp))
                    }
                }
                Text(
                    title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = WindmillFont.body(24, FontWeight.Bold),
                    color = skin.ink, modifier = Modifier.weight(1f).semantics { heading() },
                )
                actions()
            }
        },
        bottomBar = bottomBar,
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner)) { content() }
    }
}

// Every typed field in the room, dressed from the room's own scheme rather than from a colour
// literal: the ground is the card ground, the focused edge is the accent, and a refusal is brick.
@Composable
fun gymFieldColours(): TextFieldColors {
    val scheme = MaterialTheme.colorScheme
    return OutlinedTextFieldDefaults.colors(
        focusedTextColor = scheme.onSurface,
        unfocusedTextColor = scheme.onSurface,
        disabledTextColor = scheme.onSurfaceVariant,
        cursorColor = scheme.primary,
        focusedBorderColor = scheme.primary,
        unfocusedBorderColor = scheme.outline,
        disabledBorderColor = scheme.outlineVariant,
        focusedContainerColor = scheme.surfaceContainerHighest,
        unfocusedContainerColor = scheme.surfaceContainerHighest,
        disabledContainerColor = scheme.surfaceContainerHighest,
        focusedPlaceholderColor = scheme.onSurfaceVariant,
        unfocusedPlaceholderColor = scheme.onSurfaceVariant,
        focusedLabelColor = scheme.onSurfaceVariant,
        unfocusedLabelColor = scheme.onSurfaceVariant,
        errorBorderColor = scheme.error,
        errorCursorColor = scheme.error,
        errorTextColor = scheme.onSurface,
        errorContainerColor = scheme.surfaceContainerHighest,
        errorPlaceholderColor = scheme.onSurfaceVariant,
        errorLabelColor = scheme.error,
    )
}

// One segmented control for every either-or in the room. `SingleChoiceSegmentedButtonRow` draws a
// leading check on the selected item by default; none of these pickers has ever shown one and the
// fill already says which is picked, so the icon slot is emptied rather than left to the default.
@Composable
fun <T> GymSegmented(
    options: List<Pair<T, String>>,
    picked: T,
    modifier: Modifier = Modifier,
    onPick: (T) -> Unit,
) {
    val skin = LocalGymColors.current
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = value == picked,
                onClick = { onPick(value) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                icon = {},
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = skin.accentSoft,
                    activeContentColor = skin.accent,
                    activeBorderColor = skin.accent,
                    inactiveContainerColor = Color.Transparent,
                    inactiveContentColor = skin.inkDim,
                    inactiveBorderColor = skin.line,
                ),
                label = { Text(label, style = GymType.numeral(13, FontWeight.Bold), maxLines = 1) },
            )
        }
    }
}

// A top bar action whose verb has no icon worth the guess. Material's own text action, in the
// room's accent.
@Composable
fun TopAction(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val skin = LocalGymColors.current
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.textButtonColors(
            contentColor = skin.accent,
            disabledContentColor = skin.inkFaint,
        ),
    ) {
        Text(label, style = WindmillFont.body(13, FontWeight.Bold))
    }
}

// The trailing mark on a row that opens something. It says nothing TalkBack needs — the row it sits
// in carries the label — so it has no description of its own.
@Composable
fun Chevron(modifier: Modifier = Modifier) {
    val skin = LocalGymColors.current
    Icon(painterResource(R.drawable.gym_chevron), contentDescription = null,
        tint = skin.inkDim, modifier = modifier.width(10.1771.dp).height(15.5052.dp))
}

@Composable
fun YouSeat(initial: String) {
    val skin = LocalGymColors.current
    val shell = LocalShellActions.current
    Box(
        Modifier.size(48.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClickLabel = "open your account", onClick = shell.openYou)
            .semantics(mergeDescendants = true) { contentDescription = "Your account" },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(skin.raised), contentAlignment = Alignment.Center) {
            Text(initial.uppercase().ifEmpty { "•" }, style = WindmillFont.body(12, FontWeight.Bold), color = skin.ink)
        }
    }
}

// Material's own drag handle, drawn from the extended icon set's path: the room depends on the core
// set alone, and one glyph is not a reason to pull the whole extended artifact in.
val Icons.Filled.DragHandle: ImageVector
    get() = dragHandle ?: materialIcon(name = "Filled.DragHandle") {
        materialPath {
            moveTo(20.0f, 9.0f)
            horizontalLineTo(4.0f)
            verticalLineToRelative(2.0f)
            horizontalLineToRelative(16.0f)
            verticalLineTo(9.0f)
            close()
            moveTo(4.0f, 15.0f)
            horizontalLineToRelative(16.0f)
            verticalLineToRelative(-2.0f)
            horizontalLineTo(4.0f)
            verticalLineToRelative(2.0f)
            close()
        }
    }.also { dragHandle = it }

private var dragHandle: ImageVector? = null
