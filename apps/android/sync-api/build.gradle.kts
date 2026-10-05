plugins { alias(libs.plugins.kotlin.jvm) }

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(project(":sync-core"))
    testImplementation(libs.junit)
}

tasks.test {
    inputs.dir(rootProject.file("../../packages/api-contract/sync"))
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract/sync").absolutePath)
}
