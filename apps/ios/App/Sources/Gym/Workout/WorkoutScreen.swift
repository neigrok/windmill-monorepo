import SwiftUI
import UIKit
import GymDomain
import DomainKit
import SyncCore

struct WorkoutScreen: View {
  nonisolated enum Sheet: Identifiable, Equatable {
    case assembly, movement, fix(TrainingSet), wheel, coach
    case editSets(ID<Exercise>, opening: Int?), swap(ID<Exercise>), rename(ID<Exercise>)
    var id: String {
      switch self {
      case .assembly: "assembly"
      case .movement: "movement"
      case .fix(let set): "fix-\(set.id)"
      case .wheel: "wheel"
      case .coach: "coach"
      case .editSets(let id, let set): "edit-sets-\(id)-\(set.map(String.init) ?? "")"
      case .swap(let id): "swap-\(id)"
      case .rename(let id): "rename-\(id)"
      }
    }
  }
  let gym: GymModel
  @Bindable var workout: WorkoutState
  @State var coach: CoachConversation
  @Environment(\.scenePhase) var scenePhase
  @State var activeSheet: Sheet?
  @FocusState var loadFocused: Bool
  @State var nextSheet: Sheet?
  @State var finishTask: Task<Void, Never>?
  @State var idleTimerWasDisabled = false
  @State var awake = false

