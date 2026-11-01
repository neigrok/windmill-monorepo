package works.windmill.gym.coach

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import android.net.Uri
import java.io.ByteArrayOutputStream
import java.io.IOException
import works.windmill.gym.presentation.Ids

object CoachPhotos {
    const val maxBytes = 5 * 1024 * 1024
    const val maxEdge = 4096
    // An upright copy holds a second bitmap of the same size, so the decoded pixels are bounded before it is made.
    const val maxDecodedPixels = 12L * 1024 * 1024

    fun read(resolver: ContentResolver, uri: Uri, maxBytes: Int = CoachPhotos.maxBytes,
        maxEdge: Int = CoachPhotos.maxEdge): Pair<CoachAttachment, ByteArray> {
        require(maxBytes >= 1024 && maxEdge >= 1)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Choose a supported photo." }
        var sample = 1
        while (bounds.outWidth / sample > maxEdge || bounds.outHeight / sample > maxEdge ||
            (bounds.outWidth / sample).toLong() * (bounds.outHeight / sample) > maxDecodedPixels) sample *= 2
        val orientation = runCatching { resolver.openInputStream(uri)?.use {
            ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } }.getOrNull()
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(270f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(270f)
            }
        }
        val png = bounds.outMimeType == "image/png"
        var bitmap: Bitmap? = null
        try {
            bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
                ?: throw IllegalArgumentException("Choose a supported photo.")
            if (!matrix.isIdentity) {
                val decoded: Bitmap = bitmap
                val upright = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
                if (upright !== decoded) decoded.recycle()
                bitmap = upright
            }
            if (!png && bitmap.hasAlpha()) {
                val transparent: Bitmap = bitmap
                val opaque = Bitmap.createBitmap(transparent.width, transparent.height, Bitmap.Config.ARGB_8888)
                Canvas(opaque).apply { drawColor(Color.WHITE); drawBitmap(transparent, 0f, 0f, null) }
                transparent.recycle()
                bitmap = opaque
            }
            while (true) {
                val current = checkNotNull(bitmap)
                val output = ByteArrayOutputStream()
                check(current.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 88, output))
                val bytes = output.toByteArray()
                if (bytes.size <= maxBytes) return CoachAttachment(Ids.thread(), if (png) "image/png" else "image/jpeg",
                    current.width, current.height, bytes.size.toLong()) to bytes
                val smaller = Bitmap.createScaledBitmap(current, (current.width * 0.8).toInt().coerceAtLeast(1),
                    (current.height * 0.8).toInt().coerceAtLeast(1), true)
                current.recycle()
                bitmap = smaller
            }
        } catch (_: OutOfMemoryError) {
            throw IOException("The photo is too large to prepare.")
        } finally { bitmap?.recycle() }
    }
}
