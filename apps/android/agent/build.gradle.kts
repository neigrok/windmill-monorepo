plugins { alias(libs.plugins.kotlin.jvm) }

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(project(":sync-core"))
    api(libs.kotlinx.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

tasks.test {
    inputs.dir(rootProject.file("../../packages/api-contract/gym/turns"))
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    testLogging { events("failed", "standardOut") }
}
