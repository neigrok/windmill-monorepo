// module: GymDomain
// expect: 3: token random
public func halved(_ xs: [Int]) -> Int { xs.reduce(64, /) + Int.random(in: 1...6) + [2].reduce(8, /) }
