package works.windmill.gym.coach

import works.windmill.gym.ui.GymType
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.io.IOException
import kotlinx.coroutines.CancellationException
import works.windmill.gym.R
import works.windmill.gym.coach.onboarding.CoachOnboardingSeat
import works.windmill.gym.coach.turn.CoachRecovery
import works.windmill.gym.coach.turn.CoachTurnRefusal
import works.windmill.gym.ui.GymScreen
import works.windmill.gym.ui.YouSeat
import works.windmill.platform.ai.AiInstallation
import works.windmill.platform.ai.AiInstallationStorageFailure
import works.windmill.platform.net.WindmillApiException
import works.windmill.platform.telemetry.Telemetry

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

// What a refused send says at the conversation's end: its sentence, and the one door that exists.
@Composable
internal fun CoachRefusalNotice(refusal: CoachTurnRefusal, anonymous: Boolean = false, onSignIn: (() -> Unit)? = null, onConnections: () -> Unit, onTryAgain: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val recovery = refusal.recovery(anonymous)
    val notice = refusal.sentence + if (refusal is CoachTurnRefusal.Allowance && recovery == CoachRecovery.signIn) "\nSign in to continue." else ""
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(notice, style = GymType.coachSupporting, color = colors.onSurfaceVariant, textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp))
        when (recovery) {
            CoachRecovery.signIn -> if (onSignIn != null) FilledTonalButton(onClick = onSignIn,
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = colors.surfaceContainerHighest, contentColor = colors.onSurface),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
                Text(recovery.title, style = GymType.coachAction)
            }
            CoachRecovery.ownAgent -> TextButton(onClick = onConnections, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(recovery.title, style = GymType.coachStrong, color = colors.primary)
            }
            CoachRecovery.tryAgain -> TextButton(onClick = onTryAgain, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(recovery.title, style = GymType.coachStrong, color = colors.primary)
            }
            CoachRecovery.update, null -> Unit
        }
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
