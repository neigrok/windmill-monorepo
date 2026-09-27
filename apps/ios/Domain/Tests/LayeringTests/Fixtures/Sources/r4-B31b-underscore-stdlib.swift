// module: GymDomain
// expect: 4: underscore-identifier _hashValue
// expect: 5: underscore-identifier _rawHashValue
public func a() -> Int { _hashValue(for: 42) }
public func b() -> Int { 42._rawHashValue(seed: 0) }
