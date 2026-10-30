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
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.SignInDoor
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSheetBack
import works.windmill.platform.design.WindmillSheetWindow

data class YouDestination(val id: String, val label: String, val onOpen: () -> Unit)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YouSheet(
    auth: AuthStore,
    onDismiss: () -> Unit,
    destinations: List<YouDestination> = emptyList(),
    startSignIn: Boolean = false,
) {
    val scope = rememberCoroutineScope()
    val palette = LocalWindmillPalette.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var form by rememberSaveable(startSignIn) { mutableStateOf(startSignIn) }
    var busy by remember(auth) { mutableStateOf(false) }
    var closing by remember(auth) { mutableStateOf(false) }
    var refusal by remember(auth) { mutableStateOf<String?>(null) }
    val identity = remember(auth) { Any() }
    val currentIdentity by rememberUpdatedState(identity)
    val formState = rememberSaveableStateHolder()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true,
        confirmValueChange = { it != SheetValue.Hidden || !busy })
    fun dismiss(after: () -> Unit = {}) {
        if (busy || closing) return
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
            if (form) formState.SaveableStateProvider("auth") {
                SignInDoor(auth, onDone = { dismiss() }, onBusy = { busy = it })
            }
            else Column(Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                    .padding(start = 20.dp, end = 20.dp, top = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("You", style = WindmillFont.body(26, FontWeight.ExtraBold).copy(lineHeight = 32.sp), color = palette.ink)
                        auth.status.user?.let { Text(it.email, style = WindmillFont.body(16).copy(lineHeight = 24.sp), color = palette.ink) }
                    }
                    refusal?.let { Text(it, style = WindmillFont.body(14), color = palette.noticeInk) }
                    destinations.forEach { destination ->
                        key(destination.id) {
                            Row(Modifier.fillMaxWidth()
                                .clickable(enabled = !busy && !closing, role = Role.Button) { dismiss(after = destination.onOpen) }
                                .padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(destination.label, style = WindmillFont.body(15, FontWeight.Bold).copy(lineHeight = 22.sp),
                                    color = palette.ink, modifier = Modifier.weight(1f))
                                Icon(painterResource(R.drawable.you_chevron), contentDescription = null,
                                    tint = palette.inkDim, modifier = Modifier.size(18.dp))
                            }
                        }
                    }
                }
                TextButton(onClick = {
                    if (busy || closing) return@TextButton
                    if (auth.status !is AuthStatus.SignedIn) form = true
                    else {
                        busy = true
                        scope.launch {
                            var signedOut = false
                            try { auth.signOut(); signedOut = true }
                            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                            catch (failure: Exception) {
                                auth.telemetry.failure("auth_sign_out", failure)
                                if (currentIdentity === identity) refusal = "Sign-out could not be saved. Your work is still on this phone. Try again."
                            }
                            finally { if (currentIdentity === identity) busy = false }
                            if (signedOut && currentIdentity === identity) dismiss()
                        }
                    }
                }, enabled = !busy && !closing,
                    modifier = Modifier.align(Alignment.CenterHorizontally)
                        .padding(top = 20.dp, bottom = 16.dp).heightIn(min = 48.dp)) {
                    Text(if (busy) "Signing out…" else if (auth.status is AuthStatus.SignedIn) "Sign out" else "Sign in",
                        style = MaterialTheme.typography.labelLarge, color = palette.ink)
                }
            }
        }
    }
}
