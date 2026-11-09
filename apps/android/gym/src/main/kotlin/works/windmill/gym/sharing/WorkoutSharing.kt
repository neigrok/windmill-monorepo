package works.windmill.gym.sharing

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import works.windmill.gym.R
import works.windmill.gym.presentation.Readout
import works.windmill.platform.i18n.Words
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
    val shareFailureNote = Words.Message(R.string.gym_sharing_unavailable)

    data class Card(
        val title: Words,
        val body: Words,
        val link: String?,
        val action: Words,
        val share: Words?,
        val revoke: Words?,
        val note: Words?,
    )

    sealed class State {
        data class Closed(val note: Words? = null) : State()
        data object Working : State()
        data class Live(val share: SessionShare, val copied: Boolean = false, val note: Words? = null) : State()
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
        data class MintFailed(val why: Words) : Event()
        data object Copied : Event()
        data class ShareFailed(val why: Words) : Event()
        data object Shared : Event()
        data object Revoked : Event()
        data class RevokeFailed(val why: Words) : Event()
    }

    fun link(share: SessionShare, base: String): String {
        val sent = share.url
        if (!sent.isNullOrEmpty()) return sent
        return "${base.removeSuffix("/")}/#/gym/shared/${share.token}"
    }

    fun card(state: State, base: String): Card = when (state) {
        is State.Closed ->
            Card(title = Words.Message(R.string.gym_sharing_offer_title), body = Words.Message(R.string.gym_sharing_offer), link = null,
                 action = Words.Message(if (state.note == null) R.string.gym_sharing_get_link else R.string.gym_sharing_try_again), share = null, revoke = null, note = state.note)
        State.Working ->
            Card(title = Words.Message(R.string.gym_sharing_offer_title), body = Words.Message(R.string.gym_sharing_offer), link = null,
                 action = Words.Message(R.string.gym_sharing_working), share = null, revoke = null, note = null)
        is State.Live ->
            Card(
                title = Words.Message(R.string.gym_sharing_live_title),
                body = Words.Message(R.string.gym_sharing_live_body, listOf(Readout.day(state.share.expiresAtMs))),
                link = link(state.share, base),
                action = Words.Message(if (state.copied) R.string.gym_sharing_copied else R.string.gym_sharing_copy_link),
                share = Words.Message(R.string.gym_sharing_share),
                revoke = Words.Message(R.string.gym_sharing_revoke),
                note = state.note)
        State.Revoked ->
            Card(title = Words.Message(R.string.gym_sharing_dead_title),
                 body = Words.Message(R.string.gym_sharing_dead_body),
                 link = null, action = Words.Message(R.string.gym_sharing_get_link), share = null, revoke = null, note = null)
    }
}