  init(gym: GymModel, coach: CoachConversation? = nil) {
    self.gym = gym; workout = gym.workout
    _coach = State(initialValue: coach ?? CoachConversation(gym: gym))
  }
  var navigation: some View {
    let dates = gym.dates
    return NavigationStack {
      Group {
        if let session = workout.session {
          if session.isOpen { live }
          else { SessionDetailScreen(gym: gym, sessionID: session.id) }
        } else {
          ContentUnavailableView("This workout is no longer open", systemImage: "dumbbell")
        }
      }
      .background(GymPalette.canvas)
      .sensoryFeedback(.selection, trigger: workout.selected) { (old: ID<Exercise>?, new: ID<Exercise>?) in
        old != nil && new != nil && old != new
      }
      .sensoryFeedback(.success, trigger: workout.receipt?.session.id) { (old: ID<Session>?, new: ID<Session>?) in
        old == nil && new != nil
      }
      .roomTitle(workout.session?.name ?? Readout.noRoutine,
                 subtitle: workout.session.flatMap { session in session.isOpen ? String(localized: "Started \(dates.time(session.startedAt))") : nil })
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if workout.session?.isOpen == true {
          ToolbarItemGroup(placement: .topBarLeading) {
            Button("This workout", systemImage: "list.bullet.clipboard") { activeSheet = .assembly }.labelStyle(.iconOnly)
              .accessibilityIdentifier("workout-assembly")
            Button("Coach", systemImage: "bubble.left.and.bubble.right", action: openCoach).labelStyle(.iconOnly)
              .accessibilityIdentifier("workout-coach")
          }
          ToolbarItem(placement: .confirmationAction) {
            Button(workout.finishing ? "Finishing…" : "Finish") {
              finishTask = Task { await workout.finish(); updateAwake() }
            }.disabled(workout.finishing || workout.paging || gym.accountTransition || gym.readFailed)
              .accessibilityIdentifier("workout-finish").tint(GymPalette.accent)
          }
        }
      }.roomBar(.gym)
    }
  }
  var presentation: some View {
    navigation.modifier(GymPage())
    .accessibilityIdentifier("gym-workout")
    .modifier(WorkoutActivityFixtureProbe(gym: gym))
    .sheet(item: $activeSheet, onDismiss: {
      activeSheet = nextSheet; nextSheet = nil
    }) { destination in
      switch destination {
      case .assembly:
        WorkoutAssembly(workout: workout, add: { nextSheet = .movement; activeSheet = nil })
      case .movement:
        WorkoutMovementPicker(gym: gym, workout: workout)
      case .fix(let set):
        SetEditor(gym: gym, set: set, identifier: "workout-fix")
      case .editSets(let id, let set):
        EditSetsSheet(gym: gym, workout: workout, exerciseId: id, opening: set)
      case .swap(let id):
        WorkoutSwapPicker(gym: gym, workout: workout, exerciseId: id)
      case .rename(let id):
        if let exercise = gym.catalogue.find(id) { RenameMovementSheet(gym: gym, exercise: exercise) }
      case .wheel:
        let movement = workout.selected.flatMap { gym.catalogue.find($0) }
        RepsWheelSheet(title: String(localized: "Set \(String(workout.currentSets.count + 1))", comment: "A set by its place: Set 3"),
                       movement: movement?.name ?? String(localized: "Movement"),
                       reps: workout.reps) { reps in workout.adjustRack(weightKg: workout.weightKg, reps: reps) }
      case .coach:
        NavigationStack { coachRoom }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
          .environment(\.coachOpenAccount, { leave(for: .you) })
          .environment(\.coachKeepRoutines, { leave(for: .keepRoutines) })
          .environment(\.coachOpenRoutine, { id in leave(for: .routine(ID(RecordID(id)))) })
      }
    }
    .sheet(isPresented: Binding(get: { workout.receipt != nil }, set: { if !$0 { workout.closeReceipt() } })) {
      if let receipt = workout.receipt { WorkoutReceipt(gym: gym, receipt: receipt) }
    }
  }

  var observedWorkout: some View {
    presentation
    // The rack's load is typed in while its field has focus; a sheet opening or a change of movement takes the focus, so the
    // load lands before the sheet, and nothing brings the field back after it.
    .onChange(of: loadFocused) { (_: Bool, typing: Bool) in workout.typingLoad = typing }
    .onChange(of: activeSheet == Sheet.wheel) { (_: Bool, open: Bool) in workout.wheelOpen = open }
    .onChange(of: activeSheet) { (_: Sheet?, destination: Sheet?) in if destination != nil { loadFocused = false } }
    .onChange(of: workout.selected) { (_: ID<Exercise>?, _: ID<Exercise>?) in loadFocused = false }
    .sensoryFeedback(.impact(weight: .light), trigger: workout.restReaches) { (_: Int, _: Int) in
      activeSheet == nil && workout.receipt == nil && scenePhase == .active && gym.preferences.confirmHaptic
    }
    .onChange(of: gym.sets) { (_: [TrainingSet], _: [TrainingSet]) in workout.reconcile() }
    .onChange(of: gym.openSession?.plan) { (_: SessionPlan?, _: SessionPlan?) in workout.reconcile() }
    .onChange(of: gym.openSession?.id) { (_: ID<Session>?, _: ID<Session>?) in workout.reconcile(); updateAwake() }
    .onChange(of: gym.notices.map(\.id)) { (_: [String], _: [String]) in workout.reconcile() }
    .onChange(of: workout.message ?? gym.workoutNotice ?? gym.error) { (_: String?, message: String?) in
      if let message { UIAccessibility.post(notification: .announcement, argument: message) }
    }
    .onChange(of: gym.readFailed) { (_: Bool, failed: Bool) in if !failed { workout.reconcile() } }
  }

  var body: some View {
    observedWorkout
    .onAppear(perform: appear)
    .onChange(of: gym.account) { _, _ in
      nextSheet = nil; activeSheet = nil; finishTask?.cancel(); workout.accountChanged(); updateAwake()
    }
    .onChange(of: gym.accountTransition) { _, changing in
      if changing { nextSheet = nil; activeSheet = nil; loadFocused = false; finishTask?.cancel() }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .background { workout.flushRack(); finishTask?.cancel() }
      updateAwake()
    }
    .onDisappear(perform: disappear)
  }

  func appear() {
    if workout.sessionId != gym.openSession?.id && gym.openSession != nil { workout.restore() }
    workout.reconcile()
    updateAwake()
    gym.telemetry.event("gym_screen_viewed", properties: ["screen": "workout"])
  }

  // Coach over the workout keeps its answers clear of its bar at the large detent: the bar's edge is hard (08.54).
  @ViewBuilder var coachRoom: some View {
    let room = CoachTab(gym: gym, coach: coach, escapeSetup: { choice in if choice == .buildManually { leave(for: .buildRoutine) } },
                        close: { activeSheet = nil })
    if #available(iOS 26.0, *) { room.scrollEdgeEffectStyle(.hard, for: .top) } else { room }
  }

  // Coach over the workout is a deliberate entry, so it opens on a fresh chat (08.54); closing it leaves the rack as it was.
  func openCoach() {
    let account = gym.account, session = workout.sessionId
    Task {
      await coach.activate()
      guard activeSheet == nil, workout.receipt == nil, gym.account == account, workout.sessionId == session,
            workout.session?.isOpen == true else { return }
      _ = coach.fresh(door: "workout")
      activeSheet = .coach
    }
  }
  // Coach's doors to the rest of the gym, its account, Keep, a routine and a new one, close the sheet and hide the workout
  // as Build my routine does; the room opens them once the cover has gone.
  func leave(for handoff: WorkoutHandoff) {
    activeSheet = nil
    gym.hideWorkout(handingOff: handoff)
  }

  // The screen's focus goes with it and reports no change, while the workout outlives the screen: what the focus drove
  // is cleared here, or a return would find a typing session no field holds.
  func disappear() {
    workout.flushRack()
    workout.typingLoad = false; workout.wheelOpen = false
    finishTask?.cancel()
    releaseAwake()
  }

  var live: some View { WorkoutLive(gym: gym, workout: workout, loadFocused: $loadFocused, present: { activeSheet = $0 }) }
  func updateAwake() {
    let live = scenePhase == .active && workout.session?.isOpen == true
    if live && !awake { idleTimerWasDisabled = UIApplication.shared.isIdleTimerDisabled; UIApplication.shared.isIdleTimerDisabled = true; awake = true }
    if !live { releaseAwake() }
  }
  func releaseAwake() {
    if awake { UIApplication.shared.isIdleTimerDisabled = idleTimerWasDisabled; awake = false }
  }
}

