import Foundation
import Testing
import DomainKit
import DomainKitTesting
import RoadmapDomain
import RoadmapLayout
import SyncCore
import SyncModelServer
import SyncSchema
@testable import Windmill

@Suite @MainActor struct GraphPictureTests {
  // The domain's read of the one roadmap a phone holds, as the room's model takes it.
  func read(_ id: ID<RoadmapEntry>, on phone: Harness) throws -> FollowGraph {
    let tree = try RoadmapTree(id: id, listed: phone.runner.read(RoadmapEntry.scope) { try $0.repository(RoadmapEntry.self).record(id, in: .drawn) },
                               tree: phone.runner.read(id.tree) { try $0.records(in: .drawn) },
                               overlay: phone.runner.read(id.overlay) { try $0.records(in: .drawn) })
    let account = RoadmapAccount([tree])
    let listed = try #require(account.list().first)
    return try #require(account.graph(listed.id))
  }

  // A picture as its parts tell it: each step's name at its seat in its tier and its hue, by name. The steps the
  // fixture planted share their order keys among siblings, so the roadmap's order falls to their ids, which a phone mints.
  func drawn(_ picture: GraphPicture) -> [String] {
    picture.model.nodes.enumerated().map { (place: Int, node: RenderModel.Node) -> String in
      "\(node.label) at \(node.x), \(node.y) in tier \(node.tier.rawValue), \(picture.hues[picture.hueOf[place]])\(node.crowned ? ", crowned" : "")"
    }.sorted()
  }

  // Each link from the step followed to its follower, and whether it is lit, by name.
  func bows(_ picture: GraphPicture) -> [String] {
    picture.bows.map { "\(picture.model.nodes[$0.from].label) → \(picture.model.nodes[$0.to].label)\($0.lit ? ", lit" : "")" }.sorted()
  }

