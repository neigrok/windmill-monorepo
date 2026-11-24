import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncModelServer
import Testing

// A roadmap's steps and links: each case of steps-actions.json by its complete decision, and, over the real engine, a
// change made against another phone's delete (INV-1), as the web's harness tells it (harness.test.js).
struct StepsTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/steps-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try Self.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  static func decision(_ vector: Vector) throws -> JSON {
    let corpus = ProductCorpus(RoadmapRules.book)
    let input = try vector.input.member("input")
    let tree: ID<RoadmapEntry> = try input.id("tree")
    switch try vector.input.member("action").asString() {
    case "CreateStep":
      let act = CreateStep(tree: tree, step: try RoadmapStep.Changes(form: input.member("step")), prerequisites: try input.ids("prerequisites"),
                           id: try input.optionalID("id"))
      return try corpus.act(act, vector, result: \.json, refusal: \.form)
    case "ChangeStep":
      let act = ChangeStep(tree: tree, step: try input.id("step"), changes: try RoadmapStep.Changes(form: input.member("changes")))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "MoveStep":
      let act = MoveStep(tree: tree, step: try input.id("step"), below: try input.optionalID("below"), siblings: try input.ids("siblings"))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "DeleteStep": return try corpus.act(DeleteStep(tree: tree, step: input.id("step")), vector, result: { .null }, refusal: \.form)
    case "ChangePrerequisites":
      let act = ChangePrerequisites(tree: tree, step: try input.id("step"), add: try input.ids("add"), remove: try input.ids("remove"))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "ImportSteps":
      let act = ImportSteps(tree: tree, imported: try ImportedSteps(form: input.member("imported")), under: try input.optionalID("under"),
                            done: try input.optional("done") { try $0.asArray().map { try $0.asString() } } ?? [])
      return try corpus.act(act, vector, result: { (planted: [(key: String, id: ID<RoadmapStep>)]) -> JSON in
        .object(JSON.Object(uniqueKeysWithValues: planted.map { ($0.key, $0.id.json) }))
      }, refusal: \.form)
    case let name: throw ContractError("no step action \(name)")
    }
  }

  // A roadmap of the steps named, each following the one before it, made on the phone and taken by the server, which a
  // tablet of the same account then holds too.
  static func chained(_ labels: [String]) throws -> (phone: Harness, tablet: Harness, tree: ID<RoadmapEntry>, steps: [ID<RoadmapStep>]) {
    let phone = RoadmapsTests.phone()
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn Rust")) else {
      throw ContractError("the roadmap was not created")
    }
    var steps: [ID<RoadmapStep>] = []
    for label in labels {
      let act = CreateStep(tree: created.tree, step: RoadmapStep.Changes(label: label, icon: "book"), prerequisites: steps.suffix(1))
      guard case .committed(let step, _) = try phone.runner.runAct(act) else { throw ContractError("the step \(label) was not created") }
      steps.append(step)
    }
    phone.sync()
    let tablet = phone.device()
    phone.sync()
    return (phone, tablet, created.tree, steps)
  }

  // The device's note of a roadmap, as its row holds it.
  static func note(of tree: ID<RoadmapEntry>, on phone: Harness) throws -> JSON {
    try phone.runner.read(tree.tree) { (scope: Reader) throws -> JSON in try scope.device("landing:\(tree)") ?? .null }
  }

  static func drawn(_ tree: ID<RoadmapEntry>, on phone: Harness) throws -> [[JSON]] {
    try phone.drawn(RoadmapStep.self, in: tree.tree).map { (step: RoadmapStep) -> [JSON] in [step.id.json, .string(step.label), .string(step.icon)] }
  }

  // §5 A step's delete is held: Undo during the hold brings the step back, and once the hold ends the delete stands.
  @Test func aStepsDeleteIsHeldAndAnUndoInItsHoldBringsTheStepBack() throws {
    let phone = RoadmapsTests.phone()
    let (tree, basics) = try RoadmapsTests.rooted(on: phone)
    guard case .committed(_, let held) = try phone.runner.runAct(DeleteStep(tree: tree, step: basics)) else {
      Issue.record("the step was not deleted")
      return
    }
    #expect(held.releaseAt == phone.clock.nowMs() + Constants.holdMs)
    #expect(try phone.drawn(RoadmapStep.self, in: tree.tree).isEmpty)
    #expect(try phone.stored(RoadmapStep.self, in: tree.tree).map(\.id) == [basics])
    #expect(try phone.runner.cancelHeld(held.gestureId))
    #expect(try phone.drawn(RoadmapStep.self, in: tree.tree).map(\.id) == [basics])
    guard case .committed(_, let again) = try phone.runner.runAct(DeleteStep(tree: tree, step: basics)) else {
      Issue.record("the step was not deleted again")
      return
    }
    phone.advance(ms: Constants.holdMs)
    #expect(try !phone.runner.cancelHeld(again.gestureId))
    #expect(try phone.drawn(RoadmapStep.self, in: tree.tree).isEmpty)
  }

  // INV-1, the change made before the delete arrived. The tablet deletes the step and leaves the app, so its hold is
  // released and sent: the server holds the step dead, and the phone, which has not heard, still draws it. The phone's
  // change carries the step's life, the server admits it and revives the step, and both draw it changed. The phone never
  // found the step absent, so its note is the one its create left.
  @Test func aChangeMadeBeforeAnotherPhonesDeleteArrivedIsAdmittedAndTheStepIsPresentOnBoth() throws {
    let (phone, tablet, tree, steps) = try Self.chained(["Basics"])
    let basics = steps[0]
    guard case .committed = try tablet.runner.runAct(DeleteStep(tree: tree, step: basics)) else {
      Issue.record("the step was not deleted")
      return
    }
    tablet.leave()
    let scope = try #require(ScopeKey(tree.tree, account: "acct-1"))
    #expect(phone.server.state.rows[scope]?[RecordKey(RoadmapStep.type, basics.record)]?.lattice.life?.isAlive == false)
    #expect(try Self.drawn(tree, on: phone) == [[basics.json, "Basics", "book"]])
    guard case .committed = try phone.runner.runAct(ChangeStep(tree: tree, step: basics, changes: RoadmapStep.Changes(label: "The basics"))) else {
      Issue.record("the step was not changed")
      return
    }
    phone.sync()
    #expect(try Self.drawn(tree, on: phone) == [[basics.json, "The basics", "book"]])
    #expect(try Self.drawn(tree, on: tablet) == [[basics.json, "The basics", "book"]])
    #expect(try Self.note(of: tree, on: phone) == ["nodes": [basics.json], "edges": [], "revived": [], "names": []])
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty && tablet.notices(RoadmapRefusal.self).isEmpty)
  }

  // INV-1, the change made after. Once the tablet's delete has reached the phone it holds no record of the step, only its
  // spent id. A change revives the step with the field it names, and the server's revival keeps the others, so both draw
  // the step with its icon. The phone notes the step it brought back, and that write lets go of the step its create
  // noted, which had landed and said nothing.
  @Test func aChangeMadeWhenThePhoneKeepsOnlyTheStepsSpentIdBringsItBackWithEveryFieldTheServerKept() throws {
    let (phone, tablet, tree, steps) = try Self.chained(["Basics"])
    let basics = steps[0]
    guard case .committed = try tablet.runner.runAct(DeleteStep(tree: tree, step: basics)) else {
      Issue.record("the step was not deleted")
      return
    }
    phone.advance(ms: Constants.holdMs)
    phone.sync()
    let held = try phone.runner.read(tree.tree) { (scope: Reader) throws -> [Bool] in
      let steps = scope.repository(RoadmapStep.self)
      return [try steps.record(basics, in: .drawn) == nil, try steps.spentBorn(basics) != nil]
    }
    #expect(held == [true, true])
    guard case .committed = try phone.runner.runAct(ChangeStep(tree: tree, step: basics, changes: RoadmapStep.Changes(label: "The basics"))) else {
      Issue.record("the step was not changed")
      return
    }
    #expect(try Self.note(of: tree, on: phone) == ["nodes": [], "edges": [], "revived": [basics.json], "names": []])
    phone.sync()
    #expect(try Self.drawn(tree, on: phone) == [[basics.json, "The basics", "book"]])
    #expect(try Self.drawn(tree, on: tablet) == [[basics.json, "The basics", "book"]])
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty && tablet.notices(RoadmapRefusal.self).isEmpty)
  }
}
