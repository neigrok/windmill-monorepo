import DomainKit
import GymDomain

// A typed name as its domain text rule reads it: composed, trimmed, and counted in code points.
struct NameField {
  static let movement = NameField(rule: ExerciseRules.name)
  static let routine = NameField(rule: RoutineRules.name)

  let rule: TextSpec
  var counterFrom: Int { rule.max * 4 / 5 }

  func trimmed(_ value: String) -> String { rule.normalised(value) }

  // The typed text up to the scalar that would take it past the rule's length.
  func capped(_ value: String) -> String {
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

  // A search's text taken as a name: trimmed, then cut at the rule's length.
  func taken(from query: String) -> String { capped(trimmed(query)) }

  // A violation the form has no words for is the save's to refuse, in the refusal's words.
  func problem(_ value: String) -> String? {
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

  func counter(_ value: String) -> String? {
    let count = rule.measure(value)
    return count < counterFrom ? nil : "\(count)/\(rule.max)"
  }

  func changed(from: String, to: String) -> Bool {
    problem(to) == nil && trimmed(to) != from
  }
}
