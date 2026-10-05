package works.windmill.domain.testing

import java.io.File
import java.util.jar.JarFile
import org.junit.Assert.*
import org.junit.Test
import org.objectweb.asm.*

// Checks bytecode owners, including constant-pool entries that no instruction uses (§2.3).
class KitLayering(val packages: List<String>) {
    data class Finding(val rule: String, val owner: String)
    fun inspect(bytes: ByteArray): Set<Finding> {
        val findings = linkedSetOf<Finding>()
        val reader = ClassReader(bytes)
        val className = reader.className
        var declaredMethods = 0
        val bootstrapOwners = mutableSetOf<String>()
        reader.accept(object : ClassVisitor(Opcodes.ASM9) {
            override fun visitMethod(access: Int, name: String, descriptor: String, signature: String?, exceptions: Array<out String>?): MethodVisitor = object : MethodVisitor(Opcodes.ASM9) {
                override fun visitInvokeDynamicInsn(name: String, descriptor: String, bootstrapMethodHandle: Handle, vararg bootstrapMethodArguments: Any) {
                    bootstrapOwners.add(bootstrapMethodHandle.owner)
                    for (type in Type.getArgumentTypes(bootstrapMethodHandle.desc) + Type.getReturnType(bootstrapMethodHandle.desc)) {
                        if (type.sort == Type.OBJECT) bootstrapOwners.add(type.internalName)
                    }
                }
            }
        }, ClassReader.SKIP_DEBUG or ClassReader.SKIP_FRAMES)
        fun owner(name: String) {
            val owner = if (name.startsWith('[')) Type.getType(name).elementType.let { if (it.sort == Type.OBJECT) it.internalName else return } else name
            val kotlin = owner.startsWith("kotlin/") && listOf("io", "concurrent", "system", "random", "time", "reflect", "uuid", "coroutines").none { owner == "kotlin/$it" || owner.startsWith("kotlin/$it/") }
            val lang = owner.removePrefix("java/lang/").let { name -> owner.startsWith("java/lang/") && (name in listOf("Object", "String", "CharSequence", "StringBuilder", "Comparable", "Enum", "Iterable", "Number", "Boolean", "Byte", "Short", "Integer", "Long", "Float", "Double", "Character", "Math", "Class", "Throwable") || name.endsWith("Exception") || name.endsWith("Error")) }
            val util = owner.removePrefix("java/util/").let { name -> owner.startsWith("java/util/") && name in listOf("Collection", "List", "Set", "Map", "Map\$Entry", "Iterator", "ListIterator", "SortedSet", "NavigableSet", "SortedMap", "NavigableMap", "Queue", "Deque", "RandomAccess", "ArrayList", "LinkedHashMap", "LinkedHashSet", "Comparator", "Locale") }
            val thread = owner == "java/lang/Thread" && (className == "works/windmill/domain/kit/Draft" || className == "works/windmill/domain/kit/ActionRunner")
            val normalizer = owner in listOf("java/text/Normalizer", "java/text/Normalizer\$Form") && className == "works/windmill/domain/kit/Nfc"
            val bootstrap = owner.startsWith("java/lang/invoke/") && owner in bootstrapOwners
            if (!kotlin && !lang && !util && !thread && !normalizer && !bootstrap && packages.none { owner.startsWith("$it/") }) findings.add(Finding("owner", owner))
        }
        fun member(owner: String, name: String, descriptor: String) {
            val forbidden = when {
                owner == "java/lang/Thread" -> name != "currentThread"
                owner == "java/lang/Object" -> name in listOf("wait", "notify", "notifyAll")
                owner == "java/lang/String" -> name in listOf("format", "formatted") || (name in listOf("toUpperCase", "toLowerCase") && descriptor == "()Ljava/lang/String;")
                owner in listOf("java/lang/Integer", "java/lang/Long", "java/lang/Boolean") -> name in listOf("getInteger", "getLong", "getBoolean")
                owner == "java/lang/Throwable" -> name == "printStackTrace"
                owner == "java/lang/Class" -> true
                owner == "java/lang/Math" -> name !in listOf("abs", "min", "max", "floor", "ceil", "rint", "round", "sqrt", "signum", "copySign", "floorDiv", "floorMod") && !name.endsWith("Exact")
                owner == "java/util/Locale" -> name != "ROOT"
                owner == "kotlin/math/MathKt" -> name in listOf("pow", "exp", "ln", "log", "log10", "log2")
                owner.startsWith("kotlin/collections/") || owner.startsWith("kotlin/sequences/") -> name in listOf("shuffle", "shuffled", "random", "randomOrNull")
                else -> false
            }
            if (forbidden) findings.add(Finding("member", "$owner.$name$descriptor"))
        }
        val buffer = CharArray(reader.maxStringLength)
        for (i in 1 until reader.itemCount) {
            val offset = reader.getItem(i)
            if (offset == 0) continue
            when (reader.readByte(offset - 1)) {
                7 -> owner(reader.readUTF8(offset, buffer))
                9, 10, 11 -> {
                    val declaring = reader.readClass(offset, buffer)
                    val pair = reader.getItem(reader.readUnsignedShort(offset + 2))
                    member(declaring, reader.readUTF8(pair, buffer), reader.readUTF8(pair + 2, buffer))
                }
            }
        }
        reader.accept(object : ClassVisitor(Opcodes.ASM9) {
            override fun visitMethod(access: Int, name: String, descriptor: String, signature: String?, exceptions: Array<out String>?): MethodVisitor {
                if (!name.startsWith('<')) declaredMethods++
                if (access and Opcodes.ACC_NATIVE != 0) findings.add(Finding("native", "$className.$name"))
                return object : MethodVisitor(Opcodes.ASM9) {
                    override fun visitInsn(opcode: Int) {
                        if (opcode == Opcodes.MONITORENTER) findings.add(Finding("monitor", className))
                    }
                }
            }
        }, ClassReader.SKIP_DEBUG or ClassReader.SKIP_FRAMES)
        if (className == "works/windmill/domain/kit/Nfc" && declaredMethods != 1) findings.add(Finding("nfc", className))
        return findings
    }
}

