// module: GymDomain
// expect: 9: token finalize
// expect: 10: underscore-identifier _hashValue
// expect: 11: underscore-identifier _rawHashValue
// expect: 12: token ObjectIdentifier
// expect: 13: unsafe withUnsafePointer
// expect: 14: underscore-identifier _isDebugAssertConfiguration
final class Probe {}
func seeded() -> Int { var h = Hasher.init(); h.combine(42); return h.finalize() }
let a = _hashValue(for: 42)
let b = 42._rawHashValue(seed: 0)
let c = UInt(bitPattern: ObjectIdentifier(Probe()))
func addr(_ x: inout Int) -> Int { withUnsafePointer(to: &x) { Int(bitPattern: $0) } }
let limit = _isDebugAssertConfiguration() ? 1_000 : 10
