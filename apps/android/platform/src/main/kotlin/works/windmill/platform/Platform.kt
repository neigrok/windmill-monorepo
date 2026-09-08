package works.windmill.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.serialization.Serializable
import works.windmill.platform.net.WindmillApi

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

// `user` null means nobody is signed in; `verified` false means the seat stands on the device's
// last-known user, unasked.
class Account(val api: WindmillApi, val user: User?, val verified: Boolean = true) {
    val isSignedIn: Boolean
        get() = user != null
}

@Serializable
data class User(val id: String, val email: String, val name: String = "")

class ShellActions(val openYou: () -> Unit)

val LocalShellActions = staticCompositionLocalOf<ShellActions> { ShellActions(openYou = {}) }