// The open workout: its page under the rack's column. The rack lies over the page: the page keeps the room the rack leaves
// it at rest, and with the keyboard up the rack rides over it rather than pushing it, so the page keeps its head and a tap
// anywhere on it reaches it. The column is canvas to its top, since it lies over the page and whatever the page draws
// under its band and top padding — the ledger's card, where the keyboard's height leaves the rack short of the card's top —
// would show through transparent padding. The rack's height is this view's alone, so its changes re-render no screen; it
// is not a `reachBand`, whose `safeAreaBar` reports no focus for the field, so a load typed there is never the rack's.
struct WorkoutLive: View {
  let gym: GymModel
  @Bindable var workout: WorkoutState
  let loadFocused: FocusState<Bool>.Binding
  let present: (WorkoutScreen.Sheet) -> Void
  @State private var rackHeight = 0.0

  var body: some View {
    ZStack(alignment: .bottom) {
      VStack(spacing: 0) {
        if workout.walk.order.isEmpty {
          VStack(spacing: RoomSpace.panel) {
            Spacer()
            Text("Choose your first movement").font(.title2.weight(.semibold)).foregroundStyle(GymPalette.ink)
              .multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
            Button("Add movement", systemImage: "plus") { present(.movement) }
              .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.large).tint(GymPalette.accent).fontWeight(.semibold)
              .padding(.top, RoomSpace.panel).accessibilityIdentifier("workout-add")
            Spacer()
          }.padding(.horizontal, RoomSpace.inset).padding(.bottom, 120).frame(maxWidth: .infinity)
        } else {
          WorkoutPager(gym: gym, workout: workout, present: present)
            .overlay {
              if workout.typingLoad {
                Color.clear.contentShape(Rectangle()).onTapGesture { loadFocused.wrappedValue = false }.accessibilityHidden(true)
              }
            }
        }
      }
      .padding(.bottom, rackHeight)
      .ignoresSafeArea(.keyboard)
      .modifier(GymPage())
      VStack(spacing: 0) {
        GymTransient(gym: gym, message: workout.message, dismiss: { workout.message = nil }, noticeMessage: gym.workoutNotice,
                     retry: { gym.workout.retryRead() }, errorIdentifier: "workout-refusal")
          .modifier(BoundedBand())
        if workout.selected != nil {
          WorkoutRack(workout: workout, loadFocused: loadFocused, editReps: { present(.wheel) })
            .padding(RoomSpace.inset)
            .background {
              UnevenRoundedRectangle(topLeadingRadius: RoomSpace.panel, topTrailingRadius: RoomSpace.panel)
                .fill(GymPalette.card).ignoresSafeArea(edges: .bottom)
            }
            .padding(.top, RoomSpace.related)
        }
      }.frame(maxWidth: .infinity).background(GymPalette.canvas)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rackHeight = $0 }
    }
  }
}

// The movement's page: its header, dots and facts, then the ledger, drawn from the top of whatever height the rack leaves
// it, so with the keyboard up the page keeps its head and what stands below passes under the rack.
struct WorkoutLedger: View {
  let gym: GymModel
  let workout: WorkoutState
  let exerciseId: ID<Exercise>
  let present: (WorkoutScreen.Sheet) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  var body: some View {
    let ledger = workout.ledger(exerciseId)
    let unsent = gym.unsentSets(workout.sets)
    let fixable = !(workout.paging || workout.finishing || workout.finishQueued || gym.accountTransition)
    let movement = gym.catalogue.find(exerciseId)
    let editable = fixable && workout.canEditPlan(exerciseId)
    Color.clear.overlay(alignment: .top) {
      VStack(spacing: RoomSpace.related) {
        header(movement, editable: editable, enabled: fixable)
          .padding(.horizontal, RoomSpace.inset)
        if !typeSize.isAccessibilitySize { details }
        LedgerCard(ledger: ledger, unsent: unsent, editable: editable, open: { open($0, ledger: ledger, editable: editable, fixable: fixable) }) { details }
          .padding(.horizontal, RoomSpace.inset)
        if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
      }.padding(.top, RoomSpace.related)
    }.background(GymPalette.canvas)
  }

