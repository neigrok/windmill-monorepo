import Foundation
import DomainKit
import GymDomain
import SyncAPI
import SyncCore
import SyncSchema

// What a turn writes and reads on the replica beside the domain's OpenTurn, EndTurn and the executor: the answer's text as it
// streams, a turn withdrawn before the server took it, a conversation deleted whole, the pictures a message keeps on this
// phone (Coach §9.3), and the pure reads the driver and the room take over a conversation's messages.

// A picture as this phone keeps it, in the `picture:<id>` device row: the original the lifter chose and the model copy that
// leaves the phone inside an open request.
nonisolated struct CoachPictureRow: Equatable, Sendable {
  static let prefix = "picture:"

  let id: String
  let mediaType: String
  let width: Int
  let height: Int
  let original: Data
  let model: Data

  static func key(_ id: String) -> String { prefix + id }

  var json: JSON {
    ["mediaType": .string(mediaType), "width": JSON(width), "height": JSON(height),
     "original": .string(original.base64EncodedString()), "model": .string(model.base64EncodedString())]
  }

  init(id: String, mediaType: String, width: Int, height: Int, original: Data, model: Data) {
    self.id = id; self.mediaType = mediaType; self.width = width; self.height = height; self.original = original; self.model = model
  }

  init?(id: String, json: JSON?) {
    guard let json, let mediaType = try? json.member("mediaType").asString(), let width = try? json.member("width").asInteger(),
          let height = try? json.member("height").asInteger(), let original = try? json.member("original").asString(),
          let model = try? json.member("model").asString(),
          let originalData = Data(base64Encoded: original), let modelData = Data(base64Encoded: model) else { return nil }
    self.init(id: id, mediaType: mediaType, width: Int(width), height: Int(height), original: originalData, model: modelData)
  }

  // The lifter's photo as the composer and the transcript draw it.
  var attachment: CoachAttachment { CoachAttachment(id: id, mediaType: mediaType, width: width, height: height, bytes: original.count) }
}

struct KeepPicture: Action {
  let picture: CoachPictureRow

  var scope: ScopeRef { Gym.scope }

  func load(_ read: Reader) throws {}

  func decide(_ loaded: Void, ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    var plan = Plan()
    plan.device(CoachPictureRow.key(picture.id), picture.json)
    return .write(plan)
  }
}

// The answer's text as it streams (Coach §4.3): the running Coach message of this replica takes the text so far, one commit
// per coalesced chunk; a message that ended, or another replica's, takes nothing.
struct StreamTurnText: Action {
  let message: ID<CoachMessage>
  let text: String

  var scope: ScopeRef { Gym.scope }

  func load(_ read: Reader) throws -> (message: CoachMessage?, replica: String, moment: Moment) {
    (try read.repository(CoachMessage.self).find(message, in: .drawn), read.replica, read.moment)
  }

  func decide(_ loaded: (message: CoachMessage?, replica: String, moment: Moment), ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard var streaming = loaded.message, streaming.role == .coach else {
      return .refuse(GymRefusal(Refused(.unknownRecord, subject: message.ref, path: .predicted)))
    }
    guard streaming.state == .running, streaming.replica == loaded.replica, streaming.text != text else { return .unchanged(()) }
    streaming.text = text
    var plan = Plan()
    plan.update(try Valid(streaming, fields: ["text"], at: loaded.moment), fields: ["text"])
    return .write(plan)
  }
}

// A turn the server refused before its stream started never happened: its two messages go, with the pictures the
// lifter's kept on this phone, the conversation too when it held nothing else, and the device's `runningTurn` row
// clears, so the question returns to the field.
struct WithdrawTurn: Action {
  let turn: OpenTurn.Turn

  var scope: ScopeRef { Gym.scope }

  func load(_ read: Reader) throws -> [CoachMessage] {
    try read.repository(CoachMessage.self).children(of: turn.thread, via: "threadId", in: .stored)
  }

