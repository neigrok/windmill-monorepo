// §2.4 values against the registry: ids, field values and command arguments in their units and domains, every number on
// its domain's quantum at any depth (§6.1 step 2); and §7.1 step 4's rounding of every number to its domain's quantum.
// Every integer is a safe integer (§9.1), as `asInteger` reads one.

extension Registry {
  // A tree or overlay reference names an id of the governing type.
  public func isScopeID(_ scope: ScopeRef) -> Bool {
    guard let tree = scope.tree else { return true }
    guard let governing = governingType else { return false }
    return isID(.string(tree), of: governing)
  }

  public func isID(_ id: JSON, of type: TypeDef) -> Bool {
    if case .keyed = type.identity, let key = type.key {
      switch key {
      case .ref(let target):
        guard let target = self.type(target) else { return false }
        return isID(id, of: target) && (type.idPattern.map { Registry.matches(id, $0) } ?? true)
      case .tuple(let parts):
        guard case .array(let items) = id, items.count == parts.count else { return false }
        return zip(items, parts).allSatisfy { item, part in self.type(part.ref).map { isID(item, of: $0) } ?? false }
      }
    }
    guard let pattern = type.idPattern, Registry.matches(id, pattern) else { return false }
    guard type.identity == .singleton, let singleton = type.singletonId else { return true }
    return id == .string(singleton)
  }

  // A field's value: its kind's (a ranked field's rank, a time field's epoch ms), its domain's, its ref's and its bounds'.
  public func admits(_ value: JSON, for field: FieldDef) -> Bool {
    switch field.kind {
    case .ranked(let rank): guard rank.of(value) != nil else { return false }
    case .time: guard Registry.isEpochMs(value) else { return false }
    default: break
    }
    if let domain = field.domain, !domain.admits(value) { return false }
    if value.isNull { return field.domain?.nullable ?? (field.ref == nil) }
    if let target = field.ref, !(type(target).map { isID(value, of: $0) } ?? false) { return false }
    return field.bounds?.admits(value) ?? true
  }

  public func admits(_ value: JSON, for argument: ArgumentDef) -> Bool {
    if let domain = argument.domain, !domain.admits(value) { return false }
    switch argument.type {
    case .json: return true
    case .time, .instant: return Registry.isEpochMs(value)
    case .ref(let target):
      if value.isNull { return argument.domain?.nullable ?? false }
      return type(target).map { isID(value, of: $0) } ?? false
    }
  }

  // §7.1 step 4: the command with every number of its arguments rounded to its argument domain's quantum, at any depth. A
  // command, argument or shape the registry does not declare is left as it is, for admission to refuse.
  public func rounded(_ command: Command) -> Command {
    guard let definition = self.command(command.name), case .object(let args) = command.args else { return command }
    let rounded = args.members.map { name, value in
      (name, definition.args.first { $0.name.utf8.elementsEqual(name.utf8) }?.domain?.rounded(value) ?? value)
    }
    return Command(name: command.name, args: .object(JSON.Object(uniqueKeysWithValues: rounded)))
  }

  static func matches(_ id: JSON, _ pattern: Pattern) -> Bool {
    guard case .string(let text) = id else { return false }
    return pattern.matches(text)
  }

  static func isEpochMs(_ value: JSON) -> Bool {
    (try? value.asInteger(atLeast: 0)) != nil
  }
}

extension Domain {
  // The value is of the domain, each nested value of its own, and every number on its quantum.
  public func admits(_ value: JSON) -> Bool {
    if value.isNull { return nullable }
    switch shape {
    case .string(let allowed, let pattern, let bounds):
      guard case .string(let text) = value else { return false }
      if let allowed, !allowed.contains(where: { $0.utf8.elementsEqual(text.utf8) }) { return false }
      if let pattern, !pattern.matches(text) { return false }
      return bounds?.admits(value) ?? true
    case .number(let integer, let min, let max, let quantum):
      guard case .number(let number) = value else { return false }
      if integer && (try? value.asInteger()) == nil { return false }
      if let quantum, !quantum.holds(number.value) { return false }
      return number.value >= (min ?? -.infinity) && number.value <= (max ?? .infinity)
    case .boolean:
      if case .bool = value { return true }
      return false
    case .fracKey:
      guard case .string(let text) = value else { return false }
      return (try? FractionalKey(text)) != nil
    case .stamp:
      guard case .string(let text) = value else { return false }
      return (try? Stamp(text)) != nil
    case .id:
      if case .string = value { return true }
      return false
    case .json:
      return true
    case .array(let items, let maxItems):
      guard case .array(let elements) = value, elements.count <= (maxItems ?? Int.max) else { return false }
      return elements.allSatisfy(items.admits)
    case .object(let properties, let required):
      guard case .object(let object) = value else { return false }
      for (name, member) in object.members {
        guard let property = properties.first(where: { $0.name.utf8.elementsEqual(name.utf8) }), property.domain.admits(member) else {
          return false
        }
      }
      return required.allSatisfy { object[$0] != nil }
    }
  }

  // §7.1 step 4: every number of the value rounded to its domain's quantum, at any depth. A value off the domain's shape,
  // or a number too large to round, is left as it is, for admission to refuse.
  public func rounded(_ value: JSON) -> JSON {
    switch (shape, value) {
    case (.number(_, _, _, let quantum?), .number(let number)):
      return JSON.Number(quantum.rounded(number.value)).map(JSON.number) ?? value
    case (.array(let items, _), .array(let elements)):
      return .array(elements.map(items.rounded))
    case (.object(let properties, _), .object(let object)):
      return .object(JSON.Object(uniqueKeysWithValues: object.members.map { name, member in
        (name, properties.first { $0.name.utf8.elementsEqual(name.utf8) }?.domain.rounded(member) ?? member)
      }))
    default:
      return value
    }
  }
}
