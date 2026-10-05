package works.windmill.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import javax.crypto.KeyGenerator
import java.io.IOException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.platform.auth.SecretVault

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
        val restarted = EngineStorage(context, vault)
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
}
