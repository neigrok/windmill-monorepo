import SwiftUI
import UIKit
import GymDomain
import DomainKit
import SyncCore

struct GymRoom: View {
  enum Tab: Hashable { case routines, log, coach }
  enum Destination: Hashable { case session(String) }
  @Bindable var gym: GymModel
  @Bindable var app: AppModel
  @State var coach: CoachConversation
  @State var setupNavigationChosen = false
  @State var routineAwaitingSync = false
  @State var setupChecked: String?
  @State var setupBuilder: RoutineEditingSession?
  @State var tab = Tab.routines
  @State var routinesPath = NavigationPath()
  @State var logPath = NavigationPath()
  @State var coachPath = NavigationPath()
  @State var proposal: CoachProposalID?
  @State var coachHandoff: CoachHandoff?
  @State var revealedProposal: String?
  @State var finishedHandoff: WorkoutHandoff?
  @State var share: SessionShareID?
  @State var shareAfterSignIn: ID<Session>?
  @State var coachAfterSignIn = false
  @State var routine: ID<Routine>?
  @State var startRoutine: ID<Routine>?
  @State var risingFromAccessory = false
  @State var hiddenTabBars: Set<Tab> = []
  static let accessoryZoom = "hidden-workout"
  @Namespace var zoom
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  init(gym: GymModel, app: AppModel) {
    self.gym = gym; self.app = app
    _coach = State(initialValue: CoachConversation(gym: gym, rest: CoachFixture.rest(gym)))
  }

  var tabs: some View {
    TabView(selection: $tab) {
      SwiftUI.Tab("Routines", systemImage: "list.bullet.rectangle", value: Tab.routines) {
        NavigationStack(path: $routinesPath) {
          root(RoutinesTab(gym: gym, onReviewProposal: reviewProposal))
        }.roomBar(.gym).onPreferenceChange(TabBarHidden.self) { tabBar(.routines, hidden: $0) }
      }
      SwiftUI.Tab("The log", systemImage: "calendar", value: Tab.log) {
        NavigationStack(path: $logPath) { root(LogTab(gym: gym)) }.roomBar(.gym).onPreferenceChange(TabBarHidden.self) { tabBar(.log, hidden: $0) }
      }.badge(gym.isAnonymous ? 0 : gym.workoutsToReview.count)
      SwiftUI.Tab("Coach", systemImage: "bubble.left.and.bubble.right", value: Tab.coach) {
        NavigationStack(path: $coachPath) { root(CoachTab(gym: gym, handoff: $coachHandoff, revealedProposal: $revealedProposal, coach: coach, escapeSetup: escapeSetup)) }.roomBar(.gym)
          .onPreferenceChange(TabBarHidden.self) { tabBar(.coach, hidden: $0) }
      }
    }.tint(GymPalette.accent).accessibilityHidden(gym.workout.isPresented)
  }

  // The stacks' back chevrons and the room menu take the label colour; each screen's page keeps the accent. Each root holds
  // its list's end clear of the tab bar across a pop and a bounce that brings the bar back.
  func root(_ screen: some View) -> some View {
    screen.modifier(HeldFoot()).toolbar { roomToolbar }.roomBar(.gym).navigationDestination(for: Destination.self, destination: destination)
  }

