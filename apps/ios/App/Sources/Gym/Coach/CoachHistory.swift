import SwiftUI
import DomainKit
import GymDomain

// History: every conversation the engine holds, newest first, beside the drafts this phone keeps; each row the first
// question over what the conversation came to, trailing the day it was last asked.
struct CoachHistoryScreen: View {
  struct Row: Identifiable {
    let id: String
    let title: String
    let meta: String?
    let date: Int64
    let answering: Bool
  }
  let gym: GymModel
  let coach: CoachConversation
  @State var deletion: Row?
  @Environment(\.dismiss) var dismiss

  var rows: [Row] {
    let local = (try? coach.owner.map { try coach.store.archive($0).entries } ?? []) ?? []
    let messages = Dictionary(grouping: coach.allMessages, by: \.threadId)
    var rows: [Row] = coach.threads.map { thread in
      let said = (messages[thread.id] ?? []).inOrder
      let draft = local.first { $0.id == thread.id.description }
      let date = max(said.last?.at.ms ?? 0, draft?.updatedAt ?? 0)
      return Row(id: thread.id.description, title: thread.title, meta: meta(of: said, draft: draft), date: date, answering: said.last?.state == .running)
    }
    let known = Set(rows.map(\.id))
    rows += local.filter { !known.contains($0.id) }.map { Row(id: $0.id, title: $0.headline, meta: $0.state, date: $0.updatedAt, answering: false) }
    return rows.sorted { $0.date == $1.date ? $0.id > $1.id : $0.date > $1.date }
  }
  // The row's second line: an answer under way, a draft waiting, how the conversation's latest turn ended, or what it came
  // to — the routine and what was proposed for it with the card's word, or the routines it created.
  func meta(of messages: [CoachMessage], draft: CoachArchive.Entry?) -> String? {
    guard let answer = messages.last(where: { $0.role == .coach }) else { return draft?.state }
    switch answer.state {
    case .running: return "Answering"
    case .interrupted, .failed: return "Interrupted"
    case .stopped: return "Stopped"
    case .declined, .completed: break
    }
    if let draft, draft.state == "Draft" { return "Draft" }
    let writes = CoachWrites(calls: messages.filter { $0.role == .coach }.flatMap(\.calls), gym: gym)
    if let id = writes.proposals.last, let proposal = gym.proposals.first(where: { $0.id.description == id }) {
      let removal = proposal.intent == "remove"
      let settled = gym.coachProposalOutOfDate(proposal) && proposal.state == "pending" ? CoachCopy.outOfDate : CoachCopy.settled(proposal.state, removal: removal)
      let title = CoachCopy.proposalTitle(routine: proposal.baseName ?? gym.coachRoutine(proposal)?.name, changes: gym.coachChangeCount(proposal), removal: removal)
      return ([title] + [settled].compactMap { $0 }).joined(separator: " · ")
    }
    if !writes.routines.isEmpty { return "Created " + GymCount.of(writes.routines.count, "routine") }
    return nil
  }
  var body: some View {
    let rows = rows
    Group {
      if !coach.allowed {
        CoachUnavailable(symbol: "bubble.left.and.bubble.right", sentence: CoachCopy.accountChanging)
      } else if rows.isEmpty {
        CoachUnavailable(symbol: "bubble.left.and.bubble.right", sentence: "No conversations yet.\nWhat you ask Coach on this phone is listed here.")
      } else { conversations(rows) }
    }.navigationTitle("History").modifier(GymPage()).accessibilityIdentifier("gym-coach-history")
      .gymTabBar()
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New chat", systemImage: "square.and.pencil") { if coach.fresh(door: "history") { dismiss() } }
            .disabled(!coach.allowed).accessibilityIdentifier("coach-new-chat")
        }
      }
      .destructiveQuestion(gym, screen: "history", title: "Delete this conversation?", message: "You can’t undo this.", act: "Delete",
                           isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } })) {
        if let row = deletion, coach.allowed { _ = coach.delete(row.id) }
      }
      .reachBand { GymTransient(gym: gym, message: coach.error, dismiss: { coach.error = nil }, errorIdentifier: "gym-coach-error") }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "history"]) }
  }
  func conversations(_ rows: [Row]) -> some View {
    List {
      Section {
        ForEach(rows) { row in
          conversation(row)
            .trashSwipe("Delete conversation", enabled: !row.answering) { deletion = row }
            .contextMenu {
              if !row.answering { Button("Delete conversation", role: .destructive) { deletion = row } }
            }
        }
      }.listRowBackground(GymPalette.canvas).listSectionSeparator(.hidden)
    }.listStyle(.plain).scrollContentBackground(.hidden)
  }
  func conversation(_ row: Row) -> some View {
    let day = row.date > 0 ? gym.dates.day(Instant(ms: row.date)) : nil
    return Button {
      if coach.open(row.id) { dismiss() }
    } label: {
      GymRow(title: row.title.isEmpty ? "Conversation" : row.title, meta: row.meta, trailing: day.map { .fact($0, door: true) } ?? .door, lineLimit: 1)
        .contentShape(Rectangle())
    }.disabled(!coach.allowed)
  }
}