  // The movement's name is its menu (03.26, 03.27): a movement with nothing logged edits its sets or swaps; every movement
  // adds another and edits its own name and equipment. A logged movement's menu holds no plan item and says nothing of why.
  func header(_ movement: Exercise?, editable: Bool, enabled: Bool) -> some View {
    Menu {
      if editable {
        Section {
          Button("Edit sets", systemImage: "slider.horizontal.3") { present(.editSets(exerciseId, opening: nil)) }
            .accessibilityIdentifier("workout-menu-edit-sets")
          Button("Swap movement", systemImage: "arrow.triangle.2.circlepath") { present(.swap(exerciseId)) }
            .accessibilityIdentifier("workout-menu-swap")
        }
      }
      Section {
        Button("Add movement", systemImage: "plus.square.on.square") { present(.movement) }
          .accessibilityIdentifier("workout-menu-add")
        if movement != nil {
          Button("Edit movement", systemImage: "pencil") { present(.rename(exerciseId)) }
            .accessibilityIdentifier("workout-menu-edit-movement")
        }
      }
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
        if let symbol = MovementEquipment(movement).symbol {
          Image(systemName: symbol).font(.title3).accessibilityHidden(true)
        }
        Text(movement?.name ?? String(localized: "Movement")).font(.title2.weight(.bold)).multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
        Image(systemName: "chevron.down").font(.subheadline.weight(.semibold)).foregroundStyle(GymPalette.inkDim).accessibilityHidden(true)
      }.frame(maxWidth: .infinity)
    }.buttonStyle(.plain).foregroundStyle(GymPalette.ink).tint(GymPalette.ink).disabled(!enabled)
      .accessibilityLabel("Movement options").accessibilityValue(movement?.name ?? String(localized: "Movement"))
      .accessibilityIdentifier("workout-movement-menu")
  }

  // A logged row opens Fix set; a movement with nothing logged opens Edit sets at the row's planned set, or with none open
  // where the plan holds no targets.
  func open(_ row: MovementLedger.Row, ledger: MovementLedger, editable: Bool, fixable: Bool) {
    guard fixable else { return }
    if let set = row.set { present(.fix(set)); return }
    guard editable else { return }
    present(.editSets(exerciseId, opening: ledger.targets.indices.contains(row.id) ? row.id : nil))
  }

  var details: some View {
    VStack(spacing: RoomSpace.related) {
      WorkoutPageControl(workout: workout, exerciseId: exerciseId).frame(height: RoomSpace.minimumTarget)
      WorkoutFacts(workout: workout, exerciseId: exerciseId).padding(.horizontal, RoomSpace.inset * 2)
    }
  }
}

// The ledger's card (03.34): its rows at the row height, three deep at the standard sizes and as tall as its page allows
// at accessibility sizes, where the page's details lead the list; the current row scrolls into view as sets are logged.
struct LedgerCard<Details: View>: View {
  let ledger: MovementLedger
  let unsent: Set<ID<TrainingSet>>
  let editable: Bool
  let open: (MovementLedger.Row) -> Void
  @ViewBuilder let details: () -> Details
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  var body: some View {
    ScrollViewReader { scroll in
      List {
        if typeSize.isAccessibilitySize {
          Section { details().listRowInsets(EdgeInsets()).listRowSeparator(.hidden) }
            .listRowBackground(GymPalette.canvas)
        }
        Section {
          ForEach(ledger.rows) { row in
            WorkoutLedgerRow(row: row, unsent: row.set.map { unsent.contains($0.id) } ?? false)
              .frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
              .listRowInsets(EdgeInsets(top: 0, leading: RoomSpace.inset, bottom: 0, trailing: RoomSpace.inset))
              .onTapGesture { open(row) }
              .accessibilityRemoveTraits(row.set == nil && !editable ? [.isButton, .isSelected] : .isSelected)
              .accessibilityAddTraits(row.set == nil && !editable ? .isStaticText : .isButton)
              .accessibilityRespondsToUserInteraction(row.set != nil || editable)
              .accessibilityHint(row.set != nil ? "Opens Fix set." : editable ? "Opens Edit sets." : "")
              .accessibilityAction { open(row) }
          }
        }.listRowBackground(GymPalette.card)
      }.listStyle(.plain)
        .environment(\.defaultMinListRowHeight, RoomSpace.minimumTarget)
        .contentMargins(.vertical, 0, for: .scrollContent).modifier(GymPage())
        .accessibilityIdentifier("workout-ledger")
        .onAppear { scroll.scrollTo(ledger.performed, anchor: .bottom) }
        .onChange(of: ledger.sets.count) { _, _ in
          withAnimation(reduceMotion ? nil : .spring) { scroll.scrollTo(ledger.performed, anchor: .bottom) }
        }
    }.frame(height: typeSize.isAccessibilitySize ? nil : CGFloat(min(ledger.rows.count, 3)) * RoomSpace.minimumTarget)
      .frame(maxHeight: typeSize.isAccessibilitySize ? .infinity : nil)
      .background(GymPalette.card).clipShape(.card)
  }
}

