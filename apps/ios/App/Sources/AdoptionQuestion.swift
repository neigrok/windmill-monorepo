import JournalDomain
import GymDomain

// The sign-in question (23d–23j), one for every room due: what the phone holds by kind, sets inside their workouts, and
// what the account holds. Settings, movement names and proposals go unnamed; a room holding only those counts changes.
struct AdoptionQuestion: Equatable {
  static let named = [(Session.type, "workout", "workouts"), (Routine.type, "routine", "routines"), (WeighIn.type, "weigh-in", "weigh-ins"),
                      (Exercise.type, "movement", "movements"), (Note.type, "note", "notes"), (Page.type, "journal page", "journal pages")]
  let phrase: String
  let kinds: Int
  let single: Bool
  let account: String

  // `counts` holds each pending room's records by type, so every room the answer applies to is named.
  init(counts: [AppModel.Room: [String: Int]]) {
    let parts = [AppModel.Room.gym, .journal].compactMap { counts[$0] }.flatMap { room in
      let held = Self.named.compactMap { type, one, many in room[type].flatMap { $0 > 0 ? ($0, "\($0) \($0 == 1 ? one : many)") : nil } }
      let changes = room.filter { $0.key != JournalState.type }.values.reduce(0, +)
      return held.isEmpty ? [(changes, "\(changes) \(changes == 1 ? "change" : "changes")")] : held
    }
    phrase = Self.joined(parts.map(\.1))
    kinds = parts.count
    single = parts.count == 1 && parts[0].0 == 1
    account = Self.joined([counts[.gym] != nil ? "training" : nil, counts[.journal] != nil ? "journal pages" : nil].compactMap { $0 })
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
