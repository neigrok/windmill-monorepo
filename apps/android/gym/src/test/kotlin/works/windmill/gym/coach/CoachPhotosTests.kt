package works.windmill.gym.coach

import works.windmill.gym.store.*
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.exifinterface.media.ExifInterface
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.presentation.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CoachPhotosTests {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun encodedPhotoIsUprightAndWithinTheServersPixelAndByteLimits() {
        val file = File(tmp.root, "photo.jpg")
        val bitmap = Bitmap.createBitmap(4100, 100, Bitmap.Config.ARGB_8888)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        bitmap.recycle()
        ExifInterface(file).apply { setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString()); saveAttributes() }
        val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
        val (photo, bytes) = CoachPhotos.read(resolver, Uri.fromFile(file))
        val decoded = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
        assertEquals("image/jpeg", photo.mediaType)
        assertEquals(decoded.width, photo.width)
        assertEquals(decoded.height, photo.height)
        assertTrue(photo.height > photo.width)
        assertTrue(photo.width <= 4096 && photo.height <= 4096)
        assertTrue(photo.width.toLong() * photo.height <= 16_777_216)
        assertEquals(bytes.size.toLong(), photo.bytes)
        assertTrue(bytes.size <= 5 * 1024 * 1024)
        decoded.recycle()
    }

    @Test
    fun aLocatedPhotoLeavesWithoutItsLocationOrCamera() {
        val file = File(tmp.root, "located.jpg")
        val bitmap = Bitmap.createBitmap(320, 200, Bitmap.Config.ARGB_8888).apply { eraseColor(0xff336699.toInt()) }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        bitmap.recycle()
        ExifInterface(file.absolutePath).apply {
            setAttribute(ExifInterface.TAG_GPS_LATITUDE, "51/1,30/1,0/1"); setAttribute(ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            setAttribute(ExifInterface.TAG_MAKE, "FixtureCam")
            saveAttributes()
        }
        val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
        val (_, bytes) = CoachPhotos.read(resolver, Uri.fromFile(file), 1024 * 1024, 4096)
        val out = File(tmp.root, "out.jpg").apply { writeBytes(bytes) }
        assertNull(ExifInterface(out.absolutePath).getAttribute(ExifInterface.TAG_GPS_LATITUDE))
        assertFalse(String(bytes, Charsets.ISO_8859_1).contains("FixtureCam"))
    }

    @Test
    fun aLargeRotatedPhotoIsDecodedWithinThePixelBudgetBeforeItIsTurnedUpright() {
        val file = File(tmp.root, "large.jpg")
        val bitmap = Bitmap.createBitmap(4000, 3600, Bitmap.Config.ARGB_8888)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 80, it) }
        bitmap.recycle()
        ExifInterface(file).apply { setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_ROTATE_90.toString()); saveAttributes() }
        val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
        val (photo, _) = CoachPhotos.read(resolver, Uri.fromFile(file))
        assertEquals(1800 to 2000, photo.width to photo.height)
        assertTrue(photo.width.toLong() * photo.height <= CoachPhotos.maxDecodedPixels)
    }

    @Test
    fun corruptInputDoesNotProduceAnAttachment() {
        val file = File(tmp.root, "invalid").apply { writeText("not a photo") }
        val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
        assertThrows(IllegalArgumentException::class.java) { CoachPhotos.read(resolver, Uri.fromFile(file)) }
    }

    @Test
    fun unresolvedDraftPhotoAndRequestSurviveRestartOnlyForTheirOwnerThenAreRemovedTogether() {
        val file = File(tmp.root, "coach")
        val photo = CoachAttachment("attachment-a", "image/png", 1, 1, 4)
        val bytes = byteArrayOf(1, 2, 3, 4)
        val draft = CoachDraft("Caption", photo)
        val request = AskQuestion("thread-a", "Caption", "request-a", listOf(photo.id))
        LocalCoach(file).apply { savePhoto("a", photo.id, bytes); saveDraft("a", "thread-a", draft); keep("a", request) }
        val restored = LocalCoach(file)
        assertEquals(draft, restored.draft("a", "thread-a"))
        assertEquals(CoachDraft(), restored.draft("b", "thread-a"))
        assertArrayEquals(bytes, restored.photoFile("a", photo.id).readBytes())
        assertFalse(restored.photoFile("b", photo.id).exists())
        restored.saveDraft("a", "thread-a", CoachDraft())
        assertTrue(restored.photoFile("a", photo.id).exists())
        restored.clear("a", "thread-a", "request-a")
        assertFalse(restored.photoFile("a", photo.id).exists())
        assertEquals(emptyList<AskQuestion>(), LocalCoach(file).pending("a"))
    }
}