struct WorkoutPageControl: UIViewRepresentable {
  let workout: WorkoutState
  let exerciseId: ID<Exercise>
  func makeCoordinator() -> Coordinator { Coordinator(workout) }
  func makeUIView(context: Context) -> UIPageControl {
    let control = UIPageControl()
    control.currentPageIndicatorTintColor = GymPalette.uiAccent
    control.pageIndicatorTintColor = GymPalette.uiInkFaint
    control.backgroundStyle = .minimal
    control.addTarget(context.coordinator, action: #selector(Coordinator.select(_:)), for: .valueChanged)
    control.accessibilityLabel = String(localized: "Movements")
    control.accessibilityIdentifier = "workout-pages"
    return control
  }
  func updateUIView(_ control: UIPageControl, context: Context) {
    let order = workout.walk.order
    control.numberOfPages = order.count
    control.currentPage = order.firstIndex(of: exerciseId) ?? 0
    control.isEnabled = !(workout.paging || workout.finishing || workout.finishQueued || workout.gym.accountTransition)
  }
  final class Coordinator: NSObject {
    let workout: WorkoutState
    init(_ workout: WorkoutState) { self.workout = workout }
    @objc func select(_ control: UIPageControl) {
      let order = workout.walk.order
      guard order.indices.contains(control.currentPage) else { return }
      workout.select(order[control.currentPage])
    }
  }
}

// One line of the ledger, read aloud as one element: the set's place, its numbers and its mark at the trailing edge (03.34).
// A logged row reads what was lifted, an open row what the plan expects, the current one in ink and the planned ones
// dimmed; a load still waiting on last time is a placeholder bar that resolves in place. The current row's dot turns into
// the logged set's check on the system spring; under Reduce Motion each change is a 200 ms fade.
struct WorkoutLedgerRow: View {
  let row: MovementLedger.Row
  let unsent: Bool
  @Environment(\.accessibilityReduceMotion) var reduceMotion

  var body: some View {
    let mark: (symbol: String, colour: Color) = switch row.place {
    case .logged: unsent ? ("iphone", GymPalette.inkDim) : ("checkmark", GymPalette.done)
    case .current, .planned: ("circle.fill", GymPalette.accent)
    }
    HStack(spacing: RoomSpace.related) {
      Text(row.marker).foregroundStyle(row.place == .current ? GymPalette.accent : GymPalette.inkDim)
        .frame(minWidth: 20, alignment: .leading)
      reading.foregroundStyle(row.place == .planned ? GymPalette.inkDim : GymPalette.ink)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: RoomSpace.related)
      Image(systemName: mark.symbol).font(row.set == nil ? .system(size: RoomSpace.related) : .body)
        .foregroundStyle(mark.colour).opacity(row.place == .planned ? 0 : 1)
        .contentTransition(RoomMotion.symbol(reduceMotion: reduceMotion))
        .accessibilityHidden(true).accessibilityRemoveTraits(.isSelected)
    }.font(.body.monospacedDigit())
      .roomMotion(row).roomMotion(unsent)
      .accessibilityElement(children: row.place == .planned ? .ignore : .combine)
      .accessibilityLabel(spoken)
      .accessibilityIdentifier(row.set.map { "workout-set-\($0.id.record)" } ?? (row.place == .current ? "workout-current-set" : ""))
  }

