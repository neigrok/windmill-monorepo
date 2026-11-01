package works.windmill.gym.ui

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.R

internal object GymNativeType {
    val sans = FontFamily(
        Font(R.font.onboarding_nunito_regular, FontWeight.Normal),
        Font(R.font.onboarding_nunito_bold, FontWeight.Bold),
        Font(R.font.onboarding_nunito_extrabold, FontWeight.ExtraBold),
    )
    val mono = FontFamily(Font(R.font.onboarding_mono_medium, FontWeight.Medium))
    val button = TextStyle(fontFamily = sans, fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 22.sp)
    val note = TextStyle(fontFamily = FontFamily(Font(R.font.onboarding_mono_regular)), fontSize = 12.sp, lineHeight = 16.sp)
}

@Composable
fun GymSnackbarHost(state: SnackbarHostState, modifier: Modifier = Modifier) {
    val type = MaterialTheme.typography
    MaterialTheme(typography = type.copy(
        bodyMedium = type.bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = .25.sp),
        labelLarge = type.labelLarge.copy(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = .1.sp, fontWeight = FontWeight.Medium),
    )) {
        SnackbarHost(state, modifier.padding(horizontal = 4.dp))
    }
}

@Composable
fun GymFab(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    FloatingActionButton(onClick, modifier.size(56.dp).semantics { contentDescription = label },
        shape = RoundedCornerShape(16.dp), containerColor = colors.primaryContainer.compositeOver(colors.surfaceContainer),
        contentColor = colors.primary) {
        Icon(painterResource(R.drawable.gym_native_add), null, Modifier.size(24.dp))
    }
}

// Collapsed to its icon while the list beneath it is scrolled; the label stays its accessible name.
@Composable
fun GymExtendedFab(label: String, onClick: () -> Unit, icon: Painter, modifier: Modifier = Modifier, expanded: Boolean = true) {
    val colors = MaterialTheme.colorScheme
    ExtendedFloatingActionButton(
        text = { Text(label, style = GymNativeType.button.copy(lineHeight = 24.sp)) },
        icon = { Icon(icon, null, Modifier.size(24.dp)) },
        onClick = onClick,
        modifier = modifier.semantics { contentDescription = label },
        expanded = expanded,
        shape = RoundedCornerShape(16.dp),
        containerColor = colors.primaryContainer.compositeOver(colors.surfaceContainer),
        contentColor = colors.primary,
    )
}

@Composable
fun GymErrorButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(onClick, modifier.heightIn(min = 56.dp), enabled = enabled, shape = RoundedCornerShape(16.dp),
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error,
            contentColor = MaterialTheme.colorScheme.onError)) {
        Text(label, style = GymNativeType.button)
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun GymErrorTextButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, minimumHeight: Dp = 56.dp) {
    val error = MaterialTheme.colorScheme.error
    CompositionLocalProvider(LocalRippleConfiguration provides RippleConfiguration(color = error,
        rippleAlpha = RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.08f, hoveredAlpha = 0.08f, pressedAlpha = 0.12f))) {
        TextButton(onClick, modifier.heightIn(min = minimumHeight), enabled = enabled, shape = RoundedCornerShape(16.dp),
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = error)) {
            Text(label, style = GymNativeType.button)
        }
    }
}

@Composable
fun GymMenu(expanded: Boolean, onDismissRequest: () -> Unit, modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit) {
    DropdownMenu(expanded, onDismissRequest, modifier, shape = RoundedCornerShape(16.dp),
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
            Text(label, style = TextStyle(fontFamily = GymNativeType.sans, fontSize = 14.sp, lineHeight = 20.sp))
        }
    }, onClick = onClick, modifier = modifier.heightIn(min = 48.dp), enabled = enabled,
        contentPadding = PaddingValues(horizontal = 16.dp),
        colors = MenuDefaults.itemColors(textColor = ink))
}
