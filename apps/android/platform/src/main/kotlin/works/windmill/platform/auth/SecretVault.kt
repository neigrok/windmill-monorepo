package works.windmill.platform.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import works.windmill.platform.telemetry.Telemetry
import java.security.KeyStore
import java.util.Base64
import java.util.Collections
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// AES-GCM under a key minted in the Android Keystore and never readable out of it.
class SecretVault(private val telemetry: Telemetry = Telemetry.None, private val key: () -> SecretKey?) {
    // A Keystore call blocks on its daemon: the key and the last secrets opened or sealed are kept, a failure is not.
    private var loaded: SecretKey? = null
    private val opened = object : LinkedHashMap<String, String>(remembered, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>) = size > remembered
    }
    private val forgotten = Collections.newSetFromMap(object : LinkedHashMap<String, Boolean>() {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>) = size > tombstones
    })

    // Sealed as `iv || ciphertext||tag`, base64.
    fun seal(plain: String): String? = withKey("session_seal") { secret ->
        val cipher = Cipher.getInstance(transformation)
        cipher.init(Cipher.ENCRYPT_MODE, secret)
        Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8)))
    }?.also { sealed -> keep(sealed, plain) }

    fun open(sealed: String): String? {
        synchronized(opened) { opened[sealed] }?.let { return it }
        return withKey("session_open") { secret ->
            val bytes = Base64.getDecoder().decode(sealed)
            require(bytes.size > ivBytes) { "Sealed session is incomplete" }
            val cipher = Cipher.getInstance(transformation)
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(tagBits, bytes, 0, ivBytes))
            String(cipher.doFinal(bytes, ivBytes, bytes.size - ivBytes), Charsets.UTF_8)
        }?.also { plain -> keep(sealed, plain) }
    }

    // For a sealed value that left storage: it is not kept again, not even by an open already in flight.
    fun forget(sealed: String) {
        synchronized(opened) { opened.remove(sealed); forgotten += sealed }
    }

    private fun keep(sealed: String, plain: String) {
        synchronized(opened) { if (sealed !in forgotten) opened[sealed] = plain }
    }

    // A failed cipher call drops the key, so the next one loads it by alias again.
    private fun <T> withKey(operation: String, work: (SecretKey) -> T): T? {
        val secret = synchronized(this) { loaded ?: key()?.also { loaded = it } } ?: return null
        return runCatching { work(secret) }
            .onFailure { synchronized(this) { if (loaded === secret) loaded = null }; telemetry.failure(operation, it) }
            .getOrNull()
    }

    companion object {
        const val alias = "works.windmill.session"

        private const val transformation = "AES/GCM/NoPadding"
        private const val ivBytes = 12
        private const val tagBits = 128
        private const val remembered = 8
        private const val tombstones = 32

        fun onThisDevice(telemetry: Telemetry = Telemetry.None): SecretVault = SecretVault(telemetry) {
            runCatching {
                val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.secretKey
                    ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                        .apply {
                            init(KeyGenParameterSpec.Builder(alias,
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                                .build())
                        }
                        .generateKey()
            }.onFailure { telemetry.failure("session_key", it) }.getOrNull()
        }
    }
}
