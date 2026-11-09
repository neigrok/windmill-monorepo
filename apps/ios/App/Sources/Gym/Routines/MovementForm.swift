import SwiftUI
import DomainKit
import GymDomain

// A movement's targets as the form drafts them (02L.5, 02L.6): a count of sets, 0 for an open plan, over rows that keep
// their place past a smaller count, so a count stepped down and up again finds the sets it left. Straight, every set
// reads the first; varied, each set stands on its own, and a scheme that opens with differing sets opens varied. Turned
// straight again, every set takes the first's target. The count and reps run to the routine rule's bounds.
nonisolated struct TargetsDraft: Equatable, Sendable {
  static let maxSets = RoutineRules.targets.max
  // The rule bounds a target's reps, so its maximum is always set.
  static let maxReps = Int(RoutineRules.targetReps.max!)
  private(set) var rows: [SetTarget]
  private(set) var count: Int
  var varied: Bool {
    didSet {
      guard oldValue, !varied else { return }
      let first = shared
      retargetAll { $0 = first }
    }
  }

  init(sets: [SetTarget]?) {
    rows = sets ?? []
    count = rows.count
    varied = !SetTarget.straight(rows)
  }

  var isOpen: Bool { count == 0 }
  var sets: [SetTarget]? { isOpen ? nil : Array(rows.prefix(count)) }
  // The target every set shares while the scheme is straight: the first set's.
  var shared: SetTarget { isOpen ? SetTarget() : rows[0] }

  // A count grown copies the last set it has into each new place.
  mutating func setCount(_ next: Int) {
    count = min(max(next, 0), Self.maxSets)
    if count > rows.count { rows += Array(repeating: rows.last ?? SetTarget(), count: count - rows.count) }
  }
  mutating func retargetAll(_ edit: (inout SetTarget) -> Void) { for index in 0..<count { edit(&rows[index]) } }
  mutating func retarget(_ index: Int, _ edit: (inout SetTarget) -> Void) {
    guard index < count else { return }
    edit(&rows[index])
  }
}

// One movement as the form holds it: its name, equipment and dumbbell count beside the targets and rest it takes in this
// routine. `base` is the movement as the catalogue holds it, nil for one made here; the plan is its line in the routine as
// the form opened on it, an entry with no sets read as the open plan.
struct MovementFormDraft: Equatable, Identifiable {
  static let rests = [30, 60, 90, 120, 150, 180, 240, 300]
  let base: Exercise?
  let opening: Exercise
  let adding: Bool
  var name: String
  var equipment: String
  var loadCount: Int
  var targets: TargetsDraft
  var restSeconds: Int?
  let openingPlan: RoutineEntry

  init(exercise: Exercise, base: Exercise?, entry: RoutineEntry?) {
    self.base = base; opening = exercise; adding = entry == nil
    name = exercise.name; equipment = exercise.equipment
    loadCount = Equipment(exercise.equipment) == .dumbbell ? exercise.loadCount : 2
    targets = TargetsDraft(sets: entry?.sets)
    restSeconds = entry?.restSeconds
    openingPlan = RoutineEntry(exerciseId: exercise.id, sets: targets.sets, restSeconds: restSeconds)
  }

  var id: ID<Exercise> { opening.id }
  var exercise: Exercise {
    Exercise(id: id, name: NameField.movement.trimmed(name), pattern: opening.pattern, equipment: equipment,
             stepKg: base == nil ? ExerciseRules.defaultStepKg(equipment: equipment) : opening.stepKg, loadCount: loadCount, aliases: opening.aliases)
  }
  var basis: MovementEquipment { MovementEquipment(exercise) }
  var planned: RoutineEntry { RoutineEntry(exerciseId: id, sets: targets.sets, restSeconds: restSeconds) }
  var isDirty: Bool { exercise != opening || planned != openingPlan }
  var problem: String? {
    if let problem = NameField.movement.problem(name) { return problem }
    if !MovementEquipment.choices.contains(equipment) && !(Equipment(base?.equipment) == .other && Equipment(equipment) == .other) { return String(localized: "Choose equipment.") }
    if Equipment(equipment) == .dumbbell && ![1, 2].contains(loadCount) { return String(localized: "Choose one or two dumbbells.") }
    return nil
  }
}

// The movement form (02L.5, 02L.6, 02L.8), a sheet stacked over the routine editor: Name, Equipment and the dumbbell
// count; Targets as the Sets stepper, 0 reading Open, the Reps stepper, 0 reading Max, the Load field in the movement's
// basis and Varied sets, which gives each set its own section; then Rest. Cancel and Add, or Save, in the bar. Nothing
// is written until the routine saves.
struct MovementForm: View {
  let gym: GymModel
  @Binding var draft: MovementFormDraft
  let refusal: String?
  let onCancel: () -> Void
  let onCommit: () -> Bool
  @State private var discardChanges = false
  @FocusState private var nameFocused: Bool

  var title: LocalizedStringResource { draft.base == nil ? "New movement" : draft.adding ? "Add movement" : "Edit movement" }

