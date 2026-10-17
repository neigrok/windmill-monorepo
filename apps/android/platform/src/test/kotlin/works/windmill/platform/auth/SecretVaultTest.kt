package works.windmill.platform.auth

import java.security.ProviderException
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test
import works.windmill.platform.telemetry.Telemetry

// A Keystore key: its material is used inside the daemon on every cipher call, and the daemon can stop answering.
internal class KeystoreKey : SecretKey {
    private val material = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().encoded
    @Volatile var answers = true
    override fun getAlgorithm() = "AES"
    override fun getFormat() = "RAW"
    override fun getEncoded(): ByteArray = if (answers) material.clone() else throw ProviderException("keystore2 did not answer")
}

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
        assertEquals("a relaunch opens it with the same key", secret, SecretVault { key }.open(sealed))
    }

    @Test
    fun testTheSameSecretSealsDifferentlyEveryTime() {
        val once = vault.seal(secret)!!
        val again = vault.seal(secret)!!
        val relaunched = SecretVault { key }

        assertNotEquals(once, again)
        assertEquals(secret, relaunched.open(once))
        assertEquals(secret, relaunched.open(again))
    }

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

    @Test
    fun testWithNoKeyNothingIsSealedAndNothingIsOpened() {
        val keyless = SecretVault { null }

        assertNull(keyless.seal(secret))
        assertNull(keyless.open(vault.seal(secret)!!))
    }

    @Test
    fun testTheKeyIsLoadedOnceForEverySealAndOpen() {
        val elsewhere = List(5) { vault.seal("secret-$it")!! }
        var loads = 0
        val counted = SecretVault { loads += 1; key }

        val opened = elsewhere.map(counted::open)
        val resealed = List(5) { counted.seal("secret-$it")!! }

        assertEquals(List(5) { "secret-$it" }, opened)
        assertEquals(List(5) { "secret-$it" }, resealed.map(vault::open))
        assertEquals(1, loads)
    }

    @Test
    fun testWhatTheVaultOpenedOrSealedIsReadAgainWithoutTheKeystore() {
        val keystore = KeystoreKey()
        val before = SecretVault { keystore }
        val opened = before.seal(secret)!!
        val neverOpened = before.seal("secret-B")!!
        val relaunched = SecretVault { keystore }
        assertEquals(secret, relaunched.open(opened))
        val sealed = relaunched.seal("secret-C")!!

        keystore.answers = false

        assertEquals(List(10) { secret }, List(10) { relaunched.open(opened) })
        assertEquals("secret-C", relaunched.open(sealed))
        assertNull("a value it never opened still needs the keystore", relaunched.open(neverOpened))
    }

    @Test
    fun testAFailedKeyLoadIsReportedAndRetriedRatherThanRemembered() {
        var loads = 0
        val flaky = SecretVault { loads += 1; if (loads == 1) null else key }

        assertNull(flaky.seal(secret))
        assertEquals(secret, flaky.open(vault.seal(secret)!!))
        assertEquals("secret-B", flaky.open(vault.seal("secret-B")!!))
        assertEquals(2, loads)

        val reports = mutableListOf<String>()
        val device = SecretVault.onThisDevice(object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { reports += operation }
        })
        // The host JVM has no AndroidKeyStore, so the device vault's key load fails here.
        assertNull(device.seal(secret))
        assertNull(device.open(vault.seal(secret)!!))
        assertEquals(listOf("session_key", "session_key"), reports)
    }

    @Test
    fun testAFailedOpenIsReportedAndRetriedRatherThanRemembered() {
        val keystore = KeystoreKey()
        val sealed = SecretVault { keystore }.seal(secret)!!
        val reports = mutableListOf<String>()
        val reported = SecretVault(object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { reports += operation }
        }) { keystore }

        keystore.answers = false
        val unanswered = List(2) { reported.open(sealed) }
        keystore.answers = true

        assertEquals(listOf(null, null), unanswered)
        assertEquals(secret, reported.open(sealed))
        assertEquals(listOf("session_open", "session_open"), reports)
    }

    @Test
    fun testAForgottenSecretNeedsTheKeystoreAgain() {
        val keystore = KeystoreKey()
        val vault = SecretVault { keystore }
        val sealed = vault.seal(secret)!!

        vault.forget(sealed)
        keystore.answers = false
        val unanswered = vault.open(sealed)
        keystore.answers = true

        assertNull(unanswered)
        assertEquals(secret, vault.open(sealed))
    }

    @Test
    fun testAForgottenSecretIsNeverKeptAgain() {
        val keystore = KeystoreKey()
        val sealed = SecretVault { keystore }.seal(secret)!!
        val vault = SecretVault { keystore }
        assertEquals(secret, vault.open(sealed))

        vault.forget(sealed)
        val reopened = vault.open(sealed)
        keystore.answers = false

        assertEquals("a reader still holding it can open it", secret, reopened)
        assertNull("but nothing keeps it", vault.open(sealed))
    }

    @Test
    fun testAFailedCipherCallDropsTheKeySoTheNextLoadsItByAliasAgain() {
        val broken = KeystoreKey().apply { answers = false }
        val handles = mutableListOf<SecretKey>(broken, key)
        val reports = mutableListOf<String>()
        val vault = SecretVault(object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) {}
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { reports += operation }
        }) { handles.removeAt(0) }
        val sealed = SecretVault { key }.seal(secret)!!

        val unanswered = vault.open(sealed)
        val reloaded = vault.open(sealed)

        assertEquals(listOf(null, secret), listOf(unanswered, reloaded))
        assertEquals(listOf("session_open"), reports)
        assertEquals("both handles were loaded", emptyList<SecretKey>(), handles)
    }

    @Test
    fun testAnOpenInFlightAcrossAForgetIsNotKept() {
        val keystore = KeystoreKey()
        val sealed = SecretVault { keystore }.seal(secret)!!
        lateinit var vault: SecretVault
        var forgotten = false
        val forgetsMidOpen = object : SecretKey by keystore {
            override fun getEncoded(): ByteArray {
                if (!forgotten) { forgotten = true; vault.forget(sealed) }
                return keystore.encoded
            }
        }
        vault = SecretVault { forgetsMidOpen }

        val inFlight = vault.open(sealed)
        keystore.answers = false

        assertEquals("the open in flight still answers", secret, inFlight)
        assertNull("but its answer is not kept past the forget", vault.open(sealed))
    }

    @Test
    fun testOpensAndForgetsFromManyThreadsAgreeAndLoadTheKeyOnce() {
        val sealed = List(4) { vault.seal("secret-$it")!! }
        val loads = AtomicInteger()
        val shared = SecretVault { loads.incrementAndGet(); Thread.sleep(50); key }
        val pool = Executors.newFixedThreadPool(9)
        val start = CountDownLatch(1)

        val readers = List(8) { pool.submit<List<String?>> { start.await(); List(200) { shared.open(sealed[it % 4]) } } }
        val forgetter = pool.submit { start.await(); repeat(200) { shared.forget(sealed[it % 4]) } }
        start.countDown()
        forgetter.get(30, TimeUnit.SECONDS)
        val read = readers.map { it.get(30, TimeUnit.SECONDS) }
        pool.shutdown()

        assertEquals(List(8) { List(200) { "secret-${it % 4}" } }, read)
        assertEquals(1, loads.get())
    }
}
