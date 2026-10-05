plugins { alias(libs.plugins.kotlin.jvm) }

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(project(":sync-core"))
    api(project(":sync-api"))
    api(project(":sync-model-server"))
    api(project(path = ":sync-engine", configuration = "jvmRuntimeElements"))
    testImplementation(libs.junit)
    testImplementation(project(":sync-schema"))
    testImplementation(project(":sync-api"))
    testImplementation(project(":domain-kit"))
    testImplementation("org.ow2.asm:asm:9.7.1")
}

tasks.test {
    inputs.dir(rootProject.file("../../packages/api-contract/sync"))
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    systemProperty("windmill.android", rootProject.projectDir.absolutePath)
    exclude("**/LayeringTests.class")
    testLogging { events("failed", "standardOut"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}

val layering by tasks.registering(Test::class) {
    dependsOn(rootProject.tasks.named("layeringModel"), ":sync-core:classes", ":sync-api:classes", ":sync-schema:classes", ":domain-kit:classes", ":gym:domain:classes")
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    include("**/LayeringTests.class")
    systemProperty("windmill.android", rootProject.projectDir.absolutePath)
    systemProperty("windmill.model", rootProject.layout.buildDirectory.file("layering/model.tsv").get().asFile.absolutePath)
    inputs.file(rootProject.layout.buildDirectory.file("layering/model.tsv"))
    testLogging { events("failed", "standardOut") }
}
tasks.named("check") { dependsOn(layering) }

val corpus by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("works.windmill.sync.testing.CoreCorpusKt")
    args(rootProject.file("../../packages/api-contract").absolutePath)
}
val conformance by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("works.windmill.sync.testing.CoreCorpusKt")
    args(rootProject.file("../../packages/api-contract").absolutePath, "--all")
}
val foundationCorpus by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("works.windmill.sync.testing.CoreCorpusKt")
    args(rootProject.file("../../packages/api-contract").absolutePath, "--subset")
}

val serverCorpus by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("works.windmill.sync.testing.ServerCorpusKt")
    args(rootProject.file("../../packages/api-contract").absolutePath)
}

// Strict §11.2 gate: the real engine adapter is mandatory.
val mandatoryProperties by tasks.registering(Test::class) {
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    include("**/ServerPropertyTests.class", "**/EnginePropertyTests.class")
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    inputs.dir(rootProject.file("../../packages/api-contract/sync"))
    testLogging { events("failed", "standardOut") }
}
tasks.named("check") { dependsOn(conformance, serverCorpus, mandatoryProperties) }
