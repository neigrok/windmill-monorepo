package works.windmill.gym.coach

import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import android.content.ClipData
import android.text.format.DateFormat
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import works.windmill.gym.R
import works.windmill.platform.i18n.Words
import works.windmill.platform.i18n.text
import works.windmill.platform.R as PlatformR
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.gym.telemetry.coachAction

internal enum class CoachGroup {
    Single, First, Middle, Last;

    // 20 dp outside and 4 dp on the side that meets the next of the group, on the speaker's edge.
    fun shape(fromLifter: Boolean): RoundedCornerShape {
        val above = this == First || this == Middle
        val below = this == Last || this == Middle
        return RoundedCornerShape(
            topStart = if (!fromLifter && below) 4.dp else 20.dp,
            topEnd = if (fromLifter && below) 4.dp else 20.dp,
            bottomEnd = if (fromLifter && above) 4.dp else 20.dp,
            bottomStart = if (!fromLifter && above) 4.dp else 20.dp,
        )
    }
}

internal class CoachCopyMenu { var selected by mutableStateOf<Int?>(null) }

@Composable
internal fun CoachBubble(
    fromLifter: Boolean = false,
    group: CoachGroup = CoachGroup.Single,
    fullWidth: Boolean = false,
    copyText: () -> String,
    copyLink: String? = null,
    copyMenu: CoachCopyMenu? = null,
    copyIndex: Int = 0,
    copyLastIndex: Int = copyIndex,
    content: @Composable () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val clipboard = LocalClipboard.current
    val clipLabel = stringResource(PlatformR.string.platform_clip_label)
    val telemetry = LocalTelemetry.current
    val scope = rememberCoroutineScope()
    val latestCopy by rememberUpdatedState(copyText)
    val latestLink by rememberUpdatedState(copyLink)
    val ownMenu = rememberSaveable { mutableStateOf(false) }
    val menu = if (copyMenu == null) ownMenu.value else copyMenu.selected?.coerceIn(0, copyLastIndex) == copyIndex
    val changeMenu: (Boolean) -> Unit = { open ->
        if (copyMenu == null) ownMenu.value = open else copyMenu.selected = if (open) copyIndex else null
    }
    val label = stringResource(if (fromLifter) R.string.gym_coach_copy_question else R.string.gym_coach_copy_answer)
    val copyLinkLabel = stringResource(R.string.gym_coach_copy_link)
    // The platform clipboard answers without suspending, so the undispatched copy has finished when this returns.
    val copy: (String?) -> Boolean = { link ->
        val action = if (link == null) "copy" else "copy_link"
        var copied = false
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val text = link ?: latestCopy()
                clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(clipLabel, text)))
            }
            catch (failure: Exception) {
                currentCoroutineContext().ensureActive()
                telemetry.failure("gym.copyMessage", failure)
                telemetry.coachAction(action, "failed")
                return@launch
            }
            changeMenu(false)
            telemetry.coachAction(action)
            copied = true
        }
        copied
    }
    val shape = group.shape(fromLifter)
    Box(if (fullWidth) Modifier.fillMaxWidth() else Modifier.widthIn(max = 321.dp)) {
        Box(Modifier.clip(shape).background(if (fromLifter) colors.primary else colors.surfaceContainer)
            .background(if (menu) colors.onSurface.copy(alpha = 0.16f) else Color.Transparent)
            .pointerInput(label) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    awaitLongPressOrCancellation(down.id) ?: return@awaitEachGesture
                    changeMenu(true)
                    // Consume release before the child link can treat the long press as a click.
                    do {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        event.changes.forEach { it.consume() }
                    } while (event.changes.any { it.pressed })
                }
            }
            .semantics(mergeDescendants = true) {
                customActions = buildList {
                    add(CustomAccessibilityAction(label) { copy(null) })
                    if (latestLink != null) add(CustomAccessibilityAction(copyLinkLabel) { copy(latestLink) })
                }
            }
            .padding(horizontal = 16.dp, vertical = if (fullWidth) 16.dp else 8.dp),
        ) { content() }
        DropdownMenu(expanded = menu, onDismissRequest = { changeMenu(false) }, containerColor = colors.surfaceContainer,
            modifier = Modifier.width(208.dp),
        ) {
            DropdownMenuItem(text = { Text(label, style = GymType.coachSupporting, color = colors.onSurface) }, onClick = { copy(null) })
            if (latestLink != null) DropdownMenuItem(
                text = { Text(copyLinkLabel, style = GymType.coachSupporting, color = colors.onSurface) },
                onClick = { copy(latestLink) },
            )
        }
    }
}

@Composable
internal fun CoachQuestion(question: String, group: CoachGroup = CoachGroup.Single) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        CoachBubble(fromLifter = true, group = group, copyText = { question }) {
            Text(question, style = GymType.coachParagraph, color = MaterialTheme.colorScheme.onPrimary)
        }
    }
}

// A sent picture on a phone that does not hold it: its place in the lifter's group (Coach §9.3).
@Composable
internal fun CoachPictureElsewhere(group: CoachGroup) {
    val colors = MaterialTheme.colorScheme
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
        modifier = Modifier.size(200.dp, 180.dp).clip(group.shape(fromLifter = true)).background(colors.surfaceContainerHighest).padding(horizontal = 16.dp),
    ) {
        Icon(painterResource(R.drawable.gym_coach_image_held), null, Modifier.size(24.dp), tint = colors.onSurfaceVariant)
        Text(stringResource(R.string.gym_coach_picture_elsewhere), style = GymType.coachSourceLine, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

@Composable
internal fun CoachTyping() {
    val drawable = if (LocalWindmillDark.current) R.drawable.gym_coach_typing_dark else R.drawable.gym_coach_typing_light
    Image(painterResource(drawable), stringResource(R.string.gym_coach_thinking), Modifier.width(64.dp).height(40.dp))
}

internal fun coachTimestamp(atMs: Long, nowMs: Long, clock24: Boolean, zone: ZoneId = ZoneId.systemDefault()): Words? {
    if (atMs <= 0) return null
    val at = Instant.ofEpochMilli(atMs).atZone(zone)
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    val day = when (at.toLocalDate()) {
        today -> Words.Message(R.string.gym_coach_today)
        today.minusDays(1) -> Words.Message(R.string.gym_coach_yesterday)
        else -> Words.Plain(DateTimeFormatter.ofPattern("MMM d", Locale.getDefault()).format(at))
    }
    val time = DateTimeFormatter.ofPattern(if (clock24) "H:mm" else "h:mm a", Locale.getDefault()).format(at)
    return Words.Message(R.string.gym_coach_timestamp, listOf(day, time))
}

@Composable
internal fun ChatTimestamp(atMs: Long, nowMs: Long) {
    val label = coachTimestamp(atMs, nowMs, DateFormat.is24HourFormat(LocalContext.current))?.text() ?: return
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Text(label, style = GymType.coachBubbleLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
