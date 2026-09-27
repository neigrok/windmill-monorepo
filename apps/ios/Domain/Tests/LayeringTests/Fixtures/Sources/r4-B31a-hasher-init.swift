// module: GymDomain
// expect: 4: token finalize
// expect: 5: token finalize
public func seeded() -> Int { var h = Hasher.init(); h.combine(42); return h.finalize() }
public func seeded2() -> Int { var h: Hasher = .init(); h.combine(42); return h.finalize() }
