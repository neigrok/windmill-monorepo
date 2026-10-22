import Foundation
import SyncCore

// Returning on a new phone (02c): each room's visible records landing against the count the account's hello tallied.
struct SignInRestore: Equatable {
  enum Step: Equatable { case open(AppModel.Room), complete }
  // How long the arrival waits on a reachable server that lands nothing before it opens the room anyway.
  static let patience: TimeInterval = 10

  let method: String
  let totals: [AppModel.Room: Int]
  let opening: AppModel.Room
  var opened = false
  var landed: [AppModel.Room: Int] = [:]
  var arrived: Set<AppModel.Room> = []
  var movedAt: Date

  // Nothing to bring back, or a hello that counted nothing, leaves the phone as sign-in leaves it.
  init?(method: String, holdings: [String: HelloResponse.Holding], at now: Date) {
    var totals: [AppModel.Room: Int] = [:]
    var lastWritten: (room: AppModel.Room, at: Int64)?
    for room in AppModel.Room.allCases {
      guard let holding = holdings[room.rawValue], holding.count > 0 else { continue }
      totals[room] = holding.count
      let at = holding.lastWrittenAt ?? 0
      if lastWritten.map({ at > $0.at }) ?? true { lastWritten = (room, at) }
    }
    guard let lastWritten else { return nil }
    self.method = method; self.totals = totals; opening = lastWritten.room; movedAt = now
  }

  var rooms: [AppModel.Room] { AppModel.Room.allCases.filter { totals[$0] != nil } }
  var eyebrow: String { method == "apple" ? "SIGNED IN WITH APPLE" : "SIGNED IN WITH EMAIL" }
  var line: String { "Opening \(opening.title) as soon as it’s ready." }

  // What the replica holds now; any change is progress, and resets the patience.
  mutating func land(_ landed: [AppModel.Room: Int], arrived: Set<AppModel.Room>, at now: Date) {
    guard landed != self.landed || arrived != self.arrived else { return }
    self.landed = landed; self.arrived = arrived; movedAt = now
  }

  // *64 of 142 pages*: what has landed, never more than the account holds.
  func count(_ room: AppModel.Room) -> String {
    let total = totals[room] ?? 0
    let noun = room == .journal ? (total == 1 ? "page" : "pages") : (total == 1 ? "workout" : "workouts")
    return "\(min(landed[room] ?? 0, total)) of \(total) \(noun)"
  }

  // The room last written to opens once its records are in, the server is out of reach, or nothing lands for `patience`.
  func step(at now: Date, reachable: Bool) -> Step? {
    if !opened { return arrived.contains(opening) || !reachable || now.timeIntervalSince(movedAt) >= Self.patience ? .open(opening) : nil }
    return Set(rooms).isSubset(of: arrived) ? .complete : nil
  }
}
