import Foundation
import Observation
import DomainKit
import GymDomain
import SyncCore
import SyncEngine
import SyncSchema

// The conversation the room is on: its messages as the engine holds them, the composer's draft as this phone keeps it, and
// the one turn the phone drives through the turn driver. One instance serves the room; History opens another conversation
// into it, and a fresh canvas keeps the previous one in the archive.
@Observable @MainActor final class CoachConversation {
  let gym: GymModel
  let store: CoachDraftStore
  var owner: String?
  var saved = CoachSaved()
  var error: String?
  var draftReadable = true
  // A send between its admission and its record, while the composer holds still.
  var sending = false
  @ObservationIgnored var messagesView: RecordsView?
  @ObservationIgnored var threadsView: RecordsView?
  @ObservationIgnored var allMessagesView: RecordsView?

  init(gym: GymModel, store: CoachDraftStore = CoachDraftStore()) {
    self.gym = gym; self.store = store
  }

  var driver: CoachTurnDriver? { gym.coachTurns }
  var anonymous: Bool { gym.isAnonymous }
  var seat: String? {
    guard !gym.accountTransition, !gym.authPaused else { return nil }
    if !gym.isAnonymous { return gym.account }
    return try? gym.runner.read(Gym.scope) { "anonymous:" + $0.replica }
  }
  var available: Bool { seat != nil }
  var allowed: Bool { available && owner == seat }
  // The replica this phone writes: a running Coach message of another's is answering on another device (Coach §4.5).
  var replica: String? { try? gym.runner.read(Gym.scope) { $0.replica } }
  var thread: ID<CoachThread>? { saved.conversation.map { ID(RecordID($0)) } }
  var refusal: CoachTurnRefusal? { driver?.refusal }
  var canCompose: Bool { allowed && draftReadable && !(refusal?.capped ?? false) }
  // How far the draft runs past the question bound (Coach §4.1), in bytes; the composer refuses it as it is typed.
  var tooLongBy: Int { max(0, saved.text.utf8.count - textLimit) }
  // The turn in flight is this conversation's, or another's, which the band names.
  var asking: Bool { sending || (thread != nil && driver?.running?.turn.thread == thread) }
  var answeringElsewhere: Bool { driver?.running != nil && !asking }
  var stopping: Bool { asking && driver?.stopping == true }
  var reconnecting: Bool { asking && driver?.reconnecting == true }
  var textLimit: Int { CoachRules.maxQuestionBytes }
  var offline: Bool { CoachFixture.offline || gym.runtime?.engine.status.online == false }

  // The conversation's messages in the order they were said, as the engine draws them.
  var messages: [CoachMessage] {
    guard case .loaded(let snapshot)? = messagesView?.state else { return [] }
    return snapshot.records.compactMap { try? CoachMessage(Fields($0)) }.inOrder
  }
  var threads: [CoachThread] {
    guard case .loaded(let snapshot)? = threadsView?.state else { return [] }
    return snapshot.records.compactMap { try? CoachThread(Fields($0)) }
  }
  var allMessages: [CoachMessage] {
    guard case .loaded(let snapshot)? = allMessagesView?.state else { return [] }
    return snapshot.records.compactMap { try? CoachMessage(Fields($0)) }
  }
  // The first-run greeting stands until Coach accepts a first message; it steps aside while one is on its way.
  var showsGreeting: Bool {
    !asking && saved.acceptedFirstMessage != true && messages.isEmpty && !(saved.onboarding ?? []).contains { $0.response?.status == "completed" }
  }
  var hasConversation: Bool { saved.hasContent }
  // The Coach message whose calls proposed it, as the room scrolls to its card; none when no answer here did.
  func proposalTurn(_ id: String) -> AnyHashable? {
    messages.first { message in message.calls.contains { call in call.outcome == .ok && call.created.contains { $0.id.description == id } } }?.id.description
  }
  // Why Send stands dimmed: no connection, a cap the composer stays closed on, or a draft this phone cannot read.
  var sendHint: String? {
    if offline { return CoachCopy.offline }
    if let refusal, refusal.capped { return refusal.sentence }
    return draftReadable ? nil : CoachCopy.unreadableDraft
  }

  // MARK: - The owner and its archive

  // The seat's own conversation and draft; while the account changes there is no seat, and the draft on screen stays
  // where it is (board 08.6) until the next seat's own replaces it.
  func activate() async {
    let next = seat
    if next != owner {
      owner = next; error = nil; sending = false
      guard let next else { observe(); return }
      saved = CoachSaved(); draftReadable = true
      do { saved = try store.read(next) }
      catch { draftReadable = false; self.error = CoachCopy.unreadableDraft; gym.report("gym_read", error) }
    }
    observe()
  }

