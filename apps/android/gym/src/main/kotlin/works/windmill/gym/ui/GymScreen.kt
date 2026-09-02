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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import works.windmill.platform.LocalShellActions
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace

// One container, so every screen in the room says its name in the same place: the platform's top app
// bar. The back arrow carries WHERE it leads in its description rather than in a drawn label —
// Android does not label a back arrow, and the gesture is the way most hands take it anyway.
//
// The room's own Scaffold owns the window insets and the rail; this one takes none, so a screen
// drawn inside the room sits under that chrome and a screen drawn on its own still has its bar.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GymScreen(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    backTo: String? = null,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable BoxScope.() -> Unit,
) {
    Scaffold(
        modifier = modifier,
        containerColor = GymSkin.canvas,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = {
                    Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis, color = GymSkin.ink)
                },
                navigationIcon = {
                    onBack?.let { back ->
                        IconButton(onClick = back) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = backTo?.let { "Back to $it" } ?: "Back",
                            )
                        }
                    }
                },
                actions = actions,
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = GymSkin.canvas,
                    titleContentColor = GymSkin.ink,
                    navigationIconContentColor = GymSkin.inkDim,
                    actionIconContentColor = GymSkin.accent,
                ),
            )
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
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(
                selected = value == picked,
                onClick = { onPick(value) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                icon = {},
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = GymSkin.accentSoft,
                    activeContentColor = GymSkin.accent,
                    activeBorderColor = GymSkin.accent,
                    inactiveContainerColor = Color.Transparent,
                    inactiveContentColor = GymSkin.inkDim,
                    inactiveBorderColor = GymSkin.line,
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
    TextButton(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(
            contentColor = GymSkin.accent,
            disabledContentColor = GymSkin.inkFaint,
        ),
    ) {
        Text(label, style = WindmillFont.body(15, FontWeight.Bold))
    }
}

// The trailing mark on a row that opens something. It says nothing TalkBack needs — the row it sits
// in carries the label — so it has no description of its own.
@Composable
fun Chevron(modifier: Modifier = Modifier) {
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = GymSkin.inkFaint,
        modifier = modifier.size(20.dp),
    )
}

// The shared account seat, trailing every root's top bar past a hairline so it reads as the shell's
// and not the room's. Android has no shell chrome of its own, so this is the only shell thing on the
// surface. The platform owns the sheet it opens.
@Composable
fun YouSeat(initial: String) {
    val shell = LocalShellActions.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier.padding(end = WindmillSpace.x2),
    ) {
        Box(
            Modifier
                .width(1.dp)
                .height(22.dp)
                .background(Color.White.copy(alpha = 0.14f)),
        )
        Box(
            Modifier
                .size(GymTap.minimum)
                .clip(CircleShape)
                .clickable(role = Role.Button, onClickLabel = "open your account") { shell.openYou() }
                // An initial in a circle says nothing out loud; the seat says what it is.
                .semantics(mergeDescendants = true) { contentDescription = "Your account" },
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier
                    .size(30.dp)
                    .clip(CircleShape)
                    .background(GymSkin.raised),
                contentAlignment = Alignment.Center,
            ) {
                if (initial.isEmpty()) {
                    // Nobody signed in yet.
                    Box(
                        Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(GymSkin.inkFaint),
                    )
                } else {
                    Text(initial.uppercase(), style = WindmillFont.display(13), color = GymSkin.ink)
                }
            }
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
