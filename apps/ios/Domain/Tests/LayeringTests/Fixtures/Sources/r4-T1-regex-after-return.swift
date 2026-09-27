// module: GymDomain
// expect: 7: token random
// expect: 8: token print
public func quoteMark() -> Regex<Substring> {
  return /"/
}
public func roll() -> Int { Int.random(in: 1...6) }
public func show(_ s: String) { print(s) }
public let tail = "x"
