import Foundation
// Swift 6 rejects this capture (a data race); Swift 5 accepts it without a warning.
nonisolated final class Box { var n = 0 }
nonisolated func race() { let b = Box(); Task.detached { b.n += 1 }; b.n += 1 }
