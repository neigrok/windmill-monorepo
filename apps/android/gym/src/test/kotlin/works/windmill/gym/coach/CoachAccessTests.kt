package works.windmill.gym.coach

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.agent.TurnRefusal
import works.windmill.gym.coach.onboarding.CoachOnboardingSeat
import works.windmill.gym.coach.turn.CoachRecovery
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.ScriptedInstallation
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.coach.turn.TurnPhoneInstallation
import works.windmill.platform.ClientUpdateDestination
import works.windmill.platform.LocalClientUpdateDestination
import works.windmill.platform.ai.AiInstallationApi
import works.windmill.platform.ai.AiInstallationResponse
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry

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

    @Test fun aSpentAllowanceAsksASignedOutPhoneToSignInAndOffersASignedInOneNothing() {
        var anonymous by mutableStateOf(true)
        var signIns = 0
        compose.setContent { CoachRefusalNotice(CoachTurnRefusal.Allowance("subject_exhausted"), anonymous, { signIns++ }, {}, {}) }
        compose.onNodeWithText("You have used all of your AI allowance.\nSign in to continue.").assertIsDisplayed()
        compose.onNodeWithText("Sign in").performClick()
        compose.runOnIdle { assertEquals(1, signIns); anonymous = false }
        compose.onNodeWithText("You have used all of your AI allowance.").assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertDoesNotExist()
    }

    @Test fun theSharedPoolPausedOffersTheLiftersOwnAgentAndATransportLossOffersTryAgain() {
        var refusal by mutableStateOf<CoachTurnRefusal>(CoachTurnRefusal.FreeMonthExhausted(null))
        val actions = mutableListOf<String>()
        compose.setContent { CoachRefusalNotice(refusal, anonymous = true, onSignIn = { actions += "signIn" }, onConnections = { actions += "connections" }, onTryAgain = { actions += "again" }) }
        compose.onNodeWithText("Coach is paused for everyone this month.").assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertDoesNotExist()
        compose.onNodeWithText("Use your own AI agent").performClick()
        compose.runOnIdle { refusal = CoachTurnRefusal.Offline }
        compose.onNodeWithText("No connection. Your question is kept here.").assertIsDisplayed()
        compose.onNodeWithText("Try again").performClick()
        compose.runOnIdle { assertEquals(listOf("connections", "again"), actions) }
    }

    @Test fun everyRefusalSaysTheBoardsWordsWithTheBoardsOneDoor() {
        val utc = ZoneId.of("UTC")
        val monthTurns = LocalDate.of(2026, 11, 1).atStartOfDay(utc).toInstant().toEpochMilli()
        val dayTurns = LocalDateTime.of(2026, 11, 4, 3, 0).atZone(utc).toInstant().toEpochMilli()
        class Board(val refusal: CoachTurnRefusal, val anonymous: Boolean, val words: String, val door: CoachRecovery?)
        val own = CoachRecovery.ownAgent
        for (board in listOf(
            Board(CoachTurnRefusal.Offline, false, "No connection. Your question is kept here.", CoachRecovery.tryAgain),
            Board(CoachTurnRefusal.LogArriving, false, "Your log is still arriving on this phone. Ask again in a moment.", null),
            Board(CoachTurnRefusal.TooLong(1_400), false, "Too long by 1,400 bytes. The limit is 8,000 bytes.\nEnglish letters take 1 byte each. Other letters and emoji take more.", null),
            Board(CoachTurnRefusal.TooLong(1), false, "Too long by 1 byte. The limit is 8,000 bytes.\nEnglish letters take 1 byte each. Other letters and emoji take more.", null),
            Board(CoachTurnRefusal.of("invalid_installation"), true, "This phone can’t ask Coach signed out any more. Sign in to continue.", CoachRecovery.signIn),
            Board(CoachTurnRefusal.of("device_bound"), true, "This phone is linked to an account. Sign in to ask Coach.", CoachRecovery.signIn),
            Board(CoachTurnRefusal.of("free_month_exhausted", 429, monthTurns), false, "Coach is paused for everyone this month. It comes back on Nov 1.", own),
            Board(CoachTurnRefusal.of("free_month_exhausted", 429), false, "Coach is paused for everyone this month.", own),
            Board(CoachTurnRefusal.of("coach-update-required", 426), false, "This version can’t ask Coach any more. Update Windmill to continue.", CoachRecovery.update),
            Board(CoachTurnRefusal.of("free_day_exhausted", 429, dayTurns), false, "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.\nYou can use Coach again on Nov 4 at 3:00 AM.", own),
            Board(CoachTurnRefusal.of("free_day_exhausted", 429, dayTurns), true, "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.\nYou can use Coach again on Nov 4 at 3:00 AM.", own),
            Board(CoachTurnRefusal.of("free_day_exhausted", 429), false, "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.", own),
            Board(CoachTurnRefusal.of(TurnRefusal.rateLimited, 429), false, "You can ask again later.", own),
        )) {
            assertEquals(board.words, board.refusal.notice(board.anonymous, clock24 = false, zone = utc))
            assertEquals(board.words, board.door, board.refusal.recovery(board.anonymous))
        }
        assertEquals("Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.\nYou can use Coach again on Nov 4 at 3:00.",
            CoachTurnRefusal.of("free_day_exhausted", 429, dayTurns).notice(anonymous = false, clock24 = true, zone = utc))
    }

    @Test fun theUpdateDoorOpensTheUpdateAndSaysWhenItCouldNot() {
        val opened = mutableListOf<String>()
        val telling = TellingRecorder()
        var failing = false
        val handler = object : UriHandler {
            override fun openUri(uri: String) { if (failing) error("No browser"); opened += uri }
        }
        compose.setContent {
            CompositionLocalProvider(LocalClientUpdateDestination provides ClientUpdateDestination("https://windmill.works/android.apk", "Get the update"),
                LocalUriHandler provides handler, LocalTelemetry provides telling) {
                CoachRefusalNotice(CoachTurnRefusal.UpdateRequired, onConnections = {}, onTryAgain = {})
            }
        }
        compose.onNodeWithText("This version can’t ask Coach any more. Update Windmill to continue.").assertIsDisplayed()
        compose.onNodeWithText("Get the update").performClick()
        compose.runOnIdle { assertEquals(listOf("https://windmill.works/android.apk"), opened); failing = true }
        compose.onNodeWithText("Get the update").performClick()
        compose.onNodeWithText("The link could not be opened. Try again, or open Windmill’s website in your browser.").assertIsDisplayed()
        assertEquals(listOf(mapOf("action" to "update"), mapOf("action" to "update"), mapOf("action" to "update", "outcome" to "failed")), telling.named("client_update_required"))
        assertEquals(emptyList<Map<String, String>>(), telling.failures)
    }

    @Test fun aLinkedPhonesSignInIsTheBoardsTextDoorAndASignedInPhoneHasNone() {
        var anonymous by mutableStateOf(true)
        var signIns = 0
        compose.setContent { CoachRefusalNotice(CoachTurnRefusal.Installation("device_bound"), anonymous, { signIns++ }, {}, {}) }
        compose.onNodeWithText("This phone is linked to an account. Sign in to ask Coach.").assertIsDisplayed()
        compose.onNodeWithText("Sign in").performClick()
        compose.runOnIdle { assertEquals(1, signIns); anonymous = false }
        compose.onNodeWithText("Sign in").assertDoesNotExist()
    }

    @Test fun aQuestionPastItsBoundTellsOnceThatItWasShown() {
        val telling = TellingRecorder()
        var refusal by mutableStateOf<CoachTurnRefusal>(CoachTurnRefusal.TooLong(1_400))
        compose.setContent {
            CompositionLocalProvider(LocalTelemetry provides telling) { CoachRefusalNotice(refusal, onConnections = {}, onTryAgain = {}) }
        }
        compose.onNodeWithText("Too long by 1,400 bytes.", substring = true).assertIsDisplayed()
        compose.runOnIdle { refusal = CoachTurnRefusal.TooLong(1_500) }
        compose.onNodeWithText("Too long by 1,500 bytes.", substring = true).assertIsDisplayed()
        assertEquals(listOf(mapOf("screen" to "coach", "action" to "too_long", "outcome" to "shown")), telling.named("gym_action"))
    }

    @Test fun anonymousAccessAnswersOnlyForTheSeatItAskedFor() = runBlocking {
        val telling = TellingRecorder()
        val seat = CoachOnboardingSeat("anonymous:phone", "replica")
        assertEquals(AnonymousCoachAccess.Available, anonymousCoachAccess(TurnPhoneInstallation.onMemory(), { seat }, telling))
        assertEquals(AnonymousCoachAccess.Unavailable, anonymousCoachAccess(TurnPhoneInstallation.onMemory(), { null }, telling))

        var standing: CoachOnboardingSeat? = seat
        val scripted = ScriptedInstallation()
        val replaced = TurnPhoneInstallation.onMemory(object : AiInstallationApi by scripted {
            override suspend fun issue(): AiInstallationResponse = scripted.issue().also { standing = CoachOnboardingSeat("anonymous:phone", "another-replica") }
        })
        assertEquals("the seat it asked for is gone", AnonymousCoachAccess.Unavailable, anonymousCoachAccess(replaced, { standing }, telling))

        val bound = TurnPhoneInstallation.onMemory()
        bound.forAnonymousSend()
        bound.markBound()
        assertEquals(AnonymousCoachAccess.Bound, anonymousCoachAccess(bound, { seat }, telling))

        val declined = TurnPhoneInstallation.onMemory(ScriptedInstallation().apply { issueFailure = WindmillApiException.Refused(503, Refusal(code = "anonymous_ai_unavailable")) })
        assertEquals(AnonymousCoachAccess.Unavailable, anonymousCoachAccess(declined, { seat }, telling))
        assertEquals(emptyList<Map<String, String>>(), telling.failures)
    }

    @Test fun anAccessFailureReportsOnceWithAStaticMessage() = runBlocking {
        val reported = mutableListOf<Pair<String, String?>>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) = Unit
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { reported += operation to error.message }
        }
        val scripted = ScriptedInstallation()
        val broken = TurnPhoneInstallation.onMemory(object : AiInstallationApi by scripted {
            override suspend fun issue(): AiInstallationResponse = error("private detail")
        })
        assertEquals(AnonymousCoachAccess.Unavailable, anonymousCoachAccess(broken, { CoachOnboardingSeat("anonymous:phone", "replica") }, telemetry))
        assertEquals(listOf("gym.coachAccess" to "The installation could not be read."), reported)
    }
}
