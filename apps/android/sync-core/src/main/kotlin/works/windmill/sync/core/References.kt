package works.windmill.sync.core

// E-8 typed references (engine.md §2.4 References): every place a registry declares a record identity inside a value,
// compiled once per registry into leaves. A record's own id, its key parts, a `ref` field, a `ref<t>` argument and each
// literal property path a `refPaths` entry names is a leaf; this one traversal serves validation, dependency extraction
// (§7.7 step 3) and the global and scoped id maps. Unannotated JSON and text are never read.

// Where a leaf's value hangs in its holder (a delta, a row, a guard or a command): the record's id, one part of a tuple
// id, a field register's value, or the command's arguments. A registry's literal path continues below it.
sealed interface Base {
    fun read(holder: Json): Json?
    fun write(holder: Json, value: Json): Json
    data object Id : Base {
        override fun read(holder: Json) = holder["id"]
        override fun write(holder: Json, value: Json) = holder.with("id" to value)
    }
    data class Part(val index: Int) : Base {
        override fun read(holder: Json) = (holder["id"] as? Json.Arr)?.values?.getOrNull(index)
        override fun write(holder: Json, value: Json) = holder.with("id" to Json.Arr(holder.member("id").arr().toMutableList().apply { this[index] = value }))
    }
    data class Field(val name: String) : Base {
        override fun read(holder: Json) = (holder["f"]?.get(name) as? Json.Arr)?.values?.getOrNull(0)
        override fun write(holder: Json, value: Json): Json {
            val fields = holder.member("f")
            return holder.with("f" to fields.with(name to Json.Arr(fields.member(name).arr().toMutableList().apply { this[0] = value })))
        }
    }
    data object Args : Base {
        override fun read(holder: Json) = holder["args"]
        override fun write(holder: Json, value: Json) = holder.with("args" to value)
    }
}

// The scope a reference names: the one its type lives in seen from the holder's scope, a product scope the registry
// fixes, or the tree (or its overlay) whose governing id another leaf of the same declaration holds.
sealed interface LeafScope {
    data object Origin : LeafScope
    data class Fixed(val scope: ScopeRef) : LeafScope
    class TreeFrom(val path: List<String>) : LeafScope { lateinit var source: Leaf }
}

// One place an identity sits. `role` is `identity` for a record's own id, `creation` for a command's proposed identity,
// and `ordinary` for every reference. `annotated` leaves come from `refPaths` and are what value checks hold.
class Leaf(val name: String, val base: Base, val path: List<String>, val type: String, val scope: LeafScope = LeafScope.Origin,
    val nullable: Boolean = false, val role: Role = Role.ordinary, val annotated: Boolean = false) {
    enum class Role { identity, creation, ordinary }
    sealed interface Found {
        data object Absent : Found
        // A null on the way to the leaf: it names nothing.
        data object OuterNull : Found
        // Something other than an object where the path continues.
        data object Malformed : Found
        data object Null : Found
        data class Value(val value: Json) : Found
    }
    fun find(holder: Json): Found {
        var node = base.read(holder) ?: return Found.Absent
        for (step in path) {
            if (node === Json.Null) return Found.OuterNull
            if (node !is Json.Obj) return Found.Malformed
            node = node[step] ?: return Found.Absent
        }
        return if (node === Json.Null) Found.Null else Found.Value(node)
    }
    // The holder with `value` at this leaf, which `find` answered present.
    fun write(holder: Json, value: Json): Json = base.write(holder, placed(base.read(holder)!!, path, value))
    private fun placed(node: Json, path: List<String>, value: Json): Json =
        if (path.isEmpty()) value else node.with(path[0] to placed(node.member(path[0]), path.drop(1), value))
}

// A record a leaf resolves to, in the scope it names.
data class Reference(val leaf: Leaf, val scope: ScopeRef, val key: RecordKey)

// One mapping of a logical id map (§7.7 write map): a global type's id renames in every scope, any other type's only in
// `scope`, which first follows the map's own governor mappings.
data class Mapping(val type: String, val from: RecordID, val id: RecordID, val scope: ScopeRef? = null) {
    constructor(json: Json) : this(json.member("t").str(), RecordID(json.member("from")), RecordID(json.member("id")), json["scope"]?.let(::ScopeRef))
}

