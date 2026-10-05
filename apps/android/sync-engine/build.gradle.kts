plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "works.windmill.sync.engine"
    compileSdk = 36
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
dependencies {
    api(project(":sync-api"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:${libs.versions.kotlinxCoroutines.get()}")
    implementation(libs.okhttp)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(project(":sync-schema"))
}

// The testing kit is a JVM module; the runtime kernel has no Android references.
val jvmJar by tasks.registering(Jar::class) {
    dependsOn("compileDebugKotlin")
    archiveClassifier.set("jvm")
    from(layout.buildDirectory.dir("tmp/kotlin-classes/debug"))
    exclude("**/AndroidSqlite*", "**/AndroidClock*", "**/BuildConfig*")
}
configurations.create("jvmRuntimeElements") {
    isCanBeResolved = false
    isCanBeConsumed = true
    extendsFrom(configurations.getByName("api"), configurations.getByName("implementation"))
    outgoing.artifact(jvmJar)
}
tasks.withType<Test>().configureEach {
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    inputs.dir(rootProject.file("../../packages/api-contract/sync"))
    testLogging { events("failed", "standardOut") }
}
