package works.windmill.app

import android.content.Context
import android.content.ContextWrapper
import android.os.Looper
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyStore
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.SecureRandom
import java.security.Security
import java.security.cert.Certificate
import java.security.spec.AlgorithmParameterSpec
import java.util.Collections
import java.util.Date
import java.util.Enumeration
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.KeyGenerator
import javax.crypto.KeyGeneratorSpi
import javax.crypto.SecretKey
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import works.windmill.gym.store.GymEngineSession
import works.windmill.platform.User
import works.windmill.platform.auth.AuthStatus
import works.windmill.platform.auth.AuthStore
import works.windmill.platform.auth.LocalSession
import works.windmill.platform.auth.PrefsSessions
import works.windmill.platform.auth.SecretVault
import works.windmill.platform.telemetry.Telemetry
import works.windmill.sync.core.Json
import works.windmill.sync.engine.AndroidClock
import works.windmill.sync.engine.AndroidSqlite
import works.windmill.sync.engine.Engine
import works.windmill.sync.engine.LiveConnection
import works.windmill.sync.engine.Reply
import works.windmill.sync.engine.SyncResponse
import works.windmill.sync.engine.SyncRuntime
import works.windmill.sync.engine.SyncTransport
import works.windmill.sync.engine.signIn
import works.windmill.sync.schema.SyncSchema

// keystore2 as a provider named AndroidKeyStore, so SecretVault.onThisDevice runs its real code; each call notes if it ran on main.
private class Keystore2 : Provider("AndroidKeyStore", 1.0, "keystore2 stand-in") {
    val calls = CopyOnWriteArrayList<Pair<String, Boolean>>()
    private val material = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().encoded
    @Volatile private var minted = false

    private fun record(call: String) { calls += call to Looper.getMainLooper().isCurrentThread }
    private fun key(): SecretKey = object : SecretKey {
        override fun getAlgorithm() = "AES"
        override fun getFormat() = "RAW"
        override fun getEncoded(): ByteArray { record("cipher"); return material.clone() }
    }

    init {
        putService(object : Service(this, "KeyStore", "AndroidKeyStore", "keystore2", null, null) {
            override fun newInstance(constructorParameter: Any?): Any = object : KeyStoreSpi() {
                override fun engineLoad(stream: InputStream?, password: CharArray?) {}
                override fun engineGetEntry(alias: String?, protection: KeyStore.ProtectionParameter?): KeyStore.Entry? {
                    record("key")
                    return if (minted) KeyStore.SecretKeyEntry(key()) else null
                }
                override fun engineGetKey(alias: String?, password: CharArray?): Key? = null
                override fun engineGetCertificateChain(alias: String?): Array<Certificate>? = null
                override fun engineGetCertificate(alias: String?): Certificate? = null
                override fun engineGetCreationDate(alias: String?): Date? = null
                override fun engineSetKeyEntry(alias: String?, key: Key?, password: CharArray?, chain: Array<out Certificate>?) {}
                override fun engineSetKeyEntry(alias: String?, key: ByteArray?, chain: Array<out Certificate>?) {}
                override fun engineSetCertificateEntry(alias: String?, cert: Certificate?) {}
                override fun engineDeleteEntry(alias: String?) {}
                override fun engineAliases(): Enumeration<String> = Collections.emptyEnumeration()
                override fun engineContainsAlias(alias: String?) = minted
                override fun engineSize() = if (minted) 1 else 0
                override fun engineIsKeyEntry(alias: String?) = minted
                override fun engineIsCertificateEntry(alias: String?) = false
                override fun engineGetCertificateAlias(cert: Certificate?): String? = null
                override fun engineStore(stream: OutputStream?, password: CharArray?) {}
            }
        })
        putService(object : Service(this, "KeyGenerator", "AES", "keystore2", null, null) {
            override fun newInstance(constructorParameter: Any?): Any = object : KeyGeneratorSpi() {
                override fun engineInit(random: SecureRandom?) {}
                override fun engineInit(params: AlgorithmParameterSpec?, random: SecureRandom?) {}
                override fun engineInit(keysize: Int, random: SecureRandom?) {}
                override fun engineGenerateKey(): SecretKey { minted = true; return key() }
            }
        })
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class WindmillApplicationTests {
    private val sam = User("sam", "sam@example.com")

    @Test fun aSignedInColdStartLoadsTheKeyOnceAndOpensTheAccountAndTheSyncCredentialOnMain() {
        val keystore = Keystore2()
        Security.addProvider(keystore)
        try {
            val host = RuntimeEnvironment.getApplication()
            val previousRun = SecretVault.onThisDevice()
            PrefsSessions(host, previousRun, Telemetry.None).commit("secret-sam", sam)
            EngineStorage(host, previousRun).save("sam", "secret-sam")
            val bound = Engine.memory(SyncSchema.registry).use { it.signIn("sam", mapOf("gym" to false)); it.snapshot() }
            AndroidSqlite.open(File(host.filesDir, "sync-replica.sqlite"), SyncSchema.registry, bound, AndroidClock(host),
                DeviceIdentities(), "r_000000000000").close()
            val app = WindmillApplication()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
                .apply { isAccessible = true }.invoke(app, host.baseContext)
            keystore.calls.clear()

            app.onCreate()

            assertEquals(listOf("key", "cipher", "cipher"), keystore.calls.filter { it.second }.map { it.first })
            assertEquals(LocalSession.Owned(sam), app.auth.localSession)
            app.onTerminate()
        } finally { Security.removeProvider("AndroidKeyStore") }
    }

    @Test fun anOnlineRestoreOfTheUnchangedAccountNeverReachesTheKeystore() = runBlocking {
        val keystore = Keystore2()
        Security.addProvider(keystore)
        try {
            val host = RuntimeEnvironment.getApplication()
            val previousRun = SecretVault.onThisDevice()
            PrefsSessions(host, previousRun, Telemetry.None).commit("secret-sam", sam)
            EngineStorage(host, previousRun).save("sam", "secret-sam")
            val bound = Engine.memory(SyncSchema.registry).use { it.signIn("sam", mapOf("gym" to false)); it.snapshot() }
            val unreachable = object : SyncTransport {
                override suspend fun hello(token: String?): Reply<SyncResponse> = Reply.Unreachable
                override suspend fun push(request: Json, token: String): Reply<SyncResponse> = Reply.Unreachable
                override suspend fun pull(request: Json, token: String?): Reply<SyncResponse> = Reply.Unreachable
                override suspend fun openLive(token: String): Reply<LiveConnection> = Reply.Unreachable
            }
            val vault = SecretVault.onThisDevice()
            val sessions = PrefsSessions(host, vault, Telemetry.None)
            val tokens = EngineStorage(host, vault)
            Engine.memory(SyncSchema.registry, bound).use { engine ->
                SyncRuntime(engine, unreachable, tokens, "test", products = listOf("gym")).use { runtime ->
                    MockWebServer().use { server ->
                        server.enqueue(MockResponse().setBody("""{"user":{"id":"sam","email":"sam@example.com"}}"""))
                        val auth = AuthStore(server.url("/"), sessions, lifecycle = GymEngineSession(engine, runtime))
                        assertEquals(LocalSession.Owned(sam), sessions.localSession)
                        runtime.launch(tokens)
                        keystore.calls.clear()

                        auth.restore()

                        assertEquals(AuthStatus.SignedIn(sam) to emptyList<Pair<String, Boolean>>(), auth.status to keystore.calls.toList())
                    }
                }
            }
        } finally { Security.removeProvider("AndroidKeyStore") }
    }
}
