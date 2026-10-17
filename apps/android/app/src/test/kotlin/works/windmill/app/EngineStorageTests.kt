package works.windmill.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import java.io.IOException
import java.security.ProviderException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.platform.auth.SecretVault

// A Keystore key: its material is used inside the daemon on every cipher call, and the daemon can stop answering.
private class KeystoreKey : SecretKey {
    private val material = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().encoded
    var answers = true
    override fun getAlgorithm() = "AES"
    override fun getFormat() = "RAW"
    override fun getEncoded(): ByteArray = if (answers) material.clone() else throw ProviderException("keystore2 did not answer")
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class EngineStorageTests {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private fun preferences() = context.getSharedPreferences("works.windmill.engine", Context.MODE_PRIVATE)

    @Test fun credentialsAreSealedAndAccountIsolatedAcrossRestart() {
        preferences().edit().clear().commit()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val vault = SecretVault { key }
        val storage = EngineStorage(context, vault)
        storage.save("A", "secret-A")
        storage.save("B", "secret-B")
        assertFalse(preferences().all.values.any { it.toString().contains("secret-") })
        val restarted = EngineStorage(context, SecretVault { key })
        assertEquals(setOf("A", "B"), restarted.accounts())
        assertEquals("secret-A", restarted.token("A"))
        assertEquals("secret-B", restarted.token("B"))
        restarted.delete("A")
        assertNull(restarted.token("A"))
        assertEquals(setOf("B"), restarted.accounts())
    }

    @Test fun unavailableKeystoreCannotWriteAnUnsealedCredential() {
        preferences().edit().clear().commit()
        val storage = EngineStorage(context, SecretVault { null })
        assertThrows(IOException::class.java) { storage.save("A", "secret-A") }
        assertEquals(emptyMap<String, Any>(), preferences().all)
        assertNull(storage.token("A"))
    }

    @Test fun forkGuardSurvivesRestartWithoutBeingACredential() {
        preferences().edit().clear().commit()
        val storage = EngineStorage(context, SecretVault { null })
        storage.save("guard")
        assertEquals("guard", EngineStorage(context, SecretVault { null }).load())
        assertEquals(emptySet<String>(), storage.accounts())
    }

    @Test fun aCredentialReachesTheKeystoreOnceHoweverOftenItIsRead() {
        preferences().edit().clear().commit()
        val keystore = KeystoreKey()
        EngineStorage(context, SecretVault { keystore }).save("A", "secret-A")
        var loads = 0
        val restarted = EngineStorage(context, SecretVault { loads += 1; keystore })
        assertEquals("secret-A", restarted.token("A"))
        keystore.answers = false
        assertEquals(List(20) { "secret-A" }, List(20) { restarted.token("A") })
        assertEquals(1, loads)
    }

    @Test fun savingTheStoredCredentialAgainWritesNothing() {
        preferences().edit().clear().commit()
        val keystore = KeystoreKey()
        EngineStorage(context, SecretVault { keystore }).save("A", "secret-A")
        val sealed = preferences().getString("token.A", null)
        val restarted = EngineStorage(context, SecretVault { keystore })
        assertEquals("secret-A", restarted.token("A"))
        keystore.answers = false
        restarted.save("A", "secret-A")
        assertEquals(mapOf("token.A" to sealed), preferences().all)
        assertThrows(IOException::class.java) { restarted.save("A", "secret-B") }
        assertEquals(mapOf("token.A" to sealed), preferences().all)
    }

    @Test fun replacedAndDeletedCredentialsLeaveMemory() {
        preferences().edit().clear().commit()
        val keystore = KeystoreKey()
        val vault = SecretVault { keystore }
        val storage = EngineStorage(context, vault)
        storage.save("A", "secret-1")
        val first = preferences().getString("token.A", null)!!
        storage.save("A", "secret-2")
        val second = preferences().getString("token.A", null)!!
        keystore.answers = false
        assertEquals("the replacement reads back without the keystore", "secret-2", storage.token("A"))
        storage.delete("A")
        assertEquals(listOf(null, null), listOf(first, second).map(vault::open))
        assertNull(storage.token("A"))
        assertEquals(emptyMap<String, Any>(), preferences().all)
    }
}
