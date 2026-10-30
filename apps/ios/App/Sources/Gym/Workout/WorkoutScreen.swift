import SwiftUI
import UIKit
import GymDomain
import DomainKit
import SyncCore

struct WorkoutScreen: View {
  nonisolated enum Sheet: Identifiable, Equatable {
    case assembly, movement, fix(TrainingSet), wheel, coach
    var id: String {
      switch self {
      case .assembly: "assembly"
      case .movement: "movement"
      case .fix(let set): "fix-\(set.id)"
      case .wheel: "wheel"
      case .coach: "coach"
      }
    }
  }
  let gym: GymModel
  @Bindable var workout: WorkoutState
  @State var coach: CoachConversation
  @Environment(\.scenePhase) var scenePhase
  @State var activeSheet: Sheet?
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
                 subtitle: workout.session.flatMap { session in session.isOpen ? "Started " + dates.time(session.startedAt) : nil })
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
      case .wheel:
        let movement = workout.selected.flatMap { gym.catalogue.find($0) }
        SetWheelSheet(title: "Set \(workout.currentSets.count + 1)", movement: movement?.name ?? "Movement", basis: MovementEquipment(movement),
                      weightKg: workout.weightKg, reps: workout.reps) { weightKg, reps in workout.adjustRack(weightKg: weightKg, reps: reps) }
      case .coach:
        NavigationStack {
          CoachTab(gym: gym, coach: coach, escapeSetup: { choice in if choice == .buildManually { leave(for: .buildRoutine) } },
                   close: { activeSheet = nil })
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
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
    .onChange(of: activeSheet) { (_: Sheet?, destination: Sheet?) in workout.rackEditing = destination == Sheet.wheel }
    .onChange(of: gym.sets) { (_: [TrainingSet], _: [TrainingSet]) in workout.reconcile() }
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
      if changing { nextSheet = nil; activeSheet = nil; finishTask?.cancel() }
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

  // Coach over the workout is a deliberate entry, so it opens on a fresh chat (08.54); closing it leaves the rack as it was.
  func openCoach() {
    Task {
      await coach.activate()
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

  func disappear() {
    workout.flushRack()
    workout.rackEditing = false
    finishTask?.cancel()
    releaseAwake()
  }

  var live: some View {
    VStack(spacing: 0) {
      if workout.walk.order.isEmpty {
        VStack(spacing: RoomSpace.panel) {
          Spacer()
          Text("Choose your first movement").font(.title2.weight(.semibold)).foregroundStyle(GymPalette.ink)
            .multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
          Button("Add movement", systemImage: "plus") { activeSheet = .movement }
            .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.large).tint(GymPalette.accent).fontWeight(.semibold)
            .padding(.top, RoomSpace.panel).accessibilityIdentifier("workout-add")
          Spacer()
        }.padding(.horizontal, RoomSpace.inset).padding(.bottom, 120).frame(maxWidth: .infinity)
      } else {
        WorkoutPager(gym: gym, workout: workout, assembly: { activeSheet = .assembly }, fix: { activeSheet = .fix($0) })
      }
    }
    .modifier(GymPage())
    .reachBand(spacing: 0) {
      VStack(spacing: 0) {
        GymTransient(gym: gym, message: workout.message, dismiss: { workout.message = nil }, noticeMessage: gym.workoutNotice,
                     retry: { gym.workout.retryRead() }, errorIdentifier: "workout-refusal")
          .modifier(BoundedBand())
        if workout.selected != nil {
          WorkoutRack(workout: workout, edit: { activeSheet = .wheel })
            .padding(RoomSpace.inset)
            .background {
              UnevenRoundedRectangle(topLeadingRadius: RoomSpace.panel, topTrailingRadius: RoomSpace.panel)
                .fill(GymPalette.card).ignoresSafeArea(edges: .bottom)
            }
            .padding(.top, RoomSpace.related)
        }
      }.frame(maxWidth: .infinity)
    }
  }
  func updateAwake() {
    let live = scenePhase == .active && workout.session?.isOpen == true
    if live && !awake { idleTimerWasDisabled = UIApplication.shared.isIdleTimerDisabled; UIApplication.shared.isIdleTimerDisabled = true; awake = true }
    if !live { releaseAwake() }
  }
  func releaseAwake() {
    if awake { UIApplication.shared.isIdleTimerDisabled = idleTimerWasDisabled; awake = false }
  }
}

struct WorkoutLedger: View {
  let gym: GymModel
  let workout: WorkoutState
  let exerciseId: ID<Exercise>
  var assembly: () -> Void = {}
  let fix: (TrainingSet) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  var body: some View {
    let ledger = workout.ledger(exerciseId)
    let unsent = gym.unsentSets(workout.sets)
    let fixable = !(workout.paging || workout.finishing || workout.finishQueued || gym.accountTransition)
    let movement = gym.catalogue.find(exerciseId)
    VStack(spacing: RoomSpace.related) {
      Button(action: assembly) {
        HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
          if let symbol = MovementEquipment(movement).symbol {
            Image(systemName: symbol).font(.title3).accessibilityHidden(true)
          }
          Text(movement?.name ?? "Movement").font(.title2.weight(.bold)).multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity)
      }.buttonStyle(.plain).foregroundStyle(GymPalette.ink)
        .accessibilityHint("Open this workout’s movements")
        .padding(.horizontal, RoomSpace.inset)
      if !typeSize.isAccessibilitySize { details }
      ScrollViewReader { scroll in
        List {
          if typeSize.isAccessibilitySize {
            Section { details.listRowInsets(EdgeInsets()).listRowSeparator(.hidden) }
              .listRowBackground(GymPalette.canvas)
          }
          Section {
            ForEach(ledger.rows) { row in
              WorkoutLedgerRow(row: row, unsent: row.set.map { unsent.contains($0.id) } ?? false)
                .frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
                .listRowInsets(EdgeInsets(top: 0, leading: RoomSpace.inset, bottom: 0, trailing: RoomSpace.inset))
                .onTapGesture { if let set = row.set, fixable { fix(set) } }
                .accessibilityRemoveTraits(row.set == nil ? [.isButton, .isSelected] : .isSelected)
                .accessibilityAddTraits(row.set == nil ? .isStaticText : .isButton)
                .accessibilityRespondsToUserInteraction(row.set != nil)
                .accessibilityHint(row.set == nil ? "" : "Opens Fix set.")
                .accessibilityAction { if let set = row.set, fixable { fix(set) } }
            }
          }.listRowBackground(GymPalette.card)
        }.listStyle(.plain)
          .environment(\.defaultMinListRowHeight, RoomSpace.minimumTarget)
          .contentMargins(.vertical, 0, for: .scrollContent).modifier(GymPage())
          .accessibilityIdentifier("workout-ledger")
          .onAppear { scroll.scrollTo(ledger.current.id, anchor: .bottom) }
          .onChange(of: ledger.sets.count) { _, _ in
            withAnimation(reduceMotion ? nil : .spring) { scroll.scrollTo(ledger.current.id, anchor: .bottom) }
          }
      }.frame(height: typeSize.isAccessibilitySize ? nil : CGFloat(min(ledger.rows.count, 3)) * RoomSpace.minimumTarget)
        .frame(maxHeight: typeSize.isAccessibilitySize ? .infinity : nil)
        .background(GymPalette.card).clipShape(RoundedRectangle(cornerRadius: RoomSpace.cardRadius))
        .padding(.horizontal, RoomSpace.inset)
      if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
    }.padding(.top, RoomSpace.related).background(GymPalette.canvas)
  }

  var details: some View {
    VStack(spacing: RoomSpace.related) {
      WorkoutPageControl(workout: workout, exerciseId: exerciseId).frame(height: RoomSpace.minimumTarget)
      WorkoutFacts(workout: workout)
    }
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
    control.accessibilityLabel = "Movements"
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

// One line of the ledger, read aloud as one element: the set's place, its numbers and its mark at the trailing edge. The
// current row's dot turns into the logged set's check on the system spring; under Reduce Motion each change is a 200 ms fade.
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
      Text(row.marker).foregroundStyle(row.place == .current ? GymPalette.accent : row.place == .planned ? GymPalette.inkFaint : GymPalette.inkDim)
        .frame(minWidth: 20, alignment: .leading)
      Text(row.reading).foregroundStyle(row.place == .planned ? GymPalette.inkFaint : GymPalette.ink)
        .fixedSize(horizontal: false, vertical: true)
        .contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion))
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

  var spoken: String {
    switch row.place {
    case .logged(let set):
      return "Set \(row.marker), logged, \(Readout.weight(set.weightKg)) kilograms, \(GymCount.of(set.reps, "rep"))\(unsent ? ", on this phone" : "")"
    case .current: return "Set \(row.marker), current, \(asked.map { "target " + $0 } ?? "open target")"
    case .planned: return "Set \(row.marker), planned, \(asked ?? "open target")"
    }
  }

  // The numbers the plan asks for, in words: the load, the reps, or both; nil when it asks for neither.
  var asked: String? {
    let numbers = [row.target?.weightKg.map { "\(Readout.weight($0)) kilograms" }, row.target?.reps.map { GymCount.of($0, "rep") }].compactMap { $0 }
    return numbers.isEmpty ? nil : numbers.joined(separator: ", ")
  }
}