  var body: some View {
    Group {
      if #available(iOS 26.1, *) {
        tabs.tabBarMinimizeBehavior(.onScrollDown).tabViewBottomAccessory(isEnabled: accessoryStands) { accessory }
      } else if #available(iOS 26, *) {
        if accessoryStands { tabs.tabBarMinimizeBehavior(.onScrollDown).tabViewBottomAccessory { accessory } }
        else { tabs.tabBarMinimizeBehavior(.onScrollDown) }
      } else { tabs }
    }
    .environment(\.coachOpenAccount, app.openYou)
    .environment(\.coachKeepRoutines, { app.keep(routines: true) })
    .environment(\.coachOpenRoutine, { id in routineAwaitingSync = !gym.isAnonymous; routine = ID(RecordID(id)) })
    .environment(\.coachOpenSession, { id in tab = .log; logPath.append(Destination.session(id)) })
    .environment(\.gymShareSession, { id in share = SessionShareID(id: id) })
    .sheet(isPresented: Binding(get: { routine != nil }, set: { if !$0 { routine = nil } }), onDismiss: {
      if let id = startRoutine { startRoutine = nil; gym.startWorkout(routineId: id) }
    }) {
      if let routine { RoutineSummarySheet(gym: gym, id: routine, awaitSync: routineAwaitingSync) { startRoutine = routine; self.routine = nil } }
    }
    .sheet(item: $setupBuilder) { editing in RoutineBuilder(gym: gym, editing: editing) { routine = $0 } }
    .sheet(item: $proposal) { proposal in ProposalSheet(gym: gym, id: proposal.id) }
    // Sign in to share closes the sheet into You; when You closes signed in the share returns, and otherwise nothing is
    // shared.
    .sheet(item: $share, onDismiss: { if shareAfterSignIn != nil { app.openYou() } }) { request in
      SessionShareSheet(gym: gym, sessionID: request.id) { shareAfterSignIn = request.id }
    }
    .onChange(of: app.sheet) { closed, sheet in
      guard sheet == nil, closed != nil else { return }
      if let pending = shareAfterSignIn {
        shareAfterSignIn = nil
        if !gym.sharingNeedsSignIn { share = SessionShareID(id: pending) }
      }
      if coachAfterSignIn {
        coachAfterSignIn = false
        if !gym.sharingNeedsSignIn { ask(WorkoutHandoff.coachQuestion, send: true) }
      }
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
    .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition)") {
      await coach.activate()
    }
    .onChange(of: gym.account) { _, account in setupBuilder = nil; if coachHandoff?.account != account { coachHandoff = nil } }
    .onChange(of: gym.accountTransition) { _, active in if active { setupBuilder = nil } }
    .onChange(of: tab) { _, _ in if !setupReady { setupNavigationChosen = true } }
    .onChange(of: setupReady, initial: true) { _, ready in
      guard ready, let account = coach.seat, setupChecked != account else { return }
      setupChecked = account
      let occupied = setupNavigationChosen || tab != .routines || !routinesPath.isEmpty || !logPath.isEmpty || !coachPath.isEmpty ||
        gym.openSession != nil || gym.workout.isPresented || routine != nil || proposal != nil || coachHandoff != nil || app.routinesRequested
      if !occupied, coach.setupNeedsAttention { tab = .coach; return }
      if CoachSetupEligibility.shouldOffer(signedIn: coach.allowed, hydrated: gym.historyKnown, empty: !gym.hasData,
          resolved: !app.signInPending, occupied: occupied, hasConversation: coach.hasConversation, choice: coach.saved.setupChoice), coach.beginSetup() {
        tab = .coach
        gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "shown"])
      }
    }
    .onChange(of: app.routinesRequested, initial: true) { _, requested in
      if requested { setupChecked = gym.account; app.routinesRequested = false; routinesPath = NavigationPath(); tab = .routines }
    }
  }

  // A stack whose front screen hides the tab bar takes the accessory away with it.
  func tabBar(_ stack: Tab, hidden: Bool) { if hidden { hiddenTabBars.insert(stack) } else { hiddenTabBars.remove(stack) } }

  // The accessory stands while a workout is hidden and the selected tab's front screen keeps the tab bar, by this one rule
  // on every iOS 26 release, whether the system can switch the accessory off (26.1) or the room must leave it out (26.0).
  static func accessoryStands(workoutHidden: Bool, tab: Tab, hiddenTabBars: Set<Tab>) -> Bool { workoutHidden && !hiddenTabBars.contains(tab) }
  var accessoryStands: Bool { Self.accessoryStands(workoutHidden: hiddenWorkout != nil, tab: tab, hiddenTabBars: hiddenTabBars) }

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
      case .session(let id): SessionDetailScreen(gym: gym, sessionID: ID(RecordID(id)))
      }
    }.gymTabBar()
  }
  var setupReady: Bool {
    coach.allowed && coach.draftReadable && !gym.coachUnavailable && gym.historyKnown && !app.signInPending && !gym.accountTransition && app.sheet == nil
  }
  func escapeSetup(_ choice: CoachSetupChoice) {
    if choice == .buildManually { tab = .routines; setupBuilder = RoutineEditingSession(gym: gym, routine: nil) }
  }
  // A proposal's row opens the conversation at its card while the conversation on screen holds it; one it does not — a
  // connected tool's, or one from another conversation — opens its card on a sheet.
  func reviewProposal(_ id: ID<Proposal>) {
    guard coach.proposalTurn(id.description) != nil else { proposal = CoachProposalID(id: id.description); return }
    coachPath = NavigationPath(); revealedProposal = id.description; tab = .coach
  }
  func ask(_ question: String, send: Bool = false) {
    coachPath = NavigationPath(); tab = .coach
    coachHandoff = CoachHandoff(account: gym.account, question: question, send: send)
  }
  func receiveWorkout() {
    risingFromAccessory = false
    guard let handoff = gym.workout.handoff ?? finishedHandoff else { return }
    finishedHandoff = nil; gym.workout.handoff = nil
    switch handoff {
    case .detail(let id): tab = .log; if let id { logPath.append(Destination.session(id.description)) }
    case .keep(let id): tab = .log; logPath.append(Destination.session(id.description)); app.keep()
    case .coach:
      if gym.sharingNeedsSignIn { coachAfterSignIn = true; app.keep() }
      else { ask(WorkoutHandoff.coachQuestion, send: true) }
    case .writtenProgram: if gym.isAnonymous || gym.authPaused { app.openYou() } else { ask("Help me turn my written program into a routine.") }
    }
  }
}

// A hidden workout in the tab bar's accessory (Figma Gym · iOS 03.5): its name and clock, the clock alone beside a minimized bar.
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
