package works.windmill.platform.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import works.windmill.platform.User
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.net.WindmillApiException

@Composable
fun SignInDoor(
    auth: AuthStore,
    onDone: () -> Unit = {},
    flowId: String? = null,
    onSignedIn: (User, String?) -> Unit = { _, _ -> },
    onBusy: (Boolean) -> Unit = {},
    now: () -> Long = { System.currentTimeMillis() },
) {
    var email by rememberSaveable(flowId) { mutableStateOf("") }
    var typed by rememberSaveable(flowId) { mutableStateOf("") }
    var sentTo by rememberSaveable(flowId) { mutableStateOf<String?>(null) }
    var refusal by rememberSaveable(flowId) { mutableStateOf<String?>(null) }
    var resendAt by rememberSaveable(flowId) { mutableLongStateOf(0L) }
    var pending by remember(auth, flowId) { mutableStateOf<String?>(null) }
    var completed by remember(auth, flowId) { mutableStateOf(false) }
    val identity = remember(auth, flowId) { Any() }
    val currentIdentity by rememberUpdatedState(identity)
    val busyCallback by rememberUpdatedState(onBusy)
    val doneCallback by rememberUpdatedState(onDone)
    val signedInCallback by rememberUpdatedState(onSignedIn)
    var active by remember(auth, flowId) { mutableStateOf(true) }
    DisposableEffect(identity) { onDispose { active = false; onBusy(false) } }
    val scope = rememberCoroutineScope()
    val palette = LocalWindmillPalette.current
    var tick by remember(flowId) { mutableLongStateOf(now()) }
    LaunchedEffect(resendAt, flowId) {
        tick = now()
        while (tick < resendAt) { delay(250); tick = now() }
    }
    val seconds = ((resendAt - maxOf(tick, now()) + 999) / 1000).coerceIn(0, 30)

    fun requestCode() {
        if (pending != null || completed || email.isBlank() || (sentTo != null && seconds > 0)) return
        pending = "Sending…"
        busyCallback(true)
        refusal = null
        val address = email
        scope.launch {
            try {
                auth.requestLink(address)
                if (active && currentIdentity === identity) {
                    sentTo = address.trim()
                    resendAt = now() + 30_000
                }
            } catch (refused: WindmillApiException) {
                if (active && currentIdentity === identity) refusal = refused.line
            } finally {
                if (active && currentIdentity === identity) { pending = null; busyCallback(false) }
            }
        }
    }
    fun signIn() {
        val address = sentTo ?: return
        if (pending != null || completed || typed.isBlank()) return
        pending = "Signing in…"
        busyCallback(true)
        refusal = null
        val entry = typed.trim()
        val code = entry.takeIf { it.length == 6 && it.all(Char::isDigit) }
        scope.launch {
            try {
                val beforeCommit: (User) -> Unit = { user ->
                    if (!active || currentIdentity !== identity) throw CancellationException("The sign-in form changed.")
                    signedInCallback(user, flowId)
                }
                if (code != null) auth.completeCode(address, code, beforeCommit) else auth.completeLink(entry, beforeCommit)
                if (active && currentIdentity === identity) {
                    completed = true
                    pending = null
                    busyCallback(false)
                    doneCallback()
                }
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refused: WindmillApiException) {
                if (active && currentIdentity === identity) refusal = MagicLink.refusal(refused, ofCode = code != null)
            } catch (failed: Exception) {
                auth.telemetry.failure("auth_sign_in", failed)
                if (active && currentIdentity === identity) refusal = "Sign-in could not be completed. Try again."
            } finally {
                if (active && currentIdentity === identity) { pending = null; busyCallback(false) }
            }
        }
    }
    Column(Modifier.fillMaxWidth().imePadding()) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
            .padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(if (sentTo == null) "Sign in" else "Check your email",
                style = WindmillFont.body(26, FontWeight.Bold).copy(lineHeight = 36.sp), color = palette.ink)
            if (sentTo == null) {
                Text("New here? The same door creates your account.", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = palette.inkDim)
                DoorField("Email", "you@example.com", email, KeyboardType.Email, pending == null && !completed, refusal) { email = it; refusal = null }
                Text("Logged before any sign-in. Nothing joins an account until you say it is yours.",
                    style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = palette.inkDim)
            } else {
                Text("Code sent to $sentTo.", style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = palette.ink)
                DoorField("Code", "6-digit code", typed, KeyboardType.Number, pending == null && !completed, refusal) { typed = it; refusal = null }
                Text("Works once. Expires in 15 minutes.", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = palette.inkDim)
                Text("You can also paste the email link.", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = palette.inkDim)
                TextButton(onClick = ::requestCode, enabled = pending == null && !completed && seconds == 0L, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(if (seconds > 0) "Resend in ${seconds}s" else "Resend", style = WindmillFont.body(14), color = palette.inkDim)
                }
            }
            refusal?.let { Text(it, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = palette.noticeInk,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { if (sentTo == null) requestCode() else signIn() },
                enabled = pending == null && !completed && (if (sentTo == null) email else typed).isNotBlank(),
                shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = palette.accent, contentColor = palette.onAccent)) {
                Text(pending ?: if (sentTo == null) "Send code" else "Sign in", style = WindmillFont.body(16, FontWeight.Bold))
            }
            if (sentTo != null) TextButton(onClick = { sentTo = null; typed = ""; refusal = null; resendAt = 0L },
                enabled = pending == null && !completed, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text("Change email", style = WindmillFont.body(16, FontWeight.Bold), color = palette.ink)
            }
        }
    }
}

@Composable
private fun DoorField(label: String, placeholder: String, value: String, keyboard: KeyboardType,
    enabled: Boolean, refusal: String?, onChange: (String) -> Unit) {
    val palette = LocalWindmillPalette.current
    Text(label, style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = palette.inkDim)
    OutlinedTextField(value, onValueChange = onChange, enabled = enabled, singleLine = true,
        textStyle = WindmillFont.body(18).copy(lineHeight = 24.sp),
        placeholder = { Text(placeholder, style = WindmillFont.body(18).copy(lineHeight = 24.sp)) },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = keyboard),
        shape = RoundedCornerShape(20.dp), isError = refusal != null,
        colors = OutlinedTextFieldDefaults.colors(focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh, disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            focusedBorderColor = palette.accent, unfocusedBorderColor = Color.Transparent, cursorColor = palette.accent,
            focusedTextColor = palette.ink, unfocusedTextColor = palette.ink),
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics { contentDescription = "$label field"; refusal?.let { error(it) } })
}
