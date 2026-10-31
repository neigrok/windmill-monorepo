import SwiftUI
import UIKit
import DomainKit
import GymDomain

struct RoutineMovementDraft: Equatable {
  let base: Exercise?
  let opening: Exercise
  let initialTargets: RoutineTargetDraft
  let adding: Bool
  var name: String
  var equipment: String
  var loadCount: Int
  var targets: RoutineTargetDraft

  init(exercise: Exercise, base: Exercise?, entry: RoutineEntry?) {
    self.base = base; opening = exercise; adding = entry == nil
    name = exercise.name; equipment = exercise.equipment
    loadCount = Equipment(exercise.equipment) == .dumbbell ? exercise.loadCount : 2
    initialTargets = RoutineTargetDraft(sets: entry?.sets)
    targets = initialTargets
  }

  var id: ID<Exercise> { opening.id }
  var exercise: Exercise {
    Exercise(id: id, name: NameField.movement.trimmed(name), pattern: opening.pattern, equipment: equipment,
             stepKg: base == nil ? ExerciseRules.defaultStepKg(equipment: equipment) : opening.stepKg, loadCount: loadCount, aliases: opening.aliases)
  }
  var equipmentChanged: Bool { base != nil && (equipment != base?.equipment || exercise.loadCount != base?.loadCount) }
  var isDirty: Bool { exercise != opening || targets != initialTargets }
  var problem: String? {
    if let problem = NameField.movement.problem(name) { return problem }
    if !MovementEquipment.choices.contains(equipment) && !(Equipment(base?.equipment) == .other && Equipment(equipment) == .other) { return "Choose equipment." }
    if Equipment(equipment) == .dumbbell && ![1, 2].contains(loadCount) { return "Choose one or two dumbbells." }
    return targets.refusal?.message
  }
}

struct RoutineMovementEditor: View {
  let gym: GymModel
  let refusal: String?
  let onCommit: () -> Bool
  let onCancel: () -> Void
  @Binding private var movement: RoutineMovementDraft
  @State private var discardChanges = false
  @State private var feedback = 0
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @FocusState private var focus: Focus?

  private enum Focus: Hashable { case name, sets, reps, weight, rowReps(Int), rowWeight(Int) }

  init(gym: GymModel, draft: Binding<RoutineMovementDraft>, refusal: String?, onCancel: @escaping () -> Void, onCommit: @escaping () -> Bool) {
    self.gym = gym; _movement = draft; self.refusal = refusal
    self.onCancel = onCancel; self.onCommit = onCommit
  }

  private var exercise: Exercise { movement.exercise }

