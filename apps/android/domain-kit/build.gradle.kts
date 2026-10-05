plugins { alias(libs.plugins.kotlin.jvm) }

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(project(":sync-core"))
    api(project(":sync-api"))
    testImplementation(libs.junit)
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:${libs.versions.kotlinxCoroutines.get()}")
}

tasks.test {
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    testLogging { events("failed", "standardOut") }
}
