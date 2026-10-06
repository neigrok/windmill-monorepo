package works.windmill.app

import android.content.Context
import java.io.File
import java.io.IOException
import works.windmill.gym.store.LocalCoach
import works.windmill.gym.store.WorkoutControls
import works.windmill.platform.telemetry.Telemetry

class OnboardingLaunch(context: Context, private val telemetry: Telemetry) {
    private val prefs = try {
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
    } catch (_: Exception) {
        telemetry.failure("onboarding_storage", IOException("Onboarding storage unavailable"))
        null
    }
    private val freshDevice = if (prefs == null) false else try {
        if (prefs.getBoolean("examined", false)) false else {
            val preferencesDirectory = File(context.applicationInfo.dataDir, "shared_prefs")
            val preferenceFiles = if (preferencesDirectory.exists()) {
                preferencesDirectory.listFiles() ?: throw IOException()
            } else emptyArray()
            val previousOnboarding = preferenceFiles.any {
                it.name == "$preferencesName.xml" || it.name == "$preferencesName.xml.bak"
            }
            if (previousOnboarding) {
                telemetry.failure("onboarding_storage", IOException("Onboarding flag unavailable"))
            }
            val files = context.filesDir.listFiles() ?: throw IOException()
            val storageNames = setOf(LocalCoach.fileName, WorkoutControls.fileName)
            val storedGym = files.any { file ->
                file.name == "coach-photos" || storageNames.any { name ->
                    file.name == name || file.name.startsWith("$name.")
                }
            }
            val previousAccountOrGym = preferenceFiles.any {
                it.name.startsWith("works.windmill.session.xml") || it.name.startsWith("workout-notifications.xml")
            }
            @Suppress("DEPRECATION")
            val install = context.packageManager.getPackageInfo(context.packageName, 0)
            val updatedInstall = install.firstInstallTime < install.lastUpdateTime
            !storedGym && !previousAccountOrGym && !previousOnboarding && !updatedInstall
        }
    } catch (_: Exception) {
        telemetry.failure("onboarding_storage", IOException("Onboarding storage unavailable"))
        false
    }

    @Synchronized
    fun firstLaunch(hasAccount: Boolean, deepLink: Boolean): Boolean {
        if (prefs == null) return false
        return try {
            if (prefs.getBoolean("examined", false)) return false
            if (!prefs.edit().putBoolean("examined", true).commit()) throw IOException()
            freshDevice && !hasAccount && !deepLink
        } catch (_: Exception) {
            telemetry.failure("onboarding_storage", IOException("Onboarding storage unavailable"))
            false
        }
    }

    companion object {
        const val preferencesName = "works.windmill.onboarding"
    }
}
