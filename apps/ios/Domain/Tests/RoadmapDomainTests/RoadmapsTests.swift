import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import Testing

// A roadmap's own acts: each case of roadmaps-actions.json by its complete decision, and what the device predicts of the
// server's writes against the model server holding the same records; one roadmap read from a phone's engine: through a
// step another device deleted, in the server's order, and as the corpus reads the same records; and, as the web's harness
// tells them (harness.test.js), a roadmap's delete and its note, a subtree's standing across another phone's delete, and
// two phones' visibilities.
struct RoadmapsTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/roadmaps-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try RoadmapAct.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  // The corpus's two revivals before a subtree hold no note. Every write of the note first lets go of each entry whose
  // write has landed and that says nothing: the web's module decides each case with the device noting step `b`, which has
  // landed, as it decides the case itself, and Swift is held to that decision.
  @Test(arguments: ["a subtree on a step this device deleted itself", "a subtree on a step another device deleted"])
  func aSubtreesRevivalLetsGoOfWhatTheNoteHeldThatLandedAndSaysNothing(_ revival: String) throws {
    let vector = try #require(try Contract.vectors("roadmap/domain/roadmaps-actions.json").first { $0.name.hasPrefix(revival) })
    var input = try vector.input.asObject()
    input["device"] = ["landing:t_0000000000000001": ["nodes": ["b"], "edges": [], "revived": [], "names": []]]
    let scene = Vector(file: vector.file, name: vector.name, input: .object(input), expect: vector.expect)
    for decided in [scene, scene.withRecordsReversed] {
      let actual = try RoadmapAct.decision(decided)
      #expect(actual == vector.expect, "got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  // A phone signed in, or signed out, whose replica is the device's own and sends nothing.
  static func phone(signedOut: Bool = false) -> Harness {
    Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000), account: signedOut ? nil : "acct-1", rules: RoadmapServerRules())
  }

  // A root of one step, made on the phone and taken by the server.
  static func rooted(on phone: Harness) throws -> (tree: ID<RoadmapEntry>, step: ID<RoadmapStep>) {
    let planted = ImportedSteps(steps: [ImportedStep(key: "first", .init(label: "Basics"))])
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
      steps: [ImportedStep(key: "basics", .init(label: "Basics")), ImportedStep(key: "lifetimes", .init(label: "Lifetimes")), ImportedStep(key: "traits", .init(label: "Traits"))],
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
      steps: ["Basics", "Ownership", "Traits", "Tools", "Macros"].map { ImportedStep(key: $0, .init(label: $0)) }, links: [(from: "Basics", to: "Ownership")])
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

  // §6 the device's note of the steps it made goes with the roadmap's delete, at once and not with its hold.
  @Test func aRoadmapsDeleteLetsGoOfTheNoteOfItAtOnce() throws {
    let (phone, _, tree, _) = try StepsTests.chained(["Basics", "Lifetimes"])
    let note = { () throws -> JSON? in try phone.runner.read(RoadmapEntry.scope) { try $0.device("landing:\(tree)") } }
    #expect(try note() != nil)
    guard case .committed = try phone.runner.runAct(DeleteRoadmap(tree: tree)) else {
      Issue.record("the roadmap was not deleted")
      return
    }
    #expect(try note() == nil)
  }

  // A root and its subtree, public, that the server holds and a tablet of the same account has pulled.
  static func branch() throws -> (phone: Harness, tablet: Harness, tree: ID<RoadmapEntry>, step: ID<RoadmapStep>, subtree: ID<RoadmapEntry>) {
    let phone = Self.phone()
    let (tree, step) = try Self.rooted(on: phone)
    guard case .committed(let made, _) = try phone.runner.runAct(CreateSubtree(tree: tree, step: step)),
          case .committed = try phone.runner.runAct(SetVisibility(tree: tree, visibility: "public")) else {
      throw ContractError("the subtree or the visibility was not committed")
    }
    phone.sync()
    let tablet = phone.device()
    phone.sync()
    return (phone, tablet, tree, step, made.subtree)
  }

  // The meta's `visibility` and `reach` of each roadmap, as a device draws them and as the server holds them.
  static func reaches(of roadmaps: [ID<RoadmapEntry>], on device: Harness) throws -> [[String]] {
    try roadmaps.map { (roadmap: ID<RoadmapEntry>) throws -> [String] in
      let meta = try device.drawn(RoadmapMeta.self, in: roadmap.tree)
      return meta.map(\.visibility) + meta.map(\.reach)
    }
  }

  static func serverReaches(of roadmaps: [ID<RoadmapEntry>], on device: Harness) throws -> [JSON?] {
    let rows = device.server.state.rows
    return try roadmaps.map { (roadmap: ID<RoadmapEntry>) throws -> JSON? in
      let scope = try #require(ScopeKey(roadmap.tree, account: "acct-1"))
      return rows[scope]?[RecordKey(RoadmapMeta.type, RoadmapMeta.singleton.record)]?.lattice.fields["reach"]?.value
    }
  }

  // The tablet deletes the step that owns the subtree and leaves the app, so its hold is released and sent: the server ends
  // the subtree's standing and makes it private. The phone has not heard; its change of the step carries the step's life,
  // the server revives it, the subtree stands again in the reach of its root, and both draw it so.
  @Test func aStepDeletedOnAnotherPhoneEndsItsSubtreesStandingAndAChangeMadeWithoutKnowingBringsItBackOnBoth() throws {
    let (phone, tablet, tree, step, subtree) = try Self.branch()
    #expect(try Self.reaches(of: [subtree], on: phone) == [["private", "public"]])
    #expect(try Self.reaches(of: [subtree], on: tablet) == [["private", "public"]])
    guard case .committed = try tablet.runner.runAct(DeleteStep(tree: tree, step: step)) else {
      Issue.record("the step was not deleted")
      return
    }
    tablet.leave()
    #expect(try Self.serverReaches(of: [subtree], on: phone) == ["private"])
    guard case .committed = try phone.runner.runAct(ChangeStep(tree: tree, step: step, changes: RoadmapStep.Changes(label: "The basics"))) else {
      Issue.record("the step was not changed")
      return
    }
    phone.sync()
    #expect(try Self.serverReaches(of: [subtree], on: phone) == ["public"])
    #expect(try Self.reaches(of: [subtree], on: phone) == [["private", "public"]])
    #expect(try Self.reaches(of: [subtree], on: tablet) == [["private", "public"]])
    let owner = try tablet.drawn(RoadmapStep.self, in: tree.tree).map { [$0.id.json, .string($0.label), $0.branch?.json ?? .null] }
    #expect(owner == [[step.json, "The basics", subtree.json]])
  }

  // The phone makes the public branch private and public again and, a second later, the tablet makes it private and sends
  // first. The phone's public is sent after it under an older stamp and loses, on the server and on both devices, so the
  // branch stays private.
  @Test func aStalePublicSentAfterANewerPrivateLosesOnTheServerAndOnBoth() throws {
    let (phone, tablet, tree, _, subtree) = try Self.branch()
    guard case .committed = try phone.runner.runAct(SetVisibility(tree: tree, visibility: "private")),
          case .committed = try phone.runner.runAct(SetVisibility(tree: tree, visibility: "public")) else {
      Issue.record("the phone's visibility was not written")
      return
    }
    phone.advance(ms: 1000)
    guard case .committed = try tablet.runner.runAct(SetVisibility(tree: tree, visibility: "private")) else {
      Issue.record("the tablet's visibility was not written")
      return
    }
    tablet.leave()
    phone.sync()
    for device in [phone, tablet] {
      #expect(try Self.reaches(of: [tree, subtree], on: device) == [["private", "private"], ["private", "private"]])
    }
    #expect(try Self.serverReaches(of: [tree, subtree], on: phone) == ["private", "private"])
  }
}

extension RoadmapEntry.Parent {
  var form: JSON { ["tree": tree.json, "step": step.json] }
}

extension ImportedSteps {
  // `{steps: [{key, label, icon?, color?, description?, links?}], links: [[fromKey, toKey]]}`.
  init(form: JSON) throws {
    let steps = try form.member("steps").asArray().map { ImportedStep(key: try $0.member("key").asString(), try RoadmapStep.Changes(form: $0)) }
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
