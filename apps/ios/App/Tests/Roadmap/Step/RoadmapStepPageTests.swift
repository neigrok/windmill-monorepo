import Foundation
import Testing
import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import SyncModelServer
import SyncSchema
@testable import Windmill

@Suite @MainActor struct RoadmapStepPageTests {
  // Roadmap · iOS 03.1, 03.5, 03.6 and 03.6b: a step's page in its own words over the domain's read of *Learn to sail*.
  // The status row names the state, then the kind with why the step stands there, or on a Done step what Reset would
  // return to Locked; a row of a step it requires or opens says that step's state, and a Done one says nothing.
  @Test func aStepsPageSaysItsStateItsKindAndTheStateOfEachStepAroundIt() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                        rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let planted = try RoadmapFixture.plantLearnToSail(phone.runner)
    let said = { (label: String) throws -> [String] in
      let id = planted.tree
      let tree = try RoadmapTree(id: id, listed: phone.runner.read(RoadmapEntry.scope) { try $0.repository(RoadmapEntry.self).record(id, in: .drawn) },
                                 tree: phone.runner.read(id.tree) { try $0.records(in: .drawn) },
                                 overlay: phone.runner.read(id.overlay) { try $0.records(in: .drawn) })
      let account = RoadmapAccount([tree])
      let listed = try #require(account.list().first)
      let open = try #require(RoadmapModel.OpenRoadmap(listed, in: account))
      let step = try #require(tree.nodes.first { $0.label == label })
      let page = try #require(open.page(of: step.id))
      let rows = { (rows: [RoadmapModel.Row]) -> String in
        rows.map { (row: RoadmapModel.Row) -> String in [row.name, RoadmapStepPage.state(row.card)].compactMap { $0 }.joined(separator: " | ") }
          .joined(separator: ", ")
      }
      return ["\(page.row.name): \(page.row.card.column.title) | \(RoadmapStepPage.detail(of: page, in: open))",
              "requires: " + rows(page.requires), "opens: " + rows(page.opens)]
    }

    #expect(try said("Read the wind") == [
      "Read the wind: Up next | Sky · Unlocks Leave the dock", "requires: Name the boat parts", "opens: Leave the dock | Locked · 1 to go",
    ])
    #expect(try said("Sail solo") == [
      "Sail solo: Locked | Milestone · Needs Sail a triangle +1 · 4 to go", "requires: Sail a triangle | Locked · 2 to go, Tie a bowline | Up next",
      "opens: ",
    ])
    #expect(try said("Name the boat parts") == [
      "Name the boat parts: Done | Sky · Reset returns 2 steps to Locked", "requires: Choose a sailing course",
      "opens: Rig the boat, Read the wind | Up next, Tie a bowline | Up next",
    ])
    #expect(try said("Rig the boat") == ["Rig the boat: Done | Build", "requires: Name the boat parts", "opens: Leave the dock | Locked · 1 to go"])

    try RoadmapFixture.complete("read", of: planted, by: phone.runner)
    #expect(try said("Read the wind") == [
      "Read the wind: Done | Sky · Reset returns 1 step to Locked", "requires: Name the boat parts", "opens: Leave the dock | Up next",
    ])
  }
}
