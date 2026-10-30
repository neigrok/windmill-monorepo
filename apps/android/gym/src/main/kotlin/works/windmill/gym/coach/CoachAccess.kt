package works.windmill.gym.coach

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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlinx.coroutines.delay
import works.windmill.gym.R
import works.windmill.gym.ui.GymScreen
import works.windmill.gym.ui.LocalGymColors
import works.windmill.gym.ui.YouSeat

@Composable
fun CoachAccessStance(seat: String, onSignIn: () -> Unit, onThreads: (() -> Unit)? = null, bound: Boolean = false) {
    val skin = LocalGymColors.current
    GymScreen(title = Ask.title, actions = {
        onThreads?.let { history -> IconButton(onClick = history, modifier = Modifier.size(48.dp)) {
            Icon(painterResource(R.drawable.gym_coach_history), "History", tint = skin.ink, modifier = Modifier.size(24.dp))
        } }
        YouSeat(seat)
    }) {
        Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).padding(vertical = if (bound) 20.dp else 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (bound) {
                Spacer(Modifier.weight(1f))
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Sign in to ask Coach.", style = CoachType.body(22, FontWeight.ExtraBold).copy(lineHeight = 28.sp), color = skin.ink)
                    Text("Your earlier chats stay on this phone.", style = CoachType.body(16).copy(lineHeight = 23.sp), color = skin.inkDim)
                }
            } else {
                Spacer(Modifier.weight(1f))
                Text(Ask.accessNeedsSignIn, style = CoachType.body(18).copy(lineHeight = 26.sp), color = skin.inkDim,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.weight(1f))
            }
            CoachAction("Sign in", onSignIn, primary = true)
        }
    }
}

@Composable
fun AskAbsentStance(seat: String, onThreads: (() -> Unit)? = null) {
    val skin = LocalGymColors.current
    GymScreen(title = Ask.title, actions = {
        onThreads?.let { history -> IconButton(onClick = history, modifier = Modifier.size(48.dp)) {
            Icon(painterResource(R.drawable.gym_coach_history), "History", tint = skin.ink, modifier = Modifier.size(24.dp))
        } }
        YouSeat(seat)
    }) {
        Column(Modifier.fillMaxSize().padding(horizontal = 40.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)) {
            Icon(painterResource(R.drawable.gym_coach_error), null, tint = skin.inkDim, modifier = Modifier.size(32.dp))
            Text(Ask.notHere, style = CoachType.body(15).copy(lineHeight = 23.sp), color = skin.inkDim, textAlign = TextAlign.Center)
        }
    }
}

internal fun coachDailyNotice(deadline: Long?, now: Long, locale: Locale, zone: ZoneId): String? {
    if (deadline == null || deadline <= 0) return Ask.capReached
    if (deadline <= now) return null
    val time = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale).withZone(zone)
        .format(Instant.ofEpochMilli(deadline))
    return "You can ask again on $time."
}

internal fun coachAllowanceNotice(anonymous: Boolean, deadline: Long?, locale: Locale, zone: ZoneId): String {
    if (anonymous) return AskCap.Allowance.wordless + "\nSign in to continue."
    if (deadline == null || deadline <= 0) return AskCap.Allowance.wordless
    val time = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale).withZone(zone)
        .format(Instant.ofEpochMilli(deadline))
    return AskCap.Allowance.wordless + "\nYou can use Coach again on $time."
}

@Composable
internal fun CoachCapNotice(cap: AskCap, exchange: AskExchange?, anonymous: Boolean = false,
    onSignIn: (() -> Unit)? = null, onConnections: () -> Unit) {
    val skin = LocalGymColors.current
    val lifecycle = LocalLifecycleOwner.current
    val configuration = LocalConfiguration.current
    if (cap == AskCap.Allowance) {
        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(coachAllowanceNotice(anonymous, exchange?.retryAtMs, configuration.locales[0], ZoneId.systemDefault()),
                style = CoachType.body(14).copy(lineHeight = 20.sp), color = skin.inkDim, textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 300.dp))
            if (anonymous && onSignIn != null) FilledTonalButton(onClick = onSignIn,
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = skin.raised, contentColor = skin.ink),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
                Text("Sign in", style = CoachType.body(14, FontWeight.Bold).copy(lineHeight = 20.sp, letterSpacing = .1.sp))
            }
        }
        return
    }
    var now by remember(exchange?.requestId) { mutableLongStateOf(System.currentTimeMillis()) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) now = System.currentTimeMillis() }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(exchange?.retryAtMs) {
        val deadline = exchange?.retryAtMs ?: return@LaunchedEffect
        while (deadline > now) {
            delay((deadline - now).coerceIn(1, 60_000))
            now = System.currentTimeMillis()
        }
    }
    val notice = if (cap == AskCap.Daily) coachDailyNotice(exchange?.retryAtMs, now, configuration.locales[0], ZoneId.systemDefault())
        else exchange?.trouble ?: Ask.ceilingReached
    notice?.let {
        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(it, style = CoachType.body(14).copy(lineHeight = 20.sp), color = skin.inkDim, textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 300.dp))
            TextButton(onClick = onConnections, modifier = Modifier.heightIn(min = 48.dp)) {
                Text("Use your own AI agent", style = CoachType.body(14, FontWeight.Bold).copy(lineHeight = 20.sp), color = skin.accent)
            }
        }
    }
}
