package works.windmill.platform.storage

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

object AtomicDocument {
    fun write(file: File, text: String) {
        val parent = file.absoluteFile.parentFile ?: throw IOException("The saved document has no parent folder.")
        if (!parent.isDirectory && !parent.mkdirs()) throw IOException("The saved document folder could not be created.")
        val temporary = File(parent, file.name + ".tmp")
        FileOutputStream(temporary).use { stream ->
            stream.write(text.toByteArray(Charsets.UTF_8))
            stream.fd.sync()
        }
        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        FileChannel.open(parent.toPath(), StandardOpenOption.READ).use { it.force(true) }
    }
}
