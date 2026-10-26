package works.windmill.platform.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException

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
    fun absentServerWordsKeepTheExpiredFallbackAndOfflineHasItsOwnLine() {
        assertEquals("Can’t reach windmill.works", MagicLink.refusal(WindmillApiException.Offline))
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
            "Can’t reach windmill.works",
            MagicLink.refusal(WindmillApiException.Offline, ofCode = true),
        )
    }

    @Test fun serverRefusalsJoinTheirWordsWithoutInventingExpiry() {
        for ((refusal, expected) in listOf(
            Refusal("That code didn't work", "Check the digits, or send a fresh one.") to
                "That code didn't work. Check the digits, or send a fresh one.",
            Refusal("That code didn't work.", "Check the digits.") to "That code didn't work. Check the digits.",
            Refusal("Try again!", "Check the digits.") to "Try again! Check the digits.",
            Refusal("  Check the digits.  ") to "Check the digits.",
            Refusal(detail = "  Send a fresh one.  ") to "Send a fresh one.",
            Refusal("  ", "\n") to MagicLink.expiredCode,
        )) {
            assertEquals(expected, MagicLink.refusal(WindmillApiException.Refused(410, refusal), ofCode = true))
        }
        assertEquals("That link didn't work. Send a fresh one.", MagicLink.refusal(
            WindmillApiException.Refused(410, Refusal("That link didn't work", "Send a fresh one."))))
        assertEquals("Update Windmill to keep syncing. Your work is saved on this phone.", MagicLink.refusal(
            WindmillApiException.Refused(426, Refusal("Do not show this", "Or this")), ofCode = true))
    }

}
