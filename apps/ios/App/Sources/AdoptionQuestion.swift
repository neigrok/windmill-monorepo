import JournalDomain
import GymDomain

// The sign-in question (23d–23j), one for every room due: what the phone holds by kind, sets inside their workouts, and
// what the account holds. Settings, movement names and proposals go unnamed; a phone holding only those counts changes.
struct AdoptionQuestion: Equatable {
  static let named = [(Session.type, "workout", "workouts"), (Routine.type, "routine", "routines"), (WeighIn.type, "weigh-in", "weigh-ins"),
                      (Exercise.type, "movement", "movements"), (Note.type, "note", "notes"), (Page.type, "journal page", "journal pages")]
  let phrase: String
  let kinds: Int
  let single: Bool
  let account: String

  // `counts` holds each pending room's records by type; `rooms` the rooms whose account already holds records.
  init(counts: [String: Int], rooms: Set<AppModel.Room>) {
    let held = Self.named.compactMap { type, one, many in counts[type].flatMap { $0 > 0 ? "\($0) \($0 == 1 ? one : many)" : nil } }
    let changes = counts.filter { $0.key != JournalState.type }.values.reduce(0, +)
    let parts = held.isEmpty ? ["\(changes) \(changes == 1 ? "change" : "changes")"] : held
    phrase = Self.joined(parts)
    kinds = parts.count
    single = held.isEmpty ? changes == 1 : Self.named.compactMap { counts[$0.0] }.reduce(0, +) == 1
    account = Self.joined([rooms.contains(.gym) ? "training" : nil, rooms.contains(.journal) ? "journal pages" : nil].compactMap { $0 })
  }

  var title: String { "Add to your account?" }
  var message: String {
    let them = single ? "it" : "them"
    return "This phone has \(phrase) from before you signed in. Your account already has \(account). Add \(them), or discard \(them) from this phone."
  }
  var discardTitle: String { kinds < 3 ? "Discard \(phrase)?" : "Discard all of it?" }
  var discardMessage: String {
    let deleted = kinds >= 3 ? "\(phrase) are" : single ? "It is" : "They are"
    return "\(deleted) deleted from this phone. You can’t undo this."
  }

  // *a*, *a and b*, *a, b and c*.
  static func joined(_ parts: [String]) -> String {
    guard let last = parts.last, parts.count > 1 else { return parts.first ?? "" }
    return parts.dropLast().joined(separator: ", ") + " and " + last
  }
}
