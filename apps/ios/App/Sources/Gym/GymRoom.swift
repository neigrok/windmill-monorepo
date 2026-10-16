import SwiftUI
import UIKit
import GymDomain
import DomainKit
import SyncCore

struct GymRoom: View {
  enum Tab: Hashable { case routines, log, coach }
  enum Destination: Hashable { case routine(String), session(String) }
  @Bindable var gym: GymModel
  @Bindable var app: AppModel
  @State var tab = Tab.routines
  @State var routinesPath = NavigationPath()
  @State var logPath = NavigationPath()
  @State var coachPath = NavigationPath()
  @State var proposal: ProposalReviewID?
  @State var coachHandoff: CoachHandoff?
  @State var finishedHandoff: WorkoutHandoff?
  @State var share: SessionShareID?
  @State var shareAfterSignIn: ID<Session>?
  @State var risingFromAccessory = false
  static let accessoryZoom = "hidden-workout"
  @Namespace var zoom
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  var tabs: some View {
    TabView(selection: $tab) {
      SwiftUI.Tab("Routines", systemImage: "list.bullet.rectangle", value: Tab.routines) {
        NavigationStack(path: $routinesPath) {
          root(RoutinesTab(gym: gym, onReviewProposal: { proposal = ProposalReviewID(id: $0.description) }))
        }.roomBar(.gym)
      }
      SwiftUI.Tab("The log", systemImage: "calendar", value: Tab.log) {
        NavigationStack(path: $logPath) { root(LogTab(gym: gym)) }.roomBar(.gym)
      }.badge(gym.isAnonymous ? 0 : gym.workoutsToReview.count)
      SwiftUI.Tab("Coach", systemImage: "bubble.left.and.bubble.right", value: Tab.coach) {
        NavigationStack(path: $coachPath) { root(CoachTab(gym: gym, handoff: $coachHandoff)) }.roomBar(.gym)
      }
    }.tint(GymPalette.accent).accessibilityHidden(gym.workout.isPresented)
  }

  // The stacks' back chevrons and the room menu take the label colour; each screen's page keeps the accent.
  func root(_ screen: some View) -> some View {
    screen.toolbar { roomToolbar }.roomBar(.gym).navigationDestination(for: Destination.self, destination: destination)
  }

  var body: some View {
    Group {
      if #available(iOS 26.1, *) {
        tabs.tabBarMinimizeBehavior(.onScrollDown).tabViewBottomAccessory(isEnabled: hiddenWorkout != nil) { accessory }
      } else if #available(iOS 26, *) {
        if hiddenWorkout != nil { tabs.tabBarMinimizeBehavior(.onScrollDown).tabViewBottomAccessory { accessory } }
        else { tabs.tabBarMinimizeBehavior(.onScrollDown) }
      } else { tabs }
    }
    .environment(\.coachOpenAccount, app.openYou)
    .environment(\.coachOpenRoutine, { id in tab = .routines; routinesPath.append(Destination.routine(id)) })
    .environment(\.coachOpenSession, { id in tab = .log; logPath.append(Destination.session(id)) })
    .environment(\.coachAsk, { handoff in ask(handoff.question, send: handoff.send) })
    .environment(\.gymShareSession, { id in share = SessionShareID(id: id) })
    .sheet(item: $proposal) { proposal in
      ProposalReviewSheet(gym: gym, proposalId: proposal.id) { name in
        self.proposal = nil
        ask("Tell me about the proposal for \(name).")
      }
    }
    // Sign in to share closes the sheet into You; when You closes signed in the share returns, and otherwise nothing is
    // shared (docs/design/guidelines/superapp-flow.md §5).
    .sheet(item: $share, onDismiss: { if shareAfterSignIn != nil { app.openYou() } }) { request in
      SessionShareSheet(gym: gym, sessionID: request.id) { shareAfterSignIn = request.id }
    }
    .onChange(of: app.sheet) { closed, sheet in
      guard sheet == nil, closed != nil, let pending = shareAfterSignIn else { return }
      shareAfterSignIn = nil
      if !gym.sharingNeedsSignIn { share = SessionShareID(id: pending) }
    }
    // Only a cover closed under a workout still on screen hides it; a close the workout already made records nothing.
    .fullScreenCover(isPresented: Binding(get: { gym.workout.isPresented }, set: { if !$0, gym.workout.isPresented { gym.hideWorkout() } }), onDismiss: receiveWorkout) {
      if risingFromAccessory {
        WorkoutScreen(gym: gym).interactiveDismissDisabled().navigationTransition(.zoom(sourceID: GymRoom.accessoryZoom, in: zoom))
      } else { WorkoutScreen(gym: gym).interactiveDismissDisabled() }
    }
    .onChange(of: gym.workout.handoff) { _, handoff in
      guard let handoff else { return }
      finishedHandoff = handoff
    }
    .onChange(of: gym.openSession?.id) { _, id in
      if id != nil { routinesPath = NavigationPath(); logPath = NavigationPath(); coachPath = NavigationPath() }
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

  // The open workout while the lifter has it hidden; an account changing takes it away.
  var hiddenWorkout: Session? { gym.workoutHidden && !gym.accountTransition ? gym.openSession : nil }

  // The logger rises from the accessory, with the cover's own transition under Reduce Motion.
  @available(iOS 26, *)
  @ViewBuilder var accessory: some View {
    if let hiddenWorkout {
      HiddenWorkoutAccessory(gym: gym, session: hiddenWorkout) {
        risingFromAccessory = !reduceMotion
        if !gym.openHiddenWorkout(from: .accessory) { risingFromAccessory = false }
      }.matchedTransitionSource(id: GymRoom.accessoryZoom, in: zoom)
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
      }
    }.toolbar(.hidden, for: .tabBar)
  }
  func ask(_ question: String, send: Bool = false) {
    coachPath = NavigationPath(); tab = .coach
    coachHandoff = CoachHandoff(question: question, send: send)
  }
  func receiveWorkout() {
    risingFromAccessory = false
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

// A hidden workout in the tab bar's accessory (ios-redesign §7.18): its name and clock, the clock alone beside a minimized bar.
@available(iOS 26, *)
struct HiddenWorkoutAccessory: View {
  let gym: GymModel
  let session: Session
  let open: () -> Void
  @Environment(\.tabViewBottomAccessoryPlacement) var placement

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { _ in
      let now = (try? gym.runner.moment().now) ?? Instant(Date.now)
      let clock = WorkoutClocks.reading(WorkoutClocks(session: session, sets: gym.sets, now: now).workoutMs)
      let name = session.name ?? Readout.noRoutine
      Button(action: open) {
        HStack(spacing: RoomSpace.related) {
          Image(systemName: "dumbbell.fill").foregroundStyle(GymPalette.accent)
          if placement == .inline {
            Text(clock).monospacedDigit().foregroundStyle(GymPalette.inkDim)
          } else {
            HStack(spacing: 0) {
              Text(name).fontWeight(.semibold).foregroundStyle(GymPalette.ink).lineLimit(1).truncationMode(.tail)
              Text(" · \(clock)").monospacedDigit().foregroundStyle(GymPalette.inkDim).fixedSize()
            }
          }
        }.font(.subheadline).padding(.horizontal, RoomSpace.inset).frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
      }.buttonStyle(.plain)
        .accessibilityLabel("\(name), in progress").accessibilityValue(clock)
        .accessibilityIdentifier("gym-hidden-workout")
    }
  }
}
