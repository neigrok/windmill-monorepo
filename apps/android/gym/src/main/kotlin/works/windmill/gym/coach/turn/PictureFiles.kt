package works.windmill.gym.coach.turn

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import kotlin.math.roundToInt
import works.windmill.gym.coach.CoachAttachment
import works.windmill.gym.coach.CoachPhotos
import works.windmill.gym.domain.coach.CoachPictureRow
import works.windmill.gym.domain.coach.CoachTurnBounds

// A picture the composer chose, as `CoachPhotos.read` made it.
class ChosenPicture(val attachment: CoachAttachment, val original: ByteArray)

// A turn's pictures on this phone (Coach §9.3): the original and its model copy as files named by the picture's id, in a folder no backup or transfer carries, while a `picture:<id>` device row holds what the engine must know. A row's bytes would reach every cursor window at engine open, so they stay here.
class PictureFiles(private val directory: () -> File) {
    // The files land first, so no row ever names a file that was not written. The model copy is made once.
    fun keep(picture: ChosenPicture): CoachPictureRow {
        val attachment = picture.attachment
        require(picture.original.size <= CoachPhotos.maxBytes && maxOf(attachment.width, attachment.height) <= CoachPhotos.maxEdge) { "A picture past the bounds" }
        val original = file(attachment.id, originalSuffix) ?: throw IOException("A picture's id cannot name a file.")
        val model = checkNotNull(file(attachment.id, modelSuffix))
        directory().mkdirs()
        if (!original.exists()) write(original, picture.original)
        if (!model.exists()) write(model, modelCopy(picture.original))
        return CoachPictureRow(attachment.id, attachment.mediaType, attachment.width, attachment.height, picture.original.size)
    }

    fun original(id: String): File? = file(id, originalSuffix)?.takeIf { it.exists() }

    // Absent for a picture held on another phone.
    fun model(id: String): ByteArray? = file(id, modelSuffix)?.takeIf { it.exists() }?.readBytes()

    // Every picture with a file here, a write the process died inside included.
    fun held(): Set<String> = directory().listFiles().orEmpty().map { it.name.substringBefore('.') }.toSet()

    // What an id matches among the files here, so no id reaches outside them.
    fun delete(ids: Collection<String>) {
        directory().listFiles().orEmpty().filter { it.name.substringBefore('.') in ids }.forEach { it.delete() }
    }

    // A picture id comes from a message record another phone may have written, so one that is not a plain name names no file here.
    private fun file(id: String, suffix: String): File? = if (fileId.matches(id)) File(directory(), "$id.$suffix") else null

    private fun write(target: File, bytes: ByteArray) {
        val written = File(target.path + ".tmp")
        written.outputStream().use { output ->
            output.write(bytes)
            output.fd.sync()
        }
        if (!written.renameTo(target)) throw IOException("A picture could not be kept.")
    }

    // §9.3: a JPEG on white, its long edge within `modelPictureEdge`, re-encoded down until it holds within `modelPictureBytes`.
    private fun modelCopy(original: ByteArray): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(original, 0, original.size, bounds)
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("A picture could not be read.")
        var sample = 1
        while (longest / (sample * 2) >= CoachTurnBounds.modelPictureEdge) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        var current: Bitmap? = null
        try {
            val decoded = BitmapFactory.decodeByteArray(original, 0, original.size, options) ?: throw IOException("A picture could not be read.")
            val edge = minOf(1f, CoachTurnBounds.modelPictureEdge.toFloat() / maxOf(decoded.width, decoded.height))
            current = decoded.onWhite(edge).also { decoded.recycle() }
            var quality = 85
            while (true) {
                val shown = checkNotNull(current)
                val output = ByteArrayOutputStream()
                check(shown.compress(Bitmap.CompressFormat.JPEG, quality, output))
                if (output.size() <= CoachTurnBounds.modelPictureBytes) return output.toByteArray()
                if (quality > 50) quality -= 15
                else {
                    current = shown.onWhite(0.8f)
                    shown.recycle()
                }
            }
        } catch (_: OutOfMemoryError) {
            throw IOException("A picture is too large to prepare.")
        } finally {
            current?.recycle()
        }
    }

    private fun Bitmap.onWhite(scale: Float): Bitmap {
        val drawn = Bitmap.createBitmap((width * scale).roundToInt().coerceAtLeast(1), (height * scale).roundToInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        Canvas(drawn).apply {
            drawColor(Color.WHITE)
            drawBitmap(this@onWhite, null, Rect(0, 0, drawn.width, drawn.height), Paint(Paint.FILTER_BITMAP_FLAG))
        }
        return drawn
    }

    companion object {
        const val modelMediaType = "image/jpeg"
        private const val originalSuffix = "original"
        private const val modelSuffix = "model"
        private val fileId = Regex("[A-Za-z0-9_-]{8,64}")
    }
}
