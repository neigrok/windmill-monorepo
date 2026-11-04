package works.windmill.gym.coach

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.gym.coach.onboarding.CoachOnboardingSeat
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.coach.turn.ScriptedInstallation
import works.windmill.gym.coach.turn.TellingRecorder
import works.windmill.gym.coach.turn.TurnPhoneInstallation
import works.windmill.platform.ai.AiInstallationApi
import works.windmill.platform.ai.AiInstallationResponse
import works.windmill.platform.net.Refusal
import works.windmill.platform.net.WindmillApiException
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
