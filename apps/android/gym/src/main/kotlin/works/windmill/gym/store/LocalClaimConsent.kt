package works.windmill.gym.store

import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimConsent
import works.windmill.platform.storage.AtomicDocument

class LocalClaimConsent internal constructor(
    private val file: File,
    private val write: (File, String) -> Unit,
) {
    constructor(file: File) : this(file, AtomicDocument::write)

    companion object { const val fileName = "windmill-gym-claim-consent.json" }

    @Serializable
    private data class Document(val version: Int, val consent: ClaimConsent?)

    private val json = Json { encodeDefaults = true }
    private var failed = false
    private var held: String = if (file.exists()) file.readText()
        else json.encodeToString(Document.serializer(), Document(1, null))

    init { state }

    val state: ClaimConsent?
        @Synchronized get() {
            check(!failed) { "Reopen the local-data decision after a failed disk write." }
            val document = json.decodeFromString(Document.serializer(), held)
            check(document.version == 1) { "The local-data decision uses an unsupported format." }
            return document.consent
        }

    @Synchronized
    fun requestSignIn(batch: ClaimBatch, flowId: String) = keep(ClaimConsent.requestSignIn(state, batch, flowId))

    @Synchronized
    fun approve(batch: ClaimBatch, owner: String, flowId: String? = null) = keep(ClaimConsent.approve(state, batch, owner, flowId))

    @Synchronized
    fun discard(batch: ClaimBatch) = keep(ClaimConsent.discard(state, batch))

    @Synchronized
    fun complete(batchId: String) = keep(ClaimConsent.complete(state, batchId))

    private fun keep(next: ClaimConsent?) {
        if (next == state) return
        val text = json.encodeToString(Document.serializer(), Document(1, next))
        try {
            write(file, text)
        } catch (failure: Exception) {
            failed = true
            throw failure
        }
        held = text
    }
}
