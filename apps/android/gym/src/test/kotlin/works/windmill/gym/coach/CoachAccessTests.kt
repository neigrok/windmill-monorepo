package works.windmill.gym.coach

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")
class CoachAccessTests {
    @get:Rule val compose = createComposeRule()

    @Test fun noSeatHasCenteredCurrentCopyAndOnlyTheExistingSignInDoor() {
        var signIns = 0
        compose.setContent { CoachAccessStance("•", { signIns++ }) }
        compose.onNodeWithText(Ask.accessNeedsSignIn).assertIsDisplayed()
        compose.onNodeWithContentDescription("History").assertDoesNotExist()
        compose.onNodeWithContentDescription("Question").assertDoesNotExist()
        compose.onNodeWithText("Sign in").performClick()
        compose.runOnIdle { assertEquals(1, signIns) }
    }

    @Test fun boundPhoneKeepsHistoryAndExplainsItsLocalArchiveWithoutAComposer() {
        val actions = mutableListOf<String>()
        compose.setContent { CoachAccessStance("•", { actions += "signIn" }, { actions += "history" }, bound = true) }
        compose.onNodeWithText("Sign in to ask Coach.").assertIsDisplayed()
        compose.onNodeWithText("Your earlier chats stay on this phone.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Question").assertDoesNotExist()
        compose.onNodeWithContentDescription("History").performClick()
        compose.onNodeWithText("Sign in").performClick()
        compose.runOnIdle { assertEquals(listOf("history", "signIn"), actions) }
    }

    @Test fun absentCoachKeepsHistoryAndHasNeitherNotesNorConnectionDoor() {
        var history = 0
        compose.setContent { AskAbsentStance("A", { history++ }) }
        compose.onNodeWithText(Ask.notHere).assertIsDisplayed()
        compose.onNodeWithText("Notes").assertDoesNotExist()
        compose.onNodeWithText("Connected log").assertDoesNotExist()
        compose.onNodeWithContentDescription("Question").assertDoesNotExist()
        compose.onNodeWithContentDescription("History").performClick()
        compose.runOnIdle { assertEquals(1, history) }
    }

    @Test fun allowanceNoticeUsesTheActualResetInTheCurrentLocaleAndZoneOnlyWhenPresent() {
        val at = Instant.parse("2026-11-01T00:00:00Z").toEpochMilli()
        assertEquals("You have used all of your AI allowance.\nSign in to continue.",
            coachAllowanceNotice(true, at, Locale.UK, ZoneId.of("UTC")))
        assertEquals(AskCap.Allowance.wordless, coachAllowanceNotice(false, null, Locale.UK, ZoneId.of("UTC")))
        assertEquals(AskCap.Allowance.wordless, coachAllowanceNotice(false, 0, Locale.UK, ZoneId.of("UTC")))
        assertEquals("You have used all of your AI allowance.\nYou can use Coach again on 1 Nov 2026, 00:00.",
            coachAllowanceNotice(false, at, Locale.UK, ZoneId.of("UTC")))
        assertEquals("You have used all of your AI allowance.\nYou can use Coach again on 31 Oct 2026, 20:00.",
            coachAllowanceNotice(false, at, Locale.UK, ZoneId.of("America/New_York")))
        assertNotEquals(coachAllowanceNotice(false, at, Locale.UK, ZoneId.of("UTC")),
            coachAllowanceNotice(false, at, Locale.FRANCE, ZoneId.of("UTC")))
    }

    @Test fun persistedDeadlineIsRecomputedForTheClockLocaleAndZoneWithoutInventedTiming() {
        val deadline = Instant.parse("2026-10-29T09:00:00Z").toEpochMilli()
        val utc = ZoneId.of("UTC")
        assertEquals(Ask.capReached, coachDailyNotice(null, deadline - 1, Locale.UK, utc))
        assertEquals(Ask.capReached, coachDailyNotice(-1, deadline - 1, Locale.UK, utc))
        assertEquals("You can ask again on 29 Oct 2026, 09:00.", coachDailyNotice(deadline, deadline - 1, Locale.UK, utc))
        assertEquals("You can ask again on 29 Oct 2026, 05:00.", coachDailyNotice(deadline, deadline - 1, Locale.UK, ZoneId.of("America/New_York")))
        assertNotEquals(coachDailyNotice(deadline, deadline - 1, Locale.UK, utc), coachDailyNotice(deadline, deadline - 1, Locale.FRANCE, utc))
        assertNull(coachDailyNotice(deadline, deadline, Locale.UK, utc))
        assertNull(coachDailyNotice(deadline, deadline + 1, Locale.UK, utc))
    }
}
