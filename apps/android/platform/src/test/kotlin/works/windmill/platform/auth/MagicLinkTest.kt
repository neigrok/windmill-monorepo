package works.windmill.platform.auth

import java.io.IOException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.i18n.Words
import org.robolectric.annotation.Config
import org.robolectric.RuntimeEnvironment
import org.robolectric.RobolectricTestRunner
import org.junit.runner.RunWith

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MagicLinkTest {
    @Test fun onlyLinkSyntaxSelectsTheLinkDoor() {
        for ((entry, expected) in listOf(
            "https://windmill.works/#/auth?token=abc" to true,
            "https://windmill.works/#/auth" to true,
            "token=abc" to true,
            "123456" to false,
            "12345" to false,
            "abc123" to false,
            "1234567" to false,
        )) assertEquals(entry, expected, MagicLink.looksLikeLink(entry))
    }

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

    @Test fun everyFailureKeepsItsOwnWordsWithoutInventingExpiry() {
        for ((failure, expected) in listOf(
            WindmillApiException.Offline to "Can’t reach windmill.works",
            WindmillApiException.Timeout(IOException()) to "That took too long. Try again.",
            WindmillApiException.Transport(IOException()) to "That connection was interrupted. Try again.",
            WindmillApiException.Malformed to "That didn’t go through",
            WindmillApiException.Unexpected(IllegalStateException()) to "That didn’t go through",
            WindmillApiException.Refused(401, Refusal()) to "That didn’t go through",
            WindmillApiException.Refused(410, Refusal("  ", "\n")) to "That didn’t go through",
            WindmillApiException.Refused(500, Refusal()) to "That didn’t go through",
            MagicLink.unreadable to "That code didn't work. Check the digits, or send a fresh one.",
        )) {
            val line = MagicLink.refused(failure).spelled()
            assertEquals(expected, line)
            assertFalse(line.contains("expired"))
        }
    }

    @Test fun serverRefusalsJoinTheirWordsWithoutInventingExpiry() {
        for ((refusal, expected) in listOf(
            Refusal("That code didn't work", "Check the digits, or send a fresh one.") to
                "That code didn't work. Check the digits, or send a fresh one.",
            Refusal("That code didn't work.", "Check the digits.") to "That code didn't work. Check the digits.",
            Refusal("Try again!", "Check the digits.") to "Try again! Check the digits.",
            Refusal("  Check the digits.  ") to "Check the digits.",
            Refusal(detail = "  Send a fresh one.  ") to "Send a fresh one.",
        )) {
            assertEquals(expected, MagicLink.refused(WindmillApiException.Refused(410, refusal)).spelled())
        }
        assertEquals("That link didn't work. Send a fresh one.", MagicLink.refused(
            WindmillApiException.Refused(410, Refusal("That link didn't work", "Send a fresh one."))).spelled())
        assertEquals("Update Windmill to keep syncing. Your work is saved on this phone.", MagicLink.refused(
            WindmillApiException.Refused(426, Refusal("Do not show this", "Or this"))).spelled())
    }

}

// The words as English spells them.
private fun Words.spelled(): String = text(RuntimeEnvironment.getApplication())
