package works.windmill.gym.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// THE CARDS THAT ARE ALL CLAIM. Nothing in `ConnectedLog` computes anything — it is sentences and
// one URL — so what is worth standing behind is exactly what those sentences say about the server,
// and these are the four corrections W8 made that a later edit could quietly undo.
//
// A test that reads copy back to itself would be worth nothing, so none of these do. Each pins a
// claim that WAS ONCE DRAWN WRONG: the design's card promised a tier that gates nothing, denied a
// delete level that really does destroy a workout, drew a per-connection freshness this phone has
// never been able to observe, and — the correction review found — listed what `write` buys without
// the one tool whose effect leaves the account.
class ConnectedLogTests {
    // Every sentence the two surfaces draw, enumerated here rather than exposed as a list on the
    // object — a property that existed only for its test would be the test writing the code it
    // checks, and a sentence added without being added here is a sentence nobody looked at.
    private val everySentence = listOf(
        ConnectedLog.title,
        ConnectedLog.head,
        ConnectedLog.sub,
        ConnectedLog.sundayLabel,
        ConnectedLog.sundayLine,
        ConnectedLog.mondayLabel,
        ConnectedLog.mondayLine,
        ConnectedLog.precondition,
        ConnectedLog.connect,
        ConnectedLog.onTheWeb,
        ConnectedLog.free,
        ConnectedLog.canDoHead,
        ConnectedLog.canDo,
        ConnectedLog.cannotDoHead,
        ConnectedLog.cannotDo,
        ConnectedLog.deleteLevel,
        ConnectedLog.whereItLives,
        ConnectedLog.notNamedHere,
        ConnectedLog.deviceOnly,
    ) + ConnectedLog.truths

    // §0 OF THE WAVE. No entitlement GATES anything in gym — the tools ask no plan question and Ask
    // ships open behind a cap — and Windmill One cannot be bought at all: `paidPlansOpen()` is a
    // hardcoded false and BillingApi 503s. (The plan is read once under gym, in `aiAllowanceFor`,
    // and only to pick which monthly AI ceiling applies; that is a size and not a door, which is why
    // "gym reads no entitlement anywhere" is not the ground this test stands on.) So a tier, a price
    // or an upgrade named on these cards would be an advert for a checkout that answers 503. The
    // urgency spellings are banned beside the prices for the same reason: "free for now" and a
    // founder's rate are claims about a decision nobody has taken.
    @Test
    fun nothingOnTheseCardsNamesAPriceALockOrATier() {
        val refused = listOf(
            "windmill one", "upgrade", "subscription", "subscribe", "trial", "premium", "pro plan",
            "unlock", "per month", "/month", "$", "€", "£", "free for now", "founder", "limited time",
        )

        val offenders = everySentence.filter { sentence ->
            refused.any { sentence.lowercase().contains(it) }
        }

        assertEquals(emptyList<String>(), offenders)
        assertTrue(
            "where the price stood, the card says connecting is free",
            ConnectedLog.free.startsWith("Connecting your log is free."),
        )
    }

    // THE CLAIM THE DESIGN GOT WRONG, AND THE ONE THIS FILE MUST NOT BE "SIMPLIFIED" BACK INTO.
    // §D's grant card says a connected tool "cannot change a routine, edit a set, or delete
    // anything". The first two hold — `propose_routine_change` writes nothing, and no tool at any
    // level edits a logged set — but `discard_session` at `delete` destroys a whole workout and
    // every set in it, so the third is false the moment a lifter grants that level.
    @Test
    fun theGrantCardNamesWhatTheDeleteLevelActuallyDestroys() {
        assertTrue(
            "the delete level is named as a level of its own, never implied by write",
            ConnectedLog.deleteLevel.contains("its own level and is never implied by write"),
        )
        assertTrue(
            "and what it buys is said in the words a lifter would use",
            ConnectedLog.deleteLevel.contains("discard a whole workout"),
        )
        assertEquals(
            "no sentence claims a connection can delete nothing",
            emptyList<String>(),
            everySentence.filter { it.lowercase().contains("delete anything") },
        )
        // The other half of the same correction: `create_routine`, `log_set`, `start_session`,
        // `finish_session` and `create_exercise` all land immediately at `write`, so the design's
        // "it never writes to your program" is not a sentence this surface may repeat.
        assertEquals(
            "and none claims a connection never writes",
            emptyList<String>(),
            everySentence.filter { it.lowercase().contains("never writes") },
        )
    }

    // THE CAPABILITY THAT LEAVES THE ACCOUNT, AND THE REASON THIS TEST EXISTS AT ALL. Every other
    // tool in the catalog moves numbers around inside one lifter's own log; `share_session` mints a
    // URL that anybody holding it reads without signing in, and it sits at `write` beside `log_set`,
    // so allowing write allows it. The first draft of "What it can do" enumerated the small writes
    // and stopped — an omission in the one place a person is deciding what to hand over. Its twin
    // `revoke_share` is at `delete`, so that level takes a coach's link away as well as a workout.
    @Test
    fun theGrantCardNamesTheOneCapabilityThatLeavesTheAccount() {
        assertTrue(
            "the write list says a link is minted and who can read it",
            ConnectedLog.canDo.contains("link") && ConnectedLog.canDo.contains("without signing in"),
        )
        assertTrue(
            "and the delete level says it can end one",
            ConnectedLog.deleteLevel.contains("end a coach link"),
        )
        // The same tool named on the invitation's own bullets, because the pitch card is where most
        // lifters meet this and the two must not disagree about what a level buys.
        assertEquals(
            "one sentence of the pitch names the shared link too",
            1,
            ConnectedLog.truths.count { it.contains("link you shared") },
        )
    }

    // A FRESHNESS NOBODY OBSERVED. §D draws each client row as `connected · read 2h ago`; the
    // connections are the account's, gym never reads them, and this phone has no per-connection
    // last-read of any kind. The row says it names none — which is the omission stated rather than a
    // number invented.
    @Test
    fun thisPhoneDrawsNoConnectionStateItCannotRead() {
        assertEquals(
            emptyList<String>(),
            everySentence.filter { it.contains(" ago") || it.lowercase().contains("last read") },
        )
        assertTrue(ConnectedLog.notNamedHere.contains("does not read that list"))
    }

    // THE TWO DOORS, SPELLED OFF THE ORIGIN THIS BUILD TALKS TO — so a debug build against the local
    // stack sends a lifter to that stack and never to windmill.works. The trailing slash is the one
    // that bites: `baseUrl.toString()` on an OkHttp HttpUrl always carries one, so a naive join
    // would hand the browser `//#/connect`.
    //
    // They are two because the web keeps them apart, and pointing either at the other is a door that
    // opens the wrong page: `#/connect` is the setup snippet, and the list of connected tools with
    // its Disconnect is a section of account settings.
    @Test
    fun bothDoorsAreSpelledOffTheOriginTheAppTalksTo() {
        assertEquals("https://windmill.works/#/connect", ConnectedLog.setupUrl("https://windmill.works/"))
        assertEquals("https://windmill.works/#/connect", ConnectedLog.setupUrl("https://windmill.works"))
        assertEquals("http://10.0.2.2:8088/#/connect", ConnectedLog.setupUrl("http://10.0.2.2:8088/"))
        assertEquals("https://windmill.works/#/settings", ConnectedLog.connectionsUrl("https://windmill.works/"))
        assertEquals("http://10.0.2.2:8088/#/settings", ConnectedLog.connectionsUrl("http://10.0.2.2:8088"))
    }
}
