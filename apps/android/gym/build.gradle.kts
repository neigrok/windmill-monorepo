// The ability catalog is the contract's own file, placed in this module's assets as it is: nothing generated to drift, nothing checked in twice.
abstract class CopyAbilityCatalog : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val catalog: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun copy() {
        catalog.get().asFile.copyTo(outputDirectory.get().asFile.resolve("gym-catalog.json"), overwrite = true)
    }
}

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "works.windmill.gym"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        // The tap tests compose the real screens on the JVM: Robolectric needs the merged manifest
        // and resources to launch the host activity the compose rule stands screens in.
        unitTests.isIncludeAndroidResources = true
    }
}

androidComponents.onVariants { variant ->
    val capitalized = variant.name.replaceFirstChar { it.uppercase() }
    val copy = tasks.register<CopyAbilityCatalog>("copy${capitalized}AbilityCatalog") {
        catalog.set(rootProject.file("../../packages/api-contract/gym/catalog.json"))
        outputDirectory.set(layout.buildDirectory.dir("generated/abilityCatalog/${variant.name}/assets"))
    }
    variant.sources.assets?.addGeneratedSourceDirectory(copy, CopyAbilityCatalog::outputDirectory)
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// The turn's tests replay the contract's exchanges and its catalog.
tasks.withType<Test>().configureEach {
    inputs.dir(rootProject.file("../../packages/api-contract/gym"))
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
}

dependencies {
    implementation(project(":platform"))
    implementation(project(":sync-engine"))
    implementation(project(":sync-schema"))
    implementation(project(":domain-kit"))
    implementation(project(":gym:domain"))
    implementation(project(":agent"))
    implementation(libs.kotlinx.serialization.json)
    // BackHandler — the room decides what the system back gesture means on its own screens.
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.browser)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    // Photo orientation for Coach: the framework ExifInterface misreads some streams on API 26–28.
    implementation(libs.androidx.exifinterface)
    // api: the application answers WorkManager's configuration, the on-demand start that keeps it out of `Application.onCreate`.
    api(libs.androidx.work.runtime)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(project(":sync-model-server"))
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.compose.ui.test.manifest)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.work.testing)
}
