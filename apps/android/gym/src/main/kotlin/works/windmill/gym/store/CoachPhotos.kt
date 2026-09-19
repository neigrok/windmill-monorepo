package works.windmill.gym.store

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import java.io.ByteArrayOutputStream
import works.windmill.gym.domain.CoachAttachment
import works.windmill.gym.domain.Ids

object CoachPhotos {
    const val maxBytes = 5 * 1024 * 1024
    const val maxEdge = 4096

    fun read(resolver: ContentResolver, uri: Uri): Pair<CoachAttachment, ByteArray> {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Choose a supported photo." }
        var sample = 1
        while (bounds.outWidth / sample > maxEdge || bounds.outHeight / sample > maxEdge) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        var bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
            ?: throw IllegalArgumentException("Choose a supported photo.")
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
        if (!matrix.isIdentity) {
            val upright = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            if (upright !== bitmap) bitmap.recycle()
            bitmap = upright
        }
        val png = bounds.outMimeType == "image/png"
        if (!png && bitmap.hasAlpha()) {
            val opaque = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
            Canvas(opaque).apply { drawColor(Color.WHITE); drawBitmap(bitmap, 0f, 0f, null) }
            bitmap.recycle()
            bitmap = opaque
        }
        try {
            while (true) {
                val output = ByteArrayOutputStream()
                check(bitmap.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 88, output))
                val bytes = output.toByteArray()
                if (bytes.size <= maxBytes) return CoachAttachment(Ids.thread(), if (png) "image/png" else "image/jpeg",
                    bitmap.width, bitmap.height, bytes.size.toLong()) to bytes
                val smaller = Bitmap.createScaledBitmap(bitmap, (bitmap.width * 0.8).toInt().coerceAtLeast(1),
                    (bitmap.height * 0.8).toInt().coerceAtLeast(1), true)
                bitmap.recycle()
                bitmap = smaller
            }
        } finally { bitmap.recycle() }
    }
}
