// module: GymDomain
// expect: 3: token @unchecked
public final class Memo: @unchecked Sendable { public var last = ""; public init() {} }
public let shared = Memo()
