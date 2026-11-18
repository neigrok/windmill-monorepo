// E-8 typed references (§2.4 References, D-10): every place a registry declares a record identity inside a value,
// compiled once per registry into leaves. A record's own id, its key parts, a `ref` field, a `ref<t>` argument and each
// literal property path a `refPaths` entry names is a leaf; this one traversal serves admission's checks, the commit's,
// dependents (§7.7 step 3) and the global and scoped id maps. Unannotated JSON and text are never read.

// One record of one scope, the same only byte for byte.
public struct ScopedKey: Sendable, Hashable {
  public let scope: ScopeRef
  public let key: RecordKey

  public init(scope: ScopeRef, key: RecordKey) {
    self.scope = scope
    self.key = key
  }
}

// One place an identity sits in a holder: `base` is the engine's own part of the pointer, `path` the registry's literal
// property path below it. `identity` is a record's own id, `creation` a command's proposed identity, `ordinary` every
// reference. `annotated` marks a leaf a `refPaths` entry declares, the ones admission checks beyond their shorthands.
public struct ReferenceLeaf: Sendable {
  public enum Role: String, Sendable {
    case identity, ordinary, creation
  }

  public enum Base: Sendable, Hashable {
    case id
    case keyPart(Int)
    case field(String)
    case args
  }

  // Where the named record lives: where its type lives seen from the holder, a declared product's scope, or the tree the
  // leaf at `path` of the same declaration names.
  public enum Scope: Sendable {
    case origin
    case fixed(ScopeRef)
    case treeFrom([String])
  }

  // A leaf in a holder: absent, null under a null object on the way (which names nothing), null, a value, or malformed
  // where something other than an object stands where the path continues.
  public enum Found: Sendable, Hashable {
    case absent, outerNull, malformed, null
    case value(JSON)

    var isValue: Bool {
      if case .value = self { return true }
      return false
    }
  }

  // A leaf's place, which two leaves may share (a key that is also the record's own id).
  struct Place: Hashable {
    let base: Base
    let path: [String]
  }

  public let name: String
  public let base: Base
  public let path: [String]
  public let type: String
  public let scope: Scope
  public let nullable: Bool
  public let role: Role
  public let annotated: Bool

  init(name: String, base: Base, path: [String] = [], type: String, scope: Scope = .origin, nullable: Bool = false,
       role: Role = .ordinary, annotated: Bool = false) {
    self.name = name
    self.base = base
    self.path = path
    self.type = type
    self.scope = scope
    self.nullable = nullable
    self.role = role
    self.annotated = annotated
  }

  var place: Place { Place(base: base, path: path) }

  // The leaf a treeFrom scope reads: the same declaration's leaf at its path.
  var source: ReferenceLeaf? {
    guard case .treeFrom(let path) = scope else { return nil }
    return ReferenceLeaf(name: path.joined(separator: "."), base: base, path: path, type: type)
  }

  public func find(in holder: ReferenceHolder) -> Found {
    var node: JSON
    switch base {
    case .id:
      guard let id = holder.id else { return .absent }
      node = id
    case .keyPart(let index):
      guard case .array(let parts)? = holder.id, parts.indices.contains(index) else { return .absent }
      node = parts[index]
    case .field(let name):
      guard let value = holder.fields[name] else { return .absent }
      node = value
    case .args:
      guard let args = holder.args else { return .absent }
      node = args
    }
    for step in path {
      if node.isNull { return .outerNull }
      guard case .object(let object) = node else { return .malformed }
      guard let next = object[step] else { return .absent }
      node = next
    }
    return node.isNull ? .null : .value(node)
  }

  // `id` written where the leaf stands; a holder's field value or arguments are replaced, never edited in place.
  func assign(_ id: JSON, in holder: inout ReferenceHolder) {
    switch base {
    case .id: holder.id = ReferenceLeaf.replacing(path, in: holder.id ?? .null, with: id)
    case .keyPart(let index):
      guard case .array(var parts)? = holder.id else { return }
      parts[index] = id
      holder.id = .array(parts)
    case .field(let name): holder.fields[name] = holder.fields[name].map { ReferenceLeaf.replacing(path, in: $0, with: id) }
    case .args: holder.args = holder.args.map { ReferenceLeaf.replacing(path, in: $0, with: id) }
    }
  }

