import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import Testing

// A roadmap's own acts: each case of roadmaps-actions.json by its complete decision, and what the device predicts of the
// server's writes against the model server holding the same records; and one roadmap read from a phone's engine: through
// a step another device deleted, in the server's order, and as the corpus reads the same records.
struct RoadmapsTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/roadmaps-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try Self.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  static func decision(_ vector: Vector) throws -> JSON {
    let corpus = ProductCorpus(RoadmapRules.book)
    let input = try vector.input.member("input")
    switch try vector.input.member("action").asString() {
    case "CreateRoadmap":
      let steps = try input["steps"].map(ImportedSteps.init(form:)) ?? ImportedSteps()
      let kinds = try input.optional("kinds") { try $0.asArray().map(NewKind.init(form:)) }
      return try corpus.act(CreateRoadmap(title: input.member("title").asString(), steps: steps, kinds: kinds), vector, result: \.form, refusal: \.form)
    case "DeleteRoadmap": return try corpus.act(DeleteRoadmap(tree: input.id("tree")), vector, result: { .null }, refusal: \.form)
    case "SetVisibility":
      let act = SetVisibility(tree: try input.id("tree"), visibility: try input.member("visibility").asString())
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case "CreateSubtree":
      return try corpus.act(CreateSubtree(tree: input.id("tree"), step: input.id("step")), vector, result: \.form, refusal: \.form)
    case "WriteRoadmap":
      let act = WriteRoadmap(tree: try input.id("tree"), title: try input.optionalString("title"), guide: try input.optionalString("guide"))
      return try corpus.act(act, vector, result: { .null }, refusal: \.form)
    case let name: throw ContractError("no roadmap action \(name)")
    }
  }

  static func phone() -> Harness {
    Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), rules: RoadmapServerRules())
  }

  // A root of one step, made on the phone and taken by the server.
  static func rooted(on phone: Harness) throws -> (tree: ID<RoadmapEntry>, step: ID<RoadmapStep>) {
    let planted = ImportedSteps(steps: [ImportedStep(key: "first", label: "Basics")])
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn Rust", steps: planted)) else {
      throw ContractError("the roadmap was not created")
    }
    phone.sync()
    return (created.tree, created.steps[0].id)
  }

  // What a device draws of a subtree and of the step that owns it: the server's registers among them.
  static func drawn(_ subtree: ID<RoadmapEntry>, under place: RoadmapEntry.Parent, on phone: Harness) throws -> JSON {
    let entry = try phone.drawn(RoadmapEntry.self).first { $0.id == subtree }
    let meta = try phone.drawn(RoadmapMeta.self, in: subtree.tree).first
    let kinds: [JSON] = try phone.drawn(RoadmapKind.self, in: subtree.tree).map { ["id": $0.id.json, "fields": .object(fields: $0.fields)] }
    let owner = try phone.drawn(RoadmapStep.self, in: place.tree.tree).first { $0.id == place.step }
    return ["parent": entry?.parent.map(\.form) ?? .null, "root": meta?.root?.json ?? .null, "metaParent": meta?.parent.map(\.form) ?? .null,
            "depth": meta.map { JSON($0.depth) } ?? .null, "reach": .of(meta?.reach), "kinds": .array(kinds), "branch": owner?.branch?.json ?? .null]
  }

  // One roadmap as a phone's engine holds it: its entry in the person's list, and every record `drawn` folds of its tree
  // scope and of its owner's overlay, visible or not.
  static func held(_ tree: ID<RoadmapEntry>, on phone: Harness) throws -> (listed: Record?, tree: [Record], overlay: [Record]) {
    (try phone.runner.read(RoadmapEntry.scope) { try $0.repository(RoadmapEntry.self).record(tree, in: .drawn) },
     try phone.runner.read(tree.tree) { try $0.records(in: .drawn) }, try phone.runner.read(tree.overlay) { try $0.records(in: .drawn) })
  }

  // A new step and the link that leads to it from another, written as an import plants them.
  struct LinkNewStep: Action {
    let tree: ID<RoadmapEntry>
    let from: ID<RoadmapStep>
    let label: String
    var scope: ScopeRef { tree.tree }

    func load(_ read: Reader) throws -> Moment { read.moment }

    func decide(_ moment: Moment, ids: IDSource) throws(Violation) -> Decision<ID<RoadmapStep>, RoadmapRefusal> {
      let step = ids.mint(RoadmapStep.self)
      var plan = Plan()
      plan.create(try Valid(RoadmapStep(id: step, label: label, ord: "a5"), at: moment))
      plan.create(try Valid(RoadmapLink(from: from, to: step), at: moment))
      return .write(plan, step)
    }
  }

  // INV-1 over the real engine, as the web's harness tells it (harness.test.js): a step the phone deletes is still linked
  // from on the tablet, which has not heard. The phone reads the step absent while its delete is held. Once both have
  // synced, the tablet holds no record of the step, only its spent id with the server's `seq` of the delete; its roadmap
  // is read through the absent step by its links; and by the `seq` of each link's confirmed row the server took the new
  // link after the delete, and the link that was there before it.
  @Test func aLinkFromAStepAnotherPhoneDeletedIsReadThroughItInTheServersOrder() throws {
    let phone = Self.phone()
    let planted = ImportedSteps(
      steps: [ImportedStep(key: "basics", label: "Basics"), ImportedStep(key: "lifetimes", label: "Lifetimes"), ImportedStep(key: "traits", label: "Traits")],
      links: [(from: "basics", to: "lifetimes"), (from: "lifetimes", to: "traits")])
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn Rust", steps: planted)) else {
      Issue.record("the roadmap was not created")
      return
    }
    phone.sync()
    let tablet = phone.device()
    phone.sync()
    let tree = created.tree
    let (basics, lifetimes, traits) = (created.steps[0].id, created.steps[1].id, created.steps[2].id)
    guard case .committed = try phone.runner.run(Remove<RoadmapStep, RoadmapRefusal>(lifetimes, in: tree.tree)),
          case .committed(let generics, _) = try tablet.runner.run(LinkNewStep(tree: tree, from: lifetimes, label: "Generics")) else {
      Issue.record("the step was not deleted or the link not made")
      return
    }
    let (kept, made) = (RoadmapLink(from: lifetimes, to: traits), RoadmapLink(from: lifetimes, to: generics))
    let read = { (phone: Harness) throws -> RoadmapTree in
      let held = try Self.held(tree, on: phone)
      return try RoadmapTree(id: tree, listed: held.listed, tree: held.tree, overlay: held.overlay)
    }
    let steps = { (roadmap: RoadmapTree) -> [String: Bool] in Dictionary(uniqueKeysWithValues: roadmap.nodes.map { ($0.id, $0.present) }) }
    let follows = { (roadmap: RoadmapTree) -> [JSON] in
      FollowGraph(roadmap).landingFacts(own: [RoadmapTree.Edge(from: made.from.description, to: made.to.description, present: true)]).map(\.form)
    }
    let order = { (phone: Harness) throws -> [Int64?] in
      try phone.runner.read(tree.tree) { (scope: Reader) throws -> [Int64?] in
        [try scope.confirmed(RoadmapLink.self, kept.id)?.seq, try scope.repository(RoadmapStep.self).spentSeq(lifetimes),
         try scope.confirmed(RoadmapLink.self, made.id)?.seq]
      }
    }
    let (basic, lifetime, trait, generic) = (basics.description, lifetimes.description, traits.description, generics.description)
    #expect(steps(try read(phone)) == [basic: true, lifetime: false, trait: true])
    #expect(steps(try read(tablet)) == [basic: true, lifetime: true, trait: true, generic: true])
    #expect(follows(try read(tablet)) == [])
    let taken = try #require(try order(tablet)[0])
    #expect(try order(tablet) == [taken, nil, nil])

    phone.advance(ms: Constants.holdMs)
    phone.sync()
    let roadmap = try read(tablet)
    #expect(steps(roadmap) == [basic: true, trait: true, generic: true])
    let links = [RoadmapLink(from: basics, to: lifetimes), kept, made].map(\.id).sorted()
    #expect(roadmap.edges.map { (edge: RoadmapTree.Edge) -> [JSON] in [edge.ends, .bool(edge.present)] }
      == links.map { (link: ID<RoadmapLink>) -> [JSON] in [link.json, true] })
    let through: JSON = ["id": basics.json, "incoming": [made.id.json], "throughAbsent": true]
    let said: [JSON] = [["node": generics.json, "incoming": [made.id.json], "followed": [through]]]
    #expect(follows(roadmap) == said)
    let server = phone.server.state
    let scope = try #require(ScopeKey(tree.tree, account: "acct-1"))
    let deleted = try #require(server.rows[scope]?[RecordKey(RoadmapStep.type, lifetimes.record)]?.seq)
    let linked = try #require(server.rows[scope]?[RecordKey(RoadmapLink.type, made.id.record)]?.seq)
    #expect(try order(tablet) == [taken, deleted, linked])
    #expect(taken < deleted && deleted < linked)
    #expect(try tablet.notices(RoadmapRefusal.self).isEmpty)
  }

  // The engine's records are the records the corpus's `roadmap` read takes. A roadmap read from a phone's engine after a
  // sync (a step whose delete is held, a subtree, a pointer, a mark the server has received and one still queued) equals
  // the corpus's read of the same records, each stated as the view record a case of replica.json holds.
  @Test func aRoadmapReadFromAPhonesEngineEqualsTheCorpusReadOfItsRecords() throws {
    let phone = Self.phone()
    let planted = ImportedSteps(
      steps: ["Basics", "Ownership", "Traits", "Tools", "Macros"].map { ImportedStep(key: $0, label: $0) }, links: [(from: "Basics", to: "Ownership")])
    guard case .committed(let created, _) = try phone.runner.runAct(CreateRoadmap(title: "Learn Rust", steps: planted)) else {
      Issue.record("the roadmap was not created")
      return
    }
    let (other, _) = try Self.rooted(on: phone)
    let (tree, steps) = (created.tree, created.steps.map(\.id))
    guard case .committed = try phone.runner.runAct(MarkStep.complete(tree: tree, step: steps[0])),
          case .committed = try phone.runner.runAct(PointStep.set(tree: tree, step: steps[2], opens: other)),
          case .committed(let grown, _) = try phone.runner.runAct(CreateSubtree(tree: tree, step: steps[3])) else {
      Issue.record("the mark, the pointer or the subtree was not committed")
      return
    }
    phone.sync()
    guard case .committed = try phone.runner.runAct(MarkStep.complete(tree: tree, step: steps[1])),
          case .committed = try phone.runner.run(Remove<RoadmapStep, RoadmapRefusal>(steps[4], in: tree.tree)) else {
      Issue.record("the queued mark or the held delete was not committed")
      return
    }
    let held = try Self.held(tree, on: phone)
    let roadmap = try RoadmapTree(id: tree, listed: held.listed, tree: held.tree, overlay: held.overlay)
    let queued: [JSON] = held.overlay.filter(\.isPending).map { ["t": .string($0.type), "id": $0.id.json] }
    let stated: JSON = [
      "operation": "roadmap", "id": tree.json, "listed": held.listed?.view ?? .null, "tree": .array(held.tree.map(\.view)),
      "overlay": ["drawn": .array(held.overlay.map(\.view)), "queued": .array(queued)], "read": true,
    ]
    #expect(roadmap.form == (try RoadmapTree(replica: stated).form))

    let unsent: [JSON] = [["t": .string(StepMark.type), "id": steps[1].json]]
    #expect(queued == unsent)
    #expect(roadmap.nodes.filter { !$0.present }.map(\.id) == [steps[4].description])
    let subtree = try #require(roadmap.nodes.first { $0.id == steps[3].description })
    #expect(subtree.branch == grown.subtree.description && subtree.branchStamp != nil)
    #expect(roadmap.pointers.map { [$0.node, $0.opens] } == [[steps[2].description, other.description]])
    #expect(roadmap.pointers.allSatisfy { $0.setAt != nil })
    let marks = roadmap.marks.map { (mark: RoadmapTree.Mark) -> [JSON] in
      [.string(mark.node), .string(mark.status), .bool(mark.recordedAt != nil), .bool(mark.deviceAt != nil && mark.stamp != nil)]
    }
    let received = [steps[0], steps[1]].sorted().map { (step: ID<RoadmapStep>) -> [JSON] in [step.json, "complete", .bool(step == steps[0]), true] }
    #expect(marks == received)
    #expect(roadmap.read == .loaded && roadmap.own && roadmap.present && roadmap.updatedAt != nil)
  }

  @Test func aSubtreeMadeWithNoConnectionIsDrawnAsTheServerThenWritesIt() throws {
    let phone = Self.phone()
    let (tree, step) = try Self.rooted(on: phone)
    guard case .committed(let made, _) = try phone.runner.runAct(CreateSubtree(tree: tree, step: step)) else {
      Issue.record("the subtree was not created")
      return
    }
    let place = RoadmapEntry.Parent(tree: tree, step: step)
    let genesis: [JSON] = [
      ["id": "build", "fields": ["hue": "terracotta", "label": "Build", "description": "Things you make", "ord": "a0"]],
      ["id": "learn", "fields": ["hue": "olive", "label": "Learn", "description": "Things you figure out", "ord": "a1"]],
      ["id": "milestone", "fields": ["hue": "gold", "label": "Milestone", "description": "Moments that matter", "ord": "a2"]],
    ]
    let planted: JSON = ["parent": place.form, "root": tree.json, "metaParent": place.form, "depth": 1, "reach": "private", "kinds": .array(genesis),
                         "branch": made.subtree.json]
    #expect(try Self.drawn(made.subtree, under: place, on: phone) == planted)
    phone.sync()
    #expect(try Self.drawn(made.subtree, under: place, on: phone) == planted)
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty)
  }

  // `tree.subtreeStep` is the server's to decide where the device does not hold the pointer another device set first.
  @Test func aSubtreeOnAStepAnotherDeviceMadeOpenARoadmapComesBackRefused() throws {
    let first = Self.phone()
    let second = first.device()
    let (tree, step) = try Self.rooted(on: first)
    let (other, _) = try Self.rooted(on: first)
    guard case .committed = try first.runner.runAct(PointStep.set(tree: tree, step: step, opens: other)),
          case .committed = try second.runner.runAct(CreateSubtree(tree: tree, step: step)) else {
      Issue.record("the pointer or the subtree was not committed")
      return
    }
    first.sync()
    let refused = Refused(Roadmap.Codes.stepOpensATree, subject: nil, path: .notice)
    #expect(try second.notices(RoadmapRefusal.self).map(\.refusal) == [.stepOpensARoadmap(refused)])
    #expect(try second.drawn(RoadmapStep.self, in: tree.tree).map(\.branch) == [nil])
    #expect(try second.drawn(RoadmapEntry.self).map(\.id) == [tree, other].sorted())
  }

  @Test func aRootsVisibilityIsDrawnAcrossItsStandingSubtreesAsTheServerThenWritesIt() throws {
    let phone = Self.phone()
    let (tree, step) = try Self.rooted(on: phone)
    guard case .committed(let made, _) = try phone.runner.runAct(CreateSubtree(tree: tree, step: step)) else {
      Issue.record("the subtree was not created")
      return
    }
    phone.sync()
    let reaches = { () throws -> [String?] in
      try [tree, made.subtree].map { try phone.drawn(RoadmapMeta.self, in: $0.tree).first?.reach }
    }
    guard case .committed = try phone.runner.runAct(SetVisibility(tree: tree, visibility: "public")) else {
      Issue.record("the visibility was not written")
      return
    }
    #expect(try reaches() == ["public", "public"])
    phone.sync()
    #expect(try reaches() == ["public", "public"])
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty)
  }

  @Test func aRootsDeleteIsHeldThenReleasedToTheServer() throws {
    let phone = Self.phone()
    let (tree, _) = try Self.rooted(on: phone)
    guard case .committed(_, let receipt) = try phone.runner.runAct(DeleteRoadmap(tree: tree)) else {
      Issue.record("the roadmap was not deleted")
      return
    }
    #expect(receipt.releaseAt != nil)
    #expect(try phone.drawn(RoadmapEntry.self).isEmpty)
    #expect(try phone.stored(RoadmapEntry.self).map(\.id) == [tree])
    phone.advance(ms: Constants.holdMs)
    phone.sync()
    #expect(try phone.stored(RoadmapEntry.self).isEmpty)
    #expect(try phone.notices(RoadmapRefusal.self).isEmpty)
  }
}

