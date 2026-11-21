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
    let id = try RoadmapFixture.plantLearnToSail(phone.runner)
    let tree = try RoadmapTree(id: id, listed: phone.runner.read(RoadmapEntry.scope) { try $0.repository(RoadmapEntry.self).record(id, in: .drawn) },
                               tree: phone.runner.read(id.tree) { try $0.records(in: .drawn) },
                               overlay: phone.runner.read(id.overlay) { try $0.records(in: .drawn) })
    let account = RoadmapAccount([tree])
    let open = RoadmapModel.OpenRoadmap(listed: try #require(account.list().first), tree: tree, board: BoardRead(try #require(account.graph(tree.id))))

    let board = RoadmapBoard(open: open)
    let groups = RoadmapBoard.groups.map { (group: BoardRead.Column.Name) -> String in
      let rows = (open.board.columns.first { $0.name == group }?.ids ?? []).map { (step: String) -> String in
        let card = open.board.cards.first { $0.id == step }
        return [board.name(open.tree.step(step)), open.tree.step(step)?.color, card.flatMap(board.reason)].compactMap { $0 }.joined(separator: " | ")
      }
      return (["\(RoadmapBoard.title(group)) \(rows.count) \(RoadmapBoard.symbol(group))"] + rows).joined(separator: "\n")
    }
    #expect(groups == [
      """
      Up next 2 circle
      Read the wind | sky | Unlocks Leave the dock
      Tie a bowline | olive
      """,
      """
      Locked 3 lock.fill
      Leave the dock | terracotta | Needs Read the wind · 1 to go
      Sail a triangle | olive | Needs Leave the dock · 2 to go
      Sail solo | gold | Needs Sail a triangle +1 · 4 to go
      """,
      """
      Done 3 checkmark.circle.fill
      Rig the boat | terracotta
      Name the boat parts | sky
      Choose a sailing course | terracotta
      """,
    ])
    #expect(board.name(nil) == "Untitled step")
  }
}
