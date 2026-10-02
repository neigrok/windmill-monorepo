import SyncCore

// The model's composition root binds each product independently, over the same server state.
public struct ComposedServerRules: ServerRules {
  let registry: Registry
  let products: [String: any ServerRules]

  public init(registry: Registry, products: [String: any ServerRules]) {
    precondition(Set(registry.products.map(\.name)) == Set(products.keys), "every composed product has rules")
    self.registry = registry; self.products = products
  }

  public static func windmill(registry: Registry) -> ComposedServerRules {
    ComposedServerRules(registry: registry, products: ["gym": GymServerRules(), "journal": JournalServerRules()])
  }

  func rules(_ context: RuleContext) -> any ServerRules { products[registry.product(of: context.scope.ref)!]! }
  public func elsewhere(_ key: RecordKey, product: JSON.Object) -> Bool { products.values.contains { $0.elsewhere(key, product: product) } }
  public func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool { rules(context).replays(command, in: context) }
  public func run(_ command: CheckedCommand, in context: RuleContext) throws(Refusal) -> CommandOutcome { try rules(context).run(command, in: context) }
  public func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] { try rules(context).check(changes, in: &context) }
  public func pruneRevisions(_ revisions: [Revision], archived: [Revision], serverNow: Int64, scope: ScopeKey, product: inout JSON.Object) -> [Revision] {
    guard let name = registry.product(of: scope.ref) else { return revisions }
    return products[name]!.pruneRevisions(revisions, archived: archived, serverNow: serverNow, scope: scope, product: &product)
  }
}
