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

class LocalPreferencesTests {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun file() = File(tmp.root, "prefs-${System.nanoTime()}.json")

    private val chosen = GymPreferences(units = Units.Pounds, restSeconds = 90, restSound = false)

    @Test
    fun testAnUntouchedSeatOwesTheAccountNothing() {
        val held = LocalPreferences(file())
        assertEquals(GymPreferences(), held.document)
        assertFalse(held.owed)
    }

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

    @Test
    fun testAnAnonymousRoomRidesOntoTheAccountThatClaimsIt() {
        val held = LocalPreferences(file())
        held.save(chosen)
        held.adopt("u1")
        assertEquals(chosen, held.document)
        assertTrue("still owed — the log has not taken it yet", held.owed)
    }

    @Test
    fun testAnUntouchedPhoneCarriesNothingOntoTheAccountItSignsInTo() {
        val held = LocalPreferences(file())
        held.adopt("u1")
        assertFalse(held.owed)
    }

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

    @Test
    fun testWhatIsKeptIsWhatTheLogStoredRatherThanWhatWentOut() {
        val held = LocalPreferences(file())
        held.save(GymPreferences(restSeconds = 4_000))
        assertEquals(GymPreferences.maxRestSeconds, held.document.restSeconds)
    }
}
