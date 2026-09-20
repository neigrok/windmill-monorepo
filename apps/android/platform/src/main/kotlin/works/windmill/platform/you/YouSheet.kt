package works.windmill.platform.you

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
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import works.windmill.platform.User
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
    flowId: String? = null,
    onSignedIn: (User, String?) -> Unit = { _, _ -> },
    onAuthDismiss: (String?) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val palette = LocalWindmillPalette.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var form by rememberSaveable(flowId, startSignIn) { mutableStateOf(startSignIn) }
    var busy by remember(auth, flowId) { mutableStateOf(false) }
    var closing by remember(auth, flowId) { mutableStateOf(false) }
    val identity = remember(auth, flowId) { Any() }
    val currentIdentity by rememberUpdatedState(identity)
    val formState = rememberSaveableStateHolder()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true,
        confirmValueChange = { it != SheetValue.Hidden || !busy })
    fun dismiss(cancelAuth: Boolean = false, after: () -> Unit = {}) {
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
                        if (cancelAuth && form) onAuthDismiss(flowId)
                        onDismiss()
                        after()
                    } else closing = false
                }
            }
        }
    }
    ModalBottomSheet(onDismissRequest = { dismiss(cancelAuth = true) }, sheetState = sheet,
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = false),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp), containerColor = palette.surface,
        scrimColor = MaterialTheme.colorScheme.scrim,
        dragHandle = { BottomSheetDefaults.DragHandle(color = palette.inkFaint) }) {
        WindmillSheetWindow()
        WindmillSheetBack(onDismiss = { dismiss(cancelAuth = true) }) {
            if (form) formState.SaveableStateProvider("auth:${flowId.orEmpty()}") {
                SignInDoor(auth, onDone = { dismiss() }, flowId = flowId,
                    onSignedIn = onSignedIn, onBusy = { busy = it })
            }
            else Column(Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())
                    .padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("You", style = WindmillFont.body(26, FontWeight.Bold).copy(lineHeight = 36.sp), color = palette.ink)
                    auth.status.user?.let { Text(it.email, style = WindmillFont.body(16).copy(lineHeight = 22.sp), color = palette.inkDim) }
                    Text("One account across Windmill.", style = WindmillFont.body(14).copy(lineHeight = 20.sp), color = palette.inkDim)
                    destinations.forEach { destination ->
                        key(destination.id) {
                            Row(Modifier.fillMaxWidth().heightIn(min = 64.dp)
                                .clickable(enabled = !busy && !closing, role = Role.Button) { dismiss(after = destination.onOpen) }
                                .padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(destination.label, style = WindmillFont.body(16, FontWeight.Bold).copy(lineHeight = 22.sp),
                                    color = palette.ink, modifier = Modifier.weight(1f))
                                Text("›", style = WindmillFont.body(24).copy(lineHeight = 34.sp), color = palette.inkDim)
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
                            try { auth.signOut() }
                            finally { if (currentIdentity === identity) busy = false }
                            if (currentIdentity === identity) dismiss()
                        }
                    }
                }, enabled = !busy && !closing,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp).heightIn(min = 56.dp)) {
                    Text(if (busy) "Signing out…" else if (auth.status is AuthStatus.SignedIn) "Sign out" else "Sign in",
                        style = WindmillFont.body(16, FontWeight.Bold), color = palette.ink)
                }
            }
        }
    }
}
