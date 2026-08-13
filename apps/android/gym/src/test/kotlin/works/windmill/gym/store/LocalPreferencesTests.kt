package works.windmill.gym.store

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import works.windmill.gym.domain.GymPreferences
import works.windmill.gym.domain.Units

// WHOSE SETTINGS THESE ARE, and when they are owed. Two losses live in this file and both are
// silent if it is wrong: an anonymous lifter's rack thrown away by the sign-in that was supposed to
// claim it, and an account's rack overwritten by a phone that never opened the screen.

class LocalPreferencesTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun file() = File(tmp.root, "prefs-${System.nanoTime()}.json")

    private val chosen = GymPreferences(units = Units.Pounds, restSeconds = 90, restSound = false)

    // A seat that never opened the screen is served the defaults and owes NOTHING. This is the
    // whole reason the document is nullable one level up: at its defaults it encodes as `{}`, so
    // the bytes cannot tell "the lifter chose these" from "nobody has touched this" — and the
    // difference is whether the claim overwrites an account's real settings with them.
    @Test
    fun testAnUntouchedSeatOwesTheAccountNothing() {
        val held = LocalPreferences(file())
        assertEquals(GymPreferences(), held.document)
        assertFalse(held.owed)
    }

    // ...and a lifter who deliberately set every row BACK to the defaults owes them, because they
    // touched it. Same bytes, different fact, and the fact survives a relaunch.
    @Test
    fun testASeatThatChoseTheDefaultsStillOwesThem() {
        val path = file()
        LocalPreferences(path).save(GymPreferences())
        val relaunched = LocalPreferences(path)
        assertEquals(GymPreferences(), relaunched.document)
        assertTrue("the choice survives a relaunch as a choice", relaunched.owed)
    }

    @Test
    fun testWhatWasSetSurvivesARelaunchAndIsOwedUntilTheLogTakesIt() {
        val path = file()
        LocalPreferences(path).save(chosen)
        val relaunched = LocalPreferences(path)
        assertEquals(chosen, relaunched.document)
        assertTrue(relaunched.owed)

        relaunched.landed(chosen)
        assertFalse(relaunched.owed)
        assertEquals(chosen, LocalPreferences(path).document)
    }

    // The claim's carry: a room set up before signing in becomes the account's, still owed, so the
    // next pass sends it. A lifter who set their rest before signing in must not lose it.
    @Test
    fun testAnAnonymousRoomRidesOntoTheAccountThatClaimsIt() {
        val held = LocalPreferences(file())
        held.save(chosen)
        held.adopt("u1")
        assertEquals(chosen, held.document)
        assertTrue("still owed — the log has not taken it yet", held.owed)
    }

    // And the other direction, which is the loss nobody would see: a phone whose settings screen
    // was never opened signs in and must send NOTHING, or an account's real rack is replaced by
    // untouched defaults.
    @Test
    fun testAnUntouchedPhoneCarriesNothingOntoTheAccountItSignsInTo() {
        val held = LocalPreferences(file())
        held.adopt("u1")
        assertFalse(held.owed)
    }

    // A RACK THE LOG IS HOLDING IS THE SEAT'S. One lifter's stored settings may not follow another
    // into the room: the account that stored them owns them, and the next read brings the arriving
    // seat's own copy. What is still OWED is the other half of this rule and has its own test below.
    @Test
    fun testASeatChangeDropsWhatTheLogIsAlreadyHolding() {
        val held = LocalPreferences(file())
        held.adopt("u1")
        held.save(chosen)
        held.landed(chosen)

        held.adopt("u2")
        assertEquals(GymPreferences(), held.document)
        assertFalse(held.owed)

        held.adopt(null)
        assertEquals("and the anonymous seat is a seat like any other", GymPreferences(), held.document)
    }

    // ...AND WHAT IS STILL OWED SURVIVES THE SEAT, in both directions, because it has landed
    // nowhere and this device is its only copy. A lifter who changes their bar in a basement and
    // then signs out kept the sets they logged in the same minute — the queue and the shelf are not
    // seat-scoped — and losing the bar alone would be a silent loss with nothing said. It rides
    // out on the sign-out and back in on the sign-in, still owed, and the claim sends it.
    @Test
    fun testAChangeThatLandedNowhereRidesThroughASignOut() {
        val held = LocalPreferences(file())
        held.adopt("u1")
        held.save(chosen)

        held.adopt(null)
        assertEquals("nothing was thrown away at the door", chosen, held.document)
        assertTrue(held.owed)

        held.adopt("u1")
        assertEquals(chosen, held.document)
        assertTrue("and the next claim is what lands it", held.owed)
    }

    // THE READ MAY NOT LAND ON TOP OF WHAT IS OWED. The account's document and a change the lifter
    // just made arrive in the same breath on connect, and the one they touched wins — §2's rule,
    // enforced here rather than by whoever happens to call in which order.
    @Test
    fun testTheAccountsCopyDoesNotOverwriteAChangeThisDeviceStillOwes() {
        val held = LocalPreferences(file())
        held.adopt("u1")
        held.save(chosen)

        held.readBack(GymPreferences(restSeconds = 180))
        assertEquals(chosen, held.document)
        assertTrue(held.owed)

        held.landed(chosen)
        held.readBack(GymPreferences(restSeconds = 180))
        assertEquals(180, held.document.restSeconds)
    }

    // What is kept is the STORED document and never the send: the log clamps a rest target into its
    // band, and a device drawing its own send would disagree with the account about the same room.
    @Test
    fun testWhatIsKeptIsWhatTheLogStoredRatherThanWhatWentOut() {
        val held = LocalPreferences(file())
        held.save(GymPreferences(restSeconds = 4_000))
        assertEquals(GymPreferences.maxRestSeconds, held.document.restSeconds)
    }
}