  // Roadmap on iOS P-4: the Graph draws the web's picture. *Learn to sail*, planted through the domain under ids of the
  // phone's own, is seated and tiered as the layout's shared fixture seats and tiers it, and each link leaving a done
  // step is lit.
  @Test func theDomainsReadOfLearnToSailIsDrawnWhereTheSharedFixtureDrawsIt() async throws {
    struct Fixture: Decodable {
      struct Roadmap: Decodable {
        struct Step: Decodable {
          let label: String
          let color: String
        }
        let steps: [Step]
      }
      let roadmap: Roadmap
      let seats: [[Double]]
      let tiers: [Int]
    }
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while directory.path != "/" && !FileManager.default.fileExists(atPath: directory.appending(path: "packages/api-contract/roadmap/layout/learn-to-sail.json").path) {
      directory = directory.deletingLastPathComponent()
    }
    let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: directory.appending(path: "packages/api-contract/roadmap/layout/learn-to-sail.json")))
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                        rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let id = try RoadmapFixture.plantLearnToSail(phone.runner).tree

    let picture = try await GraphPicture(GraphPicture.Steps(of: try read(id, on: phone)))
    #expect(picture.engine == .bubble)
    #expect(drawn(picture) == fixture.roadmap.steps.indices.map { (place: Int) -> String in
      let step = fixture.roadmap.steps[place]
      return "\(step.label) at \(fixture.seats[place][0]), \(fixture.seats[place][1]) in tier \(fixture.tiers[place]), \(step.color)\(place == 0 ? ", crowned" : "")"
    }.sorted())
    #expect(bows(picture) == [
      "Choose a sailing course → Name the boat parts, lit", "Leave the dock → Sail a triangle", "Name the boat parts → Read the wind, lit",
      "Name the boat parts → Rig the boat, lit", "Name the boat parts → Tie a bowline, lit", "Read the wind → Leave the dock",
      "Rig the boat → Leave the dock, lit", "Sail a triangle → Sail solo", "Tie a bowline → Sail solo",
    ])
    #expect(picture.hues.sorted() == ["gold", "olive", "sky", "terracotta"])
    #expect(picture.metrics.count == 8)
  }

  // A step marked done moves no seat: the picture after it stands on the seats and captions of the one before, with
  // the step complete, what it opened available and its links lit. A step added is seated anew.
  @Test func aStepMarkedDoneKeepsEverySeatAndAStepAddedIsSeatedAnew() async throws {
    let phone = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_790_424_000_000), account: nil,
                        rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let planted = try RoadmapFixture.plantLearnToSail(phone.runner)
    let before = try await GraphPicture(GraphPicture.Steps(of: try read(planted.tree, on: phone)))

    try RoadmapFixture.complete("read", of: planted, by: phone.runner)
    let marked = GraphPicture.Steps(of: try read(planted.tree, on: phone))
    #expect(marked.seated == before.steps.seated && marked != before.steps)
    // The layout is not asked again: an engine that would refuse the roadmap is never reached.
    struct Refusing: LayoutEngine {
      let name = LayoutName.bubble
      func layout(_ tree: SkillTree) throws -> [Point] { [Point(x: try Arithmetic.cos(Arithmetic.reducibleBelow), y: 0)] }
    }
    let after = try await GraphPicture(marked, after: before, by: Refusing())
    #expect(after.engine == .bubble && after.seats == before.seats)
    #expect(after.model.nodes.map { "\($0.label) \($0.tier.rawValue)" }.sorted() == [
      "Choose a sailing course 2", "Leave the dock 1", "Name the boat parts 2", "Read the wind 2", "Rig the boat 2", "Sail a triangle 0", "Sail solo 0",
      "Tie a bowline 1",
    ])
    #expect(bows(after).contains("Read the wind → Leave the dock, lit"))

    let read = try #require(planted.steps.first { $0.key == "read" }).id
    guard case .committed = try phone.runner.runAct(CreateStep(tree: planted.tree, step: RoadmapStep.Changes(label: "Reef the mainsail", color: "sky"),
                                                               prerequisites: [read])) else {
      Issue.record("Reef the mainsail was not created")
      return
    }
    let added = try await GraphPicture(GraphPicture.Steps(of: try self.read(planted.tree, on: phone)), after: after)
    #expect(added.model.nodes.count == 9 && added.seats != after.seats && added.metrics.count == 9)
    #expect(bows(added).contains("Read the wind → Reef the mainsail, lit"))
  }

  // §5: a roadmap the bubble layout refuses is seated by the fallback, and the picture says which layout drew it.
  // Steps that follow each other in a loop have no seats at all.
  @Test func aRoadmapTheLayoutRefusesIsSeatedByTheFallbackAndALoopOfStepsIsNot() async throws {
    struct Refusing: LayoutEngine {
      let name = LayoutName.bubble
      func layout(_ tree: SkillTree) throws -> [Point] { [Point(x: try Arithmetic.cos(Arithmetic.reducibleBelow), y: 0)] }
    }
    let step = { (id: String, follows: [String]) -> GraphPicture.Seated in
      GraphPicture.Seated(id: UTF16Text(id), label: UTF16Text(id), ord: UTF16Text(id), born: .unset, follows: follows.map { UTF16Text($0) }, hue: UTF16Text("sky"))
    }
    let line = GraphPicture.Steps(seated: [step("a", []), step("b", ["a"]), step("c", ["b"])], done: [true, false, false])
    let fallen = try await GraphPicture(line, by: Refusing())
    #expect(fallen.engine == .radial && fallen.seats.count == 3)
    #expect(fallen.model.nodes.map(\.tier) == [.complete, .available, .locked])
    #expect(try await GraphPicture(line).engine == .bubble)

    let loop = GraphPicture.Steps(seated: [step("a", ["b"]), step("b", ["a"])], done: [false, false])
    await #expect(throws: SkillTree.Malformed.cycle) { try await GraphPicture(loop) }
  }
}
