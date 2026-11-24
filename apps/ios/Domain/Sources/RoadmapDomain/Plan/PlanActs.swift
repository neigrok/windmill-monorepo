import DomainKit
import SyncCore

// A plan as the domain's acts take it (§7.1, §7.2): planted as a new roadmap by `CreateRoadmap`, or grafted into a roadmap
// by `ImportSteps` and `CreateKind`. Each carries the keys of the steps the plan brings done.
extension RoadmapPlan {
  // A roadmap planted from the plan: its creation, then `MarkStep.complete` of each done key, by the id the creation gave it.
  public struct Planting: Sendable {
    public let creation: CreateRoadmap
    public let done: [String]
  }

  // Steps grafted into a roadmap under one of its steps: the import, with the keys it marks done, and the kinds it adds.
  public struct Graft: Sendable {
    public let imported: ImportedSteps
    public let under: String?
    public let done: [String]
    public let kinds: [NewKind]

    public func acts(in tree: ID<RoadmapEntry>) -> [AnyActAction<RoadmapRefusal>] {
      [AnyActAction(ImportSteps(tree: tree, imported: imported, under: under.map { ID(RecordID($0)) }, done: done))]
        + kinds.map { AnyActAction(CreateKind(tree: tree, kind: $0)) }
    }
  }

  // The plan named for planting: a typed name, trimmed and clipped, names it, and the node that stands for the name where
  // one does; with none typed the plan's own name stands; with neither, nil.
  public func planting(named typed: String) -> Planting? {
    let name = PlanText.clipped(PlanText.trimmed(String(String.UnicodeScalarView(typed.unicodeScalars.filter { $0.value != 0 }))),
                                to: PlanText.titleBound)
    if name.isEmpty && missingRoot { return nil }
    let title = name.isEmpty ? self.title : name
    let renamed = name.isEmpty || isFile ? nodes : nodes.enumerated().map { index, node in
      index == 0 ? Node(id: node.id, label: name, color: node.color, follows: node.follows, done: node.done, description: node.description,
                        links: node.links) : node
    }
    let steps = renamed.enumerated().map { index, node in node.imported(icon: index == 0 ? "sparkles" : "") }
    let links = renamed.compactMap { node in node.follows.map { (from: $0, to: node.id) } }
    let legend = kinds.map { NewKind(hue: $0.hue, label: $0.label, description: $0.description) }
    let genesis = RoadmapRules.genesisKinds.map { NewKind(hue: $0.hue, label: $0.label, description: $0.description) }
    let sameAsGenesis = legend.count == genesis.count && zip(legend, genesis).allSatisfy { mine, theirs in
      [mine.hue, mine.label, mine.description].map(PlanText.key) == [theirs.hue, theirs.label, theirs.description].map(PlanText.key)
    }
    return Planting(creation: CreateRoadmap(title: title, steps: ImportedSteps(steps: steps, links: links), kinds: legend.isEmpty || sameAsGenesis ? nil : legend),
                    done: renamed.filter(\.done).map(\.id))
  }

  // The plan grafted under `target`, a step of the roadmap, or at its root: a named plan's first node follows the target,
  // and an unnamed plan's first node is dropped, the nodes that followed it following the target. Each key is the node's
  // id, counted up past `held`, every id the roadmap holds, deleted ones included. Nil where no step lands.
  public func graft(under target: String?, held: [String], liveKinds: [Kind]) -> Graft? {
    let dropped = missingRoot ? nodes.first?.id : nil
    var taken = Set(held.map(PlanText.key))
    var keys: [[UInt8]: String] = [:]
    for node in nodes where node.id != dropped {
      var key = node.id
      if taken.contains(PlanText.key(key)) {
        var n = 2
        while taken.contains(PlanText.key("\(node.id)-\(n)")) { n += 1 }
        key = "\(node.id)-\(n)"
      }
      taken.insert(PlanText.key(key))
      keys[PlanText.key(node.id)] = key
    }
    let landing = nodes.filter { $0.id != dropped }
    guard !landing.isEmpty else { return nil }
    var steps: [ImportedStep] = []
    var links: [(from: String, to: String)] = []
    var under: String?
    for node in landing {
      guard let key = keys[PlanText.key(node.id)] else { continue }
      steps.append(RoadmapPlan.Node(id: key, label: node.label, color: node.color, follows: nil, done: node.done, description: node.description,
                                    links: node.links).imported(icon: ""))
      let follows = node.id == nodes.first?.id && dropped == nil ? target : node.follows.flatMap { $0 == dropped ? target : keys[PlanText.key($0)] }
      guard let follows else { continue }
      if keys.values.contains(where: { $0 == follows }) { links.append((follows, key)) } else if under == nil { under = follows }
    }
    let live = Set(liveKinds.map { PlanText.key($0.id) })
    return Graft(imported: ImportedSteps(steps: steps, links: links), under: under,
                 done: landing.filter(\.done).compactMap { keys[PlanText.key($0.id)] },
                 kinds: kinds.filter { !live.contains(PlanText.key($0.id)) }.map { NewKind(hue: $0.hue, label: $0.label, description: $0.description) })
  }
}

extension RoadmapPlan.Node {
  // The node as an import or a creation brings a step, under its id as its key: its addresses as links with no label.
  func imported(icon: String) -> ImportedStep {
    let addresses = links.filter { !PlanText.trimmed($0).isEmpty }.map { Step.Link(url: $0, label: "") }
    return ImportedStep(key: id, RoadmapStep.Changes(label: label, icon: icon, color: color, description: description.flatMap { $0.isEmpty ? nil : $0 },
                                                     links: addresses.isEmpty ? nil : addresses))
  }
}