class RecordMap(private val registry: Registry, mappings: List<Mapping>) {
    private val global = mutableMapOf<RecordKey, RecordID>()
    private val scoped = mutableMapOf<Pair<ScopeRef, RecordKey>, RecordID>()
    private val governors = mutableMapOf<String, String>()
    init {
        val governing = registry.governingType?.name
        for (mapping in mappings.filter { registry.isGlobal(it.type) }) {
            global[RecordKey(mapping.type, mapping.from)] = mapping.id
            if (mapping.type == governing) governors[mapping.from.string!!] = mapping.id.string!!
        }
        for (mapping in mappings.filter { !registry.isGlobal(it.type) }) {
            val scope = mapping.scope ?: continue
            scoped[scope(scope) to RecordKey(mapping.type, mapping.from)] = mapping.id
        }
    }
    val movesScopes: Boolean get() = governors.isNotEmpty()
    // A tree or overlay scope after the governor mappings; any other scope as it is.
    fun scope(ref: ScopeRef): ScopeRef = when (val kind = ref.kind) {
        is ScopeRef.Kind.Tree -> governors[kind.id]?.let(ScopeRef::tree) ?: ref
        is ScopeRef.Kind.Overlay -> governors[kind.id]?.let(ScopeRef::overlay) ?: ref
        else -> ref
    }
    fun globalTarget(key: RecordKey): RecordID? = global[key]
    fun scopedTarget(scope: ScopeRef, key: RecordKey): RecordID? = scoped[scope to key]
}

fun Registry.isGlobal(type: String) = type(type)?.json?.get("idSpace") == Json.of("global")

class References internal constructor(private val registry: Registry) {
    private val records = mutableMapOf<String, List<Leaf>>()
    private val commands = mutableMapOf<String, List<Leaf>>()
    // By field definition, which equals only itself.
    private val annotatedFields = mutableMapOf<FieldDef, Pair<String, List<Leaf>>>()
    init {
        for (type in registry.types) records[type.name] = compileType(type)
        for (command in registry.commands.map(::CommandDef)) commands[command.name] = compileCommand(command)
    }

    private fun fail(): Nothing = throw RegistryError("references")

    private fun compileType(type: TypeDef): List<Leaf> = buildList {
        if (type.identity != "singleton") add(Leaf("id", Base.Id, emptyList(), type.name, role = Leaf.Role.identity))
        val key = type.json["key"]
        key?.get("ref")?.let { add(Leaf("key", Base.Id, emptyList(), it.str())) }
        key?.get("tuple")?.arr()?.forEachIndexed { index, part -> add(Leaf("key.${part.member("name").str()}", Base.Part(index), emptyList(), part.member("ref").str())) }
        for ((name, field) in type.fields) {
            val base = Base.Field(name)
            field.ref?.let { add(Leaf(name, base, emptyList(), it, nullable = field.domain?.nullable == true)) }
            val refPaths = field.json["refPaths"] ?: continue
            if (field.ref != null || field.kind !in setOf("lww", "fww", "const")) fail()
            val annotated = compilePaths(refPaths, base, type.scope, emptyList()) { path -> domainAlong(field.domain, path) }
            if (annotated.any { it.role != Leaf.Role.ordinary }) fail()
            annotatedFields[field] = name to annotated
            addAll(annotated)
        }
    }

    private fun compileCommand(command: CommandDef): List<Leaf> {
        val shorthands = command.args.values.mapNotNull { arg -> arg.ref?.let { Leaf(arg.name, Base.Args, listOf(arg.name), it) } }
        val refPaths = command.json["refPaths"] ?: return shorthands
        val annotated = compilePaths(refPaths, Base.Args, command.scope, shorthands) { path ->
            val arg = command.args[path[0]] ?: fail()
            if (arg.type != "json") fail()
            domainAlong(arg.domain, path.drop(1))
        }
        for (leaf in annotated.filter { it.role == Leaf.Role.creation }) if (registry.type(leaf.type)?.hasBorn != true || leaf.type !in command.predicts) fail()
        return shorthands + annotated
    }

