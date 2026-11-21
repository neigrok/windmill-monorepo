import Foundation
import DomainKit
import RoadmapDomain

// Simulator boards: roadmap-empty, roadmap-learn-to-sail (an account's roadmap, arriving by sync) and roadmap-unreadable.
enum RoadmapFixture {
  // The engine's views of every record of a type in a scope, visible or not, as the room's model takes them.
  static func records(_ runtime: AppRuntime) -> RoadmapModel.Records {
    #if DEBUG && targetEnvironment(simulator)
    if runtime.settings.board == "roadmap-unreadable" { return { _, _ in throw AppFailure(message: "The board's views cannot be made.") } }
    #endif
    return { scope, type in try runtime.engine.records(scope, type, .drawn, visibleOnly: false) }
  }

  static func prepare(_ board: String, model: AppModel) async -> Bool {
    #if DEBUG && targetEnvironment(simulator)
    guard board.hasPrefix("roadmap-") else { return false }
    model.openRoom(.roadmap)
    guard board == "roadmap-learn-to-sail" else { return true }
    do {
      guard let server = model.runtime?.auth.fake else { throw AppFailure(message: "no model server") }
      let identity = server.identity(email: "roadmap-fixture@example.com")
      let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: directory) }
      let remote = try AppRuntime(settings: AppSettings(arguments: ["fixture", "-model-server", "-board", board]),
                                  directory: directory, service: UUID().uuidString, syncTransport: server)
      defer { try? remote.tokens.delete(for: identity.account) }
      _ = try await remote.engine.signIn(account: identity.account, token: identity.token)
      try plantLearnToSail(remote.roadmapRunner)
      try remote.engine.leave()
      for _ in 0..<40 where try remote.store.read({ try $0.device().activeReplica.outbox.contains { $0.state != .acked } }) {
        await remote.engine.flushOnLeave()
      }
      try await model.signIn(identity)
    } catch {
      NSLog("Roadmap fixture failed: %@", String(describing: error))
      model.error = "The roadmap fixture could not be prepared."
    }
    return true
    #else
    return false
    #endif
  }

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
