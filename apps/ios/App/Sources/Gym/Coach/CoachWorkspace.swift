import Foundation
import Observation

@Observable @MainActor final class CoachWorkspace {
  var current: CoachConversation
  var conversations: [CoachConversation]
  var entries: [CoachArchive.Entry] = []
  var historyError: String?
  private var owner: String?

  init(coach: CoachConversation) {
    current = coach
    conversations = [coach]
    owner = coach.owner
    permit(coach)
  }
  var pending: CoachConversation? { conversations.first { $0.asking || $0.stopping || $0.saved.hasPendingRequest } }
  var answeringElsewhere: Bool { pending.map { $0 !== current } ?? false }

  func permit(_ conversation: CoachConversation) {
    conversation.requestPermission = { [weak self, weak conversation] in
      guard let self, let conversation else { return false }
      return self.pending == nil || self.pending === conversation
    }
  }
  func activate(resume: Bool = true) async {
    let nextOwner = current.seat
    if owner != nextOwner {
      for conversation in conversations {
        conversation.workGeneration += 1; conversation.stopGeneration += 1; conversation.invalidateRead()
        conversation.work?.cancel(); conversation.stopWork?.cancel()
        conversation.work = nil; conversation.stopWork = nil
        conversation.asking = false; conversation.stopping = false; conversation.owner = nil
      }
      let next = CoachConversation(gym: current.gym, rest: current.rest, store: current.store)
      next.owner = nextOwner
      current = next; conversations = [next]; entries = []; historyError = nil; owner = nextOwner
      permit(next)
      if let nextOwner {
        do {
          next.saved = try next.store.read(nextOwner)
          if next.anonymous { next.saved.purpose = .routineSetup }
        } catch {
          next.draftReadable = false; next.error = CoachCopy.unreadableDraft
          next.gym.report("gym_read", error)
        }
      }
    }
    guard let account = current.owner, current.allowed, current.draftReadable else { return }
    do {
      let archive = try current.store.archive(account)
      if let id = archive.pending, !conversations.contains(where: { $0.saved.threadId == id }),
         archive.entries.contains(where: { $0.id == id }) {
        let retained = CoachConversation(gym: current.gym, rest: current.rest, store: current.store)
        retained.owner = account; retained.saved = archive.conversation(id); retained.visible = false
        permit(retained); conversations.append(retained)
      }
      entries = archive.entries; historyError = nil
    } catch {
      historyError = "Your conversations couldn’t be read. Try again."
      current.gym.report("gym_read", error)
    }
    guard resume else { return }
    for conversation in conversations {
      if conversation.work?.isCancelled == true { await conversation.work?.value }
      if conversation.stopWork?.isCancelled == true { await conversation.stopWork?.value }
    }
    guard current.owner == account, current.allowed else { return }
    if let pending { await pending.activate() }
    if pending !== current { await current.activate() }
  }
  func suspend() {
    for conversation in conversations { conversation.work?.cancel(); conversation.stopWork?.cancel() }
  }
  func preserveCurrent() -> Bool {
    guard current.allowed, current.draftReadable else { return false }
    guard current.saved.hasContent else { return true }
    return current.keep(current.saved, failure: "Your conversation couldn’t be kept. Try again.")
  }
  @discardableResult func fresh(door: String = "new_chat") -> Bool {
    guard preserveCurrent() else {
      current.gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "new_chat", "door": door, "outcome": "failed"])
      return false
    }
    do {
      if let account = current.owner, try current.store.archive(account).selected != nil {
        try current.store.select(nil, account: account)
      }
    } catch {
      current.error = "Your new conversation couldn’t be opened. Try again."
      current.gym.report("gym_action", error)
      current.gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "new_chat", "door": door, "outcome": "failed"])
      return false
    }
    let next = CoachConversation(gym: current.gym, rest: current.rest, store: current.store)
    next.owner = current.owner; next.saved = current.saved.carried
    next.saved.purpose = next.anonymous ? .routineSetup : .conversation
    switch current.refusal { case .daily, .ceiling, .absent: next.refusal = current.refusal; next.error = current.error; default: break }
    select(next)
    current.gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "new_chat", "door": door, "outcome": "ok"])
    return true
  }
  func begin(_ handoff: CoachHandoff) -> Bool {
    guard current.allowed, handoff.account == current.owner, pending == nil else { return false }
    guard fresh(door: "handoff") else { return false }
    return current.begin(handoff)
  }
  func select(_ conversation: CoachConversation) {
    current.visible = false
    current = conversation; current.visible = true
    permit(current)
    if !conversations.contains(where: { $0 === current }) { conversations.append(current) }
    conversations.removeAll { $0 !== current && !$0.asking && !$0.stopping && !$0.saved.hasPendingRequest }
    refreshHistory()
  }
  @discardableResult func viewAnswer() -> Bool {
    guard let pending, preserveCurrent(), let account = current.owner else { return false }
    do { try current.store.select(pending.saved.threadId, account: account) }
    catch {
      current.error = "Your conversation couldn’t be opened. Try again."
      current.gym.report("gym_action", error)
      current.gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "view_answer", "outcome": "failed"])
      return false
    }
    select(pending)
    current.gym.telemetry.event("gym_action", properties: ["screen": "coach", "action": "view_answer", "outcome": "ok"])
    return true
  }
  func refreshHistory() {
    guard let account = current.owner, current.allowed else { entries = []; return }
    do {
      let archive = try current.store.archive(account)
      entries = archive.entries; historyError = nil
      current.saved.acceptedFirstMessage = current.saved.acceptedFirstMessage == true || archive.shared.acceptedFirstMessage == true
      current.saved.rejectedDrafts = archive.shared.rejectedDrafts
      current.saved.adoptedSources = archive.shared.adoptedSources
    }
    catch {
      historyError = "Your conversations couldn’t be read. Try again."
      current.gym.report("gym_read", error)
    }
  }
  @discardableResult func openLocal(_ id: String) -> Bool {
    guard preserveCurrent(), let account = current.owner else { return false }
    do {
      let archive = try current.store.archive(account)
      guard archive.entries.contains(where: { $0.id == id }) else { return false }
      let next: CoachConversation
      if let retained = conversations.first(where: { $0.saved.threadId == id }) { next = retained }
      else {
        next = CoachConversation(gym: current.gym, rest: current.rest, store: current.store)
        next.owner = account; next.saved = archive.conversation(id)
      }
      try current.store.select(id, account: account)
      select(next)
      current.gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "open_conversation", "outcome": "ok"])
      return true
    } catch {
      historyError = "Your conversation couldn’t be opened. Try again."
      current.gym.report("gym_read", error)
      current.gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "open_conversation", "outcome": "failed"])
      return false
    }
  }
  func openRemote(_ id: String) async -> Bool {
    guard preserveCurrent(), let account = current.owner else { return false }
    let previous = current
    let next = CoachConversation(gym: previous.gym, rest: previous.rest, store: previous.store)
    next.owner = account; next.saved = previous.saved.carried; next.visible = false
    let cached: CoachSaved?
    do {
      let archive = try previous.store.archive(account)
      cached = archive.entries.contains(where: { $0.id == id }) ? archive.conversation(id) : nil
      if let cached { next.saved = cached }
    } catch {
      historyError = "Your conversation couldn’t be opened. Try again."
      current.gym.report("gym_read", error)
      current.gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "open_conversation", "outcome": "failed"])
      return false
    }
    permit(next)
    await next.open(id, resume: false)
    guard current === previous, current.owner == account, current.allowed else { return false }
    guard next.saved.thread?.id == id || cached != nil else {
      historyError = next.error
      current.gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "open_conversation", "outcome": "failed"])
      return false
    }
    do { try current.store.select(id, account: account) }
    catch {
      historyError = "Your conversation couldn’t be opened. Try again."
      current.gym.report("gym_action", error)
      current.gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "open_conversation", "outcome": "failed"])
      return false
    }
    select(next)
    if next.saved.hasPendingRequest, next.error == nil { next.error = CoachCopy.interrupted }
    current.gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "open_conversation", "outcome": "ok"])
    return true
  }
  @discardableResult func removeLocal(_ id: String) -> Bool {
    guard let account = current.owner, current.allowed,
          !conversations.contains(where: { $0.saved.threadId == id && ($0.asking || $0.stopping || $0.saved.hasPendingRequest) }) else { return false }
    do {
      guard try current.store.archive(account).pending != id else { return false }
      try current.store.remove(id, account: account)
      if current.saved.threadId == id {
        let next = CoachConversation(gym: current.gym, rest: current.rest, store: current.store)
        next.owner = account; next.saved = current.saved.carried
        select(next)
      }
      conversations.removeAll { $0.saved.threadId == id }
      refreshHistory()
      current.gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "delete_conversation", "outcome": "ok"])
      return true
    } catch {
      historyError = "Your conversation couldn’t be deleted. Try again."
      current.gym.report("gym_action", error)
      current.gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "delete_conversation", "outcome": "failed"])
      return false
    }
  }
}
