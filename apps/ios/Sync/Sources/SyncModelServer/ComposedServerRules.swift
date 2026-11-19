import SyncCore

// The model's composition root binds each product independently, over the same server state.
public struct ComposedServerRules: ServerRules {
  let registry: Registry
  let products: [String: any ServerRules]

  public init(registry: Registry, products: [String: any ServerRules]) {
    precondition(Set(registry.products.map(\.name)) == Set(products.keys), "every composed product has rules")
    self.registry = registry; self.products = products
  }

  // Windmill's products' rules, for each product the registry composes.
  public static func windmill(registry: Registry) -> ComposedServerRules {
    let rules: [String: any ServerRules] = ["gym": GymServerRules(), "journal": JournalServerRules(), "roadmap": RoadmapServerRules()]
    return ComposedServerRules(registry: registry, products: rules.filter { (name: String, _: any ServerRules) -> Bool in
      registry.products.contains { $0.name.isSameID(as: name) }
    })
  }

  func rules(_ context: RuleContext) -> any ServerRules { products[registry.product(of: context.scope.ref)!]! }
  public func elsewhere(_ key: RecordKey, product: JSON.Object) -> Bool { products.values.contains { $0.elsewhere(key, product: product) } }
  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool { rules(context).replays(command, in: context) }
  public func discoverEffectScopes(in context: RuleContext, command: CheckedCommand?) throws -> Set<ScopeKey> {
    try rules(context).discoverEffectScopes(in: context, command: command)
  }
  public func effects(_ changes: [RecordChange], in context: inout RuleContext) throws -> Effects {
    var names = Set(changes.compactMap { registry.product(of: $0.scope.ref) })
    if names.isEmpty || !context.deltas.isEmpty, let origin = registry.product(of: context.originScope.ref) { names.insert(origin) }
    var combined: [ScopeKey: [PlannedDelta]] = [:]
    for name in names.sorted() {
      var product = context
      product.ruleProducts = [name]
      let effects = try products[name]!.effects(changes, in: &product)
      context.product = product.product
      for (scope, deltas) in effects.byScope { combined[scope, default: []] += deltas }
    }
    return Effects(byScope: combined)
  }
  public func run(_ command: CheckedCommand, in context: RuleContext) throws -> CommandOutcome { try rules(context).run(command, in: context) }
  public func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] { try rules(context).check(changes, in: &context) }
  public func pruneRevisions(_ revisions: [Revision], archived: [Revision], serverNow: Int64, scope: ScopeKey, product: inout JSON.Object) -> [Revision] {
    guard let name = registry.product(of: scope.ref) else { return revisions }
    return products[name]!.pruneRevisions(revisions, archived: archived, serverNow: serverNow, scope: scope, product: &product)
  }
}
