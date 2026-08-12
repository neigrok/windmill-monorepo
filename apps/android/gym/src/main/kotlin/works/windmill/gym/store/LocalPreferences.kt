package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import works.windmill.gym.domain.GymPreferences

// §I'S DOCUMENT, KEPT BESIDE THE QUEUE. Preferences are the ACCOUNT's — a lifter reads in one unit
// everywhere and their gym owns one set of plates — but a lifter who sets their plates before
// signing in must not lose them, so the anonymous seat keeps its own copy here and the claim
// carries it, exactly as it carries movements, routines and sessions.
//
// THE ABSENCE IS THE WRAPPER'S, NEVER THE DOCUMENT'S, and that is the whole shape of this file.
// kotlinx omits a value that equals its default, so a settings object at its defaults encodes as
// `{}` and cannot tell "the lifter chose these" from "nobody has touched this" — which is exactly
// the distinction the claim turns on. A device holding NO document must not overwrite an account's
// plates with untouched defaults the first time somebody signs in on a fresh phone. So the document
// is nullable one level up: null is a seat that has never opened the screen, and the claim carries
// nothing for it.
//
// `owed` IS THE CLAIM'S OWN FLAG. The anonymous seat's document is owed by definition — it has
// landed nowhere — and a signed-in save that could not reach the log leaves it owed too, so the
// next claim pass carries it. Until it clears, a read from the log may NOT overwrite what is held:
// the device's copy is the one the lifter just touched, and §2's rule is that it wins.
//
// WHAT HAS LANDED IS THE SEAT'S; WHAT IS STILL OWED IS THE PHONE'S. A document the log is holding
// belongs to the account that stored it, so a change of seat drops it and the next read brings that
// seat's own copy back — one lifter's rack never becomes another's by sitting on their phone. A
// document still OWED has landed nowhere and this device is its only copy, so it rides: the claim
// carries it, exactly as the shelf carries unclaimed sessions and the queue carries unsent sets,
// neither of which is seat-scoped either.
//
// That symmetry is the whole rule, and getting it wrong is silent in one direction. A lifter who
// changes their bar offline and then signs out was, until this was fixed, left with the sets from
// the same minute claimed and the bar thrown away with nothing said — the analogy with the movement
// NAMES beside it does not hold, because the names that matter at a claim are the shelf's unclaimed
// ones and those ride with every seat too.
class LocalPreferences(private val file: File) {
    companion object {
        const val fileName = "windmill-gym-preferences.json"
    }

    @Serializable
    private data class Held(
        val owner: String? = null,
        val document: GymPreferences? = null,
        val owed: Boolean = false,
    )

    // A file this build cannot read opens EMPTY rather than taking the room down with it: the
    // defaults are a working gym, and the worst a lost file costs is a plate the lifter turns off
    // again.
    private var held: Held = runCatching {
        diskJson.decodeFromString(Held.serializer(), file.readText())
    }.getOrElse { Held() }

    // What the room draws. The defaults are a real answer and not a placeholder — a lifter who
    // never opens this screen trains with a 20 kg bar, a full rack and no timer.
    val document: GymPreferences get() = held.document ?: GymPreferences()

    val owed: Boolean get() = held.owed

    // The seat changing hands, and the one carry in it: a document that has landed NOWHERE rides
    // on, still owed, so the claim sends it — the anonymous rack onto the account that just signed
    // in, and equally the change a signed-in lifter made in a basement onto the seat they sign back
    // in as. A document the log is already holding is dropped instead: it is that account's, and
    // its own copy arrives on the next read.
    fun adopt(owner: String?) {
        if (held.owner == owner) return
        val carried = held.takeIf { it.owed }?.document
        hold(Held(owner = owner, document = carried, owed = carried != null))
    }

    // A row the lifter just changed. Held before the log is consulted, exactly as a set is — the
    // screen and the logger both draw from here, and a relaunch mid-flight keeps the choice.
    fun save(document: GymPreferences) {
        hold(held.copy(document = document.normalized(), owed = true))
    }

    // The log confirming it holds this. What is kept is the STORED document and never the one that
    // went out: plates come back sorted and deduplicated, and drawing the send would leave the two
    // copies disagreeing about the same rack until the next read.
    fun landed(stored: GymPreferences) {
        hold(held.copy(document = stored.normalized(), owed = false))
    }

    // The account's own document, read back. It may not overwrite something this device still owes
    // — that copy is the one the lifter just touched, and losing it here is the loss the claim
    // exists to prevent.
    fun readBack(stored: GymPreferences) {
        if (held.owed) return
        hold(held.copy(document = stored.normalized(), owed = false))
    }

    // A document the log will never take as WRITTEN — a band this build let through and the server
    // does not. It stops being owed, because a terminal write re-sent on every connect jams the
    // claim forever behind an answer that cannot change, and the loss has already been said out
    // loud. What the device keeps drawing is still what the lifter set: the account's own copy
    // replaces it on the next read, which is the honest order.
    fun letGo() {
        hold(held.copy(owed = false))
    }

    private fun hold(next: Held) {
        if (next == held) return
        held = next
        val text = runCatching { diskJson.encodeToString(Held.serializer(), next) }.getOrNull() ?: return
        writeAtomically(file, text)
    }
}
