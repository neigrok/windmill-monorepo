// module: GymDomain
// expect: 4: token random
public func quoted(_ s: String) -> Int { s.matches(of: #/"/#).count }
public func roll() -> Int { Int.random(in: 1...6) }
