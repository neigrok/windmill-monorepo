import Foundation
import RoadmapDomain

// D-4 A direct write's receipt as the band and the conversation show it (design, Receipts; packages/api-contract/roadmap/
// coach/receipts.json): one line of at most eight words that states what Coach wrote, made from the receipt's facts and never
// from the model's text. A name too long for the line is cut a word at a time, the part with the most words first and the
// later of two, never to nothing, an ellipsis where it was cut. A receipt whose write was undone reads Undone.
enum CoachReceiptLine {
  static let maxWords = 8

  static var undone: String { String(localized: "Undone", comment: "A Coach receipt whose write was undone") }

  static func words(_ receipt: CoachReceipt, undone: Bool = false) -> String {
    if undone { return Self.undone }
    let step = receipt.label
    let first = receipt.prerequisites.first ?? ""
    switch receipt.change {
    case .completed: return cut([step]) { String(localized: "Marked done · \($0[0])", comment: "A Coach receipt: the step marked done") }
    case .reset: return cut([step]) { String(localized: "Marked not done · \($0[0])", comment: "A Coach receipt: the step marked not done") }
    case .linked:
      return cut([step, first]) { String(localized: "Link added · \($0[0]) needs \($0[1])", comment: "A Coach receipt: the step that waits, and the step it now follows") }
    case .created:
      switch receipt.prerequisites.count {
      case 0: return cut([step]) { String(localized: "Step added · \($0[0])", comment: "A Coach receipt: the new step") }
      case 1: return cut([step, first]) { String(localized: "Step added · \($0[0]) · needs \($0[1])", comment: "A Coach receipt: the new step, and the step it follows") }
      default:
        let more = receipt.prerequisites.count - 1
        return cut([step, first]) {
          String(localized: "Step added · \($0[0]) · needs \($0[1]) +\(more)", locale: .copy, comment: "A Coach receipt: the new step, the first step it follows, and how many more")
        }
      }
    case .changed:
      let (fields, items) = (receipt.fields, receipt.items)
      if fields.isEmpty && items.count == 1 { return cut([items[0]]) { String(localized: "Subtask added · \($0[0])", comment: "A Coach receipt: the subtask's words") } }
      if fields.isEmpty {
        return cut([step]) { String(localized: "\(items.count) subtasks added · \($0[0])", locale: .copy, comment: "A Coach receipt: how many subtasks, and their step") }
      }
      guard fields.count == 1, items.isEmpty else { return cut([step]) { String(localized: "Step changed · \($0[0])", comment: "A Coach receipt: the step changed") } }
      switch fields[0] {
      case "label": return cut([step]) { String(localized: "Renamed · \($0[0])", comment: "A Coach receipt: the step's new name") }
      case "description": return cut([step]) { String(localized: "Description changed · \($0[0])", comment: "A Coach receipt: the step whose description changed") }
      case "links": return cut([step]) { String(localized: "Links changed · \($0[0])", comment: "A Coach receipt: the step whose web links changed") }
      default: return cut([step]) { String(localized: "Step changed · \($0[0])", comment: "A Coach receipt: the step changed") }
      }
    }
  }

  // The words a line counts: not its separators, nor a count of more.
  static func counted(_ line: String) -> Int {
    line.split(whereSeparator: \.isWhitespace).filter { $0 != "·" && !$0.hasPrefix("+") }.count
  }

  // A line with each of its parts cut, while the whole passes eight words.
  static func cut(_ parts: [String], compose: ([String]) -> String) -> String {
    let words = parts.map { $0.split(whereSeparator: \.isWhitespace).map(String.init) }
    var kept = words.map(\.count)
    func shown() -> [String] { zip(words, kept).map { part, count in part.prefix(count).joined(separator: " ") + (count < part.count ? "…" : "") } }
    while counted(compose(shown())) > maxWords, let most = kept.max(), most > 1, let index = kept.lastIndex(of: most) {
      kept[index] = most - 1
    }
    return compose(shown())
  }
}
