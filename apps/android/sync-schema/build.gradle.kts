plugins { alias(libs.plugins.kotlin.jvm) }

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(project(":sync-core"))
    testImplementation(libs.junit)
}

tasks.test {
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    testLogging { events("failed", "standardOut") }
}

val generateSchema by tasks.registering(Exec::class) {
    commandLine("python3", rootProject.file("tools/schema_gen.py"))
}
val checkSchema by tasks.registering(Exec::class) {
    commandLine("python3", rootProject.file("tools/schema_gen.py"), "--check")
}
val testSchemaGenerator by tasks.registering(Exec::class) {
    commandLine("python3", rootProject.file("tools/test_schema_gen.py"))
}
tasks.named("check") { dependsOn(checkSchema, testSchemaGenerator) }
