package works.windmill.gym.domain

import works.windmill.gym.store.GymResult
import works.windmill.gym.store.WriteFailure

// THE COACH SHARE — one workout, handed to one person, by the lifter's own hand. It is the whole of
// gym's sharing and the shape is the point: a capability that EXPIRES and is REVOKED by deleting one
// row, per session, never per account. There is no profile, no feed, no gallery and no social share
// sheet; nothing about a session is discoverable without the token, and every other read in this
// product is still `WHERE user_id = :caller`.
//
// What the copy has to say, in every state it can be in, because a link that leaves your phone is a
// thing you are owed the truth about: ANYONE WHO HAS IT CAN READ THIS ONE WORKOUT · IT EXPIRES ·
// YOU CAN REVOKE IT. The expiry is the server's fact and is printed from the reply, never counted
// off this device's clock — a device-local clock can support an omission, never an assertion.
//
// The wire shape (SessionShare) lives in Training.kt; the card that renders this machine comes with
// a later wave. This file is the pure half a test can stand on.

// The two doors the room lends the share card, plus where the log lives so the token can be
// spelled as an address. Passed as a value for the same reason the finish screen takes `onDiscard`
// rather than the store: a screen that holds the store can write to the log in ways its own copy
// does not describe. Unlike the iOS twin the doors take the session id, so the room builds one
// value and every screen binds it to its own session.
class CoachDoors(
    val origin: String,
    val mint: suspend (String) -> GymResult<SessionShare>,
    val revoke: suspend (String) -> WriteFailure?,
)

object Coach {
    // The offer, and the sentence under it that is the same whether the door has never been opened
    // or the log just refused to open it. Said before anything is minted, so it names no expiry date
    // — there is no share yet and therefore no day to name.
    const val offer = "A link to this one workout — every set, load and rep in it, and nothing " +
        "else about your account. Anyone who has the link can read it. It expires, and you can " +
        "revoke it whenever you like."

    data class Card(
        val title: String,
        val body: String,
        val link: String?,
        val action: String,
        val revoke: String?,
        val note: String?,        // the log's own words, when a door did not open
    )

    // Four states, and `note` rides on the two that can carry a refusal: a mint that failed leaves
    // the card closed WITH a reason, and a revoke that failed leaves the link live WITH one — the
    // link is still out there and a card that said otherwise would be the lie that matters most here.
    sealed class State {
        data class Closed(val note: String? = null) : State()
        data object Working : State()
        data class Live(val share: SessionShare, val copied: Boolean = false, val note: String? = null) : State()
        data object Revoked : State()

        // The whole state machine, as one pure step. It is here rather than inside the screen because
        // the rule that matters most in it — A REVOKE THAT DID NOT HAPPEN LEAVES THE LINK LIVE — is
        // a decision about what a lifter is told about a capability that is still out there, and a
        // decision like that belongs somewhere a test can stand.
        fun after(event: Event): State = when (event) {
            Event.Asked -> Working
            is Event.Minted -> Live(share = event.share)
            is Event.MintFailed -> Closed(note = event.why)
            Event.Copied -> if (this is Live) copy(copied = true) else this
            Event.Revoked -> Revoked
            // The note is the news, so the copied flag goes back down with it: the button under a
            // failure reads "Copy link" again rather than claiming a clipboard state from before it.
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

    // The address the coach opens, and it is the server's to compose rather than ours. This phone
    // knows where the API answers; it does not know where the browser app is served, and the two are
    // one host in production — which is exactly how iOS shipped pointing at `/v1/gym/shared/…`, the
    // JSON route, so a coach tapping a link from a phone was handed a page of JSON.
    //
    // The fallback is the reader page's own route and never the API's, so the worst case against an
    // older backend is a link built from the wrong host rather than one that opens the wrong thing.
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