  // The views the room reads: this conversation's messages, and every thread and message for History.
  func observe() {
    guard let engine = gym.runtime?.engine else { return }
    do {
      messagesView = try thread.map { try engine.records(Gym.scope, Gym.Types.message, where: "threadId", is: $0.record, .drawn) }
      threadsView = try engine.records(Gym.scope, Gym.Types.thread, .drawn)
      allMessagesView = try engine.records(Gym.scope, Gym.Types.message, .drawn)
    } catch { gym.report("gym_read", error) }
  }

  @discardableResult func keep(_ next: CoachSaved, failure: String) -> Bool {
    guard let owner, allowed else { return false }
    do { try store.write(next, account: owner); saved = next; return true }
    catch { self.error = failure; gym.report("gym_action", error); return false }
  }
  func reloadDraft() {
    guard let owner, allowed else { return }
    do { saved = try store.read(owner); draftReadable = true; error = nil; observe() }
    catch { self.error = CoachCopy.unreadableDraft; gym.report("gym_read", error) }
  }

  // MARK: - The draft

  func edit(_ text: String) {
    guard text != saved.text else { return }
    var next = saved; next.text = text
    if !keep(next, failure: "Your draft couldn’t be saved. Try again.") { saved.text = text }
  }
  func addPhoto(_ data: Data) throws {
    let (attachment, bytes) = try CoachPhotoPreparation.prepare(data)
    var next = saved; next.photo = attachment; next.photoData = bytes
    if keep(next, failure: "Your draft couldn’t be saved. Try again.") { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "photo_selected"]) }
  }
  func removePhoto() {
    var next = saved; next.photo = nil; next.photoData = nil
    if keep(next, failure: "Your draft couldn’t be saved. Try again.") { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "photo_removed"]) }
  }
  @discardableResult func chooseSetup(_ choice: CoachSetupChoice) -> Bool {
    guard allowed, draftReadable, !asking else { return false }
    var next = saved; next.setupChoice = choice
    guard keep(next, failure: "Your setup choice couldn’t be saved. Try again.") else { return false }
    gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": choice.rawValue])
    return true
  }
  func noteOffline() {
    if offline, !asking, error == nil { error = CoachCopy.offline }
  }

  // MARK: - A turn

  // Coach §4.1: the question and its picture go to the driver; once the turn is recorded the field clears and this
  // conversation is the thread the turn opened. A refused send keeps the draft, and the driver's refusal says why.
  func send() {
    guard allowed, draftReadable, !asking, !answeringElsewhere, let driver, tooLongBy == 0, CoachCopy.sendable(saved.text, photo: saved.photo != nil) else { return }
    if let refusal, refusal.capped { return }
    let question = saved.text.trimmingCharacters(in: .whitespacesAndNewlines)
    let photo = saved.photo.flatMap { attachment in saved.photoData.map { (attachment, $0) } }
    let picture: CoachPictureRow?
    do { picture = try saved.photo.flatMap { photo in try saved.photoData.map { try CoachPhotoPreparation.modelCopy(of: $0, attachment: photo) } } }
    catch { self.error = (error as? AppFailure)?.message ?? "That photo is unavailable. Remove it and choose it again."; return }
    let owner = owner, before = saved.threadId
    sending = true; error = nil
    Task {
      defer { sending = false }
      let turn = await driver.send(question, picture: picture, thread: thread, anonymous: anonymous) { turn in
        self.restore(turn, question: question, photo: photo)
      }
      guard self.owner == owner, allowed else { return }
      guard let turn else {
        error = driver.error
        if driver.refusal == .absent { gym.coachUnavailable = true }
        return
      }
      adopt(turn, from: before)
    }
  }

  // A turn the server refused before it started never happened: the question and its photo return to the field, and a
  // conversation the turn had opened for them is gone with it.
  func restore(_ turn: OpenTurn.Turn, question: String, photo: (CoachAttachment, Data)?) {
    guard let owner, saved.conversation == turn.thread.description else { return }
    var next = saved
    next.text = question; next.photo = photo?.0; next.photoData = photo?.1
    let stands = (try? gym.runner.read(Gym.scope) { try $0.repository(CoachThread.self).find(turn.thread, in: .drawn) != nil }) ?? false
    if !stands {
      next.conversation = nil; next.threadId = UUID().uuidString
      try? store.remove(saved.threadId, account: owner)
    }
    keep(next, failure: "Your message couldn’t be saved. Try again.")
    observe()
  }

  // The turn's thread becomes this conversation's, under the engine's id; the field clears, since the question is a message now.
  func adopt(_ turn: OpenTurn.Turn, from previous: String) {
    guard saved.threadId == previous, let owner else { return }
    var next = saved
    next.conversation = turn.thread.description; next.threadId = turn.thread.description
    next.text = ""; next.photo = nil; next.photoData = nil; next.acceptedFirstMessage = true
    if previous != next.threadId { try? store.remove(previous, account: owner) }
    keep(next, failure: "Your message couldn’t be saved. Try again.")
    observe()
  }

  func stopResponse() {
    guard asking else { return }
    driver?.requestStop()
  }

  // MARK: - Conversations

  @discardableResult func preserveCurrent() -> Bool {
    guard allowed, draftReadable else { return false }
    guard saved.hasContent else { return true }
    return keep(saved, failure: "Your conversation couldn’t be kept. Try again.")
  }

  // A fresh canvas: the conversation on screen stays in the archive, and the next one starts with the owner's marks alone.
  @discardableResult func fresh(door: String = "new_chat", seed: String = "") -> Bool {
    guard preserveCurrent(), let owner else {
      gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "new_chat", "door": door, "outcome": "failed"])
      return false
    }
    var next = saved.carried; next.text = seed
    do { try store.select(nil, account: owner) } catch {
      self.error = "Your new conversation couldn’t be opened. Try again."
      gym.report("gym_action", error)
      gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "new_chat", "door": door, "outcome": "failed"])
      return false
    }
    saved = next
    if !(refusal?.capped ?? false) { error = nil }
    observe()
    gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "new_chat", "door": door, "outcome": "ok"])
    return true
  }

  func begin(_ handoff: CoachHandoff) -> Bool {
    guard allowed, draftReadable, handoff.account == owner, driver?.running == nil, fresh(door: "handoff", seed: handoff.question) else { return false }
    if handoff.send { send() }
    return true
  }

  // History's door: the archived conversation of that id, or the engine thread with nothing of this phone's beside it.
  @discardableResult func open(_ id: String) -> Bool {
    guard preserveCurrent(), let owner else { return false }
    do {
      let archive = try store.archive(owner)
      var next = archive.entries.contains(where: { $0.id == id }) ? archive.conversation(id) : saved.carried
      next.threadId = id
      if try holds(id) { next.conversation = id }
      try store.select(next.hasContent ? id : nil, account: owner)
      saved = next; error = nil
      observe()
      gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "open_conversation", "outcome": "ok"])
      return true
    } catch {
      self.error = "Your conversation couldn’t be opened. Try again."
      gym.report("gym_read", error)
      gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "open_conversation", "outcome": "failed"])
      return false
    }
  }

  // Whether the engine holds a conversation of this id, read now rather than from a view that may still be loading.
  func holds(_ id: String) throws -> Bool {
    try gym.runner.read(Gym.scope) { try $0.repository(CoachThread.self).find(ID(RecordID(id)), in: .drawn) != nil }
  }

  @discardableResult func viewAnswer() -> Bool {
    guard let running = driver?.running, open(running.turn.thread.description) else {
      gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "view_answer", "outcome": "failed"])
      return false
    }
    gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "view_answer", "outcome": "ok"])
    return true
  }

  // Deleting a conversation removes its thread and messages from the engine and its draft from this phone; the one on
  // screen gives way to a fresh canvas, its unsent draft kept.
  @discardableResult func delete(_ id: String) -> Bool {
    guard allowed, let owner, driver?.running?.turn.thread.description != id else { return false }
    if (try? holds(id)) ?? false {
      guard let outcome = gym.run(DeleteConversation(thread: ID(RecordID(id))), failure: "gym_action"), outcome.refusal == nil else {
        gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "delete_conversation", "outcome": "failed"])
        return false
      }
    }
    do {
      if saved.threadId == id {
        var next = saved.carried; next.text = saved.text; next.photo = saved.photo; next.photoData = saved.photoData
        try store.remove(id, account: owner, replacement: next)
        saved = next
        observe()
      } else { try store.remove(id, account: owner) }
    } catch {
      self.error = "Your deleted conversation couldn’t be cleared. Try again."
      gym.report("gym_action", error)
      gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "delete_conversation", "outcome": "failed"])
      return false
    }
    gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "delete_conversation", "outcome": "ok"])
    return true
  }
}