struct WorkoutFacts: View {
  let workout: WorkoutState
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { _ in
      if let clocks = workout.clocks {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: RoomSpace.small))
          : AnyLayout(HStackLayout(spacing: RoomSpace.panel))
        layout {
          Label(WorkoutClocks.reading(clocks.workoutMs), systemImage: "clock")
            .accessibilityLabel("Workout time").accessibilityValue(WorkoutClocks.reading(clocks.workoutMs))
          if let since = clocks.sinceSetMs {
            Label(WorkoutClocks.reading(since), systemImage: "timer")
              .accessibilityLabel("Since last set").accessibilityValue(WorkoutClocks.reading(since))
          }
        }.font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
      }
    }
  }
}

// The rack drafts the next set: the numeral, its unit at its baseline or under it at accessibility sizes, opens the
// wheels and rolls to each new load; the ladder steps by the load's own band; each change the lifter makes to load or
// reps ticks, and Log set stays silent.
struct WorkoutRack: View {
  @Bindable var workout: WorkoutState
  let edit: () -> Void
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @Environment(\.dynamicTypeSize) var typeSize
  // VoiceOver hears the numeral in its load basis, *Weight, 100 kg total*, and Log set with the set it logs.
  static func spokenWeight(_ weightKg: Double, basis: MovementEquipment) -> String { "Weight, \(Readout.weight(weightKg)) \(basis.unit)" }
  static func spokenLog(_ weightKg: Double, reps: Int) -> String { "Log set, \(Readout.weight(weightKg)) kilograms, \(GymCount.of(reps, "rep"))" }
  var body: some View {
    let basis = MovementEquipment(workout.selected.flatMap { workout.gym.catalogue.find($0) })
    let numeral = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.related))
    VStack(spacing: RoomSpace.inset) {
      numeral {
        Button(action: edit) {
          Text(Readout.weight(workout.weightKg)).modifier(GymNumeral()).lineLimit(1).minimumScaleFactor(0.5)
            .contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion, value: workout.weightKg))
        }.buttonStyle(.plain).accessibilityLabel(Self.spokenWeight(workout.weightKg, basis: basis))
          .accessibilityIdentifier("workout-weight")
        Text(basis.unit).font(.title3).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("workout-weight-unit")
      }.roomMotion(workout.weightKg)
      LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: typeSize.isAccessibilitySize ? 2 : 4), spacing: RoomSpace.related) {
        ForEach(0..<4) { index in
          let label = WeightLadder.labels(workout.weightKg)[index]
          Button { workout.weightKg = WeightLadder.bump(workout.weightKg, direction: index < 2 ? -1 : 1, big: index == 0 || index == 3) } label: {
            Text(label).frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
          }.accessibilityLabel("\(label) \(basis.unit)").accessibilityIdentifier("workout-weight-step-\(index)")
        }
      }.buttonStyle(GymInstrumentButtonStyle()).font(.body.monospacedDigit())
      HStack(spacing: RoomSpace.related) {
        Button { workout.reps = max(1, workout.reps - 1) } label: {
          Image(systemName: "minus").frame(width: 56, height: 56).contentShape(Rectangle())
        }.accessibilityLabel("Fewer reps").accessibilityIdentifier("workout-reps-minus").disabled(workout.reps <= 1)
        Button(action: edit) {
          Text(GymCount.of(workout.reps, "rep")).font(.title3.monospacedDigit())
            .contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion, value: Double(workout.reps)))
            .roomMotion(workout.reps).frame(maxWidth: .infinity, minHeight: 56).contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(GymPalette.ink).accessibilityIdentifier("workout-reps")
        Button { workout.reps = min(99, workout.reps + 1) } label: {
          Image(systemName: "plus").frame(width: 56, height: 56).contentShape(Rectangle())
        }.accessibilityLabel("More reps").accessibilityIdentifier("workout-reps-plus").disabled(workout.reps >= 99)
      }.buttonStyle(GymInstrumentButtonStyle()).font(.title3.weight(.medium))
      Button { workout.logSet() } label: {
        Text("Log set").font(.headline).frame(maxWidth: .infinity, minHeight: 32)
      }.modifier(RoomPrimaryStyle(room: .gym)).disabled(!workout.canLog)
        .accessibilityLabel(Self.spokenLog(workout.weightKg, reps: workout.reps))
        .accessibilityIdentifier("workout-log")
    }.dynamicTypeSize(...DynamicTypeSize.accessibility1)
      .disabled(workout.paging || workout.finishing || workout.finishQueued || workout.gym.accountTransition)
      .sensoryFeedback(.selection, trigger: workout.adjustments)
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
  let assembly: () -> Void
  let fix: (TrainingSet) -> Void
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
    func page(_ id: ID<Exercise>) -> UIHostingController<WorkoutLedger> {
      let view = WorkoutLedger(gym: parent.gym, workout: parent.workout, exerciseId: id, assembly: parent.assembly, fix: parent.fix)
      if let page = pages[id] { page.rootView = view; return page }
      let page = UIHostingController(rootView: view); pages[id] = page; return page
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
