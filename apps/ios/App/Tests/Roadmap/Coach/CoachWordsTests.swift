import Foundation
import Testing
import Agent
import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncCore
@testable import Windmill

// The words a Coach turn and its receipts carry: roadmap's profile from the contract's files the app ships as they are, and
// each receipt of packages/api-contract/roadmap/coach/receipts.json read in its line.
@Suite @MainActor struct CoachWordsTests {
  @Test(arguments: try Contract.json("roadmap/coach/receipts.json").asArray().indices)
  func receipt(_ index: Int) throws {
    let each = try Contract.json("roadmap/coach/receipts.json").asArray()[index]
    let input = try each.member("input")
    let line = CoachReceiptLine.words(try CoachReceipt(json: input.member("receipt")), undone: (try? input.member("fate").asString()) == "undone")
    let (name, expected) = (try each.member("name").asString(), try each.member("expect").member("line").asString())
    #expect(line == expected, "\(name)")
  }

  @Test func theProfileShipsTheContractsWordsAndOffersWhatTheConversationIsAbout() throws {
    let profile = try CoachProfile()
    let contract = { (name: String) throws -> Data in try Data(contentsOf: Contract.root().appending(path: "roadmap/coach/\(name)")) }
    #expect(Data(profile.prompt.utf8) == (try contract("prompt.md")))
    #expect(profile.refusals == (try JSONDecoder().decode([String: String].self, from: try contract("refusals.json"))))
    let roadmap = try profile.profile(seat: .bound, about: "t_0000000000000001", writes: true)
    #expect(roadmap.name == "roadmap.coach" && roadmap.version == 1 && roadmap.label == "roadmap.coach.turn")
    #expect(roadmap.tools.map(\.name) == ["get_tree", "get_nodes", "find_nodes", "get_progress", "get_diagnostics", "set_progress", "update_node", "create_node", "connect"])
    #expect(roadmap.tools.filter(\.countsAsWrite).map(\.name) == ["set_progress", "update_node", "create_node", "connect"])
    #expect([roadmap.modelCalls, roadmap.abilityCalls, roadmap.writes] == [8, 12, 6] && roadmap.groups.isEmpty)
    let every = try profile.profile(seat: .anon, about: nil, writes: false)
    #expect(every.tools.map(\.name) == ["get_tree", "get_nodes", "find_nodes", "get_progress", "get_diagnostics", "list_trees"])
    #expect(every.refusal("closes-cycle") == JSON.object(["code": "closes-cycle", "message": .string(profile.refusals["closes-cycle"] ?? "")]).jcsText)
    // A roadmap the person only reads is read, never written.
    let read = try profile.profile(seat: .bound, about: "t_0000000000000001", writes: false)
    #expect(read.tools.map(\.name) == ["get_tree", "get_nodes", "find_nodes", "get_progress", "get_diagnostics"])
  }

  @Test func theEarlierConversationKeepsItsLastTurnsWithinItsBytes() throws {
    let profile = try CoachProfile()
    let messages = (0..<60).map { index in
      CoachMessage(id: ID(RecordID("message\(1000 + index)")), threadId: ID(RecordID("thread0001")), role: index % 2 == 0 ? "person" : "coach",
                   text: String(repeating: "a", count: 900), at: Instant(ms: Int64(index)))
    }
    let history = profile.history(messages)
    #expect(history.hasPrefix(profile.words.earlierConversation.marker) && history.utf8.count <= CoachProfile.historyBytes)
    #expect(history.components(separatedBy: "\n\n").count - 1 < CoachProfile.historyTurns * 2)
    #expect(profile.history([]) == "")
  }
}
