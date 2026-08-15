package works.windmill.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.serialization.Serializable
import works.windmill.platform.net.WindmillApi

// The product-neutral seam the native superapp is built on — the mirror of web/src/shell/products.js
// and of the iOS WindmillPlatform seam, cut to what a one-room app spends. A product library
// implements ProductModule to become mountable; the app composes whichever modules exist behind one
// account. Nothing here may name a product: the moment this file says "gym" the one rule in
// STRUCTURE.md is broken.
//
// The hub, the switcher, presence, holdings and the entry doors are deliberately absent — they
// arrive with a second room, and a seam that promised them now would be promising screens nobody
// has built.

interface ProductModule {
    val id: String
    val label: String

    // The product's whole surface. The shell mounts one room full-screen and keeps it alive; a
    // module keeps its own state by remembering it inside the room it draws.
    @Composable
    fun Room(account: Account)
}

// One sign-in, one API host — handed to every product so no module invents its own idea of who is
// signed in. `user` is null while nobody has, and that is a supported state, not a degraded one: a
// room that needs an account says so through its own door, and a room that does not must open and
// work before there is an account to claim what it made (auth canon §2: claiming, not gating).
//
// `verified` is false while the seat stands on the device's last-known user because the server
// could not be asked (AuthStatus.SignedIn.verified): still signed in, and a room connects for the
// account exactly as it would — off the copies it holds — and connects again when the seat is
// verified, which is when its reads can land.
class Account(val api: WindmillApi, val user: User?, val verified: Boolean = true) {
    val isSignedIn: Boolean
        get() = user != null
}

@Serializable
data class User(val id: String, val email: String, val name: String = "")

// The one move the shell owns, handed down so a room can spend it without knowing what the shell
// looks like: a product places a seat at the end of its own bar and the seat opens You. The iOS
// ShellActions carries openSwitcher and goHome beside it — both arrive with a second room, and a
// closure nothing implements yet would be a promise, not a seam.
class ShellActions(val openYou: () -> Unit)

val LocalShellActions = staticCompositionLocalOf<ShellActions> { ShellActions(openYou = {}) }
