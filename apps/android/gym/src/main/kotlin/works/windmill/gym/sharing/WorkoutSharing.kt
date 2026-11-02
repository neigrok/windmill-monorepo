package works.windmill.gym.sharing

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import works.windmill.gym.presentation.Readout
import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WriteFailure

@Serializable
data class SessionShare(
    val token: String,
    val url: String? = null,
    @SerialName("expiresAt") val expiresAtMs: Long,
)

class WorkoutShareActions(
    val origin: String,
    val mint: suspend (String) -> GymResult<SessionShare>,
    val revoke: suspend (String) -> WriteFailure?,
)

object WorkoutSharing {
    const val chooserTitle = "Share workout link"
    const val shareFailureNote = "Sharing isn't available here. Copy the link instead."
    const val copiedAnnouncement = "Link copied"
    const val offer = "Anyone with the link can read this workout.\nIncludes set notes and effort.\nLinks last 30 days. End sharing anytime."

    data class Card(
        val title: String,
        val body: String,
        val link: String?,
        val action: String,
        val share: String?,
        val revoke: String?,
        val note: String?,
    )

    sealed class State {
        data class Closed(val note: String? = null) : State()
        data object Working : State()
        data class Live(val share: SessionShare, val copied: Boolean = false, val note: String? = null) : State()
        data object Revoked : State()

        fun after(event: Event): State = when (event) {
            Event.Asked -> Working
            is Event.Minted -> Live(share = event.share)
            is Event.MintFailed -> Closed(note = event.why)
            Event.Copied -> if (this is Live) copy(copied = true) else this
            is Event.ShareFailed -> if (this is Live) copy(note = event.why) else this
            Event.Shared -> if (this is Live && note == shareFailureNote) copy(note = null) else this
            Event.Revoked -> Revoked
            is Event.RevokeFailed -> if (this is Live) Live(share = share, note = event.why) else this
        }
    }

    sealed class Event {
        data object Asked : Event()
        data class Minted(val share: SessionShare) : Event()
        data class MintFailed(val why: String) : Event()
        data object Copied : Event()
        data class ShareFailed(val why: String) : Event()
        data object Shared : Event()
        data object Revoked : Event()
        data class RevokeFailed(val why: String) : Event()
    }

    fun link(share: SessionShare, base: String): String {
        val sent = share.url
        if (!sent.isNullOrEmpty()) return sent
        return "${base.removeSuffix("/")}/#/gym/shared/${share.token}"
    }

    fun card(state: State, base: String): Card = when (state) {
        is State.Closed ->
            Card(title = "Share this workout", body = offer, link = null,
                 action = if (state.note == null) "Get a link" else "Try again", share = null, revoke = null, note = state.note)
        State.Working ->
            Card(title = "Share this workout", body = offer, link = null,
                 action = "…", share = null, revoke = null, note = null)
        is State.Live ->
            Card(
                title = "The link is live",
                body = "Anyone who has this link can read this one workout. It stops working on " +
                    "${Readout.day(state.share.expiresAtMs)}, and revoking it kills it immediately.",
                link = link(state.share, base),
                action = if (state.copied) "Copied" else "Copy link",
                share = "Share",
                revoke = "Revoke the link",
                note = state.note)
        State.Revoked ->
            Card(title = "The link is dead",
                 body = "Anyone still holding it gets nothing. You can make a new one whenever you like.",
                 link = null, action = "Get a link", share = null, revoke = null, note = null)
    }
}
