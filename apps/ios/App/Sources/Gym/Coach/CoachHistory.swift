import SwiftUI
import Observation
import DomainKit

@Observable @MainActor final class CoachHistory {
  let gym: GymModel
  let rest: GymRESTClient
  @ObservationIgnored weak var coach: CoachConversation?
  var rows: [CoachThread] = []
  var nextCursor: String?
  var reading = false
  var loaded = false
  var error: String?
  var deletes: [String: String] = [:]
  var owner: String?
  var revision = 0
  init(gym: GymModel, rest: GymRESTClient? = nil) { self.gym = gym; self.rest = rest ?? gym.rest }
  func resetOwner() {
    let account = gym.coachAccountAvailable ? gym.account : nil
    if owner != account { rows = []; nextCursor = nil; loaded = false; reading = false; error = nil; owner = account; revision += 1 }
  }
  func load(earlier: Bool = false) async {
    resetOwner()
    guard gym.coachAccountAvailable, !gym.authPaused, !reading else { return }
    let owner = gym.account, revision = self.revision
    reading = true; error = nil
    defer { if self.owner == owner { reading = false } }
    do {
      let cursor = earlier ? nextCursor.map { "&cursor=" + CoachCopy.escaped($0) } ?? "" : ""
      let data = try await rest.coachRequest("/v1/gym/threads?limit=50\(cursor)", expectedAccount: owner)
      guard owner == gym.account, revision == self.revision, !gym.accountTransition else { return }
      let page = try JSONDecoder().decode(CoachThreadPage.self, from: data)
      var ids = Set<String>()
      rows = ((earlier ? rows : []) + page.threads).filter { row in deletes[row.id] != owner && ids.insert(row.id).inserted }
        .sorted { $0.askedAt == $1.askedAt ? $0.id > $1.id : $0.askedAt > $1.askedAt }
      nextCursor = page.nextCursor; loaded = true
    } catch {
      guard owner == gym.account, revision == self.revision, !(error is CancellationError) else { return }
      self.error = GymRESTClient.needsConnection(error) ? "Coach history needs a connection."
        : (error as? GymRESTFailure)?.message ?? "the log didn’t answer — your conversations are out of reach"
      if error is DecodingError { gym.report("gym_read", error) }
    }
  }
  func remove(_ row: CoachThread) async { await remove(row.id) }
  func remove(_ id: String) async {
    guard let account = gym.account, gym.coachAccountAvailable, deletes[id] == nil else { return }
    let row = rows.first { $0.id == id }
    revision += 1
    deletes[id] = account
    rows.removeAll { $0.id == id }
    error = nil
    let conversation = coach
    defer {
      deletes[id] = nil
      if owner == account { revision += 1 }
    }
    do {
      _ = try await rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(id))", method: "DELETE", expectedAccount: account)
    } catch let gone as GymRESTFailure where gone.status == 404 {
    } catch {
      if !(error is CancellationError || (error as? URLError)?.code == .cancelled) {
        gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "delete_conversation", "outcome": error is AppFailure || error is GymRESTFailure ? "refused" : "failed"])
      }
      guard gym.account == account else { return }
      rows.removeAll { $0.id == id }; if let row { rows.append(row) }; rows.sort { $0.askedAt > $1.askedAt }
      self.error = GymRESTClient.needsConnection(error) ? "Deleting a conversation needs a connection."
        : (error as? GymRESTFailure)?.message ?? "That conversation couldn’t be deleted. Try again."
      return
    }
    gym.telemetry.event("gym_action", properties: ["screen": "history", "action": "delete_conversation", "outcome": "ok"])
    let cleared = conversation?.deletedConversation(id, account: account) ?? true
    if gym.account == account, !cleared { error = "Your deleted conversation couldn’t be cleared. Try again." }
  }
}

struct CoachHistoryScreen: View {
  struct Row: Identifiable {
    let id: String
    let owner: String?
    let local: CoachArchive.Entry?
    let remote: CoachThread?
    var date: Int64 { max(local?.updatedAt ?? 0, remote?.askedAt ?? 0) }
  }
  let gym: GymModel
  let workspace: CoachWorkspace
  @State var history: CoachHistory
  @State var opening: String?
  @State var deletion: Row?
  @Environment(\.dismiss) var dismiss
  @Environment(\.coachOpenAccount) var openAccount

