import SwiftUI
import Observation

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
  func remove(_ row: CoachThread) async {
    guard let account = gym.account, gym.coachAccountAvailable, deletes[row.id] == nil else { return }
    revision += 1
    deletes[row.id] = account
    rows.removeAll { $0.id == row.id }
    error = nil
    let conversation = coach
    defer {
      deletes[row.id] = nil
      if owner == account { revision += 1 }
    }
    do {
      _ = try await rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(row.id))", method: "DELETE", expectedAccount: account)
    } catch let gone as GymRESTFailure where gone.status == 404 {
    } catch {
      if !(error is CancellationError || (error as? URLError)?.code == .cancelled) {
        gym.telemetry.event("gym_action", properties: ["screen": "history", "outcome": error is AppFailure || error is GymRESTFailure ? "refused" : "failed"])
      }
      guard gym.account == account else { return }
      rows.removeAll { $0.id == row.id }; rows.append(row); rows.sort { $0.askedAt > $1.askedAt }
      self.error = GymRESTClient.needsConnection(error) ? "Deleting a conversation needs a connection."
        : (error as? GymRESTFailure)?.message ?? "That conversation couldn’t be deleted. Try again."
      return
    }
    gym.telemetry.event("gym_action", properties: ["screen": "history", "outcome": "ok"])
    let cleared = conversation?.deletedConversation(row.id, account: account) ?? true
    if gym.account == account, !cleared { error = "Your deleted conversation couldn’t be cleared. Try again." }
  }
}

struct CoachHistoryScreen: View {
  let gym: GymModel
  let coach: CoachConversation
  @State var history: CoachHistory
  @State var opening: String?
  @State var deletion: CoachThread?
  @Environment(\.dismiss) var dismiss
  @Environment(\.coachOpenAccount) var openAccount
  init(gym: GymModel, coach: CoachConversation, history: CoachHistory) {
    self.gym = gym; self.coach = coach; history.coach = coach; _history = State(initialValue: history)
  }
  var body: some View {
    Group {
      if !gym.coachAccountAvailable { CoachUnavailable(symbol: "bubble.left.and.bubble.right", sentence: CoachCopy.signedOut, signIn: openAccount) }
      else if history.owner != gym.account || (history.reading && !history.loaded) { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
      else if history.loaded, history.rows.isEmpty, history.error == nil {
        ContentUnavailableView("No conversations", systemImage: "bubble.left.and.bubble.right")
      } else { conversations }
    }.navigationTitle("History").modifier(GymPage()).accessibilityIdentifier("gym-coach-history")
      .gymTabBar()
      .toolbar {
        if gym.coachAccountAvailable {
          ToolbarItem(placement: .topBarTrailing) {
            Button("New chat", systemImage: "square.and.pencil") { if coach.newChat() { dismiss() } }
              .disabled(coach.asking).accessibilityIdentifier("coach-new-chat")
          }
        }
      }
      .destructiveQuestion(gym, screen: "history", title: "Delete this conversation?", message: "You can’t undo this.", act: "Delete",
                           isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } })) {
        if let row = deletion { Task { await history.remove(row) } }
      }
      .task(id: gym.account) { await history.load() }
      .reachBand {
        GymTransient(gym: gym, message: coach.error ?? history.error,
                     dismiss: coach.error == nil ? nil : { coach.error = nil },
                     retryMessage: coach.error == nil && history.error != nil ? { Task { await history.load() } } : nil,
                     errorIdentifier: "gym-coach-error")
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "history"]) }
  }
  var conversations: some View {
    List {
      Section {
        ForEach(history.rows) { row in
          Button {
            opening = row.id
            Task {
              await coach.open(row.id); opening = nil
              if coach.saved.threadId == row.id, coach.saved.thread != nil { dismiss() }
            }
          } label: {
            let proposals = gym.proposals.filter { $0.threadId == row.id }
            let removal = proposals.contains { $0.intent == "remove" }
            let waiting = proposals.filter { $0.state == "pending" }
            GymRow(title: row.headline,
                   meta: row.outcomeLine(removal: removal, outOfDate: !waiting.isEmpty && waiting.allSatisfy(gym.coachProposalOutOfDate)),
                   trailing: opening == row.id ? .progress : row.askedDay(gym.dates).map { .fact($0, door: true) } ?? .door,
                   lineLimit: 1).contentShape(Rectangle())
          }.disabled(opening != nil || coach.asking)
            .trashSwipe("Delete conversation") { deletion = row }
            .contextMenu { Button("Delete conversation", role: .destructive) { deletion = row } }
        }
        if history.nextCursor != nil {
          ProgressView().frame(maxWidth: .infinity).task { await history.load(earlier: true) }
        }
      }.listRowBackground(GymPalette.canvas).listSectionSeparator(.hidden)
    }.listStyle(.plain).scrollContentBackground(.hidden)
      .refreshable { await history.load() }
  }
}
