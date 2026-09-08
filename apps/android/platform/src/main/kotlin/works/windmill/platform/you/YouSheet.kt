package works.windmill.platform.you

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.SignInDoor
import works.windmill.platform.design.ActionCapsule
import works.windmill.platform.design.ActionWeight
import works.windmill.platform.design.LocalWindmillPalette
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YouSheet(auth: AuthStore, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val palette = LocalWindmillPalette.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = palette.surface,
        dragHandle = { BottomSheetDefaults.DragHandle(color = palette.inkFaint) },
    ) {
        when (val status = auth.status) {
            is AuthStatus.SignedIn -> Column(
                Modifier
                    .fillMaxWidth()
                    .padding(WindmillSpace.x6),
                verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
                    Text(
                        status.user.name.ifEmpty { "Windmill" },
                        style = WindmillFont.display(19),
                        color = palette.ink,
                    )
                    Text(
                        "${status.user.email} · one account, all three apps",
                        style = WindmillFont.body(13),
                        color = palette.inkFaint,
                    )
                }
                ActionCapsule("Sign out", ActionWeight.Quiet) {
                    scope.launch { auth.signOut() }
                }
            }

            else -> SignInDoor(auth, onDone = onDismiss)
        }
    }
}
