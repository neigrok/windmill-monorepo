package works.windmill.gym.store

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FinishReceiptsTests {
    @Test
    fun onlyTheFirstAnonymousReceiptKeepsItsOfferAcrossStoreRecreation() {
        val phone = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("receipt-test", 0)
        phone.edit().clear().commit()
        val receipts = FinishReceipts(phone, Telemetry.None)
        assertEquals(false, receipts.suggestsKeep("signed-in", anonymous = false))
        assertEquals(true, receipts.suggestsKeep("first", anonymous = true))
        val recreated = FinishReceipts(phone, Telemetry.None)
        assertEquals(true, recreated.suggestsKeep("first", anonymous = true))
        assertEquals(false, recreated.suggestsKeep("first", anonymous = false))
        assertEquals(false, recreated.suggestsKeep("second", anonymous = true))
        assertEquals(mapOf("first-anonymous-receipt" to "first"), phone.all)
    }
    @Test
    fun aFailedPhoneMarkerReportsTheBoundaryWithoutShowingAnUnrecordedOffer() {
        val phone = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("receipt-failed-test", 0)
        phone.edit().clear().commit()
        val failures = mutableListOf<String>()
        val telemetry = object : Telemetry {
            override fun event(name: String, properties: Map<String, String>) { error("No analytics values belong to this marker") }
            override fun failure(operation: String, error: Throwable, properties: Map<String, String>) { failures += operation }
        }
        val failed = object : android.content.SharedPreferences by phone {
            override fun edit(): android.content.SharedPreferences.Editor {
                val editor = phone.edit()
                return object : android.content.SharedPreferences.Editor by editor {
                    override fun putString(key: String?, value: String?): android.content.SharedPreferences.Editor { editor.putString(key, value); return this }
                    override fun commit(): Boolean = false
                }
            }
        }
        assertEquals(false, FinishReceipts(failed, telemetry).suggestsKeep("private-session", anonymous = true))
        assertEquals(listOf("gym.finishReceipt"), failures)
        assertEquals(emptyMap<String, Any>(), phone.all)
    }

}
