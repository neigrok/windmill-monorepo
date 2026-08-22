package works.windmill.platform.auth

import javax.crypto.KeyGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import works.windmill.platform.User

// What has to be true of the file the 90-day bearer sleeps in: nothing in it is the secret, a
// phone whose Keystore refuses writes NOTHING rather than falling back to plaintext, and an install
// upgrading off a build that wrote cleartext carries its seat across and leaves no cleartext behind.
//
// The file is a seam (`KeptValues`) because SharedPreferences needs a device and `:platform` carries
// no Robolectric. What is NOT proven here is that the Android side of that seam commits what it is
// given — six lines of `edit()` in `SharedPrefsValues` — and that the Keystore hands back a key.
class PrefsSessionsTest {
    private class FakeValues(vararg seeded: Pair<String, String>) : KeptValues {
        val held = seeded.toMap().toMutableMap()

        override fun read(key: String): String? = held[key]

        override fun write(values: Map<String, String?>) {
            for ((key, value) in values) {
                if (value == null) held.remove(key) else held[key] = value
            }
        }
    }

    private val vault = SecretVault(keyOnce)

    private val secret = "wm_sess_3f9c1d7b2a8e4f60b5c7d9e1a2b3c4d5"
    private val sam = User(id = "u_1", email = "sam@example.com", name = "Sam")

    @Test
    fun testNothingInTheFileIsTheSecretOrTheAddressAndBothComeBackWhole() {
        val values = FakeValues()
        val sessions = PrefsSessions(values, vault)

        sessions.write(secret)
        sessions.remember(sam)

        assertFalse("the secret is not in the file under any key",
            values.held.values.any { it.contains(secret) })
        assertFalse("nor is the address", values.held.values.any { it.contains("sam@example.com") })
        assertEquals(secret, sessions.read())
        assertEquals(sam, sessions.user())
        assertEquals("and a relaunch reads the same file", secret, PrefsSessions(values, vault).read())
    }

    // The upgrade off a build that wrote cleartext: the seat survives it — signing every lifter out
    // to change how a secret is kept would be a worse product — and the cleartext does not.
    @Test
    fun testAnOlderBuildsPlaintextIsCarriedAcrossAndRemoved() {
        val values = FakeValues(
            "wm_session" to secret,
            "wm_user" to """{"id":"u_1","email":"sam@example.com","name":"Sam"}""")
        val sessions = PrefsSessions(values, vault)

        assertEquals("the lifter is still signed in", secret, sessions.read())
        assertEquals(sam, sessions.user())

        assertFalse("and the cleartext is gone", values.held.containsKey("wm_session"))
        assertFalse(values.held.containsKey("wm_user"))
        assertTrue(values.held.containsKey("wm_session.sealed"))
        assertFalse("with nothing readable left behind",
            values.held.values.any { it.contains(secret) || it.contains("sam@example.com") })
        assertEquals("read back through the seal from then on", secret,
            PrefsSessions(values, vault).read())
    }

    // A phone whose Keystore refuses keeps NOTHING. The fallback — writing it in the clear — is the
    // defect, and it would land on exactly the devices least able to afford it.
    @Test
    fun testWithNoKeyNothingIsWrittenRatherThanPlaintext() {
        val values = FakeValues()
        val keyless = PrefsSessions(values, SecretVault { null })

        keyless.write(secret)
        keyless.remember(sam)

        assertEquals("nothing was kept at all", emptyMap<String, String>(), values.held)
        assertNull(keyless.read())
        assertNull(keyless.user())
    }

    // A spent secret leaves no seat behind it — and no half of one under an older build's key.
    @Test
    fun testClearTakesBothHalvesAndTheOlderBuildsKeysWithThem() {
        val values = FakeValues("wm_session" to secret, "wm_user" to """{"id":"u_1","email":"s@e.c"}""")
        val sessions = PrefsSessions(values, vault)
        sessions.write(secret)
        sessions.remember(sam)

        sessions.clear()

        assertEquals(emptyMap<String, String>(), values.held)
        assertNull(sessions.read())
        assertNull(sessions.user())
    }

    private companion object {
        // One key for the whole class: a vault that minted a fresh key per call could never open
        // what it had just sealed, and every assertion above would pass for the wrong reason.
        val keyOnce = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().let { { it } }
    }
}
