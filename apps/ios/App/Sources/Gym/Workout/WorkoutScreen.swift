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
  @State var keypad: WorkoutKeypad.Field?
  @State var finishTask: Task<Void, Never>?
  @State var idleTimerWasDisabled = false
  @State var awake = false

  init(gym: GymModel) { self.gym = gym; workout = gym.workout }
  var navigation: some View {
    NavigationStack {
      Group {
        if let session = workout.session {
          if session.isOpen { live(session) }
          else { saved(session) }
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
      .navigationTitle(workout.session?.name ?? Readout.noRoutine)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if workout.session?.isOpen == true {
          ToolbarItem(placement: .topBarLeading) {
            Button("This session", systemImage: "list.bullet") { assembly = true }.labelStyle(.iconOnly)
              .accessibilityIdentifier("workout-assembly")
          }
          ToolbarItem(placement: .topBarTrailing) {
            Button(workout.finishing ? "Finishing…" : "Finish") {
              finishTask = Task { await workout.finish(); updateAwake() }
            }.disabled(workout.finishing || workout.paging || gym.accountTransition || gym.readFailed)
              .accessibilityIdentifier("workout-finish")
          }
        }
      }
    }
  }
  var body: some View {
    navigation.modifier(GymPage())
    .accessibilityIdentifier("gym-workout")
    .sheet(isPresented: $assembly, onDismiss: {
      if addAfterAssembly { addAfterAssembly = false; addMovement = true }
    }) {
      WorkoutAssembly(workout: workout, add: { addAfterAssembly = true; assembly = false })
    }
    .sheet(isPresented: $addMovement) { WorkoutMovementPicker(gym: gym, workout: workout) }
    .sheet(isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } })) {
      if let set = fixing { WorkoutFixSheet(gym: gym, set: set, routine: workout.session?.plan?.routine) }
    }
    .sheet(isPresented: Binding(get: { keypad != nil }, set: { if !$0 { keypad = nil } })) {
      if let keypad {
        WorkoutKeypadSheet(field: keypad, value: keypad == .weight ? workout.weightKg : Double(workout.reps)) { value in
          if keypad == .weight { workout.weightKg = value } else { workout.reps = Int(value) }
        }
      }
    }
    .sheet(isPresented: Binding(get: { workout.deviation != nil && !assembly && !addMovement }, set: { if !$0 { workout.resolveDeviation(save: false) } })) {
      if let offer = workout.deviation { WorkoutDeviationSheet(workout: workout, offer: offer) }
    }
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
    .onChange(of: gym.readFailed) { _, failed in if !failed { workout.reconcile() } }
    .onChange(of: gym.account) { _, _ in finishTask?.cancel(); workout.accountChanged(); updateAwake() }
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
          Button("Add movement", systemImage: "plus") { addMovement = true }.buttonStyle(.borderedProminent).foregroundStyle(GymPalette.onAccent)
            .accessibilityIdentifier("workout-add")
        }
      } else {
        movementHead
        if !typeSize.isAccessibilitySize { WorkoutElapsed(workout: workout) }
        WorkoutPager(gym: gym, workout: workout, fix: { fixing = $0 })
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if workout.selected != nil || workout.message != nil || gym.workoutNotice != nil || gym.error != nil || gym.readFailed || !gym.undoOffers.isEmpty {
        VStack(spacing: 8) {
          WorkoutNotice(gym: gym, message: workout.message, dismiss: { workout.message = nil })
          if workout.selected != nil {
            WorkoutRack(workout: workout, edit: { keypad = $0 })
          }
        }.frame(maxWidth: .infinity).padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8).background(GymPalette.canvas)
      }
    }
  }
  var movementHead: some View {
    VStack(spacing: 2) {
      let position = workout.walk.order.firstIndex { $0 == workout.selected } ?? 0
      HStack {
        Button("Previous movement", systemImage: "chevron.left") { workout.select(workout.walk.order[position - 1]) }
          .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).disabled(position == 0 || workout.paging)
          .accessibilityIdentifier("workout-previous")
        Button { assembly = true } label: {
          Text(gym.catalogue.find(workout.selected ?? ID("missing"))?.name ?? "Movement")
            .font(typeSize.isAccessibilitySize ? .caption.weight(.bold) : .title2.weight(.bold))
            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity)
        }.buttonStyle(.plain).accessibilityHint("Open this session’s movements")
        Button("Next movement", systemImage: "chevron.right") { workout.select(workout.walk.order[position + 1]) }
          .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
          .disabled(position + 1 >= workout.walk.order.count || workout.paging).accessibilityIdentifier("workout-next")
      }
      if workout.walk.order.count > 1 { Text("Movement \(position + 1) of \(workout.walk.order.count)").font(.caption2).foregroundStyle(GymPalette.inkDim) }
    }.padding(.horizontal, 16)
  }
  func saved(_ session: Session) -> some View {
    SessionDetailScreen(gym: gym, sessionID: session.id)
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
  let fix: (TrainingSet) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    let sets = workout.sets.filter { $0.exerciseId == exerciseId }
    let working = sets.filter { $0.kind == "working" }.count
    let targets = workout.session?.plan?.entries.first { $0.exerciseId == exerciseId }?.sets ?? []
    let pending = gym.workoutDeviceSets(workout.sets)
    ScrollViewReader { scroll in
    List {
      if typeSize.isAccessibilitySize { Section { WorkoutElapsed(workout: workout) }.listRowBackground(GymPalette.canvas) }
      if !targets.isEmpty {
        Section {
          ScrollView(.horizontal) {
            HStack(spacing: 12) {
              ForEach(Array(targets.enumerated()), id: \.offset) { index, target in
                VStack(spacing: 4) {
                  Label("Set \(index + 1)", systemImage: index < working ? "checkmark.circle.fill" : index == working ? "circle.inset.filled" : "circle")
                    .foregroundStyle(index < working ? GymPalette.done : index == working ? GymPalette.accent : GymPalette.inkDim)
                  Text(Readout.setTarget(target)).font(.caption.monospacedDigit())
                }.font(.caption).accessibilityElement(children: .combine)
              }
            }.padding(.vertical, 4)
          }.accessibilityIdentifier("workout-slots")
        }.listRowBackground(GymPalette.canvas)
      }
      if let last = gym.log?.lastTime(for: exerciseId), let top = last.sets.last {
        Section {
          Text("Last time · \(Readout.weight(top.weightKg)) kg × \(top.reps)")
            .font(.subheadline).foregroundStyle(GymPalette.inkDim)
        }.listRowBackground(GymPalette.canvas)
      }
      Section {
        ForEach(Array(sets.enumerated()), id: \.element.id) { index, set in
          let ordinal = sets.prefix(index + 1).filter { $0.kind == "working" }.count
          let marker = set.kind == "working" ? "\(ordinal)" : String(set.kind.prefix(1)).uppercased()
          Button { fix(set) } label: {
            HStack {
              Text(marker)
                .font(.body.monospacedDigit()).frame(minWidth: 24)
              Image(systemName: "checkmark").foregroundStyle(GymPalette.done)
              VStack(alignment: .leading, spacing: 4) {
                Text("\(Readout.weight(set.weightKg)) kg × \(set.reps)").font(.body.monospacedDigit())
                if pending.contains(set.id) { Text("on this device").font(.caption).foregroundStyle(GymPalette.inkDim) }
              }
              Spacer()
            }.frame(minHeight: 44).foregroundStyle(GymPalette.ink)
          }.disabled(workout.paging || workout.finishing || workout.finishQueued || gym.accountTransition)
            .accessibilityLabel("\(set.kind == "working" ? "Set \(ordinal)" : set.kind.capitalized), logged, \(Readout.weight(set.weightKg)) kg, \(set.reps) reps\(pending.contains(set.id) ? ", on this device" : "")")
            .accessibilityHint("Correct this set").accessibilityIdentifier("workout-set-\(set.id.record)")
        }
        Group {
        if typeSize.isAccessibilitySize {
          VStack(alignment: .leading, spacing: 4) {
            Text("Set \(working + 1) · Current set").font(.caption2.weight(.semibold))
            Text(working < targets.count ? "Target · \(Readout.setTarget(targets[working]))" : "You decide the numbers at the rack.")
              .font(.subheadline).foregroundStyle(GymPalette.inkDim)
          }.frame(maxWidth: .infinity, alignment: .leading)
        } else { HStack {
          Text("\(working + 1)").font(.body.monospacedDigit()).frame(minWidth: 24)
          VStack(alignment: .leading) {
            Text("Current set").font(.body.weight(.semibold))
            if working < targets.count { Text("Target · \(Readout.setTarget(targets[working]))").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
            else { Text("You decide the numbers at the rack.").font(.subheadline).foregroundStyle(GymPalette.inkDim) }
          }
          Spacer()
          Image(systemName: "circle.fill").font(.caption).foregroundStyle(.tint)
        } }
        }.frame(minHeight: 44).accessibilityElement(children: .combine).accessibilityIdentifier("workout-current-set").id("current")
        if working + 1 < targets.count {
          ForEach((working + 1)..<targets.count, id: \.self) { index in
            HStack {
              Text("\(index + 1)").frame(minWidth: 24)
              Text(Readout.setTarget(targets[index])); Spacer(); Text("planned")
            }.font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim).frame(minHeight: 44)
              .accessibilityLabel("Set \(index + 1), planned, \(Readout.setTarget(targets[index]))")
          }
        }
      }.listRowBackground(GymPalette.card)
      Color.clear.frame(height: 32).listRowSeparator(.hidden).listRowBackground(GymPalette.canvas).accessibilityHidden(true)
    }.listStyle(.plain).modifier(GymPage())
      .onAppear { scroll.scrollTo("current", anchor: .bottom) }
      .onChange(of: sets.count) { _, _ in scroll.scrollTo("current", anchor: .bottom) }
    }
  }
}

