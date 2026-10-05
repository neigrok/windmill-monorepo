plugins { alias(libs.plugins.kotlin.jvm) }

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(project(":domain-kit"))
    implementation(project(":sync-api"))
    implementation(project(":sync-core"))
    implementation(project(":sync-schema"))
    testImplementation(project(":domain-kit-testing"))
    testImplementation(project(":sync-testing"))
    testImplementation(libs.junit)
}

tasks.test {
    inputs.dir(rootProject.file("../../packages/api-contract/gym"))
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    testLogging { events("failed", "standardOut") }
}
