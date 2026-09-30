// module: GymDomain
// expect: 3: underscore-identifier _isDebugAssertConfiguration
public func limit() -> Int { _isDebugAssertConfiguration() ? 1_000 : 10 }
