package works.windmill.gym.coach.onboarding

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import works.windmill.gym.coach.CoachPhotos
import works.windmill.platform.net.WindmillJson

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CoachOnboardingLimitsTests {
    @get:Rule val temporary = TemporaryFolder()
    private val request = CoachOnboardingRequest("11111111-1111-4111-8111-111111111111", "conversation", "whole question", emptyList())

    @Test fun requiredModeAndEmptyContextAreOnTheWireAndTheEntireUtf8DraftIsRetained() {
        assertEquals("{\"requestId\":\"11111111-1111-4111-8111-111111111111\",\"mode\":\"conversation\",\"text\":\"whole question\",\"context\":[]}",
            WindmillJson.encodeToString(CoachOnboardingRequest.serializer(), request))
        assertNull(CoachOnboardingLimits.violation(request.copy(text = "é".repeat(2000))))
        val whole = request.copy(text = "é".repeat(2001))
        assertEquals(CoachOnboardingLimit.text, CoachOnboardingLimits.violation(whole))
        assertEquals("é".repeat(2001), whole.text)
        assertEquals(CoachOnboardingLimit.invalidInput, CoachOnboardingLimits.violation(request.copy(text = " ")))
        assertEquals(CoachOnboardingLimit.invalidInput, CoachOnboardingLimits.violation(request.copy(requestId = request.requestId.replace('1', 'a').uppercase())))
    }

    @Test fun contextEnforcesPerMessageTurnAndTotalByteLimitsWithoutTruncating() {
        val exactly = List(4) { CoachOnboardingContext(if (it % 2 == 0) "user" else "assistant", "é".repeat(2000)) }
        assertNull(CoachOnboardingLimits.violation(request.copy(context = exactly)))
        val tooMuch = exactly + CoachOnboardingContext("user", "x")
        assertEquals(CoachOnboardingLimit.contextBytes, CoachOnboardingLimits.violation(request.copy(context = tooMuch)))
        assertEquals(5, tooMuch.size)
        assertEquals(CoachOnboardingLimit.contextText, CoachOnboardingLimits.violation(request.copy(context = listOf(CoachOnboardingContext("user", "x".repeat(4001))))))
        assertEquals(CoachOnboardingLimit.contextTurns, CoachOnboardingLimits.violation(request.copy(context = List(13) { CoachOnboardingContext("user", "x") })))
        assertEquals(CoachOnboardingLimit.contextText, CoachOnboardingLimits.violation(request.copy(context = listOf(CoachOnboardingContext("system", "x")))))
    }

    @Test fun photoAdmissionChecksActualDecodedBytesMimeAndEdge() {
        val bitmap = Bitmap.createBitmap(32, 16, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, output); output.toByteArray() }
        bitmap.recycle()
        val photo = CoachOnboardingImage("image/png", Base64.getEncoder().encodeToString(bytes))
        assertNull(CoachOnboardingLimits.violation(request.copy(image = photo, text = "")))
        assertEquals(CoachOnboardingLimit.photoFormat, CoachOnboardingLimits.violation(request.copy(image = photo.copy(mimeType = "image/jpeg"))))
        assertEquals(CoachOnboardingLimit.photoFormat, CoachOnboardingLimits.violation(request.copy(image = photo.copy(data = photo.data + "\n"))))
        val tooManyBytes = CoachOnboardingImage("image/png", Base64.getEncoder().encodeToString(ByteArray(CoachOnboardingLimits.photoBytes + 1)))
        assertEquals(CoachOnboardingLimit.photoBytes, CoachOnboardingLimits.violation(request.copy(image = tooManyBytes)))
        val wide = Bitmap.createBitmap(4097, 1, Bitmap.Config.ARGB_8888)
        val wideBytes = ByteArrayOutputStream().use { output -> wide.compress(Bitmap.CompressFormat.PNG, 100, output); output.toByteArray() }
        wide.recycle()
        assertEquals(CoachOnboardingLimit.photoEdge, CoachOnboardingLimits.violation(request.copy(image = photo.copy(data = Base64.getEncoder().encodeToString(wideBytes)))))
    }

    @Test fun theExistingPhotoEncoderFitsTheAnonymousBudgetWhileItsSignedInDefaultStaysFiveMiB() {
        val random = java.util.Random(38)
        val pixels = IntArray(700 * 700) { random.nextInt() or 0xff000000.toInt() }
        val bitmap = Bitmap.createBitmap(pixels, 700, 700, Bitmap.Config.ARGB_8888)
        val file = File(temporary.root, "program.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        assertTrue(file.length() > CoachOnboardingLimits.photoBytes)
        val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver
        val (photo, bytes) = CoachPhotos.read(resolver, Uri.fromFile(file), CoachOnboardingLimits.photoBytes, CoachOnboardingLimits.photoEdge)
        assertTrue(bytes.size <= CoachOnboardingLimits.photoBytes)
        assertEquals(bytes.size.toLong(), photo.bytes)
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)!!
        assertEquals(photo.width, decoded.width)
        assertEquals(photo.height, decoded.height)
        decoded.recycle()
        assertNull(CoachOnboardingLimits.violation(request.copy(image = CoachOnboardingImage(photo.mediaType, Base64.getEncoder().encodeToString(bytes)))))
        assertEquals(5 * 1024 * 1024, CoachPhotos.maxBytes)
    }
}
