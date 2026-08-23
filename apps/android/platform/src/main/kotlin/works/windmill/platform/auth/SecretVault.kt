package works.windmill.platform.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// AES-GCM under a key minted in the Android Keystore and never readable out of it.
class SecretVault(private val key: () -> SecretKey?) {
    // Sealed as `iv || ciphertext||tag`, base64.
    fun seal(plain: String): String? {
        val secret = key() ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(transformation)
            cipher.init(Cipher.ENCRYPT_MODE, secret)
            val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            Base64.getEncoder().encodeToString(sealed)
        }.getOrNull()
    }

    fun open(sealed: String): String? {
        val secret = key() ?: return null
        return runCatching {
            val bytes = Base64.getDecoder().decode(sealed)
            if (bytes.size <= ivBytes) return null
            val cipher = Cipher.getInstance(transformation)
            cipher.init(Cipher.DECRYPT_MODE, secret,
                GCMParameterSpec(tagBits, bytes, 0, ivBytes))
            String(cipher.doFinal(bytes, ivBytes, bytes.size - ivBytes), Charsets.UTF_8)
        }.getOrNull()
    }

    companion object {
        const val alias = "works.windmill.session"

        private const val transformation = "AES/GCM/NoPadding"
        private const val ivBytes = 12
        private const val tagBits = 128

        fun onThisDevice(): SecretVault = SecretVault {
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
            }.getOrNull()
        }
    }
}
