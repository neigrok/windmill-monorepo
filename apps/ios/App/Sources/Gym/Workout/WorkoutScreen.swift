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
    NavigationStack {
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
                 subtitle: workout.session.flatMap { $0.isOpen ? $0.startedAt.date.formatted(date: .omitted, time: .shortened) : nil })
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if workout.session?.isOpen == true {
          ToolbarItem(placement: .topBarLeading) {
            Button("This session", systemImage: "list.bullet") { assembly = true }.labelStyle(.iconOnly)
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
        }.buttonStyle(.plain).foregroundStyle(GymPalette.ink).accessibilityHint("Open this session’s movements")
        if let position {
          WorkoutCircle(title: "Next movement", symbol: "chevron.right") { workout.select(order[position.index + 1]) }
            .disabled(position.index + 1 >= position.count || workout.paging).accessibilityIdentifier("workout-next")
        }
      }
      if !typeSize.isAccessibilitySize { WorkoutFacts(workout: workout, plan: workout.entry?.sets) }
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

// One movement's sets in the order they were logged, then the current set and the plan still ahead.
struct WorkoutLedger: View {
  let gym: GymModel
  let workout: WorkoutState
  let exerciseId: ID<Exercise>
  let fix: (TrainingSet) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    let sets = workout.sets.filter { $0.exerciseId == exerciseId }
    let working = sets.filter { $0.kind == "working" }.count
    let targets = workout.session?.plan?.entries.first { $0.exerciseId == exerciseId }?.sets ?? []
    let current = working < targets.count ? Readout.setTarget(targets[working]) : Readout.openTarget
    let unsent = gym.unsentSets(workout.sets)
    ScrollViewReader { scroll in
    List {
      if typeSize.isAccessibilitySize {
        Section {
          WorkoutFacts(workout: workout, plan: targets, position: workout.walk.position(of: exerciseId)).frame(maxWidth: .infinity)
        }.listRowBackground(GymPalette.canvas)
      }
      Section {
        ForEach(Array(sets.enumerated()), id: \.element.id) { index, set in
          let ordinal = sets.prefix(index + 1).filter { $0.kind == "working" }.count
          let name = set.kind == "working" ? "Set \(ordinal)" : set.kind.capitalized
          Button { fix(set) } label: {
            WorkoutLedgerRow(marker: SetRow.marker(set, in: sets),
                             readout: Readout.effort(weightKg: set.weightKg, reps: set.reps),
                             state: unsent.contains(set.id) ? .unsent : .sent)
          }.disabled(workout.paging || workout.finishing || workout.finishQueued || gym.accountTransition)
            .accessibilityLabel("\(name), logged, \(Readout.weight(set.weightKg)) kg, \(set.reps) reps\(unsent.contains(set.id) ? ", on this phone" : "")")
            .accessibilityHint("Correct this set").accessibilityIdentifier("workout-set-\(set.id.record)")
        }
        WorkoutLedgerRow(marker: "\(working + 1)", readout: current, state: .current)
          .accessibilityElement(children: .combine).accessibilityLabel("Set \(working + 1), current, target \(current)")
          .accessibilityIdentifier("workout-current-set").id("current")
        if working + 1 < targets.count {
          ForEach((working + 1)..<targets.count, id: \.self) { index in
            WorkoutLedgerRow(marker: "\(index + 1)", readout: Readout.setTarget(targets[index]), state: .planned)
              .accessibilityElement(children: .ignore).accessibilityLabel("Set \(index + 1), planned, \(Readout.setTarget(targets[index]))")
          }
        }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped).listSectionSpacing(.compact)
      .contentMargins(.bottom, RoomSpace.minimumTarget, for: .scrollContent).modifier(GymPage()).modifier(SoftTopEdge())
      .onAppear { scroll.scrollTo("current", anchor: .bottom) }
      .onChange(of: sets.count) { _, _ in scroll.scrollTo("current", anchor: .bottom) }
    }
  }
}

// One line of the ledger: the set's place, its numbers, and its state at the trailing edge.
struct WorkoutLedgerRow: View {
  enum State { case sent, unsent, current, planned }
  let marker: String
  let readout: String
  let state: State
  var body: some View {
    HStack(spacing: RoomSpace.inset) {
      Text(marker).foregroundStyle(state == .current ? GymPalette.accent : state == .planned ? GymPalette.inkFaint : GymPalette.inkDim)
        .frame(minWidth: 24, alignment: .leading)
      Text(readout).foregroundStyle(state == .planned ? GymPalette.inkFaint : GymPalette.ink)
      Spacer(minLength: RoomSpace.related)
      switch state {
      case .sent: Image(systemName: "checkmark").foregroundStyle(GymPalette.done)
      case .unsent: Image(systemName: "iphone").foregroundStyle(GymPalette.inkDim)
      case .current: Circle().fill(GymPalette.accent).frame(width: RoomSpace.related, height: RoomSpace.related)
      case .planned: EmptyView()
      }
    }.font(.body.monospacedDigit()).frame(minHeight: RoomSpace.minimumTarget)
  }
}

// The movement's plan and the one clock line under its name, led by its place in the walk where the head has no room for it.
struct WorkoutFacts: View {
  let workout: WorkoutState
  let plan: [SetTarget]?
  var position: (index: Int, count: Int)?
  static func eyebrow(_ position: (index: Int, count: Int)) -> some View {
    Text("Movement \(position.index + 1) of \(position.count)").font(.caption).textCase(.uppercase).foregroundStyle(GymPalette.inkFaint)
  }
  var body: some View {
    VStack(spacing: RoomSpace.small) {
      if let position { Self.eyebrow(position) }
      if let plan, !plan.isEmpty {
        Text("plan \(Readout.target(plan))").font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.inkDim)
      }
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
  var body: some View {
    VStack(spacing: RoomSpace.related) {
      WeightInstrument(weightKg: $workout.weightKg, identifier: "workout-weight", alignment: .center) { edit(.weight) }
      HStack(spacing: RoomSpace.related) {
        WorkoutCircle(title: "Fewer reps", symbol: "minus") { workout.reps = max(1, workout.reps - 1) }
        Button { edit(.reps) } label: {
          Text(GymCount.of(workout.reps, "rep")).font(.title3).monospacedDigit()
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