class KitLayeringTests {
    val android = File(System.getProperty("windmill.android"))
    val model: List<List<String>> get() = File(System.getProperty("windmill.model")).readLines().map { it.split('\t') }
    @Test fun deterministicModulesObeyCompiledOwnerRules() {
        val modules = mapOf(
            "sync-core" to listOf("works/windmill/sync/core"),
            "sync-api" to listOf("works/windmill/sync/api", "works/windmill/sync/core"),
            "sync-schema" to listOf("works/windmill/sync/schema", "works/windmill/sync/core"),
            "domain-kit" to listOf("works/windmill/domain/kit", "works/windmill/sync/api", "works/windmill/sync/core"),
            "gym:domain" to listOf("works/windmill/gym/domain", "works/windmill/domain/kit", "works/windmill/sync/api", "works/windmill/sync/core", "works/windmill/sync/schema"),
        )
        var classes = 0
        val findings = mutableListOf<String>()
        for ((module, packages) in modules) {
            val main = model.single { it[0] == "classes" && it[1] == ":$module" }[2].split(',').map(::File)
            val files = main.flatMap { it.walkTopDown().filter { it.isFile && it.extension == "class" }.toList() }
            assertTrue("$module classes missing", files.isNotEmpty())
            val shipped = model.single { it[0] == "artifacts" && it[1] == ":$module" }[2].split(',').map(::File)
            assertTrue("$module runtime artifacts missing", shipped.isNotEmpty() && shipped.all { it.isFile && it.extension == "jar" })
            val compiledNames = main.flatMap { directory -> directory.walkTopDown().filter { it.isFile && it.extension == "class" }.map { it.relativeTo(directory).invariantSeparatorsPath }.toList() }.toSet()
            val shippedNames = mutableSetOf<String>()
            for (artifact in shipped) JarFile(artifact).use { jar ->
                for (entry in jar.entries().toList().filter { !it.isDirectory && it.name.endsWith(".class") }) {
                    shippedNames.add(entry.name)
                    classes++
                    findings += KitLayering(packages).inspect(jar.getInputStream(entry).use { it.readBytes() }).map { "$module/${entry.name}: $it" }
                }
            }
            assertEquals("$module ships every compiled class", compiledNames, shippedNames)
        }
        assertEquals(emptyList<String>(), findings)
        println("layering: ${modules.size} deterministic modules, $classes compiled classes, 0 findings")
    }
    @Test fun ownerAndDeterminismAttackFixtures() {
        val base = "works/windmill/domain/kit"
        fun fixture(owner: String, member: String? = null, descriptor: String = "()V", className: String = "$base/Fixture", monitor: Boolean = false, native: Boolean = false): ByteArray {
            val writer = ClassWriter(0)
            writer.visit(Opcodes.V17, Opcodes.ACC_PUBLIC, className, null, "java/lang/Object", null)
            writer.newClass(owner)
            if (member != null) writer.newMethod(owner, member, descriptor, false)
            if (native) writer.visitMethod(Opcodes.ACC_NATIVE, "nativeCall", "()V", null, null).visitEnd()
            val method = writer.visitMethod(Opcodes.ACC_PUBLIC, "call", "()V", null, null)
            method.visitCode()
            if (monitor) method.visitInsn(Opcodes.MONITORENTER)
            method.visitInsn(Opcodes.RETURN); method.visitMaxs(1, 1); method.visitEnd(); writer.visitEnd()
            return writer.toByteArray()
        }
        val checker = KitLayering(listOf(base, "works/windmill/sync/core"))
        var attacks = 0
        fun denied(bytes: ByteArray, rule: String) { assertTrue(checker.inspect(bytes).any { it.rule == rule }); attacks++ }
        for (name in listOf("io", "concurrent", "system", "random", "time", "reflect", "uuid", "coroutines")) denied(fixture("kotlin/$name/Forbidden"), "owner")
        for (owner in listOf("android/app/Activity", "java/io/File", "java/time/Instant", "java/util/Random", "java/util/Arrays", "java/util/HashMap", "works/windmill/sync/engine/Engine", "works/windmill/domain/testing/Fake", "java/text/Normalizer", "java/lang/Thread", "java/lang/ThreadLocal", "java/lang/invoke/StringConcatFactory")) denied(fixture(owner), "owner")
        for ((owner, members) in listOf(
            "java/lang/Object" to listOf("wait", "notify", "notifyAll"),
            "java/lang/String" to listOf("format", "formatted", "toUpperCase", "toLowerCase"),
            "java/lang/Integer" to listOf("getInteger"), "java/lang/Long" to listOf("getLong"), "java/lang/Boolean" to listOf("getBoolean"),
            "java/lang/Throwable" to listOf("printStackTrace"), "java/lang/Class" to listOf("getName"),
            "java/lang/Math" to listOf("random", "pow", "exp", "log", "sin"), "java/util/Locale" to listOf("getDefault"),
            "kotlin/math/MathKt" to listOf("pow", "exp", "ln", "log", "log10", "log2"),
            "kotlin/collections/CollectionsKt" to listOf("shuffled", "shuffle", "random", "randomOrNull"),
            "kotlin/sequences/SequencesKt" to listOf("shuffled", "shuffle", "random", "randomOrNull"),
            "java/lang/Thread" to listOf("sleep", "getName"),
        )) for (member in members) denied(fixture(owner, member, if (member in listOf("toUpperCase", "toLowerCase")) "()Ljava/lang/String;" else "()V"), "member")
        denied(fixture("java/lang/Object", monitor = true), "monitor")
        denied(fixture("java/lang/Object", native = true), "native")
        assertEquals(emptySet<KitLayering.Finding>(), checker.inspect(fixture("java/text/Normalizer", className = "$base/Nfc")))
        assertEquals(emptySet<KitLayering.Finding>(), checker.inspect(fixture("java/text/Normalizer\$Form", className = "$base/Nfc")))
        assertEquals(emptySet<KitLayering.Finding>(), checker.inspect(fixture("java/lang/Thread", "currentThread", className = "$base/Draft")))
        assertEquals(emptySet<KitLayering.Finding>(), checker.inspect(fixture("java/lang/String", "toUpperCase", "(Ljava/util/Locale;)Ljava/lang/String;")))
        assertEquals(emptySet<KitLayering.Finding>(), checker.inspect(fixture("java/util/Locale", "ROOT")))
        println("layering attack fixtures: $attacks rejected, 5 allowed")
    }
    @Test fun foundationModulesArePlainJvmWithPinnedEdges() {
        val findings = validateModel(model)
        assertEquals("Complete §2.1 module inventory and edges", emptyList<String>(), findings)
    }
    @Test fun resolvedModelAttackFixtures() {
        val baseline = validateModel(model).toSet()
        val mutations = listOf(
            model + listOf(listOf("project", ":stray", File(android, "stray").path, "", "")),
            model.map { if (it[0] == "included") listOf("included", "1") else it },
            model.map { if (it[0] == "project" && it[1] == ":domain-kit") it.toMutableList().apply { this[2] += "/elsewhere" } else it },
            model.map { if (it[0] == "project" && it[1] == ":domain-kit") it.toMutableList().apply { this[3] += ",api::sync-testing" } else it },
            model.map { if (it[0] == "project" && it[1] == ":domain-kit") it.toMutableList().apply { this[4] += ",org.jetbrains.kotlin.gradle.plugin.KotlinAndroidPluginWrapper" } else it },
            model.map { if (it[0] == "classpath" && it[1] == ":domain-kit") it.toMutableList().apply { this[3] += ",module:vendor:foreign:1" } else it },
            model.map { if (it[0] == "classpath" && it[1] == ":domain-kit") it.toMutableList().apply { this[4] = "/vendor/classes" } else it },
            model.map { if (it[0] == "project" && it[1] == ":platform") it.toMutableList().apply { this[3] += ",implementation::gym" } else it },
        )
        for ((index, mutation) in mutations.withIndex()) assertTrue("model attack $index adds a finding", (validateModel(mutation).toSet() - baseline).isNotEmpty())
        println("layering model: 12 required projects, 8 JVM modules, 8 rejected model attacks")
    }

