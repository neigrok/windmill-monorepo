package works.windmill.gym.store

import java.io.File
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimItem
import works.windmill.gym.domain.ClaimKind
import works.windmill.gym.domain.ClaimSource
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

    private val chosen = GymPreferences(units = Units.Pounds, confirmSound = true)

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
        val batch = ClaimBatch("settings-approval", held.claimItems())
        held.adopt("u1")
        assertEquals(GymPreferences(), held.document)
        assertFalse(held.owed)
        held.complete(batch, "u1")
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
    fun testASeatChangeKeepsEachAccountsConfirmedSettingsSeparate() {
        val held = LocalPreferences(file())
        held.adopt("u1")
        held.save(chosen)
        held.landed(chosen)

        held.adopt("u2")
        assertEquals(GymPreferences(), held.document)
        assertFalse(held.owed)

        held.adopt(null)
        assertEquals("and the anonymous seat is a seat like any other", GymPreferences(), held.document)
        held.adopt("u1")
        assertEquals(chosen, held.document)
        assertFalse(held.owed)
    }

    @Test
    fun testAnOwedChangeStaysWithItsOwnerAcrossSignOut() {
        val held = LocalPreferences(file())
        held.adopt("u1")
        held.save(chosen)

        held.adopt(null)
        assertEquals("signed out cannot read the previous account’s settings", GymPreferences(), held.document)
        assertFalse(held.owed)

        held.adopt("u1")
        assertEquals(chosen, held.document)
        assertTrue("and the next claim is what lands it", held.owed)
    }

    @Test
    fun testTheAccountsCopyDoesNotOverwriteAChangeThisDeviceStillOwes() {
        val held = LocalPreferences(file())
        held.adopt("u1")
        held.save(chosen)

        held.readBack(GymPreferences(confirmHaptic = false))
        assertEquals(chosen, held.document)
        assertTrue(held.owed)

        held.landed(chosen)
        held.readBack(GymPreferences(confirmHaptic = false))
        assertEquals(false, held.document.confirmHaptic)
    }

    @Test
    fun aFrozenClaimWithLegacyFieldsMovesOnlyTheRecognizedPreferencesOnce() {
        val path = file()
        val payload = """{"units":"lb","restSeconds":90,"restSound":false}"""
        path.writeText("""{"document":$payload,"owed":true}""")
        val held = LocalPreferences(path)
        val batch = ClaimBatch("legacy", listOf(ClaimItem(ClaimSource.Anonymous, ClaimKind.Preferences,
            "preferences", claimRevision(payload), payload)))
        held.adopt("owner")
        held.complete(batch, "owner")
        assertEquals(GymPreferences(units = Units.Pounds), held.document)
        assertEquals(emptyList<ClaimItem>(), held.claimItems())
        val saved = path.readText()
        held.complete(batch, "owner")
        assertEquals(saved, path.readText())
        held.adopt(null)
        assertEquals(GymPreferences(), held.document)
    }

    @Test
    fun storedRestPreferencesAreIgnoredWithoutAMigration() {
        val path = file()
        val raw = """{"document":{"restSeconds":90,"restSound":false,"units":"lb"},"owed":true}"""
        path.writeText(raw)
        val held = LocalPreferences(path)
        assertEquals(GymPreferences(units = Units.Pounds), held.document)
        assertEquals(raw, path.readText())
        held.save(held.document.copy(units = Units.Kilograms))
        assertEquals("""{"shelves":{"anon":{"document":{},"owed":true}}}""", path.readText())
    }
}
