package works.windmill.gym.coach

import android.text.format.DateFormat
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import works.windmill.gym.R
import works.windmill.gym.ui.LocalGymColors
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.telemetry.LocalTelemetry

internal enum class CoachGroup { Single, First, Middle, Last }

internal class CoachCopyMenu { var selected by mutableStateOf<Int?>(null) }

@Composable
internal fun CoachBubble(
    fromLifter: Boolean = false,
    group: CoachGroup = CoachGroup.Single,
    fullWidth: Boolean = false,
    copyText: () -> String,
    copyMenu: CoachCopyMenu? = null,
    copyIndex: Int = 0,
    copyLastIndex: Int = copyIndex,
    content: @Composable () -> Unit,
) {
    val skin = LocalGymColors.current
    val clipboard = LocalClipboardManager.current
    val telemetry = LocalTelemetry.current
    val latestCopy by rememberUpdatedState(copyText)
    val ownMenu = rememberSaveable { mutableStateOf(false) }
    val menu = if (copyMenu == null) ownMenu.value else copyMenu.selected?.coerceIn(0, copyLastIndex) == copyIndex
    val changeMenu: (Boolean) -> Unit = { open ->
        if (copyMenu == null) ownMenu.value = open else copyMenu.selected = if (open) copyIndex else null
    }
    val label = if (fromLifter) "Copy question" else "Copy answer"
    val copy: () -> Boolean = copy@{
        try { clipboard.setText(AnnotatedString(latestCopy())) }
        catch (failure: Exception) {
            telemetry.failure("gym.copyMessage", failure)
            telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "copy", "outcome" to "failed"))
            return@copy false
        }
        changeMenu(false)
        telemetry.event("gym_action", mapOf("screen" to "coach", "action" to "copy", "outcome" to "ok"))
        true
    }
    val first = group == CoachGroup.First || group == CoachGroup.Middle
    val last = group == CoachGroup.Last || group == CoachGroup.Middle
    val shape = RoundedCornerShape(
        topStart = if (!fromLifter && last) 4.dp else 20.dp,
        topEnd = if (fromLifter && last) 4.dp else 20.dp,
        bottomEnd = if (fromLifter && first) 4.dp else 20.dp,
        bottomStart = if (!fromLifter && first) 4.dp else 20.dp,
    )
    Box(if (fullWidth) Modifier.fillMaxWidth() else Modifier.widthIn(max = 321.dp)) {
        Box(Modifier.clip(shape).background(if (fromLifter) skin.accent else skin.surface)
            .background(if (menu) skin.ink.copy(alpha = 0.16f) else Color.Transparent)
            .pointerInput(label) { detectTapGestures(onLongPress = { changeMenu(true) }) }
            .semantics(mergeDescendants = true) { customActions = listOf(CustomAccessibilityAction(label) { copy() }) }
            .padding(horizontal = 16.dp, vertical = if (fullWidth) 16.dp else 8.dp),
        ) { content() }
        DropdownMenu(expanded = menu, onDismissRequest = { changeMenu(false) }, containerColor = skin.surface,
            shape = RoundedCornerShape(16.dp), modifier = Modifier.width(208.dp),
        ) {
            DropdownMenuItem(text = { Text(label, style = CoachType.body(14).copy(lineHeight = 20.sp), color = skin.ink) }, onClick = { copy() })
        }
    }
}

@Composable
internal fun CoachQuestion(question: String, group: CoachGroup = CoachGroup.Single) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        CoachBubble(fromLifter = true, group = group, copyText = { question }) {
            Text(question, style = CoachType.body(16).copy(lineHeight = 22.sp), color = LocalGymColors.current.onAccent)
        }
    }
}

@Composable
internal fun CoachTyping() {
    val drawable = if (LocalWindmillDark.current) R.drawable.gym_coach_typing_dark else R.drawable.gym_coach_typing_light
    Image(painterResource(drawable), "Coach is thinking", Modifier.width(64.dp).height(40.dp))
}

internal fun coachTimestamp(atMs: Long, nowMs: Long, clock24: Boolean, zone: ZoneId = ZoneId.systemDefault()): String? {
    if (atMs <= 0) return null
    val at = Instant.ofEpochMilli(atMs).atZone(zone)
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    val day = when (at.toLocalDate()) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> DateTimeFormatter.ofPattern("MMM d", Locale.getDefault()).format(at)
    }
    val time = DateTimeFormatter.ofPattern(if (clock24) "H:mm" else "h:mm a", Locale.getDefault()).format(at)
    return "$day $time"
}

@Composable
internal fun ChatTimestamp(atMs: Long, nowMs: Long) {
    val label = coachTimestamp(atMs, nowMs, DateFormat.is24HourFormat(LocalContext.current)) ?: return
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Text(label, style = CoachType.body(12, FontWeight.Bold).copy(lineHeight = 16.sp), color = LocalGymColors.current.inkDim)
    }
}