  var body: some View {
    List {
      Group {
        Section {
          LabeledContent("Name") {
            TextField("Name", text: $movement.name)
              .multilineTextAlignment(.trailing).focused($focus, equals: .name)
              .textInputAutocapitalization(.words).autocorrectionDisabled()
              .accessibilityIdentifier("gym-movement-name").onSubmit { nextField() }
          }
          if let counter = NameField.movement.counter(movement.name) { Text(counter).font(.caption.monospacedDigit()).foregroundStyle(GymPalette.inkDim) }
          if !movement.name.isEmpty, let problem = NameField.movement.problem(movement.name) { refusalLine(problem) }
          MovementEquipmentPicker(equipment: $movement.equipment, loadCount: $movement.loadCount, identifier: "gym-movement-equipment")
        }
        Section {
          headField("Sets", field: .sets, placeholder: "open", focus: .sets)
          headField("Reps", field: .reps, placeholder: movement.targets.varies(.reps) ? "varies" : "max", focus: .reps)
          headField(MovementEquipment(exercise).unit, field: .weight, placeholder: movement.targets.varies(.weight) ? "varies" : "last time", focus: .weight)
        } header: { Text("Targets") } footer: {
          if Equipment(exercise.equipment) != .other {
            Text(Equipment(exercise.equipment) == .bodyweight ? "Enter added weight or a negative value for assistance. Blank means no load target." : MovementEquipment(exercise).help)
          }
        }
        Section {
          Toggle("Vary by set", isOn: $movement.targets.varyBySet)
            .disabled(!movement.targets.canChangeVariation)
        } footer: { Text("Clear sets for an open plan.") }
        if !movement.targets.isOpen && movement.targets.varyBySet {
          Section("Each set") {
            fillMenu
            ForEach(movement.targets.visibleRows.indices, id: \.self) { index in
              targetRow(index)
                .trashSwipe("Delete set") { delete(index) }
                .accessibilityAction(named: "Delete") { delete(index) }
                .contextMenu {
                  fillActions
                  Button("Delete", systemImage: "trash", role: .destructive) { delete(index) }
                }
            }
            Button { movement.targets.addSet(); feedback += 1 } label: { Label("Add set", systemImage: "plus") }
              .accessibilityIdentifier("gym-target-add-set")
            if movement.targets.atSetCeiling && movement.targets.refusal == nil { refusalLine(RoutineTargetDraft.outsideSets) }
          }
        }
      }.listRowBackground(GymPalette.card)
    }.listStyle(.insetGrouped)
    .accessibilityIdentifier("gym-routine-movement-editor")
    .modifier(GymPage())
    .navigationTitle(movement.adding ? "Add movement" : "Edit movement")
    .toolbar {
      ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel).accessibilityIdentifier("gym-movement-editor-cancel") }
    }.roomBar(.gym)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      VStack(spacing: 8) {
        if let refusal { Text(refusal).font(.subheadline).foregroundStyle(GymPalette.alarm).accessibilityIdentifier("gym-movement-editor-refusal") }
        if focus != nil {
          KeyboardBar(next: { nextField() }, nextDisabled: focus == lastFocus, doneIdentifier: "gym-target-keyboard-done") { focus = nil }
        }
        Button {
          focus = nil
          if !onCommit() { gym.telemetry.event("gym_action", properties: ["screen": "routine_movement_editor", "action": "stage", "outcome": "refused"]) }
        } label: { Text(movement.adding ? "Add" : "Done").frame(maxWidth: .infinity, minHeight: 22) }
          .modifier(RoomPrimaryStyle(room: .gym))
          .disabled(gym.accountTransition || movement.problem != nil)
          .accessibilityIdentifier("gym-movement-editor-commit")
      }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 8).background(GymPalette.canvas)
    }
    .confirmationDialog("Discard movement changes?", isPresented: $discardChanges, titleVisibility: .visible) {
      Button("Discard", role: .destructive) { discard() }
      Button("Keep editing", role: .cancel) {}
    }
    .sensoryFeedback(.selection, trigger: feedback)
    .onChange(of: movement.targets.refusal) { _, refusal in
      if let refusal {
        if movement.targets.headRefusal == nil { movement.targets.varyBySet = true }
        UIAccessibility.post(notification: .announcement, argument: refusal.message)
        gym.telemetry.event("gym_action", properties: ["screen": "routine_movement_editor", "action": "update", "item": "targets", "outcome": "refused"])
      }
    }
    .onAppear {
      gym.telemetry.event("gym_screen_viewed", properties: ["screen": "routine_movement_editor"])
      if movement.base == nil { focus = .name }
    }
  }
  private func cancel() {
    focus = nil
    if movement.isDirty { discardChanges = true } else { discard() }
  }

  private func discard() {
    gym.telemetry.event("gym_action", properties: ["screen": "routine_movement_editor", "action": "cancel", "outcome": "ok"])
    onCancel()
  }

  // A head row is its label, the typed value and the system stepper; at accessibility sizes the label stands above the two.
  private func headField(_ label: String, field: RoutineTargetDraft.Field, placeholder: String, focus target: Focus) -> some View {
    let refused = movement.targets.headRefusal?.field == field
    let enabled = field == .sets || movement.targets.canEditTargets
    return VStack(alignment: .leading, spacing: 8) {
      if dynamicTypeSize.isAccessibilitySize { Text(label) }
      HStack {
        if !dynamicTypeSize.isAccessibilitySize { Text(label); Spacer(minLength: 12) }
        TextField(placeholder, text: Binding(get: { movement.targets.shared(field) }, set: { movement.targets.type($0, field: field) }))
          .keyboardType(field == .weight ? .decimalPad : .numberPad)
          .multilineTextAlignment(.trailing)
          .monospacedDigit()
          .frame(minWidth: 44, maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : 120, minHeight: 44)
          .focused($focus, equals: target)
          .accessibilityLabel(field == .weight ? "Weight target" : "\(label) target")
          .accessibilityHint(refused ? movement.targets.headRefusal?.message ?? "" : "")
          .accessibilityIdentifier("gym-target-\(field)")
          .onSubmit { nextField() }
        Stepper(label) { movement.targets.step(field, direction: 1); feedback += 1 } onDecrement: { movement.targets.step(field, direction: -1); feedback += 1 }
          .labelsHidden()
          .accessibilityIdentifier("gym-target-\(field)-stepper")
        if field == .weight && Equipment(exercise.equipment) == .bodyweight { signButton(row: nil) }
      }
      .disabled(!enabled)
      if refused, let refusal = movement.targets.headRefusal { refusalLine(refusal.message) }
    }
  }

  private func targetRow(_ index: Int) -> some View {
    let refusal = movement.targets.headRefusal == nil && movement.targets.refusal?.row == index ? movement.targets.refusal : nil
    return VStack(alignment: .leading, spacing: 8) {
      Text("Set \(index + 1)").font(.subheadline).foregroundStyle(GymPalette.inkDim)
      if dynamicTypeSize.isAccessibilitySize {
        rowField("Reps", field: .reps, index: index, placeholder: "max", focus: .rowReps(index), refusal: refusal)
        HStack {
          rowField(MovementEquipment(exercise).unit, field: .weight, index: index, placeholder: "last time", focus: .rowWeight(index), refusal: refusal)
          if Equipment(exercise.equipment) == .bodyweight { signButton(row: index) }
        }
      } else {
        HStack(spacing: 16) {
          rowField("Reps", field: .reps, index: index, placeholder: "max", focus: .rowReps(index), refusal: refusal)
          rowField(MovementEquipment(exercise).unit, field: .weight, index: index, placeholder: "last time", focus: .rowWeight(index), refusal: refusal)
          if Equipment(exercise.equipment) == .bodyweight { signButton(row: index) }
        }
      }
      if let refusal { refusalLine(refusal.message) }
    }
  }

  private func rowField(_ label: String, field: RoutineTargetDraft.Field, index: Int, placeholder: String, focus target: Focus,
                        refusal: RoutineTargetDraft.Refusal?) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.caption).foregroundStyle(GymPalette.inkDim)
      TextField(placeholder, text: Binding(get: {
        guard movement.targets.rows.indices.contains(index) else { return "" }
        return field == .reps ? movement.targets.rows[index].reps : movement.targets.rows[index].weight
      }, set: { movement.targets.type($0, field: field, row: index) }))
        .keyboardType(field == .weight ? .decimalPad : .numberPad)
        .disabled(!movement.targets.canEditTargets)
        .textFieldStyle(.roundedBorder)
        .monospacedDigit()
        .focused($focus, equals: target)
        .accessibilityLabel("Set \(index + 1) \(field == .reps ? "reps" : "load")")
        .accessibilityHint(refusal?.field == field ? refusal?.message ?? "" : "")
        .accessibilityIdentifier("gym-target-row-\(index + 1)-\(field)")
        .onSubmit { nextField() }
    }
  }

  private func signButton(row: Int?) -> some View {
    Button { movement.targets.flipSign(row: row); feedback += 1 } label: { Image(systemName: "plusminus") }
      .buttonStyle(.borderless)
      .frame(minWidth: 44, minHeight: 44)
      .disabled(!movement.targets.canEditTargets)
      .accessibilityLabel("Flip the sign — band-assisted")
  }

  @ViewBuilder private var fillActions: some View {
    Button("Ramp up") { movement.targets.rampUp(); feedback += 1 }.disabled(!movement.targets.canRamp)
    Button("Match set 1") { movement.targets.matchFirst(); feedback += 1 }.disabled(!movement.targets.canEditTargets)
  }

  private var fillMenu: some View {
    Menu { fillActions } label: {
      Text("Fill").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
    }.accessibilityIdentifier("gym-target-fill")
      .simultaneousGesture(TapGesture().onEnded { focus = nil })
  }

  private func refusalLine(_ message: String) -> some View {
    Text(message).font(.subheadline).foregroundStyle(GymPalette.alarm).accessibilityIdentifier("gym-target-refusal")
  }

  private func delete(_ index: Int) {
    focus = nil
    movement.targets.deleteSet(index)
    feedback += 1
  }

  private var focusOrder: [Focus] {
    var fields: [Focus] = [.name, .sets]
    if movement.targets.canEditTargets {
      fields += [.reps, .weight]
      if movement.targets.varyBySet { fields += movement.targets.visibleRows.indices.flatMap { [Focus.rowReps($0), .rowWeight($0)] } }
    }
    return fields
  }

  private var lastFocus: Focus? { focusOrder.last }

  private func nextField() {
    guard let focus, let index = focusOrder.firstIndex(of: focus), index + 1 < focusOrder.count else { self.focus = nil; return }
    self.focus = focusOrder[index + 1]
  }
}
