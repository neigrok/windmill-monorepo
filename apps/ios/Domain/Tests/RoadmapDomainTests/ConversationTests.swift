import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// Roadmap Coach's records (conversation-actions.json): each case by its complete result, a turn's opening, end and
// withdrawal, and the read of one conversation.
struct ConversationTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/conversation-actions.json"))
  func action(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try Self.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  // A read's case, or a turn's act.
  static func decision(_ vector: Vector) throws -> JSON {
    guard let read = try vector.input["read"]?.asString() else { return try RoadmapAct.decision(vector) }
    guard read == "conversation" else { throw ContractError("no conversation read \(read)") }
    let thread: ID<CoachThread> = try vector.input.member("input").id("thread")
    return try ProductCorpus(RoadmapRules.book).read(vector, in: CoachThread.scope) { (reader: Reader) throws -> JSON in
      guard let conversation = try Conversation.read(reader, thread: thread) else { return .null }
      return ["thread": conversation.thread.id.json, "messages": .array(conversation.messages.map(\.id.json)),
              "fates": .array(conversation.fates.map(\.id.json))]
    }
  }
}
