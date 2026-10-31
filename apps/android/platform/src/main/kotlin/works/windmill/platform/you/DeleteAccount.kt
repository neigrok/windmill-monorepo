package works.windmill.platform.you

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.launch
import works.windmill.platform.R
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.WindmillFont

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeleteAccount(store: AccountDeletionStore, onExit: (Boolean) -> Unit) {
    val palette = LocalWindmillPalette.current
    val dark = LocalWindmillDark.current
    val scheme = MaterialTheme.colorScheme
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val page = store.page
    val confirming = page == AccountDeletionPage.Confirm || page == AccountDeletionPage.Deleting
    var email by rememberSaveable(store.confirmingUser?.id) { mutableStateOf("") }
    fun exit() {
        if (store.busy) return
        scope.launch {
            focus.clearFocus(); keyboard?.hide()
            store.back()
            onExit(page == AccountDeletionPage.Deleted)
        }
    }
    BackHandler { exit() }
    LaunchedEffect(store.exitRequested, store.busy) { if (store.exitRequested && !store.busy) exit() }
    Column(Modifier.fillMaxSize().background(palette.canvas).statusBarsPadding().navigationBarsPadding().imePadding()
        .testTag("account-deletion-page")) {
        if (page != AccountDeletionPage.Deleted) TopAppBar(
            title = { Text("Delete account", style = WindmillFont.body(22, FontWeight.Bold).copy(lineHeight = 28.sp), color = palette.ink) },
            navigationIcon = { IconButton(onClick = ::exit, enabled = !store.busy, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(if (dark) R.drawable.account_delete_back else R.drawable.account_delete_back_light),
                    "Back", Modifier.size(24.dp), tint = if (store.busy) palette.ink.copy(alpha = .38f) else palette.ink)
            } }, expandedHeight = 64.dp, windowInsets = WindowInsets(0, 0, 0, 0),
            colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas))
        if (confirming) Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp).padding(top = 8.dp, bottom = 8.dp)) {
            Text("Delete your account?", style = WindmillFont.body(26, FontWeight.ExtraBold).copy(lineHeight = 32.sp), color = palette.ink)
            Column(Modifier.padding(top = 12.dp, bottom = 8.dp)) {
                DeletionFact(if (dark) R.drawable.account_delete_delete else R.drawable.account_delete_delete_light,
                    "This deletes your Windmill account and its copy in the cloud: your roadmaps, journal pages and gym log.")
                DeletionFact(if (dark) R.drawable.account_delete_move_item else R.drawable.account_delete_move_item_light,
                    "Every device signs out, and connected tools lose access, right away.")
                DeletionFact(if (dark) R.drawable.account_delete_schedule else R.drawable.account_delete_schedule_light,
                    "For 30 days, you can sign in again to bring it all back. After that, it is deleted for good.")
                DeletionFact(if (dark) R.drawable.account_delete_download else R.drawable.account_delete_download_light,
                    "To keep a copy, export it first at windmill.works.")
                if (store.count > 0) DeletionFact(if (dark) R.drawable.account_delete_cloud_off else R.drawable.account_delete_cloud_off_light,
                    if (store.count == 1) "1 change on this phone hasn’t been confirmed by your account. It is deleted too."
                    else "${store.count} changes on this phone haven’t been confirmed by your account. They are deleted too.")
            }
            Text("Type your email to confirm", style = WindmillFont.body(13, FontWeight.Bold).copy(lineHeight = 18.sp), color = palette.inkDim)
            Spacer(Modifier.height(10.dp))
            MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                OutlinedTextField(email, { email = it }, modifier = Modifier.fillMaxWidth().testTag("deletion-email"),
                    label = { Text("Email") }, singleLine = true, enabled = !store.busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Done),
                    shape = RoundedCornerShape(4.dp))
            }
            store.failure?.let { Text(it, Modifier.padding(top = 10.dp),
                style = WindmillFont.body(13).copy(lineHeight = 18.sp), color = scheme.error) }
        } else BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val height = maxHeight
            if (page == AccountDeletionPage.Deleted) Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .heightIn(min = height).padding(horizontal = 20.dp).padding(bottom = 60.dp),
                verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(painterResource(if (dark) R.drawable.account_delete_check else R.drawable.account_delete_check_light),
                    null, Modifier.size(48.dp), tint = Color.Unspecified)
                Spacer(Modifier.height(12.dp))
                Text("Your account is deleted", style = WindmillFont.body(22, FontWeight.ExtraBold).copy(lineHeight = 28.sp),
                    color = palette.ink, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
                store.deletedReceipt?.let { receipt ->
                    val deadline = remember(receipt) { DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
                        .withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(receipt.closesMs)) }
                    Text("Sign in before $deadline to bring it back.", style = WindmillFont.body(15).copy(lineHeight = 22.sp),
                        color = palette.inkDim, textAlign = TextAlign.Center)
                }
            } else Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)
                .padding(top = 172.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                val message = when (page) {
                    AccountDeletionPage.Offline -> "Can’t check yet" to "Your account may already be closed. Try checking again when your connection is back."
                    AccountDeletionPage.Unavailable -> "Confirmation unavailable" to "We can’t confirm the result on this phone. Signing in may restore a closing account."
                    AccountDeletionPage.Cleanup -> "Finishing deletion" to "Your account is closed. This phone still needs to remove its local copy."
                    else -> "Checking deletion" to "Your account may already be closed. We’re waiting for confirmation."
                }
                Text(message.first, style = WindmillFont.body(22, FontWeight.ExtraBold).copy(lineHeight = 28.sp), color = palette.ink)
                Text(message.second, style = WindmillFont.body(15).copy(lineHeight = 22.sp), color = palette.inkDim)
            }
        }
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val single = page == AccountDeletionPage.Deleted || page == AccountDeletionPage.Unavailable
            val enabled = !store.busy && (!confirming || store.emailMatches(email))
            val fill = if (confirming) scheme.error else palette.accent
            val ink = if (confirming) { if (dark) Color(0xFF410E0B) else Color.White } else palette.onAccent
            Button(onClick = {
                if (single) exit()
                else {
                    focus.clearFocus(); keyboard?.hide()
                    scope.launch { if (confirming) store.confirm(email) else store.recover() }
                }
            }, enabled = enabled, shape = RoundedCornerShape(16.dp), contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = fill, contentColor = ink, disabledContainerColor = fill, disabledContentColor = ink),
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).alpha(if (!enabled && page != AccountDeletionPage.Deleting) .38f else 1f)
                    .testTag("deletion-primary")) {
                if (page == AccountDeletionPage.Deleting) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = ink, strokeWidth = 2.dp)
                    Spacer(Modifier.width(12.dp))
                }
                Text(when (page) {
                    AccountDeletionPage.Deleting -> "Deleting…"
                    AccountDeletionPage.Confirm -> if (store.failure == null) "Delete account" else "Try again"
                    AccountDeletionPage.Deleted -> "Done"
                    AccountDeletionPage.Unavailable -> "Back to You"
                    AccountDeletionPage.Cleanup -> "Retry cleanup"
                    else -> "Check again"
                }, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp))
            }
            if (!single) TextButton(onClick = ::exit, enabled = !store.busy, modifier = Modifier.heightIn(min = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = palette.ink)) {
                Text(if (confirming) "Cancel" else "Back to You")
            }
        }
    }
}

@Composable
private fun DeletionFact(icon: Int, text: String) {
    val palette = LocalWindmillPalette.current
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Icon(painterResource(icon), null, Modifier.size(24.dp), tint = Color.Unspecified)
        Text(text, style = WindmillFont.body(15).copy(lineHeight = 22.sp), color = palette.ink, modifier = Modifier.weight(1f))
    }
}