  // The row's numbers as its reading spells them, the load a placeholder bar two digits wide while it is nil.
  @ViewBuilder var reading: some View {
    if let reps = row.reps {
      HStack(alignment: .firstTextBaseline, spacing: 0) {
        if let load = row.load { Text(load).contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion)) }
        else { Text(verbatim: "00").redacted(reason: .placeholder) }
        Text(Readout.times + reps).contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion))
      }
    } else {
      Text(row.reading)
    }
  }

  var spoken: String {
    switch row.place {
    case .logged(let set):
      let load = Readout.weight(set.weightKg)
      if unsent { return String(localized: "Set \(row.marker), logged, \(load) kilograms, \(set.reps) reps, on this phone", locale: .copy) }
      return String(localized: "Set \(row.marker), logged, \(load) kilograms, \(set.reps) reps", locale: .copy)
    case .current: return String(localized: "Set \(row.marker), current, \(row.target.map { Self.expected(row.load, by: $0) } ?? String(localized: "open target"))")
    case .planned: return String(localized: "Set \(row.marker), planned, \(row.target.map { Self.expected(row.load, by: $0) } ?? String(localized: "open target"))")
    }
  }

  // A row still to lift in words: the load the plan expects, and the plan's reps.
  static func expected(_ load: String?, by target: SetTarget) -> String {
    "\(load.map { String(localized: "\($0) kilograms") } ?? String(localized: "no load yet")), \(target.reps.map { GymCount.of($0, .rep) } ?? String(localized: "max reps"))"
  }

  // The numbers the plan asks for, in words: the load, the reps, or both; nil when it asks for neither.
  static func asked(_ target: SetTarget?) -> String? {
    let numbers = [target?.weightKg.map { String(localized: "\(Readout.weight($0)) kilograms") }, target?.reps.map { GymCount.of($0, .rep) }].compactMap { $0 }
    return numbers.isEmpty ? nil : numbers.joined(separator: ", ")
  }
}

// The workout clock leads; at the trailing edge the time since the last set stands before the movement's rest target, which
// never moves (03.20). Reaching it turns the since clock and its glyph gym/accent (03.21); with no target the since clock
// stands alone (03.22). The selected movement's row reports the reach, once per rest, and VoiceOver announces nothing.
struct WorkoutFacts: View {
  let workout: WorkoutState
  let exerciseId: ID<Exercise>
  @Environment(\.dynamicTypeSize) var typeSize
  static func spokenRest(sinceMs: Int64, target: RestTarget?) -> String {
    let since = WorkoutClocks.spoken(sinceMs)
    guard let target else { return since }
    return String(localized: "\(since), target \(WorkoutClocks.spoken(Int64(target.seconds) * 1_000))", comment: "Time since the last set, then the rest target")
  }
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { _ in
      if let clocks = workout.clocks {
        let target = workout.restTarget(exerciseId)
        let reached = clocks.sinceSetMs.map { since in target?.isReached(sinceMs: since) ?? false } ?? false
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small))
          : AnyLayout(HStackLayout(spacing: RoomSpace.related))
        layout {
          Label(WorkoutClocks.reading(clocks.workoutMs), systemImage: "clock")
            .accessibilityLabel("Workout time").accessibilityValue(WorkoutClocks.spoken(clocks.workoutMs))
          if !typeSize.isAccessibilitySize { Spacer(minLength: RoomSpace.related) }
          if let since = clocks.sinceSetMs {
            HStack(spacing: RoomSpace.related) {
              Label {
                Text(WorkoutClocks.reading(since)).foregroundStyle(reached ? GymPalette.accent : GymPalette.ink)
              } icon: {
                Image(systemName: "timer").foregroundStyle(reached ? GymPalette.accent : GymPalette.inkDim)
              }
              if let target { Text("/ " + WorkoutClocks.reading(Int64(target.seconds) * 1_000)) }
            }.accessibilityElement(children: .ignore)
              .accessibilityLabel("Since last set").accessibilityValue(Self.spokenRest(sinceMs: since, target: target))
          }
        }.font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
          .onChange(of: reached) { (_: Bool, now: Bool) in if now, exerciseId == workout.selected { workout.reachRest() } }
      }
    }
  }
}

