package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import works.windmill.gym.domain.ClaimConsent

/** Read-only decoder for the shipping app's durable sign-in decision. */
class LocalClaimConsent(file: File) {
    private val held = if (file.exists()) file.readText() else """{"version":1,"consent":null}"""
    init { state }
    val state: ClaimConsent? get() = decode(held)

    companion object {
        const val fileName = "windmill-gym-claim-consent.json"
        @Serializable private data class Document(val version: Int, val consent: ClaimConsent?)
        private val json = Json { encodeDefaults = true }
        fun decode(text: String): ClaimConsent? {
            val document = json.decodeFromString(Document.serializer(), works.windmill.sync.core.Json.parse(text).jcs)
            check(document.version == 1) { "The local-data decision uses an unsupported format." }
            return document.consent
        }
    }
}
