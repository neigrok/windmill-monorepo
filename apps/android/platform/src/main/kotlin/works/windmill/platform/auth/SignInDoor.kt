package works.windmill.platform.auth

import works.windmill.platform.design.WindmillType
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import works.windmill.platform.User
import works.windmill.platform.R
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.net.WindmillApiException

@Composable
fun SignInDoor(
    auth: AuthStore,
    onDone: () -> Unit = {},
    onBusy: (Boolean) -> Unit = {},
    now: () -> Long = { System.currentTimeMillis() },
) {
    var email by rememberSaveable { mutableStateOf("") }
    var typed by rememberSaveable { mutableStateOf("") }
    var sentTo by rememberSaveable { mutableStateOf<String?>(null) }
    var refusal by rememberSaveable { mutableStateOf<String?>(null) }
    var resendAt by rememberSaveable { mutableLongStateOf(0L) }
    var pending by remember(auth) { mutableStateOf<Int?>(null) }
    var completed by rememberSaveable(auth) { mutableStateOf(false) }
    var attachedHandoff by rememberSaveable(auth) { mutableLongStateOf(0L) }
    val identity = remember(auth) { Any() }
    val currentIdentity by rememberUpdatedState(identity)
    val busyCallback by rememberUpdatedState(onBusy)
    val doneCallback by rememberUpdatedState(onDone)
    var active by remember(auth) { mutableStateOf(true) }
    DisposableEffect(identity) { onDispose { active = false; onBusy(false) } }
    val scope = rememberCoroutineScope()
    val palette = LocalWindmillPalette.current
    val context = LocalContext.current
    var tick by remember { mutableLongStateOf(now()) }
    LaunchedEffect(resendAt) {
        tick = now()
        while (tick < resendAt) { delay(250); tick = now() }
    }
    val seconds = ((resendAt - maxOf(tick, now()) + 999) / 1000).coerceIn(0, 30)

    LaunchedEffect(auth, auth.handoffRevision, attachedHandoff) {
        val revision = auth.handoffRevision
        if (revision == 0L || completed || (!auth.handoffPending && attachedHandoff != revision)) return@LaunchedEffect
        attachedHandoff = revision
        pending = R.string.platform_sign_in_signing_in
        busyCallback(true)
        try {
            if (auth.awaitExistingHandoff(revision) && active && currentIdentity === identity && !completed) {
                completed = true
                pending = null
                busyCallback(false)
                doneCallback()
            }
        } catch (interrupted: CancellationException) { throw interrupted }
        catch (refused: WindmillApiException) {
            if (active && currentIdentity === identity && auth.handoffRevision == revision)
                refusal = MagicLink.refusal(refused)
        } catch (failed: AuthHandoffFailure) {
            if (active && currentIdentity === identity && auth.handoffRevision == revision)
                refusal = context.getString(R.string.platform_sign_in_failed)
        } finally {
            if (active && currentIdentity === identity && auth.handoffRevision == revision) { pending = null; busyCallback(false) }
        }
    }
    fun requestCode() {
        if (pending != null || auth.handoffPending || completed || email.isBlank() || (sentTo != null && seconds > 0)) return
        pending = R.string.platform_sign_in_sending
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
        if (pending != null || auth.handoffPending || completed || typed.isBlank()) return
        pending = R.string.platform_sign_in_signing_in
        attachedHandoff = auth.handoffRevision + 1
        busyCallback(true)
        refusal = null
        val entry = typed.trim()
        scope.launch {
            try {
                val beforeCommit: (User) -> Unit = {
                    if (!active || currentIdentity !== identity) throw CancellationException("The sign-in form changed.")
                }
                if (!auth.resumePendingSignIn(address)) {
                    if (MagicLink.looksLikeLink(entry)) {
                        auth.completeLink(entry, beforeCommit)
                    } else {
                        if (entry.length != 6 || !entry.all(Char::isDigit)) {
                            auth.telemetry.event("auth_sign_in_started", mapOf("method" to "code"))
                            throw MagicLink.unreadable
                        }
                        auth.completeCode(address, entry, beforeCommit)
                    }
                }
                if (auth.handoffRevision == 0L && active && currentIdentity === identity && !completed) {
                    completed = true
                    pending = null
                    busyCallback(false)
                    doneCallback()
                }
            } catch (interrupted: CancellationException) {
                throw interrupted
            } catch (refused: WindmillApiException) {
                if (active && currentIdentity === identity) refusal = MagicLink.refusal(refused)
            } catch (failed: Exception) {
                if (failed !is AuthHandoffFailure) auth.telemetry.failure("auth_sign_in", failed)
                if (active && currentIdentity === identity) refusal = context.getString(R.string.platform_sign_in_failed)
            } finally {
                if (active && currentIdentity === identity) { pending = null; busyCallback(false) }
            }
        }
    }
    Column(Modifier.fillMaxWidth().imePadding()) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
            .padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(if (sentTo == null) R.string.platform_sign_in else R.string.platform_sign_in_check_email),
                style = WindmillType.doorTitle, color = palette.ink)
            if (sentTo == null) {
                Text(stringResource(R.string.platform_sign_in_new_here), style = WindmillType.paragraph, color = palette.inkDim)
                DoorField(stringResource(R.string.platform_email), stringResource(R.string.platform_sign_in_email_placeholder), email, KeyboardType.Email, ContentType.EmailAddress, pending == null && !auth.handoffPending && !completed, refusal) { email = it; refusal = null }
            } else {
                Text(stringResource(R.string.platform_sign_in_code_sent, sentTo.orEmpty()), style = WindmillType.paragraph, color = palette.ink)
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    DoorField(stringResource(R.string.platform_sign_in_code), stringResource(R.string.platform_sign_in_code_placeholder), typed, KeyboardType.NumberPassword, OneTimeCode, pending == null && !auth.handoffPending && !completed, refusal) { typed = it; refusal = null }
                    Text(refusal ?: stringResource(R.string.platform_sign_in_code_lifetime),
                        style = WindmillType.supportingParagraph,
                        color = if (refusal == null) palette.inkDim else MaterialTheme.colorScheme.error,
                        modifier = Modifier.semantics { if (refusal != null) liveRegion = LiveRegionMode.Polite })
                }
                Text(stringResource(R.string.platform_sign_in_paste_link), style = WindmillType.supportingParagraph, color = palette.inkDim)
                TextButton(onClick = ::requestCode, enabled = pending == null && !auth.handoffPending && !completed && seconds == 0L, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(if (seconds > 0) stringResource(R.string.platform_sign_in_resend_in, seconds.toString()) else stringResource(R.string.platform_sign_in_resend), style = WindmillType.supporting, color = palette.inkDim)
                }
            }
            if (sentTo == null) refusal?.let {
                Text(it, style = WindmillType.supportingParagraph, color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { if (sentTo == null) requestCode() else signIn() },
                enabled = pending == null && !auth.handoffPending && !completed && (if (sentTo == null) email else typed).isNotBlank(),
                shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = palette.accent, contentColor = palette.onAccent)) {
                Text(stringResource(pending ?: if (auth.handoffPending) R.string.platform_sign_in_signing_in else if (sentTo == null) R.string.platform_sign_in_send_code else R.string.platform_sign_in), style = WindmillType.label)
            }
            if (sentTo != null) TextButton(onClick = { attachedHandoff = 0L; sentTo = null; typed = ""; refusal = null; resendAt = 0L },
                enabled = pending == null && !auth.handoffPending && !completed, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text(stringResource(R.string.platform_sign_in_change_email), style = WindmillType.label, color = palette.ink)
            }
        }
    }
}

private val OneTimeCode = ContentType.SmsOtpCode + ContentType("emailOTPCode")

@Composable
private fun DoorField(label: String, placeholder: String, value: String, keyboard: KeyboardType, autofill: ContentType,
    enabled: Boolean, refusal: String?, onChange: (String) -> Unit) {
    val palette = LocalWindmillPalette.current
    OutlinedTextField(value, onValueChange = onChange, enabled = enabled, singleLine = true,
        label = { Text(label) }, placeholder = { Text(placeholder) },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = keyboard),
        isError = refusal != null,
        trailingIcon = if (refusal == null) null else {
            { Icon(painterResource(R.drawable.auth_field_error), contentDescription = null, modifier = Modifier.size(24.dp)) }
        },
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = palette.accent, cursorColor = palette.accent,
            focusedTextColor = palette.ink, unfocusedTextColor = palette.ink),
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics {
            contentDescription = label
            contentType = autofill
            refusal?.let { error(it) }
        })
}
