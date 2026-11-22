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

// The android-all jars Robolectric 4.15.1 runs each SDK on, from minSdk 26 up. Gradle fetches them, with its
// retries and its cache, and the unit tests of every Android module read them from robolectric-deps.properties,
// so a test JVM never downloads one itself. One configuration per SDK, since one would keep only the newest
// version of the module. A Robolectric bump renames these jars.
val robolectricAndroidAll = mapOf(
    26 to "8.0.0_r4-robolectric-r1-i7",
    27 to "8.1.0-robolectric-4611349-i7",
    28 to "9-robolectric-4913185-2-i7",
    29 to "10-robolectric-5803371-i7",
    30 to "11-robolectric-6757853-i7",
    31 to "12-robolectric-7732740-i7",
    32 to "12.1-robolectric-8229987-i7",
    33 to "13-robolectric-9030017-i7",
    34 to "14-robolectric-10818077-i7",
    35 to "15-robolectric-12650502-i7",
).map { (sdk, version) ->
    val coordinate = "org.robolectric:android-all-instrumented:$version"
    coordinate to configurations.create("robolectricAndroidAll$sdk") {
        isTransitive = false
        dependencies.add(project.dependencies.create(coordinate))
    }
}

val robolectricDependencies by tasks.registering(WriteProperties::class) {
    destinationFile.set(layout.buildDirectory.file("robolectric/robolectric-deps.properties"))
    for ((coordinate, jar) in robolectricAndroidAll) property(coordinate, jar.elements.map { it.single().asFile.absolutePath })
}

subprojects {
    if (path != ":sync-engine") tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(":sync-testing:layering") }
    plugins.withId("com.android.base") {
        tasks.withType<Test>().configureEach {
            val properties = robolectricDependencies.flatMap { it.destinationFile }
            inputs.file(properties).withPathSensitivity(PathSensitivity.NONE)
            systemProperty("robolectric-deps.properties", properties.get().asFile.absolutePath)
        }
    }
}
