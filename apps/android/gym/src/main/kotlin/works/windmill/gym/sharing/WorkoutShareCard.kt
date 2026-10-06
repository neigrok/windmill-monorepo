package works.windmill.gym.sharing

import works.windmill.gym.ui.GymTap
import works.windmill.gym.ui.GymType
import works.windmill.gym.ui.LocalGymColors
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.gym.store.GymResult
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

@Composable
fun WorkoutShareCard(sharing: WorkoutShareActions, sessionId: String) {
    val skin = LocalGymColors.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var state by remember(sessionId) { mutableStateOf<WorkoutSharing.State>(WorkoutSharing.State.Closed()) }
    val card = WorkoutSharing.card(state, sharing.origin)

    fun act() {
        val standing = state
        if (standing is WorkoutSharing.State.Live) {
            clipboard.setText(AnnotatedString(WorkoutSharing.link(standing.share, sharing.origin)))
            state = state.after(WorkoutSharing.Event.Copied)
            return
        }
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
        Text(card.title, style = WindmillFont.display(26, FontWeight.ExtraBold), color = skin.ink)

        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            card.body.split('\n').forEach { paragraph ->
                Text(paragraph, style = WindmillFont.body(16).copy(lineHeight = 21.sp), color = skin.inkDim)
            }
        }

        card.link?.let { link ->
            SelectionContainer {
                Text(
                    link,
                    style = GymType.numeral(11),
                    color = skin.accent,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(skin.raised, RoundedCornerShape(WindmillRadius.md))
                        .padding(WindmillSpace.x3),
                )
            }
        }

        card.note?.let { note ->
            Text(
                note,
                style = WindmillFont.body(16).copy(lineHeight = 21.sp),
                color = skin.alarmInk,
            )
        }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .background(skin.accent, RoundedCornerShape(16.dp))
                .clickable(enabled = state != WorkoutSharing.State.Working, role = Role.Button) { act() },
        ) {
            Text(
                card.action,
                style = WindmillFont.body(16, FontWeight.Bold),
                color = skin.onAccent,
            )
        }

        card.revoke?.let { revoke ->
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .clickable(role = Role.Button) { revokeLink() },
            ) {
                Text(
                    revoke,
                    style = WindmillFont.body(15, FontWeight.SemiBold),
                    color = skin.inkDim,
                )
            }
        }
    }
}
