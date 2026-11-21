import SyncCore
import SyncModelServer
import Testing

struct ComposedServerRulesTests {
  @Test(arguments: [false, true])
  func threeProductsDispatchOnceAndRollbackTheThirdRefusal(_ refuse: Bool) throws {
    let names = ["alpha", "beta", "gamma"]
    let registry = try Self.registry(names)
    let trace = Trace()
    let products = Dictionary(uniqueKeysWithValues: names.reversed().map { ($0, Rules(name: $0, trace: trace, refuse: refuse) as any ServerRules) })
    let rules = ComposedServerRules(registry: registry, products: products)
    let admission = Admission(registry: registry, rules: rules)
    var state = ServerState(epoch: "ep-1")
    for name in names { state.scopes[Self.scope(name)] = ScopeRecord(owner: "A", born: .firstWrite) }
    let before = state
    let intent: JSON = ["scope": "self/gamma", "cmd": ["name": "gamma.set", "args": [:]]]
    let admitted = try admission.admit(intent, from: .server(account: "A", requestId: nil), at: 1_000, in: &state)
    #expect(trace.calls == ["gamma.replay", "gamma.discover", "gamma.run", "alpha.check", "beta.check", "gamma.check"])
    if refuse {
      #expect(admitted.result == .refused(Refusal(.invalid)))
      #expect(admitted.events.isEmpty)
      #expect(state == before)
      return
    }
    #expect(admitted.result == .ok(seq: 1, write: [], detail: nil))
    #expect(admitted.events.map(\.key) == ["gamma", "alpha", "beta"].map(Self.scope))
    #expect(state.product == ["receipt": "gamma", "alpha": true, "beta": true, "gamma": true])
    for name in names {
      #expect(state.rows[Self.scope(name)]?[RecordKey(name, RecordID(name))]?.lattice.fields["value"]?.value == "checked")
    }
    trace.calls = []
    let written = state
    let replay: JSON = ["scope": "self/gamma", "cmd": ["name": "gamma.set", "args": [:]],
                        "guard": [["t": "gamma", "id": "gamma", "field": "value", "stamp": "1:0:a"]]]
    let repeated = try admission.admit(replay, from: .server(account: "A", requestId: nil), at: 2_000, in: &state)
    #expect(trace.calls == ["gamma.replay", "gamma.discover", "gamma.run", "gamma.check"])
    #expect(repeated.result == .ok(seq: 1, write: [], detail: nil))
    #expect(repeated.events.isEmpty)
    #expect(state == written)

    let revisions = (1...3).map { Revision(key: RecordKey("gamma", "gamma"), field: "text", rev: Int64($0), text: String($0)) }
    for (index, name) in names.enumerated() {
      var product: JSON.Object = [:]
      #expect(rules.pruneRevisions(revisions, archived: [], serverNow: 2_000, scope: Self.scope(name), product: &product) == Array(revisions.suffix(index + 1)))
    }
  }

  static func scope(_ name: String) -> ScopeKey { ScopeKey(.product(account: "A", name: name)) }

  static func registry(_ names: [String]) throws -> Registry {
    try Registry(name: "three", composing: names.map { name in
      try Registry(json: JSON(parsing: """
        {"registry":"\(name)","version":3,"minVersion":2,"products":{"\(name)":{}},
         "types":[{"type":"\(name)","scope":"product:\(name)","identity":"singleton","singletonId":"\(name)",
          "idPattern":"^\(name)$","life":false,"origins":["server","replica"],
          "fields":{"value":{"kind":"lww","writer":"client","domain":{"type":"string"}}}}],
         "commands":[{"name":"\(name).set","scope":"product:\(name)","origins":["server"],"serverInternal":false,"args":{}}]}
        """))
    })
  }

  final class Trace: @unchecked Sendable { var calls: [String] = [] }

  struct Rules: ServerRules {
    let name: String
    let trace: Trace
    let refuse: Bool

    func replays(_ command: CheckedCommand, in context: RuleContext) -> Bool {
      trace.calls.append("\(name).replay")
      return context.product["receipt"] == "gamma"
    }
    func discoverEffectScopes(in context: RuleContext, command: CheckedCommand?) -> Set<ScopeKey> {
      trace.calls.append("\(name).discover")
      #expect(context.scope == ComposedServerRulesTests.scope("gamma"))
      return context.product["receipt"] == nil ? Set(["alpha", "beta"].map(ComposedServerRulesTests.scope)) : []
    }
    func run(_ command: CheckedCommand, in context: RuleContext) -> CommandOutcome {
      trace.calls.append("\(name).run")
      #expect(command.name == "gamma.set")
      if context.product["receipt"] != nil { return CommandOutcome(product: context.product) }
      var product = context.product
      product["receipt"] = "gamma"
      let delta = { (name: String) in PlannedDelta.serverUpdate(RecordKey(name, RecordID(name)), born: nil, fields: ["value": "command"]) }
      return CommandOutcome(deltas: [delta("gamma")], product: product,
                            into: Dictionary(uniqueKeysWithValues: ["alpha", "beta"].map { (ComposedServerRulesTests.scope($0), [delta($0)]) }))
    }
    func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
      trace.calls.append("\(name).check")
      #expect(context.scope == ComposedServerRulesTests.scope(name))
      #expect(context.originScope == ComposedServerRulesTests.scope("gamma"))
      if changes.isEmpty { return [] }
      #expect(changes.map { $0.key.type }.sorted() == ["alpha", "beta", "gamma"])
      #expect(context.record(RecordKey(name, RecordID(name)))?.lattice.fields["value"]?.value == "command")
      if refuse && name == "gamma" { throw Refusal(.invalid) }
      context.product[name] = true
      return [.serverUpdate(RecordKey(name, RecordID(name)), born: nil, fields: ["value": "checked"])]
    }
    func keptRevisions(_ revisions: [Revision]) -> [Revision] {
      Array(revisions.suffix(["alpha": 1, "beta": 2, "gamma": 3][name]!))
    }
  }
}
