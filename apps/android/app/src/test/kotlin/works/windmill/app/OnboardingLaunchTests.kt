package works.windmill.app

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import works.windmill.gym.store.LocalCoach
import works.windmill.gym.store.WorkoutControls
import works.windmill.platform.telemetry.Telemetry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class OnboardingLaunchTests {
    private lateinit var context: Context
    private val failures = mutableListOf<String>()
    private val telemetry = object : Telemetry {
        override fun event(name: String, properties: Map<String, String>) = Unit
        override fun failure(operation: String, error: Throwable, properties: Map<String, String>) {
            assertEquals(emptyMap<String, String>(), properties)
            assertTrue(error is IOException)
            failures += operation
        }
    }

    @Before
    fun freshInstall() {
        context = RuntimeEnvironment.getApplication()
        context.filesDir.listFiles()?.forEach { it.deleteRecursively() }
        File(context.applicationInfo.dataDir, "shared_prefs").deleteRecursively()
        context.deleteSharedPreferences(OnboardingLaunch.preferencesName)
        val install = context.packageManager.getPackageInfo(context.packageName, 0)
        install.firstInstallTime = 100L
        install.lastUpdateTime = 100L
        shadowOf(context.packageManager).installPackage(install)
    }

    @Test
    fun freshInstallIsCommittedBeforeItReturnsAndNeverShownOnRestart() {
        assertTrue(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(mapOf("examined" to true),
            context.getSharedPreferences(OnboardingLaunch.preferencesName, Context.MODE_PRIVATE).all)
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun startupSnapshotPrecedesStoresCreatedByApplicationInitialization() {
        val launch = OnboardingLaunch(context, telemetry)
        File(context.filesDir, WorkoutControls.fileName).writeText("application startup fixture")
        assertTrue(launch.firstLaunch(hasAccount = false, deepLink = false))
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun signedInOrUnresolvedAccountNeverShowsAndSignOutDoesNotResetTheFlag() {
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = true, deepLink = false))
        context.getSharedPreferences("works.windmill.session", Context.MODE_PRIVATE).edit().clear().commit()
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun deepLinkNeverShowsAndLaterLauncherEntryDoesNotIntroduceIt() {
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = true))
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun everyGymShelfSuppressesIncludingEmptyCorruptAndInterruptedWrites() {
        val names = listOf(LocalCoach.fileName, WorkoutControls.fileName)
        for (name in names) {
            for (suffix in listOf("", ".tmp", ".bak")) {
                for (contents in listOf("", "corrupt", "{\"shelves\":{\"u.other\":{}}}")) {
                    context.deleteSharedPreferences(OnboardingLaunch.preferencesName)
                    val file = File(context.filesDir, name + suffix)
                    file.writeText(contents)
                    assertFalse("$name$suffix must hold returning users outside onboarding",
                        OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
                    assertTrue(file.delete())
                }
            }
        }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun unreadableGymShelfIsStillEvidenceOfExistingData() {
        val file = File(context.filesDir, WorkoutControls.fileName)
        assertTrue(file.mkdir())
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun coachPhotosSuppressEvenWhenTheCoachDocumentIsAbsent() {
        File(context.filesDir, "coach-photos/anon").mkdirs()
        File(context.filesDir, "coach-photos/anon/photo").writeText("fixture")
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun legacySignedOutOrNotificationPreferencesSuppressWithoutWorkoutRecords() {
        for (name in listOf("works.windmill.session.xml", "works.windmill.session.xml.bak",
            "workout-notifications.xml", "workout-notifications.xml.bak")) {
            context.deleteSharedPreferences(OnboardingLaunch.preferencesName)
            val file = File(context.applicationInfo.dataDir, "shared_prefs/$name")
            file.parentFile!!.mkdirs()
            file.writeText("")
            assertFalse(name, OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
            assertTrue(file.delete())
        }
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun updatedLegacyInstallSuppressesEvenWhenNoFilesRemain() {
        val install = context.packageManager.getPackageInfo(context.packageName, 0)
        install.lastUpdateTime = 200L
        shadowOf(context.packageManager).installPackage(install)
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun telemetryStorageDoesNotTurnAFreshInstallIntoAReturningOne() {
        val file = File(context.applicationInfo.dataDir, "shared_prefs/works.windmill.telemetry.xml")
        file.parentFile!!.mkdirs()
        file.writeText("fixture")
        assertTrue(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(emptyList<String>(), failures)
    }

    @Test
    fun damagedOnboardingFlagSuppressesAndReportsTheStorageBoundary() {
        val file = File(context.applicationInfo.dataDir, "shared_prefs/${OnboardingLaunch.preferencesName}.xml")
        file.parentFile!!.mkdirs()
        file.writeText("corrupt")
        assertFalse(OnboardingLaunch(context, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(listOf("onboarding_storage"), failures)
    }

    @Test
    fun failedPreferencesReadSuppressesAndReportsTheStorageBoundary() {
        val unavailable = object : ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = throw IOException()
        }
        assertFalse(OnboardingLaunch(unavailable, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(listOf("onboarding_storage"), failures)
    }

    @Test
    fun failedDirectoryInspectionSuppressesAndReportsTheStorageBoundary() {
        val unavailable = object : ContextWrapper(context) {
            override fun getFilesDir(): File = object : File(context.filesDir.absolutePath) {
                override fun listFiles(): Array<File>? = null
            }
        }
        assertFalse(OnboardingLaunch(unavailable, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(listOf("onboarding_storage"), failures)
    }

    @Test
    fun failedPreferencesCommitSuppressesAndReportsBeforeFirstFrame() {
        val prefs = context.getSharedPreferences(OnboardingLaunch.preferencesName, Context.MODE_PRIVATE)
        val unavailable = object : ContextWrapper(context) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = object : SharedPreferences by prefs {
                override fun edit(): SharedPreferences.Editor {
                    val editor = prefs.edit()
                    return object : SharedPreferences.Editor by editor {
                        override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor = this
                        override fun commit(): Boolean = false
                    }
                }
            }
        }
        assertFalse(OnboardingLaunch(unavailable, telemetry).firstLaunch(hasAccount = false, deepLink = false))
        assertEquals(listOf("onboarding_storage"), failures)
        assertEquals(emptyMap<String, Any>(), prefs.all)
    }
}