    // §2.4's load rules for one declaration's refPaths: literal nonempty paths through the value's object domain, a known
    // target with string ids, a scope of the target's family, each treeFrom source an ordinary leaf of the same declaration
    // holding a governing id, and no leaf declared twice or inside another.
    private fun compilePaths(refPaths: Json, base: Base, holderKind: String, shorthands: List<Leaf>, domainAt: (List<String>) -> String?): List<Leaf> {
        if (refPaths.arr().isEmpty()) fail()
        val leaves = refPaths.arr().map { declared ->
            declared.expectKeys(emptyList(), listOf("path", "type", "scope", "nullable", "role"))
            val path = literalPath(declared["path"])
            val target = registry.type(declared["type"]?.str() ?: fail()) ?: fail()
            if (target.json["key"]?.get("tuple") != null) fail()
            if (declared["nullable"]?.let { it != Json.of(true) } == true || declared["role"]?.let { it != Json.of("creation") } == true) fail()
            val domain = domainAt(path)
            if (domain != null && domain !in setOf("string", "id", "json")) fail()
            Leaf(path.joinToString("."), base, path, target.name, scopeFamily(declared["scope"] ?: fail(), target, holderKind),
                declared["nullable"] != null, if (declared["role"] != null) Leaf.Role.creation else Leaf.Role.ordinary, annotated = true)
        }
        val declared = shorthands + leaves
        for (leaf in leaves) {
            if (declared.any { other -> other !== leaf && (other.path == leaf.path || other.path.isPrefixOf(leaf.path) || leaf.path.isPrefixOf(other.path)) }) fail()
            val scope = leaf.scope as? LeafScope.TreeFrom ?: continue
            val source = declared.firstOrNull { it.path == scope.path } ?: fail()
            if (source.type != registry.governingType?.name || source.role != Leaf.Role.ordinary) fail()
            scope.source = source
        }
        return leaves
    }

    private fun scopeFamily(scope: Json, target: TypeDef, holderKind: String): LeafScope {
        val local = target.scope == "tree" || target.scope == "overlay"
        return when (scope.member("kind").str()) {
            "origin" -> {
                scope.expectKeys(listOf("kind"))
                if (local && holderKind != "tree" && holderKind != "overlay") fail()
                LeafScope.Origin
            }
            "fixed" -> {
                scope.expectKeys(listOf("kind", "value"))
                val product = Regex("self/([a-z][a-z0-9]*)").matchEntire(scope.member("value").str())?.groupValues?.get(1) ?: fail()
                if (product !in registry.products || target.scope != "product:$product") fail()
                LeafScope.Fixed(ScopeRef.product(product))
            }
            "treeFrom" -> {
                scope.expectKeys(listOf("kind", "path"))
                if (!local) fail()
                LeafScope.TreeFrom(literalPath(scope["path"]))
            }
            else -> fail()
        }
    }

    private fun literalPath(json: Json?): List<String> {
        val path = json?.arr()?.map { it.str() } ?: fail()
        if (path.isEmpty() || path.any { !it.matches(Regex("[a-z][A-Za-z0-9]*")) }) fail()
        return path
    }

    // The domain type a property path reaches through object domains: null once a json domain, or no domain, leaves the
    // shape open, and "none" for a path into any other shape.
    private fun domainAlong(domain: Domain?, path: List<String>): String? {
        var current = domain
        for (part in path) {
            if (current == null || current.type == "json") return null
            current = if (current.type == "object") current.properties[part] ?: return "none" else return "none"
        }
        return current?.type
    }

    private fun List<String>.isPrefixOf(other: List<String>) = size < other.size && other.subList(0, size) == this

    fun recordLeaves(type: String): List<Leaf> = records[type].orEmpty()
    fun commandLeaves(name: String): List<Leaf> = commands[name].orEmpty()

    // D-10: the scope a leaf names in a holder of `holderScope`; null when a treeFrom source holds no id.
    private fun scopeOf(leaf: Leaf, holder: Json, holderScope: ScopeRef): ScopeRef? = when (val scope = leaf.scope) {
        is LeafScope.Fixed -> scope.scope
        is LeafScope.TreeFrom -> ((scope.source.find(holder) as? Leaf.Found.Value)?.value as? Json.Str)?.value?.let { tree ->
            if (registry.type(leaf.type)?.scope == "tree") ScopeRef.tree(tree) else ScopeRef.overlay(tree)
        }
        LeafScope.Origin -> if (leaf.role == Leaf.Role.identity) holderScope else {
            val kind = registry.type(leaf.type)?.scope
            val tree = holderScope.text.substringAfterLast('/')
            when {
                kind?.startsWith("product:") == true -> ScopeRef.product(kind.removePrefix("product:"))
                kind == "tree" -> ScopeRef.tree(tree)
                else -> ScopeRef.overlay(tree)
            }
        }
    }

