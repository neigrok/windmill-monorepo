package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import works.windmill.gym.domain.Coach
import works.windmill.gym.domain.CoachDoors
import works.windmill.gym.store.GymResult
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// One drawing of the coach share, used by the screen a session ends on and by the screen it is
// revisited from. Nothing is minted until the tap, and nothing on screen claims a link exists until
// the log has said so — the same rule "Keep this as a routine" follows two cards up. The state
// machine itself is Coach's (domain/CoachShare.kt), where a test can stand on the rule that matters
// most: A REVOKE THAT DID NOT HAPPEN LEAVES THE LINK LIVE.
//
// The card takes the room's CoachDoors rather than the store: the mint and the revoke are the only
// two writes this drawing may reach, and doors.origin is where the account's own client points, so
// a debug build talking to a local server hands over a link to that server and never to
// windmill.works.
@Composable
fun CoachShareCard(coach: CoachDoors, sessionId: String) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var state by remember(sessionId) { mutableStateOf<Coach.State>(Coach.State.Closed()) }
    val card = Coach.card(state, coach.origin)

    // The one action, whatever the card currently offers: mint, or copy the link that is already
    // live. Copying is the only thing here that never touches the log.
    fun act() {
        val standing = state
        if (standing is Coach.State.Live) {
            clipboard.setText(AnnotatedString(Coach.link(standing.share, coach.origin)))
            state = state.after(Coach.Event.Copied)
            return
        }
        scope.launch {
            state = state.after(Coach.Event.Asked)
            when (val minted = coach.mint(sessionId)) {
                is GymResult.Ok -> state = state.after(Coach.Event.Minted(minted.value))
                is GymResult.Failed ->
                    state = state.after(Coach.Event.MintFailed(minted.why.line("the link wasn’t made")))
            }
        }
    }

    // A revoke that did not happen leaves the link LIVE and says so. Drawing it as dead would tell
    // a lifter their coach can no longer read the session on the strength of a request that failed
    // — the one mistake this card is not allowed to make. The live state is kept across the round
    // trip rather than replaced by Working, because that is what the failure branch falls back to.
    fun revokeLink() {
        val live = state
        if (live !is Coach.State.Live) return
        scope.launch {
            state = state.after(Coach.Event.Asked)
            val why = coach.revoke(sessionId)
            if (why == null) {
                state = state.after(Coach.Event.Revoked)
                return@launch
            }
            state = live.after(Coach.Event.RevokeFailed(why.line("the link is still live")))
        }
    }

    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Text(card.title, style = WindmillFont.display(18), color = GymSkin.ink)

        Text(
            card.body,
            style = GymType.numeral(12).copy(lineHeight = 17.sp),
            color = GymSkin.inkFaint,
        )

        card.link?.let { link ->
            // The address is shown in full and not behind the word "link": what leaves the phone is
            // what a coach can open, and a lifter is owed the sight of it before they send it.
            SelectionContainer {
                Text(
                    link,
                    style = GymType.numeral(11),
                    color = GymSkin.accent,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(GymSkin.raised, RoundedCornerShape(WindmillRadius.md))
                        .padding(WindmillSpace.x3),
                )
            }
        }

        card.note?.let { note ->
            Text(
                note,
                style = GymType.numeral(12).copy(lineHeight = 17.sp),
                color = GymSkin.alarmInk,
            )
        }

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.minimum)
                .border(1.dp, GymSkin.lineStrong, RoundedCornerShape(WindmillRadius.lg))
                .clickable(enabled = state != Coach.State.Working) { act() },
        ) {
            Text(
                card.action,
                style = WindmillFont.body(16, FontWeight.SemiBold),
                color = GymSkin.accent,
            )
        }

        card.revoke?.let { revoke ->
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum)
                    .clickable { revokeLink() },
            ) {
                Text(
                    revoke,
                    style = WindmillFont.body(15, FontWeight.SemiBold),
                    color = GymSkin.inkDim,
                )
            }
        }
    }
}
