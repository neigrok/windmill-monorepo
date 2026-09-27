// module: GymDomain
// expect: pass
import SyncCore
import DomainKit
struct Stamp: Hashable {
  let actor: String
  func hash(into hasher: inout Hasher) { hasher.combine(actor) }
}
struct CoachThread {}
let printable = "print(\(1)) and random text"
let bound = 131_072
let doubled = [1, 2].map { $0 * 2 }
let ignored = [1, 2].map { _ in 0 }