  var body: some View {
    NavigationStack {
      Form {
        Group {
          Section {
            TextField("Name", text: $draft.name).focused($nameFocused)
              .textInputAutocapitalization(.words).autocorrectionDisabled().submitLabel(.done)
              .onSubmit { nameFocused = false }.accessibilityIdentifier("gym-movement-name")
            if let counter = NameField.movement.counter(draft.name) { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
            MovementEquipmentPicker(equipment: $draft.equipment, loadCount: $draft.loadCount, identifier: "gym-movement-equipment", count: .menu)
          } footer: {
            if draft.base != nil { Text("Name and equipment apply everywhere. Targets stay in this routine.") }
          }
          Section {
            Stepper("Sets: \(draft.targets.isOpen ? String(localized: "Open", comment: "A target of no sets: an open plan") : String(draft.targets.count))",
                    value: Binding(get: { draft.targets.count }, set: { draft.targets.setCount($0) }), in: 0...TargetsDraft.maxSets)
              .accessibilityIdentifier("gym-target-sets")
            if !draft.targets.isOpen {
              if !draft.targets.varied {
                repsStepper(draft.targets.shared.reps, identifier: "gym-target-reps") { reps in draft.targets.retargetAll { $0.reps = reps } }
                TargetLoadRow(load: Binding(get: { draft.targets.shared.weightKg }, set: { load in draft.targets.retargetAll { $0.weightKg = load } }),
                              basis: draft.basis, identifier: "gym-target-load")
              }
              Toggle("Varied sets", isOn: $draft.targets.varied).accessibilityIdentifier("gym-target-varied")
            }
          } header: { Text("Targets") } footer: {
            if Equipment(draft.equipment) != .other { Text(draft.basis.help) }
          }
          if !draft.targets.isOpen, draft.targets.varied {
            ForEach(0..<draft.targets.count, id: \.self) { index in
              Section("Set \(index + 1)") {
                TargetLoadRow(load: Binding(get: { draft.targets.rows[index].weightKg }, set: { load in draft.targets.retarget(index) { $0.weightKg = load } }),
                              basis: draft.basis, identifier: "gym-target-row-\(index + 1)-load")
                repsStepper(draft.targets.rows[index].reps, identifier: "gym-target-row-\(index + 1)-reps") { reps in draft.targets.retarget(index) { $0.reps = reps } }
              }
            }
          }
          Section("Rest") { RestPicker(selection: $draft.restSeconds, choices: MovementFormDraft.rests, identifier: "gym-target-rest") }
        }.listRowBackground(GymPalette.card)
      }.scrollDismissesKeyboard(.immediately)
        .modifier(GymPage()).accessibilityIdentifier("gym-routine-movement-editor")
        .navigationTitle(title)
        .sheetCommit(draft.adding ? "Add" : "Save", identifier: "gym-movement-editor-commit", dismissalIdentifier: "gym-movement-editor-cancel",
                     disabled: gym.accountTransition || draft.problem != nil, style: .word, dismiss: cancel, commit: commit)
        .reachBand { GymTransient(gym: gym, message: refusal, errorIdentifier: "gym-movement-editor-refusal") }
    }.modifier(GymPage()).presentationDetents([.large])
      .interactiveDismissDisabled(draft.isDirty)
      .confirmationDialog("Discard movement changes?", isPresented: $discardChanges, titleVisibility: .visible) {
        Button("Discard", role: .destructive) { discard() }
        Button("Keep editing", role: .cancel) {}
      }
      .onAppear {
        gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine_movement_editor"])
        if draft.base == nil { nameFocused = true }
      }
  }

  // Reps on the stock stepper, to the rule's most; stepped below 1 the target is Max, the plan's open reps.
  func repsStepper(_ reps: Int?, identifier: String, set: @escaping (Int?) -> Void) -> some View {
    Stepper("Reps: \(reps.map(String.init) ?? String(localized: "Max", comment: "A rep target with no fixed number: as many reps as the set allows"))", value: Binding(get: { reps ?? 0 }, set: { set($0 == 0 ? nil : $0) }), in: 0...TargetsDraft.maxReps)
      .accessibilityIdentifier(identifier)
  }

  func cancel() {
    nameFocused = false
    if draft.isDirty { discardChanges = true } else { discard() }
  }

  func discard() {
    gym.telemetry.event("gym_action", properties: ["screen": "routine_movement_editor", "action": "cancel", "outcome": "ok"])
    onCancel()
  }

  func commit() {
    nameFocused = false
    if !onCommit() { gym.telemetry.event("gym_action", properties: ["screen": "routine_movement_editor", "action": "stage", "outcome": "refused"]) }
  }
}

// A target's Load row, planned, with its own focus, so each set's field in a varied scheme reports for itself.
struct TargetLoadRow: View {
  @Binding var load: Double?
  let basis: MovementEquipment
  let identifier: String
  @FocusState private var focused: Bool

  var body: some View { LoadRow(load: $load, kind: .planned, basis: basis, focus: $focused, identifier: identifier) }
}