  var rows: [Row] {
    let local = Dictionary(uniqueKeysWithValues: workspace.entries.map { ($0.id, $0) })
    let accountRows = history.owner == gym.account && gym.coachAccountAvailable ? history.rows : []
    let remote = Dictionary(uniqueKeysWithValues: accountRows.map { ($0.id, $0) })
    return Set(local.keys).union(remote.keys).filter { history.deletes[$0] == nil }.map {
      Row(id: $0, owner: workspace.current.owner, local: local[$0], remote: remote[$0])
    }.sorted { $0.date == $1.date ? $0.id > $1.id : $0.date > $1.date }
  }
  var remoteError: String? { history.owner == gym.account && gym.coachAccountAvailable ? history.error : nil }
  var body: some View {
    Group {
      if !workspace.current.allowed {
        CoachUnavailable(symbol: "bubble.left.and.bubble.right", sentence: CoachCopy.signedOut, signIn: openAccount)
      } else if rows.isEmpty, history.owner == gym.account, history.reading {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if rows.isEmpty, remoteError == nil, workspace.historyError == nil {
        ContentUnavailableView("No conversations", systemImage: "bubble.left.and.bubble.right")
      } else { conversations }
    }.navigationTitle("History").modifier(GymPage()).accessibilityIdentifier("gym-coach-history")
      .gymTabBar()
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("New chat", systemImage: "square.and.pencil") { if workspace.fresh(door: "history") { dismiss() } }
            .disabled(!workspace.current.allowed || opening != nil).accessibilityIdentifier("coach-new-chat")
        }
      }
      .destructiveQuestion(gym, screen: "history", title: "Delete this conversation?", message: "You can’t undo this.", act: "Delete",
                           isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } })) {
        if let row = deletion, row.owner == workspace.current.owner, workspace.current.allowed {
          if row.remote != nil || row.local?.remote == true {
            history.coach = workspace.current
            Task {
              guard row.owner == workspace.current.owner, workspace.current.allowed else { return }
              await history.remove(row.id); workspace.refreshHistory()
            }
          } else { _ = workspace.removeLocal(row.id) }
        }
      }
      .task(id: workspace.current.seat) {
        workspace.refreshHistory(); history.resetOwner()
        if !gym.isAnonymous { await history.load() }
      }
      .reachBand {
        GymTransient(gym: gym, message: workspace.historyError ?? workspace.current.error ?? remoteError,
                     dismiss: nil, retryMessage: workspace.historyError != nil || remoteError != nil ? {
          workspace.refreshHistory(); if !gym.isAnonymous { Task { await history.load() } }
        } : nil, errorIdentifier: "gym-coach-error")
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "history"]) }
  }
  var conversations: some View {
    List {
      Section {
        ForEach(rows) { row in
          let pending = workspace.pending?.saved.threadId == row.id
          conversation(row)
            .trashSwipe("Delete conversation", enabled: !pending) { deletion = row }
            .contextMenu {
              if !pending { Button("Delete conversation", role: .destructive) { deletion = row } }
            }
        }
        if history.owner == gym.account, gym.coachAccountAvailable, history.nextCursor != nil {
          ProgressView().frame(maxWidth: .infinity).task { await history.load(earlier: true) }
        }
      }.listRowBackground(GymPalette.canvas).listSectionSeparator(.hidden)
    }.listStyle(.plain).scrollContentBackground(.hidden)
      .refreshable { workspace.refreshHistory(); if !gym.isAnonymous { await history.load() } }
  }
  func conversation(_ row: Row) -> some View {
    let proposals = gym.proposals.filter { $0.threadId == row.id }
    let waiting = proposals.filter { $0.state == "pending" }
    let outcome = row.remote?.outcomeLine(removal: proposals.contains { $0.intent == "remove" },
                                         outOfDate: !waiting.isEmpty && waiting.allSatisfy(gym.coachProposalOutOfDate))
    let active = workspace.conversations.first { $0.saved.threadId == row.id }
    let state = active?.asking == true || active?.stopping == true ? "Answering" : row.local?.state
    let meta = state == "Conversation" || state == nil ? outcome : state
    let day = row.date > 0 ? gym.dates.day(Instant(ms: row.date)) : nil
    return Button {
      opening = row.id
      Task {
        guard row.owner == workspace.current.owner, workspace.current.allowed else { opening = nil; return }
        let opened: Bool
        if row.remote != nil, workspace.pending?.saved.threadId != row.id { opened = await workspace.openRemote(row.id) }
        else if row.local != nil { opened = workspace.openLocal(row.id) }
        else { opened = await workspace.openRemote(row.id) }
        opening = nil
        if opened { dismiss() }
      }
    } label: {
      GymRow(title: row.remote?.headline ?? row.local?.headline ?? "Conversation", meta: meta,
             trailing: opening == row.id ? .progress : day.map { .fact($0, door: true) } ?? .door,
             lineLimit: 1).contentShape(Rectangle())
    }.disabled(opening != nil || !workspace.current.allowed)
  }
}
