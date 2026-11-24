import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import Testing

// The plan grammar's shared cases, `packages/api-contract/roadmap/plan/`, each through the code the room runs: a text read,
// a plan planted and grafted as the domain's acts take them, and a roadmap written and read back, compared whole.
struct PlanCorpusTests {
  static let files = ["create-roadmap", "import-steps", "read-into", "read", "write"]

  @Test func everyFileIsClaimed() throws {
    #expect(try Contract.files(under: "roadmap/plan") == Self.files.map { "roadmap/plan/\($0).json" })
  }

  @Test(arguments: try files.flatMap { file in try Contract.vectors("roadmap/plan/\(file).json").map { (file, $0) } })
  func plan(_ file: String, _ vector: Vector) throws {
    let actual = try Self.result(of: file, vector.input)
    #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  static func result(of file: String, _ input: JSON) throws -> JSON {
    let kinds = try input["kinds"].map { try $0.asArray().map(RoadmapPlan.Kind.init(form:)) } ?? []
    switch file {
    case "read": return RoadmapPlan(reading: try input.member("text").asString(), over: kinds).form
    case "read-into": return RoadmapPlan(reading: try input.member("text").asString(), over: kinds, into: true).form
    case "create-roadmap":
      let plan = RoadmapPlan(reading: try input.member("text").asString(), over: kinds)
      guard let planting = plan.planting(named: try input.member("name").asString()) else { return .null }
      let creation = planting.creation
      return ["CreateRoadmap": ["title": .string(creation.title), "steps": creation.steps.form,
                                "kinds": creation.kinds.map { .array($0.map(\.form)) } ?? .null],
              "Complete": .strings(planting.done)]
    case "import-steps":
      let plan = RoadmapPlan(reading: try input.member("text").asString(), over: kinds, into: true)
      let held = try input.member("held").asArray().map { try $0.asString() }
      guard let graft = plan.graft(under: try input.optionalString("under"), held: held, liveKinds: kinds) else { return .null }
      var importing: JSON.Object = ["imported": graft.imported.form, "under": .of(graft.under)]
      if !graft.done.isEmpty { importing["done"] = .strings(graft.done) }
      return ["ImportSteps": .object(importing), "CreateKind": .array(graft.kinds.map(\.form))]
    case "write":
      let done = Set(try input.member("done").asArray().map { try $0.asString() })
      let steps = try input.member("nodes").asArray().map { node in
        PlanFile.Step(id: try node.member("id").asString(), label: try node.member("label").asString(), color: try node.member("color").asString(),
                      prerequisites: try node.member("prerequisites").asArray().map { try $0.asString() },
                      description: try node.optionalString("description") ?? "",
                      links: try (node["links"]?.asArray() ?? []).map { try $0.member("url").asString() })
      }
      let file = PlanFile(title: try input.member("title").asString(), guide: try input.optionalString("guide") ?? "", kinds: kinds, steps: steps, done: done)
      let readOver = try input.member("readOver").asArray().map(RoadmapPlan.Kind.init(form:))
      return ["text": .string(file.text), "readBack": RoadmapPlan(reading: file.text, over: readOver).form]
    default: throw ContractError("no plan operation \(file)")
    }
  }
}

extension RoadmapPlan.Kind {
  // `{id, hue, label?, description?}`.
  init(form: JSON) throws {
    self.init(id: try form.member("id").asString(), hue: try form.member("hue").asString(), label: try form.optionalString("label") ?? "",
              description: try form.optionalString("description") ?? "")
  }
}

extension RoadmapPlan {
  var form: JSON {
    let nodes = self.nodes.enumerated().map { (index: Int, node: Node) -> JSON in
      var form: JSON.Object = ["id": .string(node.id), "label": .string(node.label), "color": .string(node.color),
                               "prerequisites": .strings(node.follows.map { [$0] } ?? [])]
      if index == 0 { form["icon"] = "sparkles" }
      if node.done { form["status"] = "complete" }
      if let description = node.description { form["description"] = .string(description) }
      if !node.links.isEmpty { form["links"] = .strings(node.links) }
      return .object(form)
    }
    let kinds = self.kinds.map { kind -> JSON in
      ["id": .string(kind.id), "hue": .string(kind.hue), "label": .string(kind.label), "description": .string(kind.description),
       "source": .string(kind.source.rawValue)]
    }
    let gutter = self.gutter.map { line -> JSON in
      ["mark": .of(line.mark?.rawValue), "nodeId": .of(line.node), "liberties": .array(line.liberties.map(\.form))]
    }
    return ["title": .string(title), "missingRoot": .bool(missingRoot), "nodes": .array(nodes), "kinds": .array(kinds), "gutter": .array(gutter),
            "readout": ["steps": JSON(readout.steps), "branches": JSON(readout.branches), "done": JSON(readout.done)],
            "imperfections": ["notes": JSON(imperfections.notes), "clamps": JSON(imperfections.clamps), "renames": JSON(imperfections.renames),
                              "clips": JSON(imperfections.clips)]]
  }
}

extension RoadmapPlan.Liberty {
  var form: JSON {
    switch self {
    case .clamp(let indent): ["type": "clamp", "indent": .string(indent.rawValue)]
    case .note: ["type": "note"]
    case .clip: ["type": "clip"]
    case .rename(let label): ["type": "rename", "label": .string(label)]
    }
  }
}

extension ImportedSteps {
  var form: JSON {
    let steps = self.steps.map { (imported: ImportedStep) -> JSON in
      var form: JSON.Object = ["key": .string(imported.key), "label": .of(imported.step.label), "icon": .of(imported.step.icon),
                               "color": .of(imported.step.color)]
      if let description = imported.step.description { form["description"] = .string(description) }
      if let links = imported.step.links { form["links"] = .array(links.map { ["url": .string($0.url), "label": .string($0.label)] }) }
      return .object(form)
    }
    return ["steps": .array(steps), "links": .array(links.map { [.string($0.from), .string($0.to)] })]
  }
}

extension NewKind {
  var form: JSON { ["hue": .string(hue), "label": .string(label), "description": .string(description)] }
}