  func decide(_ loaded: [CoachMessage], ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    var plan = Plan()
    for message in loaded where message.id == turn.lifter || message.id == turn.coach {
      plan.remove(message.id)
      for picture in message.pictures where picture.localOnly { plan.device(CoachPictureRow.key(picture.id), nil) }
    }
    if loaded.allSatisfy({ $0.id == turn.lifter || $0.id == turn.coach }) { plan.remove(turn.thread) }
    plan.device(EndTurn.runningTurnKey, nil)
    return .write(plan)
  }
}

// A conversation deleted from History: the thread, every message it holds and the pictures those messages kept on this phone.
struct DeleteConversation: Action {
  let thread: ID<CoachThread>

  var scope: ScopeRef { Gym.scope }

  func load(_ read: Reader) throws -> (thread: CoachThread?, messages: [CoachMessage]) {
    (try read.repository(CoachThread.self).find(thread, in: .drawn),
     try read.repository(CoachMessage.self).children(of: thread, via: "threadId", in: .stored))
  }

  func decide(_ loaded: (thread: CoachThread?, messages: [CoachMessage]), ids: IDSource) throws(Violation) -> Decision<Void, GymRefusal> {
    guard loaded.thread != nil else { return .unchanged(()) }
    var plan = Plan()
    plan.remove(thread)
    for message in loaded.messages {
      plan.remove(message.id)
      for picture in message.pictures where picture.localOnly { plan.device(CoachPictureRow.key(picture.id), nil) }
    }
    return .write(plan)
  }
}

// MARK: - Reads over a conversation's messages

// A conversation's messages in the order they were said: by moment, then by id.
nonisolated extension Array where Element == CoachMessage {
  var inOrder: [CoachMessage] {
    sorted { ($0.at, $0.role == .coach ? 1 : 0, $0.id) < ($1.at, $1.role == .coach ? 1 : 0, $1.id) }
  }

  // Coach §4.1 step 4: the newest completed turns, each a lifter message and the Coach answer that completed it, within
  // the turn and byte bounds, oldest first; the turn being opened is not among them.
  func history(before turn: ID<CoachMessage>, turns: Int = CoachTurnBounds.contextTurns, bytes: Int = CoachTurnBounds.contextBytes) -> [TurnOpenRequest.Line] {
    let ordered = inOrder
    var lines: [TurnOpenRequest.Line] = []
    var used = 0, taken = 0
    for (index, answer) in ordered.enumerated().reversed() {
      guard answer.role == .coach, answer.id != turn, answer.state == .completed, index > 0 else { continue }
      let question = ordered[index - 1]
      guard question.role == .lifter else { continue }
      let cost = question.text.utf8.count + answer.text.utf8.count
      guard taken < turns, used + cost <= bytes else { break }
      lines.insert(contentsOf: [TurnOpenRequest.Line(role: .lifter, text: question.text), TurnOpenRequest.Line(role: .coach, text: answer.text)], at: 0)
      used += cost; taken += 1
    }
    return lines
  }

  // Coach §4.1 step 5: the pictures of the lifter message being sent and of the one before it, newest first.
  func contextPictures(sending lifter: ID<CoachMessage>, limit: Int = CoachTurnBounds.contextPictures) -> [Picture] {
    let questions = inOrder.filter { $0.role == .lifter }
    guard let at = questions.lastIndex(where: { $0.id == lifter }) else { return [] }
    var pictures: [Picture] = []
    for question in questions[...at].reversed() { pictures += question.pictures }
    return [Picture](pictures.prefix(limit))
  }
}

// A run's value, whether it committed or changed nothing.
extension Outcome {
  var value: Result? {
    switch self {
    case .committed(let value, _), .unchanged(let value): value
    case .refused: nil
    }
  }
}

nonisolated enum CoachTurnBounds {
  static let contextTurns = 24
  static let contextBytes = 24_000
  static let contextPictures = 2
  static let contextReadBytes = 64 * 1024
  static let modelPictureEdge = 1568
  static let modelPictureBytes = 1024 * 1024
  static let textCoalescing = Duration.milliseconds(250)
  static let contextReads = ["list_sessions", "list_notes", "list_exercises", "list_routines"]
}
