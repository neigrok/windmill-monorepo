import Foundation
import Testing
import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
import SyncModelServer
import SyncSchema
@testable import Windmill

@Suite @MainActor struct RoadmapBoardTests {
  // Roadmap · iOS 01.1: the Board's own words over the domain's read of *Learn to sail*; a Done step says nothing.
  @Test func theBoardNamesItsGroupsAndSaysWhyEachStepStandsWhereItDoes() throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                        rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let id = try RoadmapFixture.plantLearnToSail(phone.runner).tree
    let tree = try RoadmapTree(id: id, listed: phone.runner.read(RoadmapEntry.scope) { try $0.repository(RoadmapEntry.self).record(id, in: .drawn) },
                               tree: phone.runner.read(id.tree) { try $0.records(in: .drawn) },
                               overlay: phone.runner.read(id.overlay) { try $0.records(in: .drawn) })
    let account = RoadmapAccount([tree])
    let listed = try #require(account.list().first)
    let open = try #require(RoadmapModel.OpenRoadmap(listed, in: account))
    let suite = "roadmap-board-\(UUID().uuidString)", memory = UserDefaults(suiteName: suite)!
    defer { memory.removePersistentDomain(forName: suite) }
    let board = RoadmapBoard(roadmap: RoadmapModel(records: { _, _ in throw AppFailure(message: "the Board's words read no view") },
                                                   runner: phone.runner, phone: memory), open: open)

    let groups = open.groups.map { (group: RoadmapModel.Group) -> String in
      let rows = group.rows.map { (row: RoadmapModel.Row) -> String in
        [board.name(row.step), row.kind?.label ?? RoadmapBoard.hue(row.step.color), board.reason(row.card)].compactMap { $0 }.joined(separator: " | ")
      }
      return (["\(RoadmapBoard.title(group.id)) \(rows.count) \(RoadmapBoard.symbol(group.id))"] + rows).joined(separator: "\n")
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
    #expect(board.name(nil) == "Untitled step")
  }

  // Roadmap · iOS 03.8: the delete question's cost line, by how many steps follow the step.
  @Test func theDeleteQuestionSaysWhatTheDeleteCosts() {
    #expect([0, 1, 2].map(RoadmapBoard.cost) == ["Removes this step", "Removes this step · 1 branch resplices", "Removes this step · 2 branches resplice"])
  }

  // A step's colour is said by its hue's own name where no kind names it, and not at all for a hue this build does not know.
  @Test func aHueIsSaidByItsOwnName() {
    #expect(["terracotta", "olive", "gold", "brick", "sky", "plum", "teal"].map { RoadmapBoard.hue($0) ?? "" } == ["Terracotta", "Olive", "Gold", "Brick", "Sky", "Plum", ""])
  }
}