  static func replacing(_ path: [String], in value: JSON, with id: JSON) -> JSON {
    guard let step = path.first, case .object(var object) = value, let next = object[step] else { return id }
    object[step] = replacing(Array(path.dropFirst()), in: next, with: id)
    return .object(object)
  }
}

// What leaves read and write: a record's id and field values (a delta, a guard, a receipt row), or a command's arguments.
public struct ReferenceHolder: Sendable, Hashable {
  public var id: JSON?
  public var fields: [String: JSON]
  public var args: JSON?

  public init(id: JSON? = nil, fields: [String: JSON] = [:], args: JSON? = nil) {
    self.id = id
    self.fields = fields
    self.args = args
  }
}

// One identity a holder names: the leaf, the scope it declares, and the record.
public struct ResolvedReference: Sendable {
  public let leaf: ReferenceLeaf
  public let scope: ScopeRef
  public let key: RecordKey

  public var record: ScopedKey { ScopedKey(scope: scope, key: key) }
}

// A logical id map (§7.7 write map): a global mapping renames an id of a global type in every scope; a scoped mapping
// renames an id of a scope-local type in one scope, keyed by that scope as the map's own governor mappings leave it.
public struct RecordMap: Sendable {
  public struct Mapping: Sendable {
    public let type: String
    public let from: RecordID
    public let to: RecordID
    public let scope: ScopeRef?

    public init(type: String, from: RecordID, to: RecordID, scope: ScopeRef? = nil) {
      self.type = type
      self.from = from
      self.to = to
      self.scope = scope
    }
  }

  var global: [RecordKey: RecordID] = [:]
  var scoped: [ScopedKey: RecordID] = [:]
  var governors: [String: String] = [:]
  let registry: Registry

  public init(registry: Registry, mappings: [Mapping]) {
    self.registry = registry
    let globals = mappings.filter { registry.type($0.type)?.idSpace == .global }
    for mapping in globals {
      global[RecordKey(mapping.type, mapping.from)] = mapping.to
      if registry.governingType?.name.isSameID(as: mapping.type) == true, let from = mapping.from.string, let to = mapping.to.string {
        governors[from] = to
      }
    }
    for mapping in mappings where registry.type(mapping.type)?.idSpace != .global {
      guard let scope = mapping.scope else { continue }
      scoped[ScopedKey(scope: self.scope(scope), key: RecordKey(mapping.type, mapping.from))] = mapping.to
    }
  }

  // Whether any governor moves, which moves the scopes it governs.
  public var movesGovernors: Bool { !governors.isEmpty }

  // A tree or overlay ScopeRef after the governor mappings; any other scope as it is.
  public func scope(_ ref: ScopeRef) -> ScopeRef {
    guard let tree = ref.tree, let moved = governors[tree] else { return ref }
    return ref.retargeted(to: RecordID(moved))
  }

  // Where `key` resolves, a global type's in any scope and a scope-local type's in `scope` as the governors leave it.
  public func target(of key: RecordKey, in scope: ScopeRef) -> RecordID? {
    registry.type(key.type)?.idSpace == .global ? global[key] : scoped[ScopedKey(scope: self.scope(scope), key: key)]
  }
}

// The compiled leaves of a registry: each type's and each command's, and each annotated field's for its value check.
public struct References: Sendable {
  var records: [String: [ReferenceLeaf]] = [:]
  var commands: [String: [ReferenceLeaf]] = [:]

  public init() {}

  // §2.4's load rules, every type's and every command's leaves compiled; a registry that breaks one is refused.
  init(compiling registry: Registry) throws(RegistryError) {
    for type in registry.types { records[type.name] = try References.leaves(of: type, in: registry) }
    for command in registry.commands { commands[command.name] = try References.leaves(of: command, in: registry) }
  }

