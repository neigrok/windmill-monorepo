package works.windmill.gym.sharing

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import works.windmill.gym.store.GymResult
import works.windmill.gym.ui.GymTap
import works.windmill.gym.ui.GymType
import works.windmill.gym.ui.gymColors
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.design.WindmillType
import works.windmill.platform.telemetry.LocalTelemetry

@Composable
fun WorkoutShareCard(sharing: WorkoutShareActions, sessionId: String) {
    val colors = MaterialTheme.colorScheme
    val gymColors = MaterialTheme.gymColors
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val context = LocalContext.current
    val telemetry = LocalTelemetry.current
    var state by remember(sessionId) { mutableStateOf<WorkoutSharing.State>(WorkoutSharing.State.Closed()) }
    val card = WorkoutSharing.card(state, sharing.origin)

    fun copyLink() {
        val live = state as? WorkoutSharing.State.Live ?: return
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("plain text", WorkoutSharing.link(live.share, sharing.origin))))
            } catch (failure: Exception) {
                currentCoroutineContext().ensureActive()
                telemetry.failure("gym.share", failure)
                telemetry.event("gym_action", mapOf("screen" to "session", "action" to "copy_link", "outcome" to "failed"))
                return@launch
            }
            telemetry.event("gym_action", mapOf("screen" to "session", "action" to "copy_link", "outcome" to "ok"))
            state = state.after(WorkoutSharing.Event.Copied)
        }
    }

    fun shareLink() {
        val live = state as? WorkoutSharing.State.Live ?: return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, WorkoutSharing.link(live.share, sharing.origin))
        try {
            context.startActivity(Intent.createChooser(send, WorkoutSharing.chooserTitle))
        } catch (_: ActivityNotFoundException) {
            state = state.after(WorkoutSharing.Event.ShareFailed(WorkoutSharing.shareFailureNote))
            telemetry.event("gym_action", mapOf("screen" to "session", "action" to "share_link", "outcome" to "unavailable"))
            return
        } catch (failure: Exception) {
            telemetry.failure("gym.shareLink", failure)
            state = state.after(WorkoutSharing.Event.ShareFailed(WorkoutSharing.shareFailureNote))
            telemetry.event("gym_action", mapOf("screen" to "session", "action" to "share_link", "outcome" to "failed"))
            return
        }
        state = state.after(WorkoutSharing.Event.Shared)
        telemetry.event("gym_action", mapOf("screen" to "session", "action" to "share_link", "outcome" to "ok"))
    }

    fun getLink() {
        scope.launch {
            state = state.after(WorkoutSharing.Event.Asked)
            when (val minted = sharing.mint(sessionId)) {
                is GymResult.Ok -> state = state.after(WorkoutSharing.Event.Minted(minted.value))
                is GymResult.Failed ->
                    state = state.after(WorkoutSharing.Event.MintFailed(minted.why.line("the link wasn’t made")))
            }
        }
    }

    // A revoke that did not happen leaves the link LIVE and says so.
    fun revokeLink() {
        val live = state
        if (live !is WorkoutSharing.State.Live) return
        scope.launch {
            state = state.after(WorkoutSharing.Event.Asked)
            val why = sharing.revoke(sessionId)
            if (why == null) {
                state = state.after(WorkoutSharing.Event.Revoked)
                return@launch
            }
            state = live.after(WorkoutSharing.Event.RevokeFailed(why.line("the link is still live")))
        }
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp).padding(bottom = 20.dp),
    ) {
        Text(card.title, style = GymType.shareTitle, color = colors.onSurface)

        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            card.body.split('\n').forEach { paragraph ->
                Text(paragraph, style = GymType.subtitle, color = colors.onSurfaceVariant)
            }
        }

        card.link?.let { link ->
            SelectionContainer {
                Text(
                    link,
                    style = GymType.numeralTiny,
                    color = colors.primary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.surfaceContainerHighest, MaterialTheme.shapes.medium)
                        .padding(WindmillSpace.x3),
                )
            }
        }

        card.note?.let { note ->
            Text(
                note,
                style = GymType.subtitle,
                color = gymColors.alarmInk,
            )
        }

        val shareLabel = card.share
        if (shareLabel != null) {
            Row(
                modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min),
                horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
            ) {
                FilledTonalButton(
                    onClick = ::copyLink,
                    modifier = Modifier.weight(1f).fillMaxHeight().heightIn(min = GymTap.primary).semantics {
                        liveRegion = LiveRegionMode.Polite
                        if ((state as? WorkoutSharing.State.Live)?.copied == true) {
                            stateDescription = WorkoutSharing.copiedAnnouncement
                        }
                    },
                    colors = ButtonDefaults.filledTonalButtonColors(
                        containerColor = colors.surfaceContainerHighest,
                        contentColor = colors.onSurface,
                    ),
                    contentPadding = PaddingValues(horizontal = WindmillSpace.x6),
                ) {
                    Text(card.action, modifier = Modifier.fillMaxWidth(), style = WindmillType.labelParagraph, textAlign = TextAlign.Center)
                }
                Button(
                    onClick = ::shareLink,
                    modifier = Modifier.weight(1f).fillMaxHeight().heightIn(min = GymTap.primary),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.primary, contentColor = colors.onPrimary),
                    contentPadding = PaddingValues(horizontal = WindmillSpace.x6),
                ) {
                    Text(shareLabel, modifier = Modifier.fillMaxWidth(), style = WindmillType.labelParagraph, textAlign = TextAlign.Center)
                }
            }
        } else {
            Button(
                onClick = ::getLink,
                enabled = state != WorkoutSharing.State.Working,
                modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.primary,
                    contentColor = colors.onPrimary,
                    disabledContainerColor = colors.primary.copy(alpha = .38f),
                    disabledContentColor = colors.onPrimary.copy(alpha = .38f),
                ),
            ) {
                Text(card.action, style = WindmillType.label)
            }
        }

        card.revoke?.let { revoke ->
            TextButton(
                onClick = ::revokeLink,
                modifier = Modifier.fillMaxWidth().heightIn(min = GymTap.minimum),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.primary),
            ) {
                Text(revoke, style = GymType.quietAction)
            }
        }
    }
}
