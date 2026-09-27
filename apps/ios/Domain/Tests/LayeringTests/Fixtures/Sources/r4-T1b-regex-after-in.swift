// module: GymDomain
// expect: 4: token random
public let finders: [(String) -> Int] = [{ s in s.matches(of: /"/).count }]
public func roll() -> Int { Int.random(in: 1...6) }
public let tail = "x"