  public func leaves(ofType type: String) -> [ReferenceLeaf] { records[type] ?? [] }
  public func leaves(ofCommand name: String) -> [ReferenceLeaf] { commands[name] ?? [] }

  static func leaves(of type: TypeDef, in registry: Registry) throws(RegistryError) -> [ReferenceLeaf] {
    var leaves: [ReferenceLeaf] = []
    if type.identity != .singleton { leaves.append(ReferenceLeaf(name: "id", base: .id, type: type.name, role: .identity)) }
    switch type.key {
    case .ref(let target)?: leaves.append(ReferenceLeaf(name: "key", base: .id, type: target))
    case .tuple(let parts)?:
      for (index, part) in parts.enumerated() { leaves.append(ReferenceLeaf(name: "key.\(part.name)", base: .keyPart(index), type: part.ref)) }
    case nil: break
    }
    for field in type.fields {
      let place = "\(type.name).\(field.name)"
      if let target = field.ref {
        leaves.append(ReferenceLeaf(name: field.name, base: .field(field.name), type: target, nullable: field.domain?.nullable == true))
      }
      guard let refPaths = field.refPaths else { continue }
      guard field.ref == nil else { throw RegistryError("\(place): a field holds one scalar ref or refPaths, not both") }
      switch field.kind {
      case .lww, .fww, .const: break
      default: throw RegistryError("\(place): refPaths are for an lww, fww or const field")
      }
      let annotated = try compile(refPaths, at: place, base: .field(field.name), holder: type.scope, registry: registry) { path throws(RegistryError) in
        DomainAlong(field.domain, path)
      }
      guard annotated.allSatisfy({ $0.role == .ordinary }) else { throw RegistryError("\(place): only a command argument proposes a creation") }
      leaves += annotated
    }
    return leaves
  }

  static func leaves(of command: CommandDef, in registry: Registry) throws(RegistryError) -> [ReferenceLeaf] {
    let shorthands = command.args.compactMap { arg in
      arg.type.ref.map { ReferenceLeaf(name: arg.name, base: .args, path: [arg.name], type: $0) }
    }
    guard let refPaths = command.refPaths else { return shorthands }
    let place = command.name
    let annotated = try compile(refPaths, at: place, base: .args, holder: command.scope, shorthands: shorthands, registry: registry) { path throws(RegistryError) in
      guard let arg = command.args.first(where: { $0.name.utf8.elementsEqual(path[0].utf8) }) else {
        throw RegistryError("\(place): refPaths name the undeclared argument \(path[0])")
      }
      guard case .json = arg.type else { throw RegistryError("\(place): refPaths reach into a json argument, not \(arg.type) \(path[0])") }
      return DomainAlong(arg.domain, Array(path.dropFirst()))
    }
    for leaf in annotated where leaf.role == .creation {
      guard registry.type(leaf.type)?.hasBorn == true else { throw RegistryError("\(place).\(leaf.name): a creation names a minted or derived type") }
      guard command.predicts.contains(where: { $0.utf8.elementsEqual(leaf.type.utf8) }) else {
        throw RegistryError("\(place).\(leaf.name): a creation names a type the command predicts")
      }
    }
    return shorthands + annotated
  }