struct WorkoutElapsed: View {
  let workout: WorkoutState
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      if let session = workout.session {
        let clocks = WorkoutClocks(session: session, sets: workout.sets,
                                   now: Instant(ms: Int64(context.date.timeIntervalSince1970 * 1_000)))
        HStack(spacing: 16) {
          Label(WorkoutClocks.reading(clocks.workoutMs), systemImage: "clock")
            .accessibilityLabel("Workout time").accessibilityValue(WorkoutClocks.reading(clocks.workoutMs))
          Label(WorkoutClocks.reading(clocks.sinceSetMs), systemImage: "stopwatch")
            .accessibilityLabel(clocks.sinceSetName).accessibilityValue(WorkoutClocks.reading(clocks.sinceSetMs))
        }.font(.subheadline.monospacedDigit()).foregroundStyle(GymPalette.inkDim).padding(.bottom, 8)
      }
    }
  }
}

struct WorkoutRack: View {
  @Bindable var workout: WorkoutState
  let edit: (WorkoutKeypad.Field) -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    VStack(spacing: 8) {
      if typeSize.isAccessibilitySize {
        ScrollView { controls }.frame(height: 220)
      } else { controls }
      Button { workout.logSet() } label: { Text("Log set").frame(maxWidth: .infinity, minHeight: 44) }
        .buttonStyle(.borderedProminent).foregroundStyle(GymPalette.onAccent).disabled(!workout.canLog).accessibilityIdentifier("workout-log")
    }.disabled(workout.paging || workout.finishing || workout.finishQueued || workout.gym.accountTransition)
  }
  var controls: some View {
    VStack(spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Button { edit(.weight) } label: {
          Text(Readout.weight(workout.weightKg)).modifier(GymNumeral())
            .monospacedDigit().minimumScaleFactor(0.5).lineLimit(1)
        }.buttonStyle(.plain).accessibilityLabel("Weight, \(Readout.weight(workout.weightKg)) kilograms")
          .accessibilityIdentifier("workout-weight")
        if !typeSize.isAccessibilitySize { Text("kg").foregroundStyle(GymPalette.inkDim); Spacer() }
      }.frame(maxWidth: .infinity, alignment: .leading)
      if typeSize.isAccessibilitySize { Text("kg").foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity, alignment: .leading) }
      LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: typeSize.isAccessibilitySize ? 2 : 4), spacing: 8) {
        ForEach(0..<4) { index in
          Button(WeightLadder.labels(workout.weightKg)[index]) {
            workout.weightKg = WeightLadder.bump(workout.weightKg, direction: index < 2 ? -1 : 1, big: index == 0 || index == 3)
          }.buttonStyle(.bordered).frame(maxWidth: .infinity, minHeight: 44)
            .accessibilityLabel("\(WeightLadder.labels(workout.weightKg)[index]) kilograms")
        }
      }.font(.body.monospacedDigit())
      ViewThatFits(in: .horizontal) {
      HStack {
        Button("Fewer reps", systemImage: "minus") { workout.reps = max(1, workout.reps - 1) }.labelStyle(.iconOnly)
          .frame(minWidth: 44, minHeight: 44).buttonStyle(.bordered)
        Button("\(workout.reps) reps") { edit(.reps) }.font(.title3.monospacedDigit()).frame(maxWidth: .infinity, minHeight: 44)
          .accessibilityIdentifier("workout-reps")
        Button("More reps", systemImage: "plus") { workout.reps = min(99, workout.reps + 1) }.labelStyle(.iconOnly)
          .frame(minWidth: 44, minHeight: 44).buttonStyle(.bordered)
        Picker("Set kind", selection: $workout.kind) {
          ForEach(SetKind.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
        }.pickerStyle(.menu).accessibilityIdentifier("workout-kind")
      }
      VStack {
        HStack {
          Button("Fewer reps", systemImage: "minus") { workout.reps = max(1, workout.reps - 1) }.labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
          Button("\(workout.reps) reps") { edit(.reps) }.frame(maxWidth: .infinity, minHeight: 44)
          Button("More reps", systemImage: "plus") { workout.reps = min(99, workout.reps + 1) }.labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
        }
        Picker("Set kind", selection: $workout.kind) { ForEach(SetKind.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }.pickerStyle(.menu)
      }
      }
    }
  }
}

