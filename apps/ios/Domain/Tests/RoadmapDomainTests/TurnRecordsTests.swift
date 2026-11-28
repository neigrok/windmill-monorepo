import DomainKit
import DomainKitTesting
import RoadmapDomain
import SyncAPI
import SyncCore
import Testing

// A Coach turn's records beyond its opening, end and withdrawal (turn-records-actions.json): each case by its complete result,
// with its records in reverse too.
struct TurnRecordsTests {
  @Test(arguments: try Contract.vectors("roadmap/domain/turn-records-actions.json"))
  func record(_ vector: Vector) throws {
    for scene in [vector, vector.withRecordsReversed] {
      let actual = try Self.decision(scene)
      #expect(actual == vector.expect, "\(vector)\n  got    \(actual.jcsText)\n  expect \(vector.expect.jcsText)")
    }
  }

  static func decision(_ vector: Vector) throws -> JSON {
    let input = try vector.input.member("input")
    if let read = try vector.input["read"]?.asString() {
      guard read == "history" else { throw ContractError("no turn record read \(read)") }
      let current = try input["current"].flatMap { $0.isNull ? nil : try $0.asString() }
      return try ProductCorpus(RoadmapRules.book).read(vector, in: CoachThread.scope) { (reader: Reader) throws -> JSON in
        let history = try CoachHistory.read(reader, current: current)
        return ["current": .array(history.current.map(Self.form)), "other": .array(history.other.map(Self.form))]
      }
    }
    return try act(try vector.input.member("action").asString(), input).decide(vector)
  }

  static func act(_ action: String, _ input: JSON) throws -> RoadmapAct {
    switch action {
    case "BeginRound":
      return RoadmapAct(BeginRound(try input.id("message"), callId: try input.member("callId").asString(), text: try input.member("text").asString()),
                        result: { .null })
    case "StreamTurnText": return RoadmapAct(StreamTurnText(try input.id("message"), text: try input.member("text").asString()), result: { .null })
    case "RecoverMark": return RoadmapAct(RecoverMark(), result: { .array($0.map(\.json)) })
    case "ForgetRunningTurn": return RoadmapAct(ForgetRunningTurn(try input.id("message")), result: { .null })
    case "InterruptStaleTurn":
      return RoadmapAct(InterruptStaleTurn(try input.id("message"), serverNow: try input.member("serverNow").asInteger()), result: { .bool($0) })
    case "RecordWriteFate":
      guard let fate = RecordWriteFate.Fate(rawValue: try input.member("fate").asString()) else { throw ContractError("no fate in \(input)") }
      let act = RecordWriteFate(try input.id("message"), receipt: Int(try input.member("receipt").asInteger()), fate: fate,
                                code: try input.optionalString("code"))
      return RoadmapAct(act, result: { $0.json })
    case "DeleteConversation": return RoadmapAct(DeleteConversation(try input.id("thread")), result: { .null })
    case "EndTurn":
      guard let state = CoachMessageState(rawValue: try input.member("state").asString()) else { throw ContractError("no message state in \(input)") }
      let act = EndTurn(try input.id("message"), state: state, text: try input.optionalString("text"), truncated: try input.optionalBool("truncated") ?? false,
                        refusal: try input.optionalString("refusal"), calls: try input["calls"].map { try $0.asArray().map(CoachCall.init(json:)) },
                        receipts: try input["receipts"].map { try $0.asArray().map(CoachReceipt.init(json:)) })
      return RoadmapAct(act, result: { .null })
    default: throw ContractError("no turn record act \(action)")
    }
  }

  static func form(_ row: CoachHistory.Row) -> JSON {
    let proposal: JSON = row.proposal.map {
      ["id": $0.id.json, "changes": JSON($0.changes), "state": .string($0.state.rawValue), "undone": .bool($0.undone)]
    } ?? .null
    return ["thread": row.thread.id.json, "treeId": row.thread.treeId.map(JSON.string) ?? .null, "stepId": row.thread.stepId.map(JSON.string) ?? .null,
            "title": .string(row.thread.title), "at": row.at.map { JSON($0.ms) } ?? .null, "proposal": proposal]
  }
}