extension RoadmapEntry.Parent {
  var form: JSON { ["tree": tree.json, "step": step.json] }
}

extension ImportedSteps {
  // `{steps: [{key, label, icon?, color?, description?, links?}], links: [[fromKey, toKey]]}`.
  init(form: JSON) throws {
    let steps = try form.member("steps").asArray().map { step in
      let links = try step.optional("links") { links in
        try links.asArray().map { Step.Link(url: try $0.member("url").asString(), label: try $0.member("label").asString()) }
      }
      return ImportedStep(key: try step.member("key").asString(), label: try step.optionalString("label") ?? "",
                          icon: try step.optionalString("icon") ?? "", color: try step.optionalString("color") ?? "terracotta",
                          description: try step.optionalString("description") ?? "", links: links ?? [])
    }
    let links = try form.member("links").asArray().map { link in
      let ends = try link.asArray().map { try $0.asString() }
      guard ends.count == 2 else { throw ContractError("a link is [fromKey, toKey], found \(link)") }
      return (from: ends[0], to: ends[1])
    }
    self.init(steps: steps, links: links)
  }
}

extension CreateRoadmap.Result {
  var form: JSON {
    ["tree": tree.json, "steps": .object(JSON.Object(uniqueKeysWithValues: steps.map { ($0.key, $0.id.json) }))]
  }
}

extension CreateSubtree.Result {
  var form: JSON {
    var form: JSON.Object = ["subtree": subtree.json]
    form["root"] = creation?.root.json
    form["revived"] = creation.map { .bool($0.revived) }
    return .object(form)
  }
}
