import SwiftUI
import Observation

@Observable @MainActor final class CoachHistory {
  struct Held: Identifiable {
    let row: CoachThread
    let account: String
    let until: Date
    let task: Task<Void, Never>
    var id: String { row.id }
  }
  let gym: GymModel
  let rest: GymRESTClient
  @ObservationIgnored weak var coach: CoachConversation?
  var rows: [CoachThread] = []
  var nextCursor: String?
  var reading = false
  var loaded = false
  var error: String?
  var held: [Held] = []
  var owner: String?
  init(gym: GymModel, rest: GymRESTClient? = nil) { self.gym = gym; self.rest = rest ?? gym.rest }
  func resetOwner() {
    let account = gym.coachAccountAvailable ? gym.account : nil
    if owner != account { abandon(); rows = []; nextCursor = nil; loaded = false; reading = false; error = nil; owner = account }
  }
  func load(earlier: Bool = false) async {
    resetOwner()
    guard gym.coachAccountAvailable, !gym.authPaused, !reading else { return }
    let owner = gym.account
    reading = true; error = nil
    defer { if self.owner == owner { reading = false } }
    do {
      let cursor = earlier ? nextCursor.map { "&cursor=" + CoachCopy.escaped($0) } ?? "" : ""
      let data = try await rest.coachRequest("/v1/gym/threads?limit=50\(cursor)", expectedAccount: owner)
      guard owner == gym.account, !gym.accountTransition else { return }
      let page = try JSONDecoder().decode(CoachThreadPage.self, from: data)
      var ids = Set<String>()
      rows = ((earlier ? rows : []) + page.threads).filter { row in !held.contains { $0.id == row.id } && ids.insert(row.id).inserted }
        .sorted { $0.askedAt == $1.askedAt ? $0.id > $1.id : $0.askedAt > $1.askedAt }
      nextCursor = page.nextCursor; loaded = true
    } catch {
      guard owner == gym.account, !(error is CancellationError) else { return }
      self.error = GymRESTClient.needsConnection(error) ? "Coach history needs a connection."
        : (error as? GymRESTFailure)?.message ?? "the log didn’t answer — your conversations are out of reach"
      if error is DecodingError { gym.report("gym_read", error) }
    }
  }
  func remove(_ row: CoachThread) {
    guard let account = gym.account, gym.coachAccountAvailable, !held.contains(where: { $0.id == row.id }) else { return }
    let conversation = coach
    rows.removeAll { $0.id == row.id }
    let task = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(9)) } catch { return }
      guard let self, self.gym.account == account, !self.gym.accountTransition,
            self.held.contains(where: { $0.id == row.id }) else { return }
      self.held.removeAll { $0.id == row.id }
      do {
        _ = try await self.rest.coachRequest("/v1/gym/threads/\(CoachCopy.escaped(row.id))", method: "DELETE", expectedAccount: account)
        self.gym.telemetry.event("gym_action", properties: ["screen": "history", "outcome": "ok"])
        let cleared = conversation?.deletedConversation(row.id, account: account) ?? true
        if self.gym.account == account, !cleared { self.error = "Your deleted conversation couldn’t be cleared. Try again." }
      } catch {
        if (error as? GymRESTFailure)?.status == 404 {
          self.gym.telemetry.event("gym_action", properties: ["screen": "history", "outcome": "ok"])
          let cleared = conversation?.deletedConversation(row.id, account: account) ?? true
          if self.gym.account == account, !cleared { self.error = "Your deleted conversation couldn’t be cleared. Try again." }
          return
        }
        if !(error is CancellationError || (error as? URLError)?.code == .cancelled) {
          self.gym.telemetry.event("gym_action", properties: ["screen": "history", "outcome": error is AppFailure || error is GymRESTFailure ? "refused" : "failed"])
        }
        guard self.gym.account == account else { return }
        self.rows.removeAll { $0.id == row.id }; self.rows.append(row); self.rows.sort { $0.askedAt > $1.askedAt }
        self.error = GymRESTClient.needsConnection(error) ? "Deleting a conversation needs a connection."
          : (error as? GymRESTFailure)?.message ?? "That conversation couldn’t be deleted. Try again."
      }
    }
    held.append(Held(row: row, account: account, until: Date().addingTimeInterval(9), task: task))
  }
  func undo(_ id: String) {
    guard let offer = held.first(where: { $0.id == id }), offer.until > Date() else {
      error = "That change has already been kept."
      gym.telemetry.event("gym_undo", properties: ["screen": "history", "outcome": "refused"]); return
    }
    gym.telemetry.event("gym_undo", properties: ["screen": "history", "outcome": "ok"])
    offer.task.cancel(); held.removeAll { $0.id == id }
    if offer.account == gym.account { rows.append(offer.row); rows.sort { $0.askedAt > $1.askedAt } }
  }
  func abandon() {
    for offer in held {
      offer.task.cancel()
      if offer.account == gym.account { rows.append(offer.row) }
    }
    held = []; rows.sort { $0.askedAt > $1.askedAt }
  }
}

struct CoachHistoryScreen: View {
  let gym: GymModel
  let coach: CoachConversation
  @State var history: CoachHistory
  @State var opening: String?
  @Environment(\.dismiss) var dismiss
  @Environment(\.scenePhase) var phase
  @Environment(\.coachOpenAccount) var openAccount
  init(gym: GymModel, coach: CoachConversation, history: CoachHistory) {
    self.gym = gym; self.coach = coach; history.coach = coach; _history = State(initialValue: history)
  }
  var body: some View {
    Group {
      if !gym.coachAccountAvailable { CoachUnavailable(sentence: CoachCopy.signedOut, signIn: openAccount) }
      else if history.owner != gym.account || (history.reading && !history.loaded) { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
      else if history.loaded, history.rows.isEmpty, history.held.isEmpty, history.error == nil {
        ContentUnavailableView("No conversations yet", systemImage: "bubble.left.and.bubble.right",
                               description: Text("Every conversation you have with Coach is kept until you delete it."))
      } else { conversations }
    }.navigationTitle("History").modifier(GymPage()).accessibilityIdentifier("gym-coach-history")
      .toolbar(.hidden, for: .tabBar)
      .task(id: gym.account) { await history.load() }
      .reachBand {
        GymTransient(gym: gym, message: coach.error ?? history.error,
                     dismiss: coach.error == nil ? nil : { coach.error = nil },
                     retryMessage: coach.error == nil && history.error != nil ? { Task { await history.load() } } : nil,
                     held: history.held.last.map { offer in
                       .init(text: "Deleting a conversation keeps applied routine changes, created routines and saved notes.") { history.undo(offer.id) }
                     },
                     errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo")
      }
      .onChange(of: phase) { _, phase in if phase == .background { history.abandon() } }
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
            let meta = [row.outcome?.line, row.askedAt > 0 ? CoachCopy.day(row.askedAt) : nil].compactMap { $0 }
            GymRow(title: row.title.isEmpty ? "Conversation" : row.title, meta: meta.isEmpty ? nil : meta.joined(separator: " · "),
                   trailing: opening == row.id ? .progress : nil, lineLimit: 2)
          }.disabled(opening != nil || coach.asking)
            .swipeActions { Button("Delete", role: .destructive) { history.remove(row) } }
            .contextMenu { Button("Delete conversation", role: .destructive) { history.remove(row) } }
        }
        if history.nextCursor != nil {
          ProgressView().frame(maxWidth: .infinity).task { await history.load(earlier: true) }
        }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped)
      .refreshable { await history.load() }
  }
}
