import JournalDomain
import GymDomain

// The sign-in question (23d–23j), one for every room due: what the phone holds by kind, sets inside their workouts, and
// what the account holds. Settings, movement names and proposals go unnamed; a room holding only those counts changes.
struct AdoptionQuestion: Equatable {
  // The kinds the question names, in the order it names them, each counted in its own words.
  static let named: [(type: String, counted: (Int) -> String)] = [
    (Session.type, { GymCount.of($0, .workout) }),
    (Routine.type, { GymCount.of($0, .routine) }),
    (WeighIn.type, { GymCount.of($0, .weighIn) }),
    (Exercise.type, { GymCount.of($0, .movement) }),
    (Note.type, { GymCount.of($0, .note) }),
    (Page.type, { String(localized: "\($0) journal pages", locale: .copy) }),
  ]
  let phrase: String
  let kinds: Int
  let single: Bool
  let account: String

  // `counts` holds each pending room's records by type, so every room the answer applies to is named.
  init(counts: [AppModel.Room: [String: Int]]) {
    let parts = [AppModel.Room.gym, .journal].compactMap { counts[$0] }.flatMap { room in
      let held = Self.named.compactMap { type, counted in room[type].flatMap { $0 > 0 ? ($0, counted($0)) : nil } }
      let changes = room.filter { $0.key != JournalState.type }.values.reduce(0, +)
      return held.isEmpty ? [(changes, GymCount.of(changes, .change))] : held
    }
    phrase = Self.joined(parts.map(\.1))
    kinds = parts.count
    single = parts.count == 1 && parts[0].0 == 1
    account = switch (counts[.gym] != nil, counts[.journal] != nil) {
    case (true, true): String(localized: "training and journal pages", comment: "What the account already has, in the sign-in question")
    case (true, false): String(localized: "training", comment: "What the account already has, in the sign-in question")
    case (false, true): String(localized: "journal pages", comment: "What the account already has, in the sign-in question")
    case (false, false): ""
    }
  }

  var title: String { String(localized: "Add to your account?") }
  var message: String {
    single
      ? String(localized: "This phone has \(phrase) from before you signed in. Your account already has \(account). Add it, or discard it from this phone.",
               comment: "The sign-in question about one thing: 1 routine; training")
      : String(localized: "This phone has \(phrase) from before you signed in. Your account already has \(account). Add them, or discard them from this phone.",
               comment: "The sign-in question about several things: 2 routines and 1 journal page; training and journal pages")
  }
  var discardTitle: String {
    kinds < 3 ? String(localized: "Discard \(phrase)?", comment: "Discard 1 routine and 1 journal page?") : String(localized: "Discard all of it?")
  }
  var discardMessage: String {
    if kinds >= 3 { return String(localized: "\(phrase) are deleted from this phone. You can’t undo this.", comment: "2 workouts, 1 routine and 3 journal pages are deleted…") }
    return single ? String(localized: "It is deleted from this phone. You can’t undo this.") : String(localized: "They are deleted from this phone. You can’t undo this.")
  }

  // *a*, *a and b*, *a, b and c*.
  static func joined(_ parts: [String]) -> String {
    guard let last = parts.last, parts.count > 1 else { return parts.first ?? "" }
    let head = parts.dropLast().dropFirst().reduce(parts[0]) { list, next in
      String(localized: "\(list), \(next)", comment: "Joins a list's items before its last: 2 workouts, 1 routine")
    }
    return String(localized: "\(head) and \(last)", comment: "Joins a list's last item: 2 workouts and 1 routine")
  }
}
