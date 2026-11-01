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
  var title: String { kind == .dumbbell && loadCount == 1 ? "One dumbbell" : choice }
  // Its name in the Equipment menu, whatever the dumbbell count.
  var choice: String {
    switch kind {
    case .barbell: "Barbell"
    case .dumbbell: "Dumbbells"
    case .machine: "Machine"
    case .cable: "Cable"
    case .bodyweight: "Bodyweight"
    case .kettlebell: "Kettlebell"
    case .other: "Other"
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
    case .dumbbell: loadCount == 1 ? "Enter the dumbbell’s weight. Volume counts one dumbbell." : "Enter the weight of one dumbbell. Volume counts both."
    case .bodyweight: "Enter the added weight, or a negative number for help from a band. 0 means bodyweight only. Volume counts only the added weight."
    case .barbell: "Enter the total weight, including the bar."
    case .machine, .cable, .kettlebell, .other, nil: "Enter the external weight you lift."
    }
  }
}

struct MovementEquipmentPicker: View {
  @Binding var equipment: String
  @Binding var loadCount: Int
  let identifier: String
  var body: some View {
    Group {
      LabeledContent {
        Menu {
          Picker("Equipment", selection: $equipment) {
            ForEach(MovementEquipment.choices, id: \.self) { value in
              if let symbol = MovementEquipment(value).symbol {
                Label(MovementEquipment(value).choice, systemImage: symbol).tag(value)
              } else {
                Text(MovementEquipment(value).choice).tag(value)
              }
            }
          }
        } label: {
          HStack(spacing: RoomSpace.small) {
            Text(MovementEquipment(equipment).choice)
            Image(systemName: "chevron.up.chevron.down").imageScale(.small)
          }
        }.accessibilityLabel("Equipment").accessibilityValue(MovementEquipment(equipment).choice).accessibilityIdentifier(identifier)
      } label: {
        if let symbol = MovementEquipment(equipment).symbol {
          Label("Equipment", systemImage: symbol).foregroundStyle(GymPalette.ink)
        } else {
          Text("Equipment").foregroundStyle(GymPalette.ink)
        }
      }
      if Equipment(equipment) == .dumbbell {
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
