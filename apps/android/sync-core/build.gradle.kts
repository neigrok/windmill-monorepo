plugins { alias(libs.plugins.kotlin.jvm) }

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    testImplementation(libs.junit)
}

tasks.test {
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    testLogging { events("failed", "standardOut") }
}
