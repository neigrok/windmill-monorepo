package works.windmill.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import works.windmill.platform.you.YouDestination
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

// An unresolved account is still restoring credentials; an unverified user stands on the device copy.
class Account(val api: WindmillApi, val user: User?, val verified: Boolean = true, val resolved: Boolean = true) {
    val isSignedIn: Boolean
        get() = user != null
}

@Serializable
data class User(val id: String, val email: String, val name: String = "")

class AccountActions(
    val destinations: List<YouDestination>,
    val beforeSignIn: (User, String?) -> Unit,
    val cancelSignIn: (String?) -> Unit,
)

class ShellActions(val openYou: () -> Unit, val openSignIn: (String?) -> Unit = { openYou() }) {
    private var product: AccountActions? by mutableStateOf(null)
    val destinations: List<YouDestination> get() = product?.destinations.orEmpty()

    fun present(actions: AccountActions) { product = actions }

    fun authenticated(user: User, flowId: String?) {
        val actions = product
        check(flowId == null || actions != null) { "Reopen this sign-in from the screen that requested it." }
        actions?.beforeSignIn?.invoke(user, flowId)
    }

    fun authDismissed(flowId: String?) { product?.cancelSignIn?.invoke(flowId) }
}

val LocalShellActions = staticCompositionLocalOf<ShellActions> { ShellActions(openYou = {}) }
