package works.windmill.platform.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import works.windmill.platform.telemetry.Telemetry
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// AES-GCM under a key minted in the Android Keystore and never readable out of it.
class SecretVault(private val telemetry: Telemetry = Telemetry.None, private val key: () -> SecretKey?) {
    constructor(key: () -> SecretKey?) : this(Telemetry.None, key)

    // A Keystore call blocks on its daemon: the key and each opened or sealed secret are kept, a failure is not.
    private var loaded: SecretKey? = null
    private val secret: SecretKey? get() = synchronized(this) { loaded ?: key()?.also { loaded = it } }
    private val opened = object : LinkedHashMap<String, String>(remembered, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>) = size > remembered
    }
    private var forgets = 0

    // Sealed as `iv || ciphertext||tag`, base64.
    fun seal(plain: String): String? {
        val secret = secret ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(transformation)
            cipher.init(Cipher.ENCRYPT_MODE, secret)
            val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            Base64.getEncoder().encodeToString(sealed)
        }.onFailure { telemetry.failure("session_seal", it) }.getOrNull()
            ?.also { sealed -> synchronized(opened) { opened[sealed] = plain } }
    }

    fun open(sealed: String): String? {
        val (known, since) = synchronized(opened) { opened[sealed] to forgets }
        if (known != null) return known
        val secret = secret ?: return null
        return runCatching {
            val bytes = Base64.getDecoder().decode(sealed)
            require(bytes.size > ivBytes) { "Sealed session is incomplete" }
            val cipher = Cipher.getInstance(transformation)
            cipher.init(Cipher.DECRYPT_MODE, secret,
                GCMParameterSpec(tagBits, bytes, 0, ivBytes))
            String(cipher.doFinal(bytes, ivBytes, bytes.size - ivBytes), Charsets.UTF_8)
        }.onFailure { telemetry.failure("session_open", it) }.getOrNull()
            ?.also { plain -> synchronized(opened) { if (forgets == since) opened[sealed] = plain } }
    }

    // For a sealed value that left storage; an open in flight across any forget is not kept.
    fun forget(sealed: String) {
        synchronized(opened) { opened.remove(sealed); forgets += 1 }
    }

    companion object {
        const val alias = "works.windmill.session"

        private const val transformation = "AES/GCM/NoPadding"
        private const val ivBytes = 12
        private const val tagBits = 128
        private const val remembered = 8

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
