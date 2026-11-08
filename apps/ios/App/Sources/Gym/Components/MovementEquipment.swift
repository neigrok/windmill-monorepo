import SwiftUI
import GymDomain

// A movement's equipment and the basis of its entered load: a pair of dumbbells per dumbbell, one dumbbell as itself.
// `value` is the record's string; `kind` is nil for one this phone does not know.
struct MovementEquipment {
  let value: String
  let loadCount: Int
  init(_ value: String, loadCount: Int = 2) { self.value = value; self.loadCount = Equipment(value) == .dumbbell ? loadCount : 1 }
  init(_ exercise: Exercise?) { self.init(exercise?.equipment ?? "", loadCount: exercise?.loadCount ?? 2) }
  // The Equipment menu's choices, in its order; Other is not one.
  static let choices = [Equipment.barbell, .dumbbell, .machine, .cable, .kettlebell, .bodyweight].map(\.rawValue)
  var kind: Equipment? { Equipment(value) }
  var title: String { kind == .dumbbell && loadCount == 1 ? String(localized: "One dumbbell") : choice }
  // Its name in the Equipment menu, whatever the dumbbell count.
  var choice: String {
    switch kind {
    case .barbell: String(localized: "Barbell")
    case .dumbbell: String(localized: "Dumbbells")
    case .machine: String(localized: "Machine")
    case .cable: String(localized: "Cable")
    case .bodyweight: String(localized: "Bodyweight")
    case .kettlebell: String(localized: "Kettlebell")
    case .other: String(localized: "Other")
    case nil: value.capitalized
    }
  }
  // A pair of dumbbells, whose load is the weight of one, said per hand.
  var each: Bool { kind == .dumbbell && loadCount == 2 }
  // Bodyweight and Other take a load below zero: a band's help, or a machine's counterweight.
  var signed: Bool {
    switch kind {
    case .bodyweight, .other: true
    case .barbell, .dumbbell, .machine, .cable, .kettlebell, nil: false
    }
  }
  var symbol: String? {
    switch kind {
    case .barbell: "figure.strengthtraining.traditional"
    case .dumbbell: "dumbbell.fill"
    case .bodyweight, .machine, .cable: "figure.strengthtraining.functional"
    case .kettlebell: "dumbbell"
    case .other, nil: nil
    }
  }
  var unit: String { Readout.loadUnit(equipment: value, loadCount: loadCount) }
  var help: String {
    switch kind {
    case .dumbbell: loadCount == 1 ? String(localized: "Enter the dumbbell’s weight. Volume counts one dumbbell.")
      : String(localized: "Enter the weight of one dumbbell. Volume counts both.")
    case .bodyweight: String(localized: "Enter the added weight, or a negative number for help from a band. 0 means bodyweight only. Volume counts only the added weight.")
    case .barbell: String(localized: "Enter the total weight, including the bar.")
    case .machine, .cable, .kettlebell, .other, nil: String(localized: "Enter the external weight you lift.")
    }
  }
}

// The Equipment menu and, for dumbbells, how many are lifted: stock Pickers in a Form. The movement form (02L.5) takes the
// count as a menu like the equipment; Edit movement keeps its segmented pair.
struct MovementEquipmentPicker: View {
  enum Count { case segmented, menu }
  @Binding var equipment: String
  @Binding var loadCount: Int
  let identifier: String
  var count = Count.segmented

  var body: some View {
    Picker("Equipment", selection: $equipment) {
      ForEach(MovementEquipment.choices, id: \.self) { value in
        if let symbol = MovementEquipment(value).symbol {
          Label(MovementEquipment(value).choice, systemImage: symbol).tag(value)
        } else {
          Text(MovementEquipment(value).choice).tag(value)
        }
      }
    }.pickerStyle(.menu).foregroundStyle(GymPalette.ink)
      .accessibilityValue(MovementEquipment(equipment).choice).accessibilityIdentifier(identifier)
    if Equipment(equipment) == .dumbbell {
      switch count {
      case .menu:
        Picker("Dumbbells", selection: $loadCount) {
          Text("One").tag(1)
          Text("Two").tag(2)
        }.pickerStyle(.menu).foregroundStyle(GymPalette.ink).accessibilityIdentifier("\(identifier)-count")
      case .segmented:
        LabeledContent("Dumbbells lifted") {
          Picker("Dumbbells lifted", selection: $loadCount) {
            Text("One").tag(1)
            Text("Two").tag(2)
          }.pickerStyle(.segmented).fixedSize().accessibilityIdentifier("\(identifier)-count")
        }.foregroundStyle(GymPalette.ink)
      }
    }
  }
}
