import SwiftUI
import UIKit
import GymDomain
import DomainKit
import SyncCore

struct GymRoom: View {
  enum Tab: Hashable { case routines, log, coach }
  enum Destination: Hashable { case routine(String), session(String), settings }
  @Bindable var gym: GymModel
  @Bindable var app: AppModel
  @State var tab = Tab.routines
  @State var routinesPath = NavigationPath()
  @State var logPath = NavigationPath()
  @State var coachPath = NavigationPath()
  @State var proposal: ProposalReviewID?
  @State var coachHandoff: CoachHandoff?
  @State var finishedHandoff: WorkoutHandoff?

  var body: some View {
    TabView(selection: $tab) {
      NavigationStack(path: $routinesPath) {
        RoutinesTab(gym: gym, onAccount: openAccount,
                    onWrittenProgram: { if gym.isAnonymous || gym.authPaused { openAccount() } else { ask("Help me turn my written program into a routine.") } },
                    onReviewProposal: { proposal = ProposalReviewID(id: $0.description) })
          .toolbar { roomToolbar }
          .navigationDestination(for: Destination.self, destination: destination)
      }.tabItem { Label("Routines", systemImage: "list.bullet.rectangle") }.tag(Tab.routines)
      NavigationStack(path: $logPath) {
        LogTab(gym: gym).toolbar { roomToolbar }
          .navigationDestination(for: Destination.self, destination: destination)
      }.tabItem { Label("The log", systemImage: "clock") }.tag(Tab.log)
      NavigationStack(path: $coachPath) {
        CoachTab(gym: gym, handoff: $coachHandoff).toolbar { roomToolbar }
          .navigationDestination(for: Destination.self, destination: destination)
      }.tabItem { Label("Coach", systemImage: "bubble.left.and.bubble.right") }.tag(Tab.coach)
    }
    .accessibilityIdentifier("gym-room")
    .safeAreaInset(edge: .top, spacing: 0) { if !gym.workout.isPresented { WorkoutAdoptionBand(gym: gym) } }
    .tint(CoachPalette.accent)
    .environment(\.coachOpenAccount, openAccount)
    .environment(\.coachOpenRoutine, { id in tab = .routines; routinesPath.append(Destination.routine(id)) })
    .environment(\.coachOpenSession, { id in tab = .log; logPath.append(Destination.session(id)) })
    .sheet(item: $proposal) { proposal in
      ProposalReviewSheet(gym: gym, proposalId: proposal.id) { name in
        self.proposal = nil
        ask("Tell me about the proposal for \(name).")
      }
    }
    .fullScreenCover(isPresented: Binding(get: { gym.workout.isPresented }, set: { if !$0 { gym.hideWorkout() } }), onDismiss: receiveWorkout) {
      WorkoutScreen(gym: gym).interactiveDismissDisabled()
    }
    .onChange(of: gym.workout.handoff) { _, handoff in
      guard let handoff else { return }
      finishedHandoff = handoff
    }
    .onChange(of: gym.openSession?.id) { _, id in
      if id != nil { routinesPath = NavigationPath(); logPath = NavigationPath(); coachPath = NavigationPath() }
    }
    .onChange(of: app.gymSettingsRequested, initial: true) { _, requested in
      if requested { app.gymSettingsRequested = false; routinesPath.append(Destination.settings); tab = .routines }
    }
    .onChange(of: gym.error) { _, error in
      if let error, !gym.workout.isPresented, app.sheet == nil {
        UIAccessibility.post(notification: .announcement, argument: error)
      }
    }
    .onChange(of: "\(gym.account ?? ""):\(gym.isAnonymous):\(gym.authPaused):\(gym.accountTransition):\(gym.coachUnavailable)", initial: true) { _, _ in
      gym.workout.coachAvailable = gym.account != nil && !gym.isAnonymous && !gym.authPaused && !gym.accountTransition && !gym.coachUnavailable
    }
  }

  @ToolbarContentBuilder var roomToolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) { RoomSeat(app: app) }
    ToolbarItem(placement: .topBarTrailing) { AccountButton(app: app) }
  }
  @ViewBuilder func destination(_ destination: Destination) -> some View {
    switch destination {
    case .routine(let id): RoutineDetail(gym: gym, id: ID(RecordID(id))).toolbar(.hidden, for: .tabBar)
    case .session(let id): SessionDetailScreen(gym: gym, sessionID: ID(RecordID(id))).toolbar(.hidden, for: .tabBar)
    case .settings: GymSettingsScreen(gym: gym).toolbar(.hidden, for: .tabBar)
    }
  }
  func openAccount() { app.journal.done(); app.sheet = .you }
  func ask(_ question: String, send: Bool = false) {
    coachPath = NavigationPath(); tab = .coach
    coachHandoff = CoachHandoff(question: question, send: send)
  }
  func receiveWorkout() {
    guard let handoff = gym.workout.handoff ?? finishedHandoff else { return }
    finishedHandoff = nil; gym.workout.handoff = nil
    switch handoff {
    case .detail(let id): if let id { tab = .log; logPath.append(Destination.session(id.description)) }
    case .keep: app.keep()
    case .coach: ask(WorkoutHandoff.coachQuestion, send: true)
    case .writtenProgram: if gym.isAnonymous || gym.authPaused { openAccount() } else { ask("Help me turn my written program into a routine.") }
    }
  }
}
