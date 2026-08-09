package works.windmill.platform.you

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import works.windmill.platform.design.WindmillColor
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillSpace

// You — the shell's own surface, cut to what a one-room app spends: who is signed in, the way out,
// and the door in. Windmill One, appearance, holdings and the web links stay on iOS and the web
// until this shell grows a second room — a screen here could only restate what it cannot act on.
// Always the family tokens, whatever room it opened over: the sheet is the shell's, not the room's.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YouSheet(auth: AuthStore, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = WindmillColor.surfaceCanvas.color,
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
                        color = WindmillColor.textPrimary.color,
                    )
                    Text(
                        "${status.user.email} · one account, all three apps",
                        style = WindmillFont.body(13),
                        color = WindmillColor.textTertiary.color,
                    )
                }
                ActionCapsule("Sign out", ActionWeight.Quiet) {
                    scope.launch { auth.signOut() }
                }
            }

            // The door, not a "please sign in" wall: signing in happens where the person is
            // standing, and a finished sign-in redraws this sheet as the account it just made.
            // Unknown lands here too — restore is in flight for at most one round trip, and the
            // door it may replace is the truthful screen while nobody is signed in.
            else -> SignInDoor(auth)
        }
    }
}
