package works.windmill.gym.domain

import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WriteFailure

// The expiry is printed from the server's reply, never counted off this device's clock.

class CoachDoors(
    val origin: String,
    val mint: suspend (String) -> GymResult<SessionShare>,
    val revoke: suspend (String) -> WriteFailure?,
)

object Coach {
    const val offer = "A link to this one workout — every set, load and rep in it, and nothing " +
        "else about your account. Anyone who has the link can read it. It expires, and you can " +
        "revoke it whenever you like."

    data class Card(
        val title: String,
        val body: String,
        val link: String?,
        val action: String,
        val revoke: String?,
        val note: String?,        // the log's own words when a door did not open
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
            Event.Revoked -> Revoked
            is Event.RevokeFailed -> if (this is Live) Live(share = share, note = event.why) else this
        }
    }

    sealed class Event {
        data object Asked : Event()
        data class Minted(val share: SessionShare) : Event()
        data class MintFailed(val why: String) : Event()
        data object Copied : Event()
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
            Card(title = "Share with a coach", body = offer, link = null,
                 action = if (state.note == null) "Get a link" else "Try again", revoke = null, note = state.note)
        State.Working ->
            Card(title = "Share with a coach", body = offer, link = null,
                 action = "…", revoke = null, note = null)
        is State.Live ->
            Card(
                title = "The link is live",
                body = "Anyone who has this link can read this one workout. It stops working on " +
                    "${Readout.day(state.share.expiresAtMs)}, and revoking it kills it immediately.",
                link = link(state.share, base),
                action = if (state.copied) "Copied" else "Copy link",
                revoke = "Revoke the link",
                note = state.note)
        State.Revoked ->
            Card(title = "The link is dead",
                 body = "Anyone still holding it gets nothing. You can make a new one whenever you like.",
                 link = null, action = "Get a new link", revoke = null, note = null)
    }
}
