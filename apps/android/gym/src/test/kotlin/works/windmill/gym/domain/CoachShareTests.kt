package works.windmill.gym.domain

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CoachShareTests {
    private val base = "https://windmill.works"
    private val share = SessionShare(token = "abc123", expiresAtMs = 1_756_992_000_000)
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun testTheLinkIsTheReaderPageAndNotTheApiRoute() {
        assertEquals("https://windmill.works/#/gym/shared/abc123",
                     Coach.link(SessionShare(token = "abc123", expiresAtMs = 0), base))
        assertEquals("http://127.0.0.1:8080/#/gym/shared/abc123",
                     Coach.link(SessionShare(token = "abc123", expiresAtMs = 0), "http://127.0.0.1:8080/"))
    }

    @Test
    fun testTheClosedCardOffersTheLinkAndNamesTheThreeThingsThatAreTrueOfIt() {
        val card = Coach.card(Coach.State.Closed(), base)

        assertEquals("the share never carries the word coach: that names the room", "Share this workout", card.title)
        assertEquals(Coach.offer, card.body)
        assertNull(card.link)
        assertEquals("Get a link", card.action)
        assertNull(card.revoke)
        assertNull(card.note)
        assertTrue(Coach.offer.contains("Anyone who has the link can read it"))
        assertTrue(Coach.offer.contains("It expires"))
        assertTrue(Coach.offer.contains("revoke it whenever you like"))
        assertTrue(Coach.offer.contains("nothing else about your account"))
    }

    @Test
    fun testAMintThatFailedKeepsTheOfferAndRepeatsWhatTheLogSaid() {
        val card = Coach.card(Coach.State.Closed(note = "no such session"), base)

        assertEquals("Share this workout", card.title)
        assertEquals(Coach.offer, card.body)
        assertEquals("Try again", card.action)
        assertEquals("no such session", card.note)
        assertNull(card.link)
    }

    @Test
    fun testTheLinkIsTheOneTheServerSentAndTheFallbackIsNeverTheJsonRoute() {
        val sent = SessionShare(token = "abc123", expiresAtMs = 0,
                                url = "https://windmill.works/#/gym/shared/abc123")
        assertEquals("https://windmill.works/#/gym/shared/abc123",
                     Coach.link(sent, "https://api.example.com"))

        val old = SessionShare(token = "abc123", expiresAtMs = 0)
        val fallback = Coach.link(old, base)
        assertFalse(fallback.contains("/v1/"))
        assertTrue(fallback.endsWith("/#/gym/shared/abc123"))
    }

    @Test
    fun testTheLiveCardShowsTheAddressAndTheServersOwnExpiry() {
        val card = Coach.card(Coach.State.Live(share = share), base)

        assertEquals("The link is live", card.title)
        assertEquals("Anyone who has this link can read this one workout. It stops "
                     + "working on ${Readout.day(share.expiresAtMs)}, and revoking it kills it immediately.",
                     card.body)
        assertEquals("https://windmill.works/#/gym/shared/abc123", card.link)
        assertEquals("Copy link", card.action)
        assertEquals("Revoke the link", card.revoke)
        assertNull(card.note)
    }

    @Test
    fun testCopyingSaysSoAndChangesNothingElseAboutTheCard() {
        val copied = Coach.State.Live(share = share).after(Coach.Event.Copied)
        val card = Coach.card(copied, base)

        assertEquals(Coach.State.Live(share = share, copied = true), copied)
        assertEquals("Copied", card.action)
        assertEquals("https://windmill.works/#/gym/shared/abc123", card.link)
        assertEquals("Revoke the link", card.revoke)
    }

    @Test
    fun testARevokedLinkIsDeadInPlainWordsAndTheDoorReopens() {
        val card = Coach.card(Coach.State.Revoked, base)

        assertEquals("The link is dead", card.title)
        assertEquals("Anyone still holding it gets nothing. You can make a new one whenever you like.",
                     card.body)
        assertNull(card.link)
        assertEquals("Get a new link", card.action)
        assertNull(card.revoke)
    }

    @Test
    fun testWaitingOnTheLogOffersNothingToTapTwice() {
        val card = Coach.card(Coach.State.Working, base)

        assertEquals("…", card.action)
        assertNull(card.link)
        assertNull(card.revoke)
    }

    @Test
    fun testARevokeThatFailedLeavesTheLinkLiveAndSaysWhy() {
        val live = Coach.State.Live(share = share, copied = true)
        val after = live.after(Coach.Event.RevokeFailed("the log didn’t answer — the link is still live"))
        val card = Coach.card(after, base)

        assertEquals(Coach.State.Live(share = share, copied = false,
                                      note = "the log didn’t answer — the link is still live"),
                     after)
        assertEquals("The link is live", card.title)
        assertEquals("https://windmill.works/#/gym/shared/abc123", card.link)
        assertEquals("the log didn’t answer — the link is still live", card.note)
        assertEquals("the door stays open — it is still revocable", "Revoke the link", card.revoke)
        assertEquals("the note is the news, so the clipboard claim goes", "Copy link", card.action)
    }

    @Test
    fun testTheStateMachineOnlyGoesLiveOnTheLogsOwnAnswer() {
        assertEquals(Coach.State.Working, Coach.State.Closed().after(Coach.Event.Asked))
        assertEquals(Coach.State.Live(share = share),
                     Coach.State.Working.after(Coach.Event.Minted(share)))
        assertEquals(Coach.State.Closed(note = "no such session"),
                     Coach.State.Working.after(Coach.Event.MintFailed("no such session")))
        assertEquals(Coach.State.Revoked, Coach.State.Working.after(Coach.Event.Revoked))
        assertEquals("there is nothing to copy before a link exists",
                     Coach.State.Closed(), Coach.State.Closed().after(Coach.Event.Copied))
        assertEquals("a revoke cannot fail on a link that is already dead",
                     Coach.State.Revoked, Coach.State.Revoked.after(Coach.Event.RevokeFailed("gone")))
    }

    @Test
    fun testTheMintedShareDecodesOffTheWire() {
        val decoded = json.decodeFromString(
            SessionShare.serializer(), """{"token":"abc123","expiresAt":1756992000000}""")

        assertEquals(share, decoded)
    }
}
