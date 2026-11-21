import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import Testing

// A roadmap's own acts: each case of roadmaps-actions.json by its complete decision, and what the device predicts of the
// server's writes against the model server holding the same records.
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
