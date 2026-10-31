import SwiftUI
import DomainKit
import GymDomain

// A movement's name as the domain's `exercise.name` rule reads it: composed, trimmed, and counted in code points.
enum MovementName {
  static let rule = ExerciseRules.name
  static let counterFrom = rule.max * 4 / 5

  static func trimmed(_ value: String) -> String { rule.normalised(value) }

  // The typed text up to the scalar that would take it past the rule's length.
  static func capped(_ value: String) -> String {
    guard rule.measure(value) > rule.max else { return value }
    var kept = String.UnicodeScalarView()
    for scalar in value.unicodeScalars {
      var longer = kept
      longer.append(scalar)
      if rule.measure(String(longer)) > rule.max { break }
      kept = longer
    }
    return String(kept)
  }

  // A violation the form has no words for is the save's to refuse, in the refusal's words.
  static func problem(_ value: String) -> String? {
    do throws(Violation) {
      _ = try rule.apply(value, at: "name")
      return nil
    } catch {
      switch error.reason {
      case .blank, .tooShort: return "Name it to save it."
      case .tooLong(let max, _, _): return "Use \(max) characters or fewer."
      default: return nil
      }
    }
  }

  static func counter(_ value: String) -> String? {
    let count = rule.measure(value)
    return count < counterFrom ? nil : "\(count)/\(rule.max)"
  }

  static func changed(from: String, to: String) -> Bool {
    problem(to) == nil && trimmed(to) != from
  }
}

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
  var unit: String {
    switch kind {
    case .dumbbell: loadCount == 1 ? "kg" : "kg each"
    case .bodyweight: "kg added"
    case .barbell: "kg total"
    case .machine, .cable, .kettlebell, .other, nil: "kg"
    }
  }
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
