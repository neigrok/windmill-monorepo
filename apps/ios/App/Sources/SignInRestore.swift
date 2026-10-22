import SyncCore

// Returning on a new phone (02c): each room's records arriving against the count the account's hello gave, and the room
// whose newest record is latest opening once its own records are in, while the other keeps arriving behind it.
struct SignInRestore: Equatable {
  enum Step: Equatable { case open(AppModel.Room), complete }

  let method: String
  let totals: [AppModel.Room: Int]
  let opening: AppModel.Room
  var opened = false

  // Nothing to bring back, or a hello that counted nothing, leaves the phone as sign-in leaves it.
  init?(method: String, holdings: [String: HelloResponse.Holding]) {
    var totals: [AppModel.Room: Int] = [:]
    var newest: (room: AppModel.Room, at: Int64)?
    for room in AppModel.Room.allCases {
      guard let holding = holdings[room.rawValue], holding.count > 0 else { continue }
      totals[room] = holding.count
      let at = holding.newestAt ?? 0
      if newest.map({ at > $0.at }) ?? true { newest = (room, at) }
    }
    guard let newest else { return nil }
    self.method = method; self.totals = totals; opening = newest.room
  }

  var rooms: [AppModel.Room] { AppModel.Room.allCases.filter { totals[$0] != nil } }
  var eyebrow: String { method == "apple" ? "SIGNED IN WITH APPLE" : "SIGNED IN WITH EMAIL" }
  var line: String { "Opening \(opening.title) as soon as it’s ready." }

  // *64 of 142 pages*: what has landed, never more than the account holds.
  func count(_ room: AppModel.Room, landed: Int) -> String {
    let total = totals[room] ?? 0
    let noun = room == .journal ? (total == 1 ? "page" : "pages") : (total == 1 ? "workout" : "workouts")
    return "\(min(landed, total)) of \(total) \(noun)"
  }

  // The next thing the arrival does, given which rooms' records are all in.
  func step(arrived: Set<AppModel.Room>) -> Step? {
    if !opened { return arrived.contains(opening) ? .open(opening) : nil }
    return Set(rooms).isSubset(of: arrived) ? .complete : nil
  }
}
