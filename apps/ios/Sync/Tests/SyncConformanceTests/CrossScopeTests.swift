import SyncCore
import SyncModelServer
import SyncTesting
import Testing

struct CrossScopeContractTests {
  @Test func effectsCoalesceIntoOneFramePerChangedScope() throws {
    let file = try #require(Corpus.files().first { $0.path == "admit/cross-scope.json" })
    let vector = try #require(Corpus.vectors(in: file).first)
    let input = vector.input
    let rules = TraceRules(plan: try input.member("effectPlan"))
    var state = try ServerState(json: input.member("state"))
    let admission = Admission(registry: ServerHandlers.probe, rules: rules)
    let admitted = try admission.admit(input.member("intent"), from: .server(account: "A", requestId: nil),
                                       at: try input.member("serverNow").asInteger(), in: &state)
    #expect(rules.steps == ["discover", "command", "effects"])
    #expect(["result": admitted.result.json, "state": state.json] as JSON == vector.expect)
    let scopes = ["acct:A/probe", "acct:A/overlay/b_00000001", "tree:b_00000001"]
    let expected = try scopes.map { text -> JSON in
      let scope = try vector.expect.member("state").member("scopes").member(text)
      let rows = try vector.expect.member("state").member("rows").member(text).asArray()
        .filter { $0["seq"] == scope["seq"] }
      return ["key": .string(text), "frame": ["op": "change", "scope": try ScopeKey(parsing: text).ref.json,
        "epoch": "ep-1", "seq": try scope.member("seq"), "digest": try scope.member("digest"), "rows": .array(rows)]]
    }
    #expect(admitted.events.map(\.json) == expected)
  }

  @Test func aSameTextReplacementLeavesEveryScopeUnchanged() throws {
    let file = try #require(Corpus.files().first { $0.path == "admit/cross-scope.json" })
    let vector = try #require(Corpus.vectors(in: file).first)
    var state = try ServerState(json: vector.expect.member("state"))
    let before = state
    let plan: JSON = ["declared": ["acct:A/overlay/b_00000001"], "command": [
      "acct:A/overlay/b_00000001": [["t": "mark", "id": "oak", "x": ["memo": ["text": "one two", "replace": true]]]],
    ]]
    let admission = Admission(registry: ServerHandlers.probe, rules: EffectPlanRules(plan: plan))
    let admitted = try admission.admit(vector.input.member("intent"), from: .server(account: "A", requestId: nil), at: 2_000_000, in: &state)
    #expect(admitted.result == .ok(seq: 2, write: [], detail: nil))
    #expect(admitted.events == [])
    #expect(state == before)
  }

  @Test func localRulesReadTheTargetScopeAndCascadeThere() throws {
    let file = try #require(Corpus.files().first { $0.path == "admit/check.json" })
    let vector = try #require(Corpus.vectors(in: file).first { $0.name == "a run delete kills its alive laps in the same seq with one server stamp" })
    var schema = try Corpus.registryFile("probe").asObject()
    schema["commands"] = .array(try schema.member("commands").asArray().map { command in
      var object = try command.asObject()
      if object["name"] == "probe.tick" { object["scope"] = "tree" }
      return .object(object)
    })
    let registry = try Registry(json: .object(schema))
    let product = ScopeKey(.product(account: "A", name: "probe"))
    let tree = ScopeKey(.tree("b_00000001"))
    var scope = ScopeRecord(owner: "A", born: .governingCreate)
    scope.seq = 17
    var state = try ServerState(json: vector.input.member("state"))
    state.scopes[tree] = scope
    var expected = try ServerState(json: vector.expect.member("state"))
    expected.scopes[tree] = scope
    let delta = try IntentShape.effect(vector.input.member("intent").member("d").asArray()[0], in: product, source: .command, registry: registry)
    let admission = Admission(registry: registry, rules: TreeRunRules(delta: delta))
    let result = try admission.admit(["scope": tree.ref.json, "cmd": ["name": "probe.tick", "args": [:]]],
                                     from: .server(account: "A", requestId: nil), at: 1_000_000, in: &state)
    #expect(result.result == .ok(seq: 17, write: [], detail: nil))
    #expect(state == expected)
    #expect(result.events.map(\.key) == [product])
  }

  struct TreeRunRules: ServerRules {
    let delta: PlannedDelta
    var localCheckTypes: Set<String>? { ["run"] }
    func discoverEffectScopes(in context: RuleContext, command: CheckedCommand?) -> Set<ScopeKey> {
      [ScopeKey(.product(account: context.account, name: "probe"))]
    }
    func run(_ command: CheckedCommand, in context: RuleContext) -> CommandOutcome {
      CommandOutcome(product: context.product, into: [ScopeKey(.product(account: context.account, name: "probe")): [delta]])
    }
    func check(_ changes: [RecordChange], in context: inout RuleContext) throws(Refusal) -> [PlannedDelta] {
      try ProbeServerRules().check(changes, in: &context)
    }
  }

  final class TraceRules: ServerRules, @unchecked Sendable {
    let delegate: EffectPlanRules
    var steps: [String] = []

    init(plan: JSON) { delegate = EffectPlanRules(plan: plan) }
    func discoverEffectScopes(in context: RuleContext, command: CheckedCommand?) throws -> Set<ScopeKey> {
      steps.append("discover")
      guard context.record(RecordKey("card", "card0009")) == nil, context.deltas.isEmpty else { throw ServerVectorError("discovery ran after command") }
      return try delegate.discoverEffectScopes(in: context, command: command)
    }
    func run(_ command: CheckedCommand, in context: RuleContext) throws -> CommandOutcome {
      steps.append("command")
      return try delegate.run(command, in: context)
    }
    func effects(_ changes: [RecordChange], in context: inout RuleContext) throws -> Effects {
      steps.append("effects")
      guard changes.count == 3 else { throw ServerVectorError("effects did not receive all scopes") }
      return try delegate.effects(changes, in: &context)
    }
    func keptRevisions(_ revisions: [Revision]) -> [Revision] { delegate.keptRevisions(revisions) }
  }
}
