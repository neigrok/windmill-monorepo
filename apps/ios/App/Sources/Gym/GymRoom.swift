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

  var tabs: some View {
    TabView(selection: $tab) {
      SwiftUI.Tab("Routines", systemImage: "list.bullet.rectangle", value: Tab.routines) {
        NavigationStack(path: $routinesPath) {
          root(RoutinesTab(gym: gym, onAccount: app.openYou,
                           onWrittenProgram: { if gym.isAnonymous || gym.authPaused { app.openYou() } else { ask("Help me turn my written program into a routine.") } },
                           onReviewProposal: { proposal = ProposalReviewID(id: $0.description) }))
        }
      }
      SwiftUI.Tab("The log", systemImage: "calendar", value: Tab.log) {
        NavigationStack(path: $logPath) { root(LogTab(gym: gym)) }
      }
      SwiftUI.Tab("Coach", systemImage: "bubble.left.and.bubble.right", value: Tab.coach) {
        NavigationStack(path: $coachPath) { root(CoachTab(gym: gym, handoff: $coachHandoff)) }
      }
    }.accessibilityHidden(gym.workout.isPresented)
  }

  func root(_ screen: some View) -> some View {
    screen.toolbar { roomToolbar }.navigationDestination(for: Destination.self, destination: destination)
  }

  var body: some View {
    Group {
      if #available(iOS 26, *) { tabs.tabBarMinimizeBehavior(.onScrollDown) }
      else { tabs }
    }
    .environment(\.coachOpenAccount, app.openYou)
    .environment(\.coachOpenRoutine, { id in tab = .routines; routinesPath.append(Destination.routine(id)) })
    .environment(\.coachOpenSession, { id in tab = .log; logPath.append(Destination.session(id)) })
    .accessibilityIdentifier("gym-room")
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
    ToolbarItem(placement: .topBarLeading) { RoomMenu(app: app) }
  }
  func destination(_ destination: Destination) -> some View {
    Group {
      switch destination {
      case .routine(let id): RoutineDetail(gym: gym, id: ID(RecordID(id)))
      case .session(let id): SessionDetailScreen(gym: gym, sessionID: ID(RecordID(id)))
      case .settings: GymSettingsScreen(gym: gym)
      }
    }.toolbar(.hidden, for: .tabBar)
  }
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
    case .writtenProgram: if gym.isAnonymous || gym.authPaused { app.openYou() } else { ask("Help me turn my written program into a routine.") }
    }
  }
}