  // One declaration's refPaths: literal nonempty paths through the value's object domain, a known target with string ids,
  // a scope of the target's family, each treeFrom source an ordinary leaf of the same declaration holding a governing id,
  // and no leaf declared twice or inside another.
  static func compile(_ refPaths: JSON, at place: String, base: ReferenceLeaf.Base, holder: ScopeKind, shorthands: [ReferenceLeaf] = [],
                      registry: Registry, domainAt: ([String]) throws(RegistryError) -> DomainAlong) throws(RegistryError) -> [ReferenceLeaf] {
    guard case .array(let declarations) = refPaths, !declarations.isEmpty else { throw RegistryError("\(place): refPaths is a nonempty array") }
    var leaves: [ReferenceLeaf] = []
    for declared in declarations {
      guard case .object(let object) = declared,
            object.keys.allSatisfy({ ["path", "type", "scope", "nullable", "role"].contains($0) }) else {
        throw RegistryError("\(place): a refPath holds path, type, scope, nullable and role only")
      }
      guard let path = isPath(object["path"]) else { throw RegistryError("\(place): a refPath's path is a nonempty array of property names") }
      let name = "\(place).\(path.joined(separator: "."))"
      guard case .string(let typeName)? = object["type"], let target = registry.type(typeName) else {
        throw RegistryError("\(name): refers to an unknown type")
      }
      if case .tuple? = target.key { throw RegistryError("\(name): a typed leaf holds a string id, never a tuple") }
      guard object["nullable"].map({ $0 == .bool(true) }) ?? true else { throw RegistryError("\(name): nullable is true or absent") }
      guard object["role"].map({ $0 == "creation" }) ?? true else { throw RegistryError("\(name): role is creation or absent") }
      switch try domainAt(path) {
      case .open: break
      case .reaches(let domain):
        switch domain.shape {
        case .string, .id, .json: break
        default: throw RegistryError("\(name): a typed leaf's domain holds a string")
        }
      case .none: throw RegistryError("\(name): a typed leaf's domain holds a string")
      }
      let scope = try scopeFamily(object["scope"], at: name, of: target, holder: holder, registry: registry)
      leaves.append(ReferenceLeaf(
        name: path.joined(separator: "."), base: base, path: path, type: target.name, scope: scope, nullable: object["nullable"] != nil,
        role: object["role"] != nil ? .creation : .ordinary, annotated: true))
    }
    let declared = shorthands + leaves
    for (index, leaf) in leaves.enumerated() {
      let others = shorthands + leaves.enumerated().filter { $0.offset != index }.map(\.element)
      guard !others.contains(where: { $0.path == leaf.path || isPrefix($0.path, of: leaf.path) || isPrefix(leaf.path, of: $0.path) }) else {
        throw RegistryError("\(place).\(leaf.name): a leaf is declared once and never inside another")
      }
      guard case .treeFrom(let sourcePath) = leaf.scope else { continue }
      guard let source = declared.first(where: { $0.path == sourcePath }), let governing = registry.governingType,
            source.type.isSameID(as: governing.name), source.role == .ordinary else {
        throw RegistryError("\(place).\(leaf.name): treeFrom names an ordinary leaf of the governing type in the same declaration")
      }
    }
    return leaves
  }

