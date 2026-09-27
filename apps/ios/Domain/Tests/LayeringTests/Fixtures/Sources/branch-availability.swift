// module: GymDomain
// expect: 5: branch #available
// expect: 6: branch #unavailable
// expect: 7: branch @available
func limit() -> Int { if #available(iOS 99, *) { return 120 }; return 90 }
func other() -> Int { if #unavailable(iOS 18) { return 1 }; return 2 }
@available(iOS 18, *) func gated() {}
