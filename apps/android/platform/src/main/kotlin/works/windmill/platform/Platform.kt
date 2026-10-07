package works.windmill.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import works.windmill.platform.you.YouDestination
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.serialization.Serializable
import works.windmill.platform.telemetry.Telemetry

// Product-neutral: nothing here may name a product.

interface ProductModule {
    val id: String
    val label: String

    // The room's Material theme plus its `LocalWindmillPalette`, so the shell can draw its own
    // sheet in the room's colours over the room.
    @Composable
    fun Skin(content: @Composable () -> Unit)

    @Composable
    fun Room(account: Account)
}

// An unresolved account is still restoring credentials; an unverified user stands on the device copy.
// `origin` is the backend the account signs in to, where the links it shares point.
class Account(val origin: String, val user: User?, val verified: Boolean = true, val resolved: Boolean = true, val locallyTrusted: Boolean = true, val identityRevision: Long = 0) {
    val isSignedIn: Boolean
        get() = user != null
}

@Serializable
data class User(val id: String, val email: String, val name: String = "")

// The shell's account sheet, opened on its overview or straight on sign-in, and the rows the room
// in front adds under You.
class ShellActions(val openYou: () -> Unit, val openSignIn: () -> Unit = openYou) {
    var destinations: List<YouDestination> by mutableStateOf(emptyList())
        private set

    fun present(destinations: List<YouDestination>) { this.destinations = destinations }
}

val LocalShellActions = staticCompositionLocalOf<ShellActions> { ShellActions(openYou = {}) }

data class ClientUpdateDestination(val url: String = "https://windmill.works", val label: String = "Open Windmill")
val LocalClientUpdateDestination = staticCompositionLocalOf { ClientUpdateDestination() }

fun ClientUpdateDestination.open(openUri: (String) -> Unit, telemetry: Telemetry): String? {
    telemetry.event("client_update_required", mapOf("action" to "update"))
    return try { openUri(url); null }
    catch (_: Exception) {
        telemetry.event("client_update_required", mapOf("action" to "update", "outcome" to "failed"))
        "The link could not be opened. Try again, or open Windmill’s website in your browser."
    }
}
