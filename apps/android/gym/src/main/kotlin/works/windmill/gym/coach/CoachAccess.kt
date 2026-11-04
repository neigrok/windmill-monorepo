package works.windmill.gym.coach

import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
import android.text.format.DateFormat
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.io.IOException
import kotlinx.coroutines.CancellationException
import works.windmill.gym.R
import works.windmill.gym.coach.onboarding.CoachOnboardingSeat
import works.windmill.gym.coach.turn.CoachRecovery
import works.windmill.gym.coach.turn.CoachTurnFault
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.ui.GymScreen
import works.windmill.gym.ui.YouSeat
import works.windmill.platform.LocalClientUpdateDestination
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationStorageFailure
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.open
import works.windmill.platform.telemetry.LocalTelemetry
import works.windmill.platform.telemetry.Telemetry
import works.windmill.gym.telemetry.coachAction

@Composable
fun CoachAccessStance(seat: String, onSignIn: () -> Unit, onThreads: (() -> Unit)? = null, bound: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    GymScreen(title = Ask.title, actions = {
        onThreads?.let { history -> IconButton(onClick = history, modifier = Modifier.size(48.dp)) {
            Icon(painterResource(R.drawable.gym_coach_history), "History", tint = colors.onSurface, modifier = Modifier.size(24.dp))
        } }
        YouSeat(seat)
    }) {
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).padding(vertical = if (bound) 20.dp else 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (bound) {
                Spacer(Modifier.weight(1f))
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Sign in to ask Coach.", style = GymType.coachAccessTitle, color = colors.onSurface)
                    Text("Your earlier chats stay on this phone.", style = GymType.coachAccessLine, color = colors.onSurfaceVariant)
                }
            } else {
                Spacer(Modifier.weight(1f))
                Text(Ask.accessNeedsSignIn, style = GymType.coachAccessNote, color = colors.onSurfaceVariant,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.weight(1f))
            }
            CoachAction("Sign in", onSignIn, primary = true)
        }
    }
}

@Composable
fun AskAbsentStance(seat: String, onThreads: (() -> Unit)? = null) {
    val colors = MaterialTheme.colorScheme
    GymScreen(title = Ask.title, actions = {
        onThreads?.let { history -> IconButton(onClick = history, modifier = Modifier.size(48.dp)) {
            Icon(painterResource(R.drawable.gym_coach_history), "History", tint = colors.onSurface, modifier = Modifier.size(24.dp))
        } }
        YouSeat(seat)
    }) {
        Column(Modifier.fillMaxSize().padding(horizontal = 40.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)) {
            Icon(painterResource(R.drawable.gym_coach_error), null, tint = colors.onSurfaceVariant, modifier = Modifier.size(32.dp))
            Text(Ask.notHere, style = GymType.coachElsewhere, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

// What a refused send says at the conversation's end: its words, and the one door that exists. A door opening the update says when it could not.
@Composable
internal fun CoachRefusalNotice(refusal: CoachTurnRefusal, anonymous: Boolean = false, onSignIn: (() -> Unit)? = null, onConnections: () -> Unit, onTryAgain: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    val update = LocalClientUpdateDestination.current
    val uri = LocalUriHandler.current
    var updateFailure by rememberSaveable(refusal) { mutableStateOf<String?>(null) }
    if (refusal is CoachTurnRefusal.TooLong) LaunchedEffect(Unit) {
        telemetry.coachAction("too_long", "shown")
    }
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(refusal.notice(anonymous, DateFormat.is24HourFormat(LocalContext.current)), style = GymType.coachSupporting, color = colors.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 300.dp))
        when (refusal.recovery(anonymous)) {
            CoachRecovery.signIn -> if (onSignIn != null) {
                if (refusal is CoachTurnRefusal.Installation) NoticeDoor("Sign in", onSignIn)
                else FilledTonalButton(onClick = onSignIn,
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = colors.surfaceContainerHighest, contentColor = colors.onSurface),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
                    Text("Sign in", style = GymType.coachAction)
                }
            }
            CoachRecovery.ownAgent -> NoticeDoor("Use your own AI agent", onConnections)
            CoachRecovery.tryAgain -> NoticeDoor("Try again", onTryAgain)
            CoachRecovery.update -> NoticeDoor(update.label) { updateFailure = update.open(uri::openUri, telemetry) }
            null -> Unit
        }
        updateFailure?.let { Text(it, style = GymType.coachSupporting, color = colors.error, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 300.dp)) }
    }
}

@Composable
private fun NoticeDoor(title: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
        Text(title, style = GymType.coachAction, color = MaterialTheme.colorScheme.primary)
    }
}

// A send the account's change stopped: in the middle of a conversation that holds nothing, otherwise at its end.
@Composable
internal fun CoachAccountChanging(alone: Boolean, modifier: Modifier = Modifier) {
    val telemetry = LocalTelemetry.current
    LaunchedEffect(Unit) { telemetry.coachAction("account_changing", "shown") }
    Text(CoachTurnFault.accountChanging.sentence, style = if (alone) GymType.coachAccessNote else GymType.coachSupporting, color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center, modifier = modifier.fillMaxWidth().padding(horizontal = if (alone) 32.dp else 0.dp, vertical = 8.dp))
}

// A fresh chat while another chat's answer runs: Send waits for it, and this opens it.
@Composable
internal fun AnswerInProgress(pending: ConversationRow, onOpenChat: ((String) -> Unit)?) {
    val colors = MaterialTheme.colorScheme
    val telemetry = LocalTelemetry.current
    LaunchedEffect(Unit) { telemetry.coachAction("answer_in_progress", "shown") }
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Answer in progress", style = GymType.coachTitle, color = colors.onSurface)
            Text(pending.title, style = GymType.coachSupporting, color = colors.onSurfaceVariant)
        }
        onOpenChat?.let { open -> NoticeDoor("View chat") { open(pending.id) } }
    }
}

enum class AnonymousCoachAccess { Checking, Available, Bound, Unavailable }

// Whether this phone can ask Coach signed out: it reads the installation, and the seat it asked for must still stand when the answer comes.
suspend fun anonymousCoachAccess(installation: AiInstallation, seat: () -> CoachOnboardingSeat?, telemetry: Telemetry): AnonymousCoachAccess {
    val origin = seat() ?: return AnonymousCoachAccess.Unavailable
    return try {
        installation.forAnonymousSend()
        if (seat() == origin) AnonymousCoachAccess.Available else AnonymousCoachAccess.Unavailable
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: WindmillApiException.Refused) {
        if (seat() == origin && failure.refusal.code in setOf("device_bound", "installation_bound")) AnonymousCoachAccess.Bound
        else AnonymousCoachAccess.Unavailable
    } catch (_: WindmillApiException) {
        AnonymousCoachAccess.Unavailable
    } catch (failure: Exception) {
        if (failure !is AiInstallationStorageFailure) telemetry.failure("gym.coachAccess", IOException("The installation could not be read."))
        AnonymousCoachAccess.Unavailable
    }
}
