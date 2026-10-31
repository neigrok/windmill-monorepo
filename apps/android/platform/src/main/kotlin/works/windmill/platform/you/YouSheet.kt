package works.windmill.platform.you

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.painterResource
import works.windmill.platform.R
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthSignOutChoice
import works.windmill.platform.design.LocalWindmillDark
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.SignInDoor
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSheetBack
import works.windmill.platform.design.WindmillSheetWindow

data class YouDestination(val id: String, val label: String, val onOpen: () -> Unit)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun YouSheet(
    auth: AuthStore,
    onDismiss: () -> Unit,
    destinations: List<YouDestination> = emptyList(),
    startSignIn: Boolean = false,
    deletion: AccountDeletionStore? = null,
) {
    val scope = rememberCoroutineScope()
    val palette = LocalWindmillPalette.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val deletionPending = deletion?.transitionPending == true
    var form by rememberSaveable(startSignIn) { mutableStateOf(startSignIn && !deletionPending) }
    var busy by remember(auth) { mutableStateOf(false) }
    var closing by remember(auth) { mutableStateOf(false) }
    val identity = remember(auth) { Any() }
    val currentIdentity by rememberUpdatedState(identity)
    val formState = rememberSaveableStateHolder()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true,
        confirmValueChange = { it != SheetValue.Hidden || !busy && !auth.signOutBusy && auth.signOutQuestion == null })
    fun dismiss(after: () -> Unit = {}) {
        if (busy || auth.signOutBusy || auth.signOutQuestion != null || closing) return
        closing = true
        focus.clearFocus(force = true)
        keyboard?.hide()
        scope.launch {
            try {
                sheet.hide()
            } finally {
                if (currentIdentity === identity) {
                    if (!sheet.isVisible) {
                        onDismiss()
                        after()
                    } else closing = false
                }
            }
        }
    }
    ModalBottomSheet(onDismissRequest = { dismiss() }, sheetState = sheet,
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp), containerColor = palette.surface,
        scrimColor = MaterialTheme.colorScheme.scrim,
        dragHandle = {
            if (form) BottomSheetDefaults.DragHandle(color = palette.inkFaint)
            else Box(Modifier.fillMaxWidth().height(24.dp).semantics { contentDescription = "Drag handle" },
                contentAlignment = Alignment.Center) {
                Box(Modifier.size(width = 32.dp, height = 4.dp).testTag("you-sheet-handle")
                    .background(palette.inkDim, RoundedCornerShape(2.dp)))
            }
        }) {
        WindmillSheetWindow()
        WindmillSheetBack(onDismiss = { dismiss() }) {
            if (form && !deletionPending) formState.SaveableStateProvider("auth") {
                SignInDoor(auth, onDone = { dismiss() }, onBusy = { busy = it })
            }
            else Column(Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                    .padding(start = 20.dp, end = 20.dp, top = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("You", style = WindmillFont.body(26, FontWeight.ExtraBold).copy(lineHeight = 32.sp), color = palette.ink)
                        if (deletionPending) Text("Deletion unconfirmed", style = WindmillFont.body(16).copy(lineHeight = 24.sp), color = palette.inkDim)
                        else auth.status.user?.let { Text(it.email, style = WindmillFont.body(16).copy(lineHeight = 24.sp), color = palette.ink) }
                    }
                    auth.signOutFailure?.let { Text(it, style = WindmillFont.body(14), color = palette.noticeInk) }
                    val rows = destinations + if (deletion != null && (deletionPending || auth.status is AuthStatus.SignedIn))
                        listOf(YouDestination("account_deletion", when {
                            !deletionPending -> "Delete account"
                            deletion.closureConfirmed -> "Finish deletion"
                            else -> "Check deletion"
                        }, deletion::open)) else emptyList()
                    rows.forEach { destination ->
                        key(destination.id) {
                            Row(Modifier.fillMaxWidth()
                                .clickable(enabled = !busy && !auth.signOutBusy && !closing, role = Role.Button) { dismiss(after = destination.onOpen) }
                                .padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(destination.label, style = WindmillFont.body(15, FontWeight.Bold).copy(lineHeight = 22.sp),
                                    color = if (destination.id == "account_deletion" && !deletionPending) MaterialTheme.colorScheme.error else palette.ink, modifier = Modifier.weight(1f))
                                Icon(painterResource(R.drawable.you_chevron), contentDescription = null,
                                    tint = palette.inkDim, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                }
                if (deletionPending) Spacer(Modifier.height(64.dp))
                else TextButton(onClick = {
                    if (busy || auth.signOutBusy || auth.signOutQuestion != null || closing) return@TextButton
                    if (auth.status !is AuthStatus.SignedIn) form = true
                    else scope.launch {
                        auth.prepareSignOut()
                        if (auth.status == AuthStatus.SignedOut) dismiss()
                    }
                }, enabled = !busy && !auth.signOutBusy && !closing,
                    modifier = Modifier.align(Alignment.CenterHorizontally)
                        .padding(top = 20.dp, bottom = 16.dp).heightIn(min = 48.dp)) {
                    Text(if (auth.signOutBusy) "Signing out…" else if (auth.status is AuthStatus.SignedIn) "Sign out" else "Sign in",
                        style = MaterialTheme.typography.labelLarge, color = palette.ink)
                }
            }
        }
    }
    auth.signOutQuestion?.let { question ->
        val dark = LocalWindmillDark.current
        val current = MaterialTheme.colorScheme
        val scheme = if (dark) darkColorScheme(primary = current.primary, error = current.error)
            else lightColorScheme(primary = current.primary, error = current.error)
        fun cancel() { if (!auth.signOutBusy) scope.launch { auth.cancelSignOut() } }
        fun finish(choice: AuthSignOutChoice) {
            if (auth.signOutBusy) return
            scope.launch {
                auth.confirmSignOut(choice)
                if (auth.status == AuthStatus.SignedOut) dismiss()
            }
        }
        MaterialTheme(colorScheme = scheme) {
            BasicAlertDialog(onDismissRequest = ::cancel) {
                Surface(modifier = Modifier.testTag("sign-out-question"), shape = RoundedCornerShape(28.dp), color = scheme.surfaceContainerHigh) {
                    Column(Modifier.widthIn(min = 280.dp, max = 560.dp)) {
                        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                            .padding(start = 24.dp, end = 24.dp, top = 24.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            Text("Sign out?", style = MaterialTheme.typography.headlineSmall, color = scheme.onSurface)
                            val copy = if (question.unsent == 0) "Your log stays in your account and leaves this phone."
                                else "${question.unsent} " + (if (question.unsent == 1) "change hasn’t" else "changes haven’t") +
                                    " been confirmed by your account yet. Keep them on this phone until you sign in again, or discard them from this phone."
                            Text(copy, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                        }
                        FlowRow(Modifier.fillMaxWidth().padding(start = 8.dp, end = 24.dp, top = 20.dp, bottom = 20.dp),
                            horizontalArrangement = Arrangement.End) {
                            TextButton(onClick = ::cancel, enabled = !auth.signOutBusy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") }
                            if (question.unsent > 0) {
                                TextButton(onClick = { finish(AuthSignOutChoice.Discard) }, enabled = !auth.signOutBusy,
                                    modifier = Modifier.heightIn(min = 48.dp), colors = ButtonDefaults.textButtonColors(contentColor = scheme.error)) { Text("Discard") }
                            } else Spacer(Modifier.width(8.dp))
                            TextButton(onClick = { finish(AuthSignOutChoice.Keep) }, enabled = !auth.signOutBusy,
                                modifier = Modifier.heightIn(min = 48.dp), colors = ButtonDefaults.textButtonColors(
                                    contentColor = if (question.unsent == 0) scheme.error else scheme.primary)) {
                                Text(if (question.unsent == 0) "Sign out" else "Keep")
                            }
                        }
                    }
                }
            }
        }
    }

}
