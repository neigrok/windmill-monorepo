import SwiftUI
import UIKit
import GymDomain
import DomainKit
import SyncCore

struct WorkoutScreen: View {
  let gym: GymModel
  @Bindable var workout: WorkoutState
  @Environment(\.scenePhase) var scenePhase
  @Environment(\.dynamicTypeSize) var typeSize
  @State var assembly = false
  @State var addMovement = false
  @State var addAfterAssembly = false
  @State var fixing: TrainingSet?
  @State var keypad: SetKeypad.Field?
  @State var finishTask: Task<Void, Never>?
  @State var idleTimerWasDisabled = false
  @State var awake = false

  init(gym: GymModel) { self.gym = gym; workout = gym.workout }
  var navigation: some View {
    let dates = gym.dates
    return NavigationStack {
      Group {
        if let session = workout.session {
          if session.isOpen { live(session) }
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
                 subtitle: workout.session.flatMap { session in session.isOpen ? dates.time(session.startedAt) : nil })
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if workout.session?.isOpen == true {
          ToolbarItem(placement: .topBarLeading) {
            Button("This workout", systemImage: "list.bullet") { assembly = true }.labelStyle(.iconOnly)
              .accessibilityIdentifier("workout-assembly")
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
  var body: some View {
    navigation.modifier(GymPage())
    .accessibilityIdentifier("gym-workout")
    .modifier(WorkoutActivityFixtureProbe(gym: gym))
    .sheet(isPresented: $assembly, onDismiss: {
      if addAfterAssembly { addAfterAssembly = false; addMovement = true }
    }) {
      WorkoutAssembly(workout: workout, add: { addAfterAssembly = true; assembly = false })
    }
    .sheet(isPresented: $addMovement) { WorkoutMovementPicker(gym: gym, workout: workout) }
    .sheet(isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } })) {
      if let set = fixing { SetEditor(gym: gym, set: set, routine: workout.session?.plan?.routine, identifier: "workout-fix") }
    }
    .sheet(isPresented: Binding(get: { keypad != nil }, set: { if !$0 { keypad = nil } })) {
      if let keypad {
        SetKeypadSheet(field: keypad, value: keypad == .weight ? workout.weightKg : Double(workout.reps)) { value in
          if keypad == .weight { workout.weightKg = value } else { workout.reps = Int(value) }
        }
      }
    }
    .modifier(WorkoutDeviationOffer(workout: workout, held: assembly || addMovement))
    .sheet(isPresented: Binding(get: { workout.receipt != nil }, set: { if !$0 { workout.closeReceipt() } })) {
      if let receipt = workout.receipt { WorkoutReceipt(gym: gym, receipt: receipt) }
    }
    .onChange(of: keypad) { _, field in workout.rackEditing = field != nil }
    .onAppear {
      if workout.sessionId != gym.openSession?.id && gym.openSession != nil { workout.restore() }
      workout.reconcile(); updateAwake()
      gym.telemetry.event("gym_screen_viewed", properties: ["screen": "workout"])
    }
    .onChange(of: gym.sets) { _, _ in workout.reconcile() }
    .onChange(of: gym.openSession?.id) { _, _ in workout.reconcile(); updateAwake() }
    .onChange(of: gym.notices.map(\.id)) { _, _ in workout.reconcile() }
    .onChange(of: workout.message ?? gym.workoutNotice ?? gym.error) { _, message in
      if let message { UIAccessibility.post(notification: .announcement, argument: message) }
    }
    .onChange(of: gym.readFailed) { _, failed in if !failed { workout.reconcile() } }
    .onChange(of: gym.account) { _, _ in finishTask?.cancel(); workout.accountChanged(); updateAwake() }
    .onChange(of: gym.accountTransition) { _, changing in if changing { finishTask?.cancel() } }
    .onChange(of: scenePhase) { _, phase in
      if phase == .background { finishTask?.cancel() }
      updateAwake()
    }
    .onDisappear { workout.rackEditing = false; finishTask?.cancel(); releaseAwake() }
  }

  func live(_ session: Session) -> some View {
    VStack(spacing: 0) {
      if workout.walk.order.isEmpty {
        ContentUnavailableView {
          Label("Choose your first movement", systemImage: "dumbbell")
        } description: {
          Text("You decide the numbers at the rack.")
        } actions: {
          Button("Add movement", systemImage: "plus") { addMovement = true }.modifier(RoomPrimaryStyle(room: .gym))
            .accessibilityIdentifier("workout-add")
        }
      } else {
        movementHead
        WorkoutPager(gym: gym, workout: workout, fix: { fixing = $0 })
      }
    }
    .modifier(GymPage())
    .reachBand(spacing: 0) {
      VStack(spacing: 0) {
        GymTransient(gym: gym, message: workout.message, dismiss: { workout.message = nil }, noticeMessage: gym.workoutNotice,
                     retry: { gym.workout.retryRead() }, errorIdentifier: "workout-refusal", undoIdentifier: "workout-undo")
          .modifier(BoundedBand())
        if workout.selected != nil {
          WorkoutRack(workout: workout, edit: { keypad = $0 })
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
  // The eyebrow over the name, Previous and Next beside it; at accessibility sizes the eyebrow, plan and clocks move into the ledger.
  var movementHead: some View {
    let order = workout.walk.order, position = workout.walk.position(of: workout.selected)
    return VStack(spacing: RoomSpace.small) {
      if let position, !typeSize.isAccessibilitySize { WorkoutFacts.eyebrow(position) }
      HStack(spacing: RoomSpace.related) {
        if let position {
          WorkoutCircle(title: "Previous movement", symbol: "chevron.left") { workout.select(order[position.index - 1]) }
            .disabled(position.index == 0 || workout.paging).accessibilityIdentifier("workout-previous")
        }
        Button { assembly = true } label: {
          Text(gym.catalogue.find(workout.selected ?? ID("missing"))?.name ?? "Movement")
            .font(typeSize.isAccessibilitySize ? .caption.weight(.bold) : .title2.weight(.bold))
            .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity)
        }.buttonStyle(.plain).foregroundStyle(GymPalette.ink).accessibilityHint("Open this workout’s movements")
        if let position {
          WorkoutCircle(title: "Next movement", symbol: "chevron.right") { workout.select(order[position.index + 1]) }
            .disabled(position.index + 1 >= position.count || workout.paging).accessibilityIdentifier("workout-next")
        }
      }
      if !typeSize.isAccessibilitySize { WorkoutFacts(workout: workout, planLine: workout.selected.flatMap { workout.ledger($0).planLine }) }
    }.padding(.horizontal, RoomSpace.inset).padding(.bottom, RoomSpace.inset)
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

// One movement's sets in the order they were logged, then the current set and the plan still ahead. Logging a set turns the
// current row into it and scrolls the next row into the current slot (docs/design/ios/ios-redesign.md §5 Motion).
struct WorkoutLedger: View {
  let gym: GymModel
  let workout: WorkoutState
  let exerciseId: ID<Exercise>
  let fix: (TrainingSet) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  var body: some View {
    let ledger = workout.ledger(exerciseId)
    let unsent = gym.unsentSets(workout.sets)
    let fixable = !(workout.paging || workout.finishing || workout.finishQueued || gym.accountTransition)
    ScrollViewReader { scroll in
    List {
      if typeSize.isAccessibilitySize {
        Section {
          WorkoutFacts(workout: workout, planLine: ledger.planLine, position: workout.walk.position(of: exerciseId)).frame(maxWidth: .infinity)
        }.listRowBackground(GymPalette.canvas)
      }
      // Every row is the same view whatever its place, so the row a set is logged into keeps its identity and its mark: its
      // modifiers stay put, and only a logged set is a button that opens Fix set.
      Section {
        ForEach(ledger.rows) { row in
          WorkoutLedgerRow(row: row, unsent: row.set.map { unsent.contains($0.id) } ?? false)
            .contentShape(Rectangle())
            .onTapGesture { if let set = row.set, fixable { fix(set) } }
            .accessibilityRemoveTraits(row.set == nil ? [.isButton, .isSelected] : .isSelected)
            .accessibilityAddTraits(row.set == nil ? .isStaticText : .isButton)
            .accessibilityRespondsToUserInteraction(row.set != nil)
            .accessibilityHint(row.set == nil ? "" : "Opens Fix set.")
            .accessibilityAction { if let set = row.set, fixable { fix(set) } }
        }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped).listSectionSpacing(.compact)
      .contentMargins(.bottom, RoomSpace.minimumTarget, for: .scrollContent).modifier(GymPage()).modifier(SoftEdge(.top))
      .onAppear { scroll.scrollTo(ledger.current.id, anchor: .bottom) }
      .onChange(of: ledger.sets.count) { _, _ in
        withAnimation(reduceMotion ? nil : .spring) { scroll.scrollTo(ledger.current.id, anchor: .bottom) }
      }
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
    HStack(spacing: RoomSpace.inset) {
      Text(row.marker).foregroundStyle(row.place == .current ? GymPalette.accent : row.place == .planned ? GymPalette.inkFaint : GymPalette.inkDim)
        .frame(minWidth: 24, alignment: .leading)
      Text(row.reading).foregroundStyle(row.place == .planned ? GymPalette.inkFaint : GymPalette.ink)
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
      let name = set.kind == SetKind.working.rawValue ? "Set \(row.marker)" : set.kind.capitalized
      return "\(name), logged, \(Readout.weight(set.weightKg)) kilograms, \(GymCount.of(set.reps, "rep"))\(unsent ? ", on this phone" : "")"
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

// The movement's plan line, where it says what the ledger does not, and the one clock line under its name, led by its place
// in the walk where the head has no room for it.
struct WorkoutFacts: View {
  let workout: WorkoutState
  let planLine: String?
  var position: (index: Int, count: Int)?
  static func eyebrow(_ position: (index: Int, count: Int)) -> some View {
    Text("Movement \(position.index + 1) of \(position.count)").font(.caption).textCase(.uppercase).foregroundStyle(GymPalette.inkFaint)
  }
  var body: some View {
    VStack(spacing: RoomSpace.small) {
      if let position { Self.eyebrow(position) }
      if let planLine { Text(planLine).font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.inkDim) }
      TimelineView(.periodic(from: .now, by: 1)) { _ in
        if let clocks = workout.clocks {
          HStack(spacing: 0) {
            Text(WorkoutClocks.reading(clocks.workoutMs))
              .accessibilityLabel("Workout time").accessibilityValue(WorkoutClocks.reading(clocks.workoutMs))
            if let since = clocks.sinceSetMs {
              Text(" · \(WorkoutClocks.reading(since)) since last set")
                .accessibilityLabel("Since last set").accessibilityValue(WorkoutClocks.reading(since))
            }
          }.font(.footnote.monospacedDigit()).foregroundStyle(GymPalette.inkDim)
        }
      }
    }
  }
}

// A 44 pt glass circle holding one symbol: Previous and Next beside the movement, fewer and more reps beside the count.
struct WorkoutCircle: View {
  let title: String
  let symbol: String
  let action: () -> Void
  @Environment(\.isEnabled) var enabled
  var body: some View {
    Button(title, systemImage: symbol, action: action).labelStyle(.iconOnly).buttonStyle(RoomSeatStyle())
      .foregroundStyle(enabled ? GymPalette.ink : GymPalette.inkFaint)
  }
}

// The rack never scrolls and never clips: its labels stop growing at the first accessibility size, where the ladder
// stands two by two and the ledger above gives up its height first.
struct WorkoutRack: View {
  @Bindable var workout: WorkoutState
  let edit: (SetKeypad.Field) -> Void
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  var body: some View {
    VStack(spacing: RoomSpace.related) {
      WeightInstrument(weightKg: $workout.weightKg, identifier: "workout-weight") { edit(.weight) }
      HStack(spacing: RoomSpace.related) {
        WorkoutCircle(title: "Fewer reps", symbol: "minus") { workout.reps = max(1, workout.reps - 1) }
        Button { edit(.reps) } label: {
          Text(GymCount.of(workout.reps, "rep")).font(.title3).monospacedDigit()
            .contentTransition(RoomMotion.numeral(reduceMotion: reduceMotion, value: Double(workout.reps)))
            .roomMotion(workout.reps)
            .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget)
        }.buttonStyle(.plain).foregroundStyle(GymPalette.ink).accessibilityIdentifier("workout-reps")
        WorkoutCircle(title: "More reps", symbol: "plus") { workout.reps = min(99, workout.reps + 1) }
      }
      Button { workout.logSet() } label: { Text("Log set").frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget) }
        .modifier(RoomPrimaryStyle(room: .gym)).disabled(!workout.canLog)
        .accessibilityLabel("Log set, \(Readout.weight(workout.weightKg)) kilograms, \(GymCount.of(workout.reps, "rep"))")
        .accessibilityIdentifier("workout-log")
    }.dynamicTypeSize(...DynamicTypeSize.accessibility1)
      .disabled(workout.paging || workout.finishing || workout.finishQueued || workout.gym.accountTransition)
  }
}

struct WorkoutPager: UIViewControllerRepresentable {
  let gym: GymModel
  let workout: WorkoutState
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
      let view = WorkoutLedger(gym: parent.gym, workout: parent.workout, exerciseId: id, fix: parent.fix)
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
      guard parent.workout.deviation == nil, !parent.workout.finishing,
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
