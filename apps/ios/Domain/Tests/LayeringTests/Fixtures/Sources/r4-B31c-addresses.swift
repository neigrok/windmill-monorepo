// module: GymDomain
// expect: 5: token ObjectIdentifier
// expect: 6: unsafe withUnsafePointer
final class Probe {}
public func c() -> UInt { UInt(bitPattern: ObjectIdentifier(Probe())) }
public func d() -> Int { var x = 1; return withUnsafePointer(to: &x) { Int(bitPattern: $0) } }
