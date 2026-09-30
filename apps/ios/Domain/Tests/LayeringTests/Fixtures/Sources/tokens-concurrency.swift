// module: GymDomain
// expect: 9: token Task
// expect: 9: token async
// expect: 9: token await
// expect: 10: token @MainActor
// expect: 11: token nonisolated
// expect: 11: unsafe unsafe
// expect: 12: token @unchecked
func later() async -> Int { await Task.yield(); return 1 }
@MainActor func onMain() {}
nonisolated(unsafe) var shared = 0
final class Memo: @unchecked Sendable { var seen = 0 }