// The rack drafts the next set (03.23A). Its numeral is the load's field on the decimal pad, sized to its row so a wide
// load never pushes its unit out, the unit at its baseline or under it at accessibility sizes; a tap into it raises the
// keyboard and the rack rides up with it as one block, nothing in
// it appearing, going, resizing or moving. Each key edits the rack, so the ladder steps the typed load and Log set logs what
// the field shows and drops the keyboard; the typed load lands as the field lets go, by Log set, a tap outside, a sheet
// opening or a change of movement. The ladder steps by the load's own band, led for bodyweight and Other by ± (03.30), the
// pad having no minus; the reps value opens one wheel (03.24). Each change the lifter makes to load or reps ticks, a typed
// load once as it lands, and Log set stays silent.
struct WorkoutRack: View {
  @Bindable var workout: WorkoutState
  let loadFocused: FocusState<Bool>.Binding
  let editReps: () -> Void
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @Environment(\.dynamicTypeSize) var typeSize
  @ScaledMetric(relativeTo: .largeTitle) var numeralSize = GymNumeral.scaled
  @State var numeralWidth = 0.0
  @State var unitWidth = 0.0
  // The text the load field shows, as it reports it; nil until it has.
  @State var shown: String?
  // The numeral's size: its scaled size, or smaller so its text, measured with its own face and the field's clearance
  // around it, fits the row beside the unit, half the size at the least. The room is the row's width less the unit and its
  // spacing; at accessibility sizes the unit sits under the numeral. A `TextField` takes no `minimumScaleFactor`: with
  // one, its layout never settles at large text.
  func numeralPoints(_ text: String) -> CGFloat {
    let full = min(numeralSize, GymNumeral.cap)
    let room = typeSize.isAccessibilitySize ? numeralWidth : numeralWidth - unitWidth - RoomSpace.related
    guard room > 0 else { return full }
    let width = (text as NSString).size(withAttributes: [.font: GymNumeral.uiFont(full)]).width + RoomSpace.related
    return width > room ? max(full / 2, full * room / width) : full
  }
  // VoiceOver hears the numeral in its load basis, *Weight, 100 kg total*, and Log set with the set it logs.
  static func spokenWeight(_ weightKg: Double, basis: MovementEquipment) -> String { String(localized: "Weight, \(Readout.weight(weightKg)) \(basis.unit)") }
  static func spokenLog(_ weightKg: Double, reps: Int) -> String {
    String(localized: "Log set, \(Readout.weight(weightKg)) kilograms, \(reps) reps", locale: .copy)
  }
  var body: some View {
    let basis = MovementEquipment(workout.selected.flatMap { workout.gym.catalogue.find($0) })
    let numeral = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.related))
    VStack(spacing: RoomSpace.inset) {
      numeral {
        LoadField(load: Binding(get: { workout.weightKg }, set: { workout.typeLoad($0) }).optional, kind: .logged, basis: basis,
                  focus: loadFocused, identifier: "workout-load")
          .modifier(GymNumeral(points: numeralPoints(shown ?? LoadText.typed(workout.weightKg))))
          .tint(GymPalette.accent).fixedSize(horizontal: true, vertical: false)
          .accessibilityLabel(Self.spokenWeight(workout.weightKg, basis: basis))
        Text(basis.unit).font(.title3).foregroundStyle(GymPalette.inkDim).fixedSize()
          .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { unitWidth = $0 }
          .accessibilityIdentifier("workout-weight-unit")
      }.frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { numeralWidth = $0 }
        .onPreferenceChange(LoadFieldText.self) { shown = $0 }
      ladder(basis)
      reps
      Button { workout.logSet(); loadFocused.wrappedValue = false } label: {
        Text("Log set").font(.headline).frame(maxWidth: .infinity, minHeight: 32)
      }.buttonStyle(RoomPrimaryStyle(room: .gym)).disabled(!workout.canLog)
        .accessibilityLabel(Self.spokenLog(workout.weightKg, reps: workout.reps))
        .accessibilityIdentifier("workout-log")
    }.frame(maxWidth: .infinity).dynamicTypeSize(...DynamicTypeSize.accessibility1)
      .disabled(workout.paging || workout.finishing || workout.finishQueued || workout.gym.accountTransition)
      .sensoryFeedback(.selection, trigger: workout.adjustments)
  }

  // Four keys step the load by its band; a signed basis leads them with a fifth, ±, the same whether the pad is up or not.
  func ladder(_ basis: MovementEquipment) -> some View {
    let keys = typeSize.isAccessibilitySize ? 2 : basis.signed ? 5 : 4
    let labels = WeightLadder.labels(workout.weightKg)
    return LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: keys), spacing: RoomSpace.related) {
      if basis.signed { FlipSignKey(load: $workout.weightKg.optional, identifier: "workout-load", asKey: true) }
      ForEach(0..<4) { index in
        Button { workout.weightKg = WeightLadder.bump(workout.weightKg, direction: index < 2 ? -1 : 1, big: index == 0 || index == 3) } label: {
          Text(labels[index]).frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
        }.accessibilityLabel("\(labels[index]) \(basis.unit)").accessibilityIdentifier("workout-weight-step-\(index)")
      }
    }.buttonStyle(GymInstrumentButtonStyle()).font(.body.monospacedDigit())
  }

  var reps: some View {
    HStack(spacing: RoomSpace.related) {
      Button { workout.reps = max(SetRules.loggedReps.lowerBound, workout.reps - 1) } label: {
        Image(systemName: "minus").frame(width: 56, height: 56).contentShape(Rectangle())
      }.accessibilityLabel("Fewer reps").accessibilityIdentifier("workout-reps-minus").disabled(workout.reps <= SetRules.loggedReps.lowerBound)
      Button(action: editReps) {
        Text(GymCount.of(workout.reps, .rep)).font(.title3.monospacedDigit())
          .contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion, value: Double(workout.reps)))
          .roomMotion(workout.reps).frame(maxWidth: .infinity, minHeight: 56).contentShape(Rectangle())
      }.buttonStyle(.plain).foregroundStyle(GymPalette.ink).accessibilityHint("Opens the reps wheel.")
        .accessibilityIdentifier("workout-reps")
      Button { workout.reps = min(SetRules.loggedReps.upperBound, workout.reps + 1) } label: {
        Image(systemName: "plus").frame(width: 56, height: 56).contentShape(Rectangle())
      }.accessibilityLabel("More reps").accessibilityIdentifier("workout-reps-plus").disabled(workout.reps >= SetRules.loggedReps.upperBound)
    }.buttonStyle(GymInstrumentButtonStyle()).font(.title3.weight(.medium))
  }
}