  static func scopeFamily(_ json: JSON?, at name: String, of target: TypeDef, holder: ScopeKind,
                          registry: Registry) throws(RegistryError) -> ReferenceLeaf.Scope {
    guard case .object(let scope)? = json else { throw RegistryError("\(name): scope is an object") }
    let keys = scope.keys.sorted()
    let local = target.scope == .tree || target.scope == .overlay
    switch scope["kind"] {
    case "origin":
      guard keys == ["kind"] else { throw RegistryError("\(name): an origin scope holds kind only") }
      guard !local || holder == .tree || holder == .overlay else { throw RegistryError("\(name): \(target.name) lives in no scope the holder's origin names") }
      return .origin
    case "fixed":
      guard keys == ["kind", "value"] else { throw RegistryError("\(name): a fixed scope holds kind and value") }
      guard case .string(let value)? = scope["value"], let match = value.wholeMatch(of: #/self\/([a-z][a-z0-9]*)/#),
            registry.product(String(match.1)) != nil else {
        throw RegistryError("\(name): a fixed scope is self/<a declared product>")
      }
      guard target.scope == .product(String(match.1)) else { throw RegistryError("\(name): \(target.name) does not live in \(value)") }
      return .fixed(.product(String(match.1)))
    case "treeFrom":
      guard keys == ["kind", "path"], let path = isPath(scope["path"]) else {
        throw RegistryError("\(name): a treeFrom scope holds kind and a property path")
      }
      guard local else { throw RegistryError("\(name): treeFrom names a tree or overlay scope, where \(target.name) does not live") }
      return .treeFrom(path)
    default:
      throw RegistryError("\(name): scope kind is origin, fixed or treeFrom")
    }
  }

  static func isPath(_ json: JSON?) -> [String]? {
    guard case .array(let parts)? = json, !parts.isEmpty else { return nil }
    let names = parts.compactMap { if case .string(let name) = $0, name.wholeMatch(of: #/[a-z][A-Za-z0-9]*/#) != nil { name } else { nil } }
    return names.count == parts.count ? names : nil
  }

  static func isPrefix(_ prefix: [String], of path: [String]) -> Bool {
    prefix.count < path.count && zip(prefix, path).allSatisfy { $0.utf8.elementsEqual($1.utf8) }
  }
}

// The domain a property path reaches through object domains: open once a json domain, or no domain, leaves the shape
// open; none when the path runs into any other shape.
enum DomainAlong {
  case open
  case none
  case reaches(Domain)

  init(_ domain: Domain?, _ path: [String]) {
    var current = domain
    for part in path {
      guard let domain = current else { self = .open; return }
      switch domain.shape {
      case .json: self = .open; return
      case .object(let properties, _):
        guard let property = properties.first(where: { $0.name.utf8.elementsEqual(part.utf8) }) else { self = .none; return }
        current = property.domain
      default: self = .none; return
      }
    }
    self = current.map(DomainAlong.reaches) ?? .open
  }
}

// MARK: - The one traversal

extension Registry {
  // D-10: a reference names a record in the scope its leaf declares. `origin` is the scope its type lives in, seen from the
  // holder's scope: a product scope, or the tree and overlay scopes of the holder's tree. Nil when a treeFrom source holds
  // no id.
  func scope(of leaf: ReferenceLeaf, in holder: ReferenceHolder, holderScope: ScopeRef) -> ScopeRef? {
    switch leaf.scope {
    case .fixed(let scope): return scope
    case .treeFrom:
      guard case .value(.string(let tree))? = leaf.source?.find(in: holder) else { return nil }
      return type(leaf.type)?.scope == .tree ? .tree(tree) : .overlay(tree)
    case .origin:
      if leaf.role == .identity { return holderScope }
      return scope(ofType: leaf.type, from: holderScope)
    }
  }

  // Every resolved identity of `leaves` in a holder of `holderScope`.
  public func resolve(_ leaves: [ReferenceLeaf], in holder: ReferenceHolder, holderScope: ScopeRef) -> [ResolvedReference] {
    leaves.compactMap { leaf in
      guard case .value(let value) = leaf.find(in: holder), leaf.role == .identity || value.isString,
            let id = try? RecordID(json: value), let scope = scope(of: leaf, in: holder, holderScope: holderScope) else { return nil }
      return ResolvedReference(leaf: leaf, scope: scope, key: RecordKey(leaf.type, id))
    }
  }

  // The ordinary references a record holds, its key parts and field values: what makes it a dependent.
  public func references(of delta: Delta, in scope: ScopeRef) -> [ResolvedReference] {
    resolve(references.leaves(ofType: delta.key.type).filter { $0.role == .ordinary }, in: ReferenceHolder(delta), holderScope: scope)
  }

  // A command's references of one role: ordinary ones name existing records, creations propose new ones.
  public func references(of command: Command, in scope: ScopeRef, role: ReferenceLeaf.Role = .ordinary) -> [ResolvedReference] {
    guard case .object = command.args else { return [] }
    return resolve(references.leaves(ofCommand: command.name).filter { $0.role == role }, in: ReferenceHolder(args: command.args),
                   holderScope: scope)
  }

  // A delta renamed by `map`: global leaves first, then the scoped leaves resolved again from the renamed values, so a
  // treeFrom scope follows its renamed tree.
  public func remap(_ delta: inout Delta, in scope: ScopeRef, by map: RecordMap) {
    var holder = ReferenceHolder(delta)
    remap(references.leaves(ofType: delta.key.type), in: &holder, scope: scope, by: map)
    if let id = holder.id, let renamed = try? RecordID(json: id) { delta.key = RecordKey(delta.key.type, renamed) }
    for (name, value) in holder.fields where delta.lattice.fields[name]?.value != value {
      delta.lattice.fields[name] = Register(value, delta.lattice.fields[name]!.stamp)
    }
  }

  // A record named by its key alone (a guard, a receipt row, a base text) as `map` renames it.
  public func remapped(_ key: RecordKey, in scope: ScopeRef, by map: RecordMap) -> RecordKey {
    var holder = ReferenceHolder(id: key.id.json)
    remap(references.leaves(ofType: key.type), in: &holder, scope: scope, by: map)
    return holder.id.flatMap { try? RecordID(json: $0) }.map { RecordKey(key.type, $0) } ?? key
  }

  // A command's arguments renamed by `map`, except its creations, which only `moves` (its own retained source-to-target
  // identities, §7.7 write map step 0) rename.
  public func remap(_ command: inout Command, in scope: ScopeRef, by map: RecordMap, moves: [RecordKey: RecordID] = [:]) {
    guard case .object = command.args else { return }
    var holder = ReferenceHolder(args: command.args)
    remap(references.leaves(ofCommand: command.name), in: &holder, scope: scope, by: map, moves: moves)
    if let args = holder.args { command = Command(name: command.name, args: args) }
  }

  // Each pass reads every leaf before it writes one, so no mapping feeds another; a place two leaves share is written once.
  func remap(_ leaves: [ReferenceLeaf], in holder: inout ReferenceHolder, scope: ScopeRef, by map: RecordMap,
             moves: [RecordKey: RecordID] = [:]) {
    var written: Set<ReferenceLeaf.Place> = []
    let rename = { (holder: inout ReferenceHolder, renames: [(leaf: ReferenceLeaf, id: RecordID)]) in
      for (leaf, id) in renames where written.insert(leaf.place).inserted { leaf.assign(id.json, in: &holder) }
    }
    let isGlobal = { (leaf: ReferenceLeaf) in self.type(leaf.type)?.idSpace == .global }
    rename(&holder, resolve(leaves, in: holder, holderScope: scope).compactMap { reference in
      let target = moves[reference.key] ?? (reference.leaf.role != .creation && isGlobal(reference.leaf) ? map.global[reference.key] : nil)
      return target.map { (reference.leaf, $0) }
    })
    let local = leaves.filter { $0.role != .creation && !isGlobal($0) }
    rename(&holder, resolve(local, in: holder, holderScope: map.scope(scope)).compactMap { reference in
      map.scoped[reference.record].map { (reference.leaf, $0) }
    })
  }

  // §6.1 step 2 for one field value: each annotated leaf present holds an id of its type, E-2's bounds included, null
  // only where nullable, under objects all the way down; a present treeFrom leaf's source is present too. The first
  // fault, or nil.
  public func typedLeafFault(of value: JSON, for field: FieldDef, of type: TypeDef) -> String? {
    let leaves = references.leaves(ofType: type.name).filter { $0.annotated && $0.base == .field(field.name) }
    return fault(of: leaves, in: ReferenceHolder(fields: [field.name: value]))
  }

  public func typedLeafFault(of arguments: JSON, for command: CommandDef) -> String? {
    fault(of: references.leaves(ofCommand: command.name).filter(\.annotated), in: ReferenceHolder(args: arguments))
  }

  func fault(of leaves: [ReferenceLeaf], in holder: ReferenceHolder) -> String? {
    for leaf in leaves {
      switch leaf.find(in: holder) {
      case .malformed: return "\(leaf.name) lies under a value that is not an object"
      case .null where !leaf.nullable: return "\(leaf.name) is null"
      case .value(let value):
        guard let target = type(leaf.type), value.isString, isID(value, of: target) else { return "\(leaf.name) holds no id of \(leaf.type)" }
        if let source = leaf.source, !source.find(in: holder).isValue { return "\(leaf.name) names no tree" }
      case .absent, .outerNull, .null: continue
      }
    }
    return nil
  }
}

extension ReferenceHolder {
  public init(_ delta: Delta) {
    self.init(id: delta.key.id.json, fields: delta.lattice.fields.mapValues(\.value))
  }
}

extension JSON {
  var isString: Bool {
    if case .string = self { return true }
    return false
  }
}
