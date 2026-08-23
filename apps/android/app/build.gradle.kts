plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// CI overrides both: -Pwindmill.versionName=<tag> -Pwindmill.versionCode=<run number>.
val windmillVersionName = providers.gradleProperty("windmill.versionName").orNull ?: "0.1.0"
val windmillVersionCode = providers.gradleProperty("windmill.versionCode").orNull?.toInt() ?: 1

// Empty means the production host; http://10.0.2.2:8088 reaches the local stack from an emulator.
val windmillApiBase = providers.gradleProperty("windmill.apiBase").orNull ?: ""

android {
    namespace = "works.windmill.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "works.windmill.app"
        minSdk = 26
        targetSdk = 36
        versionCode = windmillVersionCode
        versionName = windmillVersionName
        buildConfigField("String", "WM_API_BASE_URL", "\"$windmillApiBase\"")
    }

    signingConfigs {
        create("release") {
            val keystorePath = System.getenv("WINDMILL_ANDROID_KEYSTORE")
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storePassword = System.getenv("WINDMILL_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("WINDMILL_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("WINDMILL_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("WINDMILL_ANDROID_KEYSTORE") != null)
                signingConfigs.getByName("release")
            else
                signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":platform"))
    implementation(project(":gym"))
    implementation(libs.androidx.activity.compose)
}