    fun validateModel(model: List<List<String>>): List<String> {
        val findings = mutableListOf<String>()
        val jvm = setOf(":sync-core", ":sync-api", ":sync-schema", ":sync-model-server", ":sync-testing", ":domain-kit", ":domain-kit-testing", ":gym:domain")
        val projects = jvm + setOf(":app", ":platform", ":gym", ":sync-engine")
        val allowed = mapOf(
            ":sync-core" to emptySet(), ":sync-api" to setOf(":sync-core"), ":sync-schema" to setOf(":sync-core"), ":sync-model-server" to setOf(":sync-core"), ":sync-testing" to setOf(":sync-core", ":sync-api", ":sync-schema", ":sync-engine", ":sync-model-server"),
            ":domain-kit" to setOf(":sync-core", ":sync-api"), ":domain-kit-testing" to setOf(":domain-kit", ":sync-core", ":sync-api", ":sync-testing", ":sync-engine"),
            ":sync-engine" to setOf(":sync-core", ":sync-api", ":sync-schema"),
            ":gym:domain" to setOf(":domain-kit", ":sync-core", ":sync-api", ":sync-schema"),
            ":platform" to setOf(":domain-kit", ":sync-core", ":sync-api", ":sync-schema", ":sync-engine"),
            ":gym" to setOf(":gym:domain", ":domain-kit", ":sync-core", ":sync-api", ":sync-schema", ":sync-engine", ":platform"), ":app" to projects,
        )
        val jvmPlugins = setOf(
            "org.gradle.api.plugins.BasePlugin", "org.gradle.api.plugins.HelpTasksPlugin", "org.gradle.api.plugins.JavaBasePlugin", "org.gradle.api.plugins.JavaPlugin",
            "org.gradle.api.plugins.JvmEcosystemPlugin", "org.gradle.api.plugins.JvmTestSuitePlugin", "org.gradle.api.plugins.JvmToolchainsPlugin", "org.gradle.api.plugins.ReportingBasePlugin",
            "org.gradle.api.plugins.SoftwareReportingTasksPlugin", "org.gradle.buildinit.plugins.BuildInitPlugin", "org.gradle.buildinit.plugins.WrapperPlugin",
            "org.gradle.kotlin.dsl.provider.plugins.KotlinScriptBasePlugin", "org.gradle.language.base.plugins.LifecycleBasePlugin", "org.gradle.testing.base.plugins.TestSuiteBasePlugin",
            "org.jetbrains.kotlin.gradle.plugin.KotlinPluginWrapper", "org.jetbrains.kotlin.gradle.scripting.internal.ScriptingGradleSubplugin", "org.jetbrains.kotlin.gradle.scripting.internal.ScriptingKotlinGradleSubplugin",
        )
        if (model.singleOrNull { it[0] == "included" }?.get(1) != "0") findings.add("included build")
        if (model.filter { it[0] == "project" }.map { it[1] }.toSet() != projects) findings.add("project inventory: missing " + (projects - model.filter { it[0] == "project" }.map { it[1] }.toSet()).sorted().joinToString() + "; extra " + (model.filter { it[0] == "project" }.map { it[1] }.toSet() - projects).sorted().joinToString())
        for (row in model.filter { it[0] == "project" }) {
            val module = row[1]
            if (row[2] != File(android, module.removePrefix(":").replace(':', '/')).absolutePath) findings.add("directory $module")
            if (module in jvm && row[4].split(',').toSet() != jvmPlugins) findings.add("plugins $module")
            for (edge in row[3].split(',').filter { it.isNotEmpty() }) {
                val configuration = edge.substringBefore(':')
                val target = edge.substringAfter(':')
                val permitted = if (configuration.contains("test", ignoreCase = true)) target == module || target !in setOf(":app", ":platform", ":gym")
                    else target in (allowed[module] ?: emptySet())
                if (!permitted || target !in projects) findings.add("edge $module → $edge")
            }
        }
        for (row in model.filter { it[0] == "classpath" }) {
            val module = row[1]
            for (component in row[3].split(',')) {
                val permitted = if (component.startsWith("project:")) component.removePrefix("project:") in ((allowed[module] ?: emptySet()) + module)
                    else component.startsWith("module:org.jetbrains.kotlin:kotlin-stdlib:") || component.startsWith("module:org.jetbrains:annotations:")
                if (!permitted) findings.add("classpath $module $component")
            }
            if (row[4].isNotEmpty()) findings.add("file classpath $module")
        }
        return findings
    }
}