    // Every identity `leaves` resolve to in a holder of `holderScope`.
    fun resolve(leaves: List<Leaf>, holder: Json, holderScope: ScopeRef): List<Reference> = leaves.mapNotNull { leaf ->
        val value = (leaf.find(holder) as? Leaf.Found.Value)?.value ?: return@mapNotNull null
        if (leaf.role != Leaf.Role.identity && value !is Json.Str) return@mapNotNull null
        val id = try { RecordID(value) } catch (_: JsonError) { return@mapNotNull null }
        scopeOf(leaf, holder, holderScope)?.let { Reference(leaf, it, RecordKey(leaf.type, id)) }
    }

    // The ordinary references a record holds, its key parts and field values: what makes it a dependent.
    fun ofRecord(scope: ScopeRef, record: Json): List<Reference> =
        resolve(recordLeaves(record.member("t").str()).filter { it.role == Leaf.Role.ordinary }, record, scope)

    // A command's references of one role: `ordinary` names existing records, `creation` proposes new ones.
    fun ofCommand(scope: ScopeRef, command: Json, role: Leaf.Role = Leaf.Role.ordinary): List<Reference> =
        if (command["args"] !is Json.Obj) emptyList() else resolve(commandLeaves(command.member("name").str()).filter { it.role == role }, command, scope)

    // A record, a row or a guard renamed by `map`: global leaves first, then the scoped leaves resolved again from the
    // renamed values, so a treeFrom scope follows its renamed tree.
    fun remapRecord(scope: ScopeRef, record: Json, map: RecordMap): Json = remap(recordLeaves(record.member("t").str()), record, scope, map, emptyMap())

    // A command's arguments renamed by `map`, except its creations, which only `moves` (its own retained source-to-target
    // identities, §7.7 write map step 0) rename.
    fun remapCommand(scope: ScopeRef, command: Json, map: RecordMap, moves: Map<RecordKey, RecordID> = emptyMap()): Json =
        if (command["args"] !is Json.Obj) command else remap(commandLeaves(command.member("name").str()), command, scope, map, moves)

    // Each pass reads every leaf before it writes one, so no mapping feeds another; a place two leaves share (a key that is
    // also the record's own id) is written once.
    private fun remap(leaves: List<Leaf>, holder: Json, scope: ScopeRef, map: RecordMap, moves: Map<RecordKey, RecordID>): Json {
        var renamed = holder
        val places = mutableSetOf<Pair<Base, List<String>>>()
        fun rename(references: List<Reference>, target: (Reference) -> RecordID?) {
            val writes = references.mapNotNull { reference -> target(reference)?.let { reference.leaf to it } }
            for ((leaf, id) in writes) if (places.add(leaf.base to leaf.path)) renamed = leaf.write(renamed, id.json)
        }
        rename(resolve(leaves, renamed, scope)) { reference ->
            moves[reference.key] ?: if (reference.leaf.role != Leaf.Role.creation && registry.isGlobal(reference.key.type)) map.globalTarget(reference.key) else null
        }
        val local = leaves.filter { it.role != Leaf.Role.creation && !registry.isGlobal(it.type) }
        rename(resolve(local, renamed, map.scope(scope))) { map.scopedTarget(it.scope, it.key) }
        return renamed
    }

    // §6.1 step 2 for one field value: each annotated leaf present holds an id of its type (E-2's bounds included), null
    // only where nullable, under objects all the way down; a present treeFrom leaf's source is present too.
    fun checkValue(field: FieldDef, value: Json): Boolean {
        val (name, leaves) = annotatedFields[field] ?: return true
        return holds(leaves, Json.objectOf("f" to Json.objectOf(name to Json.array(value))))
    }

    fun checkArguments(command: CommandDef, args: Json): Boolean = holds(commandLeaves(command.name).filter { it.annotated }, Json.objectOf("args" to args))

    private fun holds(leaves: List<Leaf>, holder: Json): Boolean = leaves.all { leaf ->
        when (val found = leaf.find(holder)) {
            Leaf.Found.Malformed -> false
            Leaf.Found.Null -> leaf.nullable
            is Leaf.Found.Value -> found.value is Json.Str && registry.type(leaf.type)?.let { registry.isId(found.value, it) } == true &&
                (leaf.scope !is LeafScope.TreeFrom || leaf.scope.source.find(holder) is Leaf.Found.Value)
            else -> true
        }
    }
}
