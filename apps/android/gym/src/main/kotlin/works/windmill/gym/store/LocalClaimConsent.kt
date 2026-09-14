package works.windmill.gym.store

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import works.windmill.gym.domain.ClaimBatch
import works.windmill.gym.domain.ClaimConsent

class LocalClaimConsent internal constructor(
    private val file: File,
    private val write: (File, String) -> Unit,
) {
    constructor(file: File) : this(file, ::persistClaimConsent)

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

internal fun persistClaimConsent(file: File, text: String) {
    val parent = file.absoluteFile.parentFile ?: throw IOException("The local-data decision has no parent folder.")
    if (!parent.isDirectory && !parent.mkdirs()) throw IOException("The local-data decision folder could not be created.")
    val temporary = File(parent, file.name + ".tmp")
    FileOutputStream(temporary).use { stream ->
        stream.write(text.toByteArray(Charsets.UTF_8))
        stream.fd.sync()
    }
    Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    FileChannel.open(parent.toPath(), StandardOpenOption.READ).use { it.force(true) }
}
