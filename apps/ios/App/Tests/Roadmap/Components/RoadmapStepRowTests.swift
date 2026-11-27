import Foundation
import Testing
import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import SyncModelServer
import SyncSchema
@testable import Windmill

@Suite @MainActor struct RoadmapStepRowTests {
  // Roadmap · iOS 01.1: the room's words over the domain's read of *Learn to sail*: each group's name and symbol, and
  // each step's name, colour and why it stands in its group; a Done step says nothing.
  @Test func theRoomNamesItsGroupsAndSaysWhyEachStepStandsWhereItDoes() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                        rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let id = try RoadmapFixture.plantLearnToSail(phone.runner).tree
    let tree = try RoadmapTree(id: id, listed: phone.runner.read(RoadmapEntry.scope) { try $0.repository(RoadmapEntry.self).record(id, in: .drawn) },
                               tree: phone.runner.read(id.tree) { try $0.records(in: .drawn) },
                               overlay: phone.runner.read(id.overlay) { try $0.records(in: .drawn) })
    let account = RoadmapAccount([tree])
    let listed = try #require(account.list().first)
    let open = try #require(RoadmapModel.OpenRoadmap(listed, in: account))

    let groups = open.groups.map { (group: RoadmapModel.Group) -> String in
      let rows = group.rows.map { (row: RoadmapModel.Row) -> String in
        [row.name, row.colour, open.reason(row.card)].compactMap { $0 }.joined(separator: " | ")
      }
      return (["\(group.id.title) \(rows.count) \(group.id.symbol)"] + rows).joined(separator: "\n")
    }
    #expect(groups == [
      """
      Up next 2 circle
      Read the wind | Sky | Unlocks Leave the dock
      Tie a bowline | Learn
      """,
      """
      Locked 3 lock.fill
      Leave the dock | Build | Needs Read the wind · 1 to go
      Sail a triangle | Learn | Needs Leave the dock · 2 to go
      Sail solo | Milestone | Needs Sail a triangle +1 · 4 to go
      """,
      """
      Done 3 checkmark.circle.fill
      Rig the boat | Build
      Name the boat parts | Sky
      Choose a sailing course | Build
      """,
    ])
  }

  // A step is named by its label, and one without a label by the room's words for it.
  @Test func aStepWithoutALabelIsNamedByTheRoom() {
    #expect(["Read the wind", ""].map(RoadmapModel.Row.name(of:)) == ["Read the wind", "Untitled step"])
  }

  // A step's colour is said by its hue's own name where no kind names it, and not at all for a hue this build does not know.
  @Test func aHueIsSaidByItsOwnName() {
    let hues = ["terracotta", "olive", "gold", "brick", "sky", "plum", "teal"].map { RoadmapModel.Row.hue($0) ?? "" }
    #expect(hues == ["Terracotta", "Olive", "Gold", "Brick", "Sky", "Plum", ""])
  }
}