// The rack's keys are instruments in ink, whatever tint the host carries; a pressed key takes the accent.
struct GymInstrumentButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(!enabled ? GymPalette.inkFaint : configuration.isPressed ? GymPalette.onAccent : GymPalette.ink)
      .background(configuration.isPressed && enabled ? GymPalette.accent : GymPalette.control,
                  in: RoundedRectangle(cornerRadius: RoomSpace.inset))
      .contentShape(Rectangle())
      .scaleEffect(configuration.isPressed && enabled && !reduceMotion ? 0.96 : 1)
  }
}


struct WorkoutPager: UIViewControllerRepresentable {
  let gym: GymModel
  let workout: WorkoutState
  let present: (WorkoutScreen.Sheet) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIViewController(context: Context) -> UIPageViewController {
    let pager = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
    pager.dataSource = context.coordinator; pager.delegate = context.coordinator
    context.coordinator.showSelected(in: pager); return pager
  }
  func updateUIViewController(_ pager: UIPageViewController, context: Context) {
    context.coordinator.parent = self
    if !workout.paging { context.coordinator.showSelected(in: pager) }
  }
  final class Coordinator: NSObject, UIPageViewControllerDataSource, UIPageViewControllerDelegate {
    var parent: WorkoutPager
    var pages: [ID<Exercise>: UIHostingController<WorkoutLedger>] = [:]
    init(_ parent: WorkoutPager) { self.parent = parent }
    // A page made once stays: its ledger reads the workout through observation, so nothing in it goes stale.
    func page(_ id: ID<Exercise>) -> UIHostingController<WorkoutLedger> {
      if let page = pages[id] { return page }
      let page = UIHostingController(rootView: WorkoutLedger(gym: parent.gym, workout: parent.workout, exerciseId: id, present: parent.present))
      pages[id] = page; return page
    }
    func identity(_ controller: UIViewController) -> ID<Exercise>? { pages.first { $0.value === controller }?.key }
    func showSelected(in pager: UIPageViewController) {
      guard let id = parent.workout.selected else { return }
      let current = page(id)
      pages = pages.filter { parent.workout.walk.order.contains($0.key) }
      if pager.viewControllers?.first !== current { pager.setViewControllers([current], direction: .forward, animated: false) }
    }
    func neighbor(_ view: UIViewController, direction: Int) -> UIViewController? {
      guard !parent.workout.finishing,
            let id = identity(view), let position = parent.workout.walk.order.firstIndex(of: id),
            parent.workout.walk.order.indices.contains(position + direction) else { return nil }
      return page(parent.workout.walk.order[position + direction])
    }
    func pageViewController(_ pager: UIPageViewController, viewControllerBefore view: UIViewController) -> UIViewController? { neighbor(view, direction: -1) }
    func pageViewController(_ pager: UIPageViewController, viewControllerAfter view: UIViewController) -> UIViewController? { neighbor(view, direction: 1) }
    func pageViewController(_ pager: UIPageViewController, willTransitionTo pending: [UIViewController]) { parent.workout.paging = true }
    func pageViewController(_ pager: UIPageViewController, didFinishAnimating finished: Bool, previousViewControllers: [UIViewController], transitionCompleted: Bool) {
      if transitionCompleted, let current = pager.viewControllers?.first, let id = identity(current) { parent.workout.select(id) }
      parent.workout.paging = false; showSelected(in: pager)
    }
  }
}
