plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kotlin.jvm) apply false
}

abstract class WriteLayeringModel : DefaultTask() {
    @get:Input abstract val rows: ListProperty<String>
    @get:OutputFile abstract val destination: RegularFileProperty
    @TaskAction fun write() {
        destination.get().asFile.apply { parentFile.mkdirs(); writeText(rows.get().joinToString("\n", postfix = "\n")) }
    }
}

val layeringModel by tasks.registering(WriteLayeringModel::class) {
    destination.set(layout.buildDirectory.file("layering/model.tsv"))
}
gradle.projectsEvaluated {
    val model = mutableListOf<String>()
    model.add("root\t" + rootProject.projectDir.absolutePath)
    model.add("included\t" + gradle.includedBuilds.size)
    for (module in subprojects.sortedBy { it.path }) {
        val edges = module.configurations.flatMap { configuration -> configuration.dependencies.withType(ProjectDependency::class.java).map { configuration.name + ":" + it.dependencyProject.path } }.sorted()
        val plugins = module.plugins.map { it.javaClass.name.removeSuffix("_Decorated") }.sorted()
        model.add(listOf("project", module.path, module.projectDir.absolutePath, edges.joinToString(","), plugins.joinToString(",")).joinToString("\t"))
        if (module.path in setOf(":sync-core", ":sync-api", ":sync-schema", ":domain-kit", ":gym:domain")) {
            val java = module.extensions.getByType(JavaPluginExtension::class.java)
            model.add(listOf("classes", module.path, java.sourceSets.getByName("main").output.classesDirs.files.joinToString(",") { it.absolutePath }).joinToString("\t"))
            for (name in listOf("compileClasspath", "runtimeClasspath")) {
                val components = module.configurations.getByName(name).incoming.resolutionResult.allComponents.map { component ->
                    when (val id = component.id) {
                        is org.gradle.api.artifacts.component.ProjectComponentIdentifier -> "project:" + id.projectPath
                        is org.gradle.api.artifacts.component.ModuleComponentIdentifier -> "module:" + id.group + ":" + id.module + ":" + id.version
                        else -> "other:" + id.displayName
                    }
                }.sorted()
                val local = module.configurations.getByName(name).allDependencies.withType(org.gradle.api.artifacts.FileCollectionDependency::class.java).flatMap { it.files.files }.map { it.absolutePath }
                model.add(listOf("classpath", module.path, name, components.joinToString(","), local.joinToString(",")).joinToString("\t"))
            }
        }
    }
    layeringModel.configure { rows.set(model) }
}

subprojects {
    if (path != ":sync-engine") tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(":sync-testing:layering") }
}
