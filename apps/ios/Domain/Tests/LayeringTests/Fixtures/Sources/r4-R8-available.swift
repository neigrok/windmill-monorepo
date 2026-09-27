// module: GymDomain
// expect: 3: branch #available
public func cap() -> Int { if #available(macOS 26, *) { return 12 } else { return 10 } }
