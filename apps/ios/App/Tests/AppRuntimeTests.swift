import Foundation
import Testing
import DomainKit
import RoadmapDomain
import SyncCore
import SyncEngine
import SyncSchema
@testable import Windmill

@Suite(.serialized) @MainActor struct AppRuntimeTests {
  // The test bundle's Info.plist names no Roadmap room, as a Release build's says NO; the host app is a Debug build.
  let shipped = AppSettings(arguments: ["app"], bundle: Bundle(for: TelemetryRecorder.self))
  let debug = AppSettings(arguments: ["app"])

  // The composition is windmill's three registries at 13 / minimum 11; the engine carries roadmap only with its room.
  @Test func theEngineCarriesRoadmapOnlyWhereTheBuildCarriesItsRoom() {
    #expect(SyncSchema.registry.products.map(\.name) == ["gym", "journal", "roadmap"])
    #expect(SyncSchema.version == 13 && SyncSchema.registry.minVersion == 11)
    #expect(!shipped.roadmapRoom && shipped.engineConfig.products(of: SyncSchema.registry) == ["gym", "journal"])
    #expect(debug.roadmapRoom && debug.engineConfig.products(of: SyncSchema.registry) == ["gym", "journal", "roadmap"])
  }

  // One engine, two runners: a step deleted through roadmap's is held for Undo, and one deleted through the app's is gone.
  @Test func roadmapsRunnerHoldsARemovalWhileTheAppsRunnerRemovesAtOnce() throws {
    let directory = URL.temporaryDirectory.appending(path: UUID().uuidString)
    let runtime = try AppRuntime(settings: AppSettings(arguments: ["app", "-model-server"]), directory: directory, service: "works.windmill.roadmap-tests.\(UUID())")
    let planted = ImportedSteps(steps: ["Basics", "Ownership", "Traits"].map { ImportedStep(key: $0, RoadmapStep.Changes(label: $0)) })
    guard case .committed(let created, _) = try runtime.roadmapRunner.runAct(CreateRoadmap(title: "Learn Rust", steps: planted)),
          case .committed(_, let held) = try runtime.roadmapRunner.runAct(DeleteStep(tree: created.tree, step: created.steps[1].id)),
          case .committed(_, let gone) = try runtime.runner.runAct(DeleteStep(tree: created.tree, step: created.steps[2].id)) else {
      Issue.record("the roadmap was not created or a step not deleted")
      return
    }
    let present = { try runtime.runner.read(created.tree.tree) { try $0.repository(RoadmapStep.self).all(in: .drawn).map(\.label).sorted() } }
    #expect(held.releaseAt != nil && gone.releaseAt == nil)
    #expect(try present() == ["Basics"])
    #expect(try !runtime.runner.cancelHeld(gone.gestureId))
    #expect(try runtime.roadmapRunner.cancelHeld(held.gestureId))
    #expect(try present() == ["Basics", "Ownership"])
  }
}
