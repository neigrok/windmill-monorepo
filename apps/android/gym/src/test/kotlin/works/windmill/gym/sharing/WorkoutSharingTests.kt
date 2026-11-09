package works.windmill.gym.sharing

import org.robolectric.annotation.Config
import org.robolectric.RobolectricTestRunner
import org.junit.runner.RunWith
import works.windmill.gym.spelled
import works.windmill.gym.string
import works.windmill.platform.i18n.Words
import works.windmill.gym.R
import works.windmill.gym.presentation.Readout
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WorkoutSharingTests {
    private val base = "https://windmill.works"
    private val share = SessionShare(token = "abc123", expiresAtMs = 1_756_992_000_000)
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun testTheLinkIsTheReaderPageAndNotTheApiRoute() {
        assertEquals("https://windmill.works/#/gym/shared/abc123",
                     WorkoutSharing.link(SessionShare(token = "abc123", expiresAtMs = 0), base))
        assertEquals("http://127.0.0.1:8080/#/gym/shared/abc123",
                     WorkoutSharing.link(SessionShare(token = "abc123", expiresAtMs = 0), "http://127.0.0.1:8080/"))
    }

    @Test
    fun testTheClosedCardOffersTheLinkAndNamesTheThreeThingsThatAreTrueOfIt() {
        val card = WorkoutSharing.card(WorkoutSharing.State.Closed(), base)

        assertEquals("the share never carries the word coach: that names the room", "Share this workout", card.title.spelled())
        assertEquals(string(R.string.gym_sharing_offer), card.body.spelled())
        assertNull(card.link)
        assertNull(card.share.spelled())
        assertEquals("Get a link", card.action.spelled())
        assertNull(card.revoke.spelled())
        assertNull(card.note.spelled())
        assertEquals("Anyone with the link can read this workout.\nIncludes set notes and effort.\nLinks last 30 days. End sharing anytime.", card.body.spelled())
    }

    @Test
    fun testAMintThatFailedKeepsTheOfferAndRepeatsWhatTheLogSaid() {
        val card = WorkoutSharing.card(WorkoutSharing.State.Closed(note = Words.Plain("no such session")), base)

        assertEquals("Share this workout", card.title.spelled())
        assertEquals(string(R.string.gym_sharing_offer), card.body.spelled())
        assertEquals("Try again", card.action.spelled())
        assertEquals("no such session", card.note.spelled())
        assertNull(card.link)
        assertNull(card.share.spelled())
    }

    @Test
    fun testTheLinkIsTheOneTheServerSentAndTheFallbackIsNeverTheJsonRoute() {
        val sent = SessionShare(token = "abc123", expiresAtMs = 0,
                                url = "https://windmill.works/#/gym/shared/abc123")
        assertEquals("https://windmill.works/#/gym/shared/abc123",
                     WorkoutSharing.link(sent, "https://api.example.com"))

        val old = SessionShare(token = "abc123", expiresAtMs = 0)
        val fallback = WorkoutSharing.link(old, base)
        assertFalse(fallback.contains("/v1/"))
        assertTrue(fallback.endsWith("/#/gym/shared/abc123"))
    }

    @Test
    fun testTheLiveCardShowsTheAddressAndTheServersOwnExpiry() {
        val card = WorkoutSharing.card(WorkoutSharing.State.Live(share = share), base)

        assertEquals("The link is live", card.title.spelled())
        assertEquals("Anyone who has this link can read this one workout. It stops "
                     + "working on ${Readout.day(share.expiresAtMs).spelled()}, and revoking it kills it immediately.",
                     card.body.spelled())
        assertEquals("https://windmill.works/#/gym/shared/abc123", card.link)
        assertEquals("Copy link", card.action.spelled())
        assertEquals("Share", card.share.spelled())
        assertEquals("Revoke the link", card.revoke.spelled())
        assertNull(card.note.spelled())
    }

    @Test
    fun testCopyingSaysSoAndChangesNothingElseAboutTheCard() {
        val copied = WorkoutSharing.State.Live(share = share).after(WorkoutSharing.Event.Copied)
        val card = WorkoutSharing.card(copied, base)

        assertEquals(WorkoutSharing.State.Live(share = share, copied = true), copied)
        assertEquals("Copied", card.action.spelled())
        assertEquals("https://windmill.works/#/gym/shared/abc123", card.link)
        assertEquals("Revoke the link", card.revoke.spelled())
    }

    @Test
    fun testARevokedLinkIsDeadInPlainWordsAndTheDoorReopens() {
        val card = WorkoutSharing.card(WorkoutSharing.State.Revoked, base)

        assertEquals("The link is dead", card.title.spelled())
        assertEquals("Anyone still holding it gets nothing. You can make a new one whenever you like.",
                     card.body.spelled())
        assertNull(card.link)
        assertNull(card.share.spelled())
        assertEquals("Get a link", card.action.spelled())
        assertNull(card.revoke.spelled())
    }

    @Test
    fun testWaitingOnTheLogOffersNothingToTapTwice() {
        val card = WorkoutSharing.card(WorkoutSharing.State.Working, base)

        assertEquals("…", card.action.spelled())
        assertNull(card.link)
        assertNull(card.share.spelled())
        assertNull(card.revoke.spelled())
    }

    @Test
    fun testARevokeThatFailedLeavesTheLinkLiveAndSaysWhy() {
        val live = WorkoutSharing.State.Live(share = share, copied = true)
        val after = live.after(WorkoutSharing.Event.RevokeFailed(Words.Plain("the log didn’t answer — the link is still live")))
        val card = WorkoutSharing.card(after, base)

        assertEquals(WorkoutSharing.State.Live(share = share, copied = false,
                                      note = Words.Plain("the log didn’t answer — the link is still live")),
                     after)
        assertEquals("The link is live", card.title.spelled())
        assertEquals("https://windmill.works/#/gym/shared/abc123", card.link)
        assertEquals("the log didn’t answer — the link is still live", card.note.spelled())
        assertEquals("the door stays open — it is still revocable", "Revoke the link", card.revoke.spelled())
        assertEquals("the note is the news, so the clipboard claim goes", "Copy link", card.action.spelled())
    }

    @Test
    fun testTheStateMachineOnlyGoesLiveOnTheLogsOwnAnswer() {
        assertEquals(WorkoutSharing.State.Working, WorkoutSharing.State.Closed().after(WorkoutSharing.Event.Asked))
        assertEquals(WorkoutSharing.State.Live(share = share),
                     WorkoutSharing.State.Working.after(WorkoutSharing.Event.Minted(share)))
        assertEquals(WorkoutSharing.State.Closed(note = Words.Plain("no such session")),
                     WorkoutSharing.State.Working.after(WorkoutSharing.Event.MintFailed(Words.Plain("no such session"))))
        assertEquals(WorkoutSharing.State.Revoked, WorkoutSharing.State.Working.after(WorkoutSharing.Event.Revoked))
        assertEquals("there is nothing to copy before a link exists",
                     WorkoutSharing.State.Closed(), WorkoutSharing.State.Closed().after(WorkoutSharing.Event.Copied))
        assertEquals("a revoke cannot fail on a link that is already dead",
                     WorkoutSharing.State.Revoked, WorkoutSharing.State.Revoked.after(WorkoutSharing.Event.RevokeFailed(Words.Plain("gone"))))
    }

    @Test fun sharingFailurePreservesTheLiveLinkAndCopyClaim() {
        val live = WorkoutSharing.State.Live(share, copied = true)
        val changed = live.after(WorkoutSharing.Event.ShareFailed(Words.Plain("unavailable")))
        assertEquals(live.copy(note = Words.Plain("unavailable")), changed)
        assertEquals(WorkoutSharing.card(live, base).copy(note = Words.Plain("unavailable")), WorkoutSharing.card(changed, base))
        for (state in listOf(WorkoutSharing.State.Closed(), WorkoutSharing.State.Closed(Words.Plain("failed")),
            WorkoutSharing.State.Working, WorkoutSharing.State.Revoked)) {
            assertEquals(state, state.after(WorkoutSharing.Event.ShareFailed(Words.Plain("unavailable"))))
            assertNull(WorkoutSharing.card(state, base).share)
        }
    }

    @Test fun sharingSuccessfullyClearsOnlyTheShareFailureAndPreservesTheCopyClaim() {
        for (copied in listOf(false, true)) {
            val live = WorkoutSharing.State.Live(share, copied = copied)
            assertEquals(live, live.after(WorkoutSharing.Event.Shared))
            val failed = live.after(WorkoutSharing.Event.ShareFailed(WorkoutSharing.shareFailureNote))
            assertEquals(live.copy(note = WorkoutSharing.shareFailureNote), failed)
            assertEquals(live, failed.after(WorkoutSharing.Event.Shared))
            val revokeFailed = live.copy(note = Words.Plain("the log didn’t answer — the link is still live"))
            assertEquals(revokeFailed, revokeFailed.after(WorkoutSharing.Event.Shared))
        }
        for (state in listOf(WorkoutSharing.State.Closed(), WorkoutSharing.State.Closed(Words.Plain("failed")),
            WorkoutSharing.State.Working, WorkoutSharing.State.Revoked)) {
            assertEquals(state, state.after(WorkoutSharing.Event.Shared))
        }
    }

    @Test
    fun testTheMintedShareDecodesOffTheWire() {
        val decoded = json.decodeFromString(
            SessionShare.serializer(), """{"token":"abc123","expiresAt":1756992000000}""")

        assertEquals(share, decoded)
    }
}
