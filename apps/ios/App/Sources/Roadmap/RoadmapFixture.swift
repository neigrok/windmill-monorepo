import Foundation
import DomainKit
import RoadmapDomain

// The roadmap the Roadmap room's simulator fixtures and tests plant.
enum RoadmapFixture {
  #if DEBUG && targetEnvironment(simulator)
  // The boards' *Learn to sail*, as `packages/api-contract/roadmap/layout/learn-to-sail.json` links it, its first three steps done.
  @discardableResult
  static func plantLearnToSail(_ runner: ActionRunner) throws -> ID<RoadmapEntry> {
    let steps: [(key: String, label: String, color: String, description: String, follows: [String])] = [
      ("choose", "Choose a sailing course", "terracotta", "Pick a beginner course near you.", []),
      ("parts", "Name the boat parts", "sky", "Hull, mast, boom, sheets and tiller.", ["choose"]),
      ("rig", "Rig the boat", "terracotta", "Step the mast and run the sheets.", ["parts"]),
      ("read", "Read the wind", "sky", "Learn to spot shifts in wind direction from the water, the telltales and the flag.", ["parts"]),
      ("tie", "Tie a bowline", "olive", "Tie a secure loop that is easy to undo, then practise it with your eyes closed.", ["parts"]),
      ("leave", "Leave the dock", "terracotta", "Cast off safely and steer clear of the dock.", ["rig", "read"]),
      ("tri", "Sail a triangle", "olive", "Practise reaching, tacking and returning to start.", ["leave"]),
      ("solo", "Sail solo", "gold", "Plan and sail a short route on your own.", ["tri", "tie"]),
    ]
    let planted = ImportedSteps(
      steps: steps.map { ImportedStep(key: $0.key, RoadmapStep.Changes(label: $0.label, color: $0.color, description: $0.description)) },
      links: steps.flatMap { step in step.follows.map { (from: $0, to: step.key) } })
    guard case .committed(let created, _) = try runner.runAct(CreateRoadmap(title: "Learn to sail", steps: planted)) else {
      throw AppFailure(message: "Learn to sail was not planted.")
    }
    for done in ["choose", "parts", "rig"] {
      guard let step = created.steps.first(where: { $0.key == done })?.id,
            case .committed = try runner.runAct(MarkStep.complete(tree: created.tree, step: step)) else {
        throw AppFailure(message: "Learn to sail's \(done) was not marked done.")
      }
    }
    return created.tree
  }
  #endif
}
