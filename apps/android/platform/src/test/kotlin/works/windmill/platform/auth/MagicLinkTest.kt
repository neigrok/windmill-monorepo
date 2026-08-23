package works.windmill.platform.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MagicLinkTest {
    @Test
    fun theEmailedLinkYieldsItsToken() {
        assertEquals("abc123", MagicLink.token("https://windmill.works/#/auth?token=abc123"))
    }

    @Test
    fun aBareTokenIsTheToken() {
        assertEquals("abc123", MagicLink.token("abc123"))
    }

    @Test
    fun aPaddedBareTokenIsTrimmed() {
        assertEquals("abc123", MagicLink.token("  abc123\n"))
    }

    @Test
    fun aTrackingWrappedLinkStillYieldsTheToken() {
        assertEquals("tok", MagicLink.token("https://mail.example/open?utm=1&token=tok&next=2"))
    }

    @Test
    fun anAmpersandEndsTheToken() {
        assertEquals("abc", MagicLink.token("token=abc&sig=zzz"))
    }

    @Test
    fun aFragmentEndsTheToken() {
        assertEquals("abc", MagicLink.token("token=abc#rest"))
    }

    @Test
    fun whitespaceEndsTheToken() {
        assertEquals("abc", MagicLink.token("token=abc def"))
    }

    @Test
    fun aUrlCarryingNoTokenIsUnreadable() {
        assertNull(MagicLink.token("https://windmill.works/#/auth"))
    }

    @Test
    fun anEmptyTokenValueIsUnreadable() {
        assertNull(MagicLink.token("token="))
    }

    @Test
    fun anEmptyPasteIsUnreadable() {
        assertNull(MagicLink.token("   "))
    }

    @Test
    fun onlyAnOfflineFailureEscapesTheExpiredSentence() {
        assertEquals("Can't reach windmill.works", MagicLink.refusal(works.windmill.platform.net.WindmillApiException.Offline))
        assertEquals(MagicLink.expired, MagicLink.refusal(MagicLink.unreadable))
        assertEquals(MagicLink.expired, MagicLink.refusal(IllegalStateException("anything else")))
    }

    @Test
    fun aCodeFailureGetsTheCodeSentence() {
        assertEquals(MagicLink.expiredCode, MagicLink.refusal(MagicLink.unreadable, ofCode = true))
        assertEquals(
            "That code has expired. Codes work once and last 15 minutes — send a fresh one.",
            MagicLink.expiredCode,
        )
        assertEquals(
            "Can't reach windmill.works",
            MagicLink.refusal(works.windmill.platform.net.WindmillApiException.Offline, ofCode = true),
        )
    }
}
