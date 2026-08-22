package works.windmill.platform.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// THE WRAP AROUND THE 90-DAY BEARER, and the reason the app-private file it sleeps in was not the
// whole of the protection after all. `MODE_PRIVATE` keeps other apps out; it keeps nothing out of
// a BACKUP. Everything under this app's data directory rode Android's default backup
// participation into Google's cloud and into device-to-device transfer, and on API 26-30 `adb
// backup` pulls the same bytes off any phone with USB debugging on, no root — so the session
// secret, and the email beside it, left the device in the clear and a restore stood the account up
// on a phone it never approved. The manifest closes the transport (`allowBackup="false"` plus the
// data-extraction rules); this closes the bytes.
//
// AES-GCM under a key MINTED IN THE ANDROID KEYSTORE AND NEVER READABLE OUT OF IT, which is what
// makes the two halves independent: a file copied off this device — by a backup that predates the
// manifest change, by an image, by anything — decrypts nowhere else, because the key it needs
// stays in hardware on the phone that made it. GCM rather than CBC so a tampered blob fails to
// open rather than opening as something else.
//
// NO DEPENDENCY WAS ADDED FOR THIS. `androidx.security:security-crypto` is the usual answer and it
// is the wrong one here: the stable line is deprecated and its successor is alpha, and what it
// would buy over these forty lines is a key-wrapping scheme this app does not need for two short
// strings. The cipher is javax.crypto and the key store is the platform's.
//
// The key is a lambda so the whole of the format — the IV, the tag, the encoding — is provable on
// the JVM with an ordinary AES key, and only the four lines that reach the Keystore are not.
class SecretVault(private val key: () -> SecretKey?) {
    // Sealed as `iv || ciphertext||tag`, base64 — one string, because SharedPreferences holds
    // strings and a second key for the IV is a second thing to lose.
    fun seal(plain: String): String? {
        val secret = key() ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(transformation)
            cipher.init(Cipher.ENCRYPT_MODE, secret)
            val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            Base64.getEncoder().encodeToString(sealed)
        }.getOrNull()
    }

    // Anything that does not open is NOTHING — a blob from another device's key, a truncated
    // write, a tampered file. The caller reads that as no secret and shows the door, which is the
    // one honest answer: a credential this app cannot read is not a credential.
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

        // The key that never leaves this phone. Minted once and found again by alias afterwards;
        // a device where the Keystore cannot be reached at all yields null, and the store above it
        // then keeps nothing rather than falling back to writing the secret in the clear — the
        // fallback IS the defect.
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