struct WorkoutNotice: View {
  enum Message: Equatable {
    case local(String), notice(String, String), error(String)
    var text: String {
      switch self { case .local(let text), .error(let text), .notice(_, let text): text }
    }
  }
  let gym: GymModel
  let message: String?
  let dismiss: () -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  var shown: Message? {
    if let message { return .local(message) }
    if let notice = gym.notices.last, let message = gym.workoutNotice { return .notice(notice.id, message) }
    return gym.error.map(Message.error)
  }
  func dismissMessage(_ shown: Message) {
    switch shown {
    case .local(let text):
      dismiss()
      if gym.error == text { gym.error = nil; gym.refusal = nil }
    case .notice(let id, _): gym.dismissNotice(id)
    case .error(let text):
      if gym.error == text { gym.error = nil; gym.refusal = nil }
    }
  }
  var body: some View {
    VStack(spacing: 4) {
      if let banner = gym.workoutBanner(gym.workoutStrandedSets.count) {
        let line = Text(banner).font(.footnote).foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity, alignment: .leading)
        if typeSize.isAccessibilitySize { ScrollView { line }.frame(height: 100) }
        else { line }
      }
      WorkoutAdoptionBand(gym: gym)
      if let shown {
        HStack {
          Text(shown.text).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
          Button("Dismiss message", systemImage: "xmark") { dismissMessage(shown) }
            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
        }.accessibilityAction(named: "Dismiss") {
          dismissMessage(shown)
        }
          .accessibilityIdentifier("workout-refusal")
      }
      if let offer = gym.undoOffers.last {
        HStack {
          Text(gym.undoOffers.count == 1 ? "Change deleted" : "\(gym.undoOffers.count) changes deleted").font(.footnote)
          Spacer(); Button("Undo") { _ = gym.undo(offer.id) }.frame(minHeight: 44)
        }.accessibilityIdentifier("workout-undo")
      }
      if gym.readFailed { Button("Try again") { gym.workout.retryRead() }.font(.footnote) }
    }.onChange(of: message ?? gym.workoutNotice ?? gym.error) { _, message in
      if let message { UIAccessibility.post(notification: .announcement, argument: message) }
    }
  }
}

extension Instant {
  nonisolated var date: Date { Date(timeIntervalSince1970: Double(ms) / 1_000) }
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
