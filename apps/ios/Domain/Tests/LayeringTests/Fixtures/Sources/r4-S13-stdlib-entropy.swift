// module: GymDomain
// expect: 8: token random
// expect: 9: token randomElement
// expect: 10: token shuffled
// expect: 11: token ContinuousClock
// expect: 11: token ContinuousClock
// expect: 12: token print
public func roll() -> Int { Int.random(in: 1...6) }
public func pick() -> Int? { [1, 2, 3].randomElement() }
public func mix() -> [Int] { [1, 2, 3].shuffled() }
public func t() -> ContinuousClock.Instant { ContinuousClock.now }
public func io() { print("x") }
