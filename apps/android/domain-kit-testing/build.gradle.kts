plugins { alias(libs.plugins.kotlin.jvm) }

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    api(project(":domain-kit"))
    api(project(":sync-core"))
    api(project(":sync-api"))
    api(project(":sync-testing"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:${libs.versions.kotlinxCoroutines.get()}")
    testImplementation(libs.junit)
    testImplementation("org.ow2.asm:asm:9.7.1")
}

tasks.test {
    inputs.dir(rootProject.file("../../packages/api-contract/domain-kit"))
    systemProperty("windmill.contract", rootProject.file("../../packages/api-contract").absolutePath)
    exclude("**/KitLayeringTests.class")
    testLogging { events("failed", "standardOut") }
}

val corpus by tasks.registering(JavaExec::class) {
    inputs.dir(rootProject.file("../../packages/api-contract/domain-kit"))
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("works.windmill.domain.testing.KitCorpusKt")
    args(rootProject.file("../../packages/api-contract").absolutePath)
}
val conformance by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("works.windmill.domain.testing.KitCorpusKt")
    args(rootProject.file("../../packages/api-contract").absolutePath, "--all")
}
val foundationCorpus by tasks.registering(JavaExec::class) {
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("works.windmill.domain.testing.KitCorpusKt")
    args(rootProject.file("../../packages/api-contract").absolutePath, "--subset")
}

abstract class WriteKitLayeringModel : DefaultTask() {
    @get:Input abstract val rows: ListProperty<String>
    @get:OutputFile abstract val destination: RegularFileProperty
    @TaskAction fun write() {
        destination.get().asFile.apply { parentFile.mkdirs(); writeText(rows.get().joinToString("\n", postfix = "\n")) }
    }
}
val kitLayeringModel by tasks.registering(WriteKitLayeringModel::class) {
    destination.set(layout.buildDirectory.file("layering/model.tsv"))
}
gradle.projectsEvaluated {
    val model = mutableListOf("root\t" + rootProject.projectDir.absolutePath, "included\t" + gradle.includedBuilds.size)
    for (module in rootProject.subprojects.sortedBy { it.path }) {
        val edges = module.configurations.flatMap { configuration -> configuration.dependencies.withType(ProjectDependency::class.java).map { configuration.name + ":" + it.dependencyProject.path } }.sorted()
        val plugins = module.plugins.map { it.javaClass.name.removeSuffix("_Decorated") }.sorted()
        model.add(listOf("project", module.path, module.projectDir.absolutePath, edges.joinToString(","), plugins.joinToString(",")).joinToString("\t"))
        if (module.path in setOf(":sync-core", ":sync-api", ":sync-schema", ":domain-kit", ":gym:domain")) {
            val java = module.extensions.getByType(JavaPluginExtension::class.java)
            tasks.named("layering") { inputs.files(java.sourceSets.getByName("main").output.classesDirs, module.configurations.getByName("runtimeElements").outgoing.artifacts.files) }
            model.add(listOf("artifacts", module.path, module.configurations.getByName("runtimeElements").outgoing.artifacts.files.files.joinToString(",") { it.absolutePath }).joinToString("\t"))
            model.add(listOf("classes", module.path, java.sourceSets.getByName("main").output.classesDirs.files.joinToString(",") { it.absolutePath }).joinToString("\t"))
            for (name in listOf("compileClasspath", "runtimeClasspath")) {
                val configuration = module.configurations.getByName(name)
                val components = configuration.incoming.resolutionResult.allComponents.map { component ->
                    when (val id = component.id) {
                        is org.gradle.api.artifacts.component.ProjectComponentIdentifier -> "project:" + id.projectPath
                        is org.gradle.api.artifacts.component.ModuleComponentIdentifier -> "module:" + id.group + ":" + id.module + ":" + id.version
                        else -> "other:" + id.displayName
                    }
                }.sorted()
                val local = configuration.allDependencies.withType(org.gradle.api.artifacts.FileCollectionDependency::class.java).flatMap { it.files.files }.map { it.absolutePath }
                model.add(listOf("classpath", module.path, name, components.joinToString(","), local.joinToString(",")).joinToString("\t"))
            }
        }
    }
    kitLayeringModel.configure { rows.set(model) }
}
val layering by tasks.registering(Test::class) {
    dependsOn(kitLayeringModel, ":sync-core:jar", ":sync-api:jar", ":sync-schema:jar", ":domain-kit:jar", ":gym:domain:jar")
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    include("**/KitLayeringTests.class")
    systemProperty("windmill.android", rootProject.projectDir.absolutePath)
    systemProperty("windmill.model", layout.buildDirectory.file("layering/model.tsv").get().asFile.absolutePath)
    inputs.file(layout.buildDirectory.file("layering/model.tsv"))
    testLogging { events("failed", "standardOut") }
}
tasks.named("check") { dependsOn(layering, corpus) }
