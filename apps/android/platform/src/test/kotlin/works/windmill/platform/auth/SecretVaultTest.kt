package works.windmill.platform.auth

import java.util.Base64
import javax.crypto.KeyGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

// What has to be true for the 90-day bearer to survive leaving the phone in a backup: the bytes on
// disk are not the secret, they do not repeat, and anything that is not exactly what this vault
// wrote opens as nothing rather than as something.
//
// The KEY is the one part not proven here — on a device it comes out of the Android Keystore and
// cannot be read out of it at all, which is the whole reason a copied file decrypts nowhere else.
// This stands an ordinary AES key in its place so the format is provable on the JVM.
class SecretVaultTest {
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val vault = SecretVault { key }

    private val secret = "wm_sess_3f9c1d7b2a8e4f60b5c7d9e1a2b3c4d5"

    @Test
    fun testTheStoredBytesAreNotTheSecretAndTheSecretComesBackWhole() {
        val sealed = vault.seal(secret)!!

        assertNotEquals("the point of the whole file", secret, sealed)
        assertFalse("nor is it in there anywhere", sealed.contains(secret))
        assertFalse("nor with the encoding taken off",
            String(Base64.getDecoder().decode(sealed), Charsets.ISO_8859_1).contains(secret))
        assertEquals(secret, vault.open(sealed))
    }

    // A fresh IV every time, so two writes of the same secret are two different blobs — a file
    // whose bytes told you the secret had not changed would be telling somebody something.
    @Test
    fun testTheSameSecretSealsDifferentlyEveryTime() {
        val once = vault.seal(secret)!!
        val again = vault.seal(secret)!!

        assertNotEquals(once, again)
        assertEquals(secret, vault.open(once))
        assertEquals(secret, vault.open(again))
    }

    // Everything that is not this vault's own writing is NOTHING, and the caller reads that as no
    // secret and shows the door: a credential the app cannot read is not a credential.
    @Test
    fun testAnythingElseOpensAsNothing() {
        val sealed = vault.seal(secret)!!
        val bytes = Base64.getDecoder().decode(sealed)
        bytes[bytes.size - 1] = (bytes[bytes.size - 1] + 1).toByte()

        assertNull("a tampered blob fails the tag rather than opening as something else",
            vault.open(Base64.getEncoder().encodeToString(bytes)))
        assertNull("a blob from another device's key", SecretVault {
            KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        }.open(sealed))
        assertNull("the plaintext an older build wrote is not a sealed value", vault.open(secret))
        assertNull("nor is a truncated write", vault.open(Base64.getEncoder()
            .encodeToString(bytes.copyOf(8))))
        assertNull("nor is nothing at all", vault.open(""))
    }

    // A phone whose Keystore cannot be reached keeps NOTHING rather than falling back to plaintext
    // — the fallback is the defect this file exists to remove.
    @Test
    fun testWithNoKeyNothingIsSealedAndNothingIsOpened() {
        val keyless = SecretVault { null }

        assertNull(keyless.seal(secret))
        assertNull(keyless.open(vault.seal(secret)!!))
    }
}
