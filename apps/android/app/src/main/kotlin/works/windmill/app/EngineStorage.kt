package works.windmill.app

import android.content.Context
import android.content.SharedPreferences
import java.io.IOException
import java.security.SecureRandom
import works.windmill.platform.auth.SecretVault
import works.windmill.sync.engine.ForkGuardStore
import works.windmill.sync.engine.IdentitySource
import works.windmill.sync.engine.SessionTokens

internal class EngineStorage(context: Context, private val vault: SecretVault) : SessionTokens, ForkGuardStore {
    private val preferences: SharedPreferences = context.getSharedPreferences("works.windmill.engine", Context.MODE_PRIVATE)
    override fun token(account: String): String? = preferences.getString("token.$account", null)?.let(vault::open)
    override fun save(account: String, token: String) {
        val sealed = vault.seal(token) ?: throw IOException("The sync credential could not be sealed.")
        if (!preferences.edit().putString("token.$account", sealed).commit()) throw IOException("The sync credential could not be saved.")
    }
    override fun delete(account: String) {
        if (!preferences.edit().remove("token.$account").commit()) throw IOException("The sync credential could not be removed.")
    }
    override fun accounts(): Set<String> = preferences.all.keys.filter { it.startsWith("token.") }.map { it.removePrefix("token.") }.toSet()
    override fun load(): String? = preferences.getString("fork_guard", null)
    override fun save(value: String) {
        if (!preferences.edit().putString("fork_guard", value).commit()) throw IOException("The device guard could not be saved.")
    }
}

internal class DeviceIdentities : IdentitySource {
    private val random = SecureRandom()
    override fun opaqueID(): String = buildString { repeat(32) { append("0123456789abcdef"[random.nextInt(16)]) } }
    override fun draw(bound: Int): Int = random.nextInt(bound)
}
