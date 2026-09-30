// Every error SyncCore throws, one per kind of value it refuses.

public enum JSONError: Error, Equatable, CustomStringConvertible {
  case syntax(String, offset: Int)
  case duplicateKey(String)
  case tooDeep(offset: Int)
  case shape(String)

  public var description: String {
    switch self {
    case .syntax(let reason, let offset): "JSON syntax: \(reason) at byte \(offset)"
    case .duplicateKey(let key): "JSON object repeats the key \(JSON.string(key).jcsText)"
    case .tooDeep(let offset): "JSON nests deeper than \(JSON.maxDepth) at byte \(offset)"
    case .shape(let reason): "JSON shape: \(reason)"
    }
  }
}

public struct StampError: Error, Equatable, CustomStringConvertible {
  public let text: String
  public let reason: String

  public var description: String { "invalid stamp \(JSON.string(text).jcsText): \(reason)" }
}

public enum JoinError: Error, Equatable, CustomStringConvertible {
  case unranked(JSON)
  case unknownFieldOnBothSides(String)
  case notJoinable(field: String, kind: String)

  public var description: String {
    switch self {
    case .unranked(let value): "the ranked value \(value.jcsText) has no rank"
    case .unknownFieldOnBothSides(let field): "two registers of the unknown field \(field) meet in a join"
    case .notJoinable(let field, let kind): "the \(kind) field \(field) is sequenced by the server, never joined"
    }
  }
}

public enum FractionalKeyError: Error, Equatable, CustomStringConvertible {
  case invalid(String)
  case notAscending(String, String)
  case exhausted
  case anchorMissing(String)

  public var description: String {
    switch self {
    case .invalid(let key): "\(JSON.string(key).jcsText) is not a fractional key"
    case .notAscending(let a, let b): "no key lies between \(a) and \(b): they do not ascend"
    case .exhausted: "the key space ends here"
    case .anchorMissing(let id): "the drop anchor \(id) is not in the list"
    }
  }
}

public struct DigestError: Error, Equatable, CustomStringConvertible {
  public let hex: String

  public init(hex: String) {
    self.hex = hex
  }

  public var description: String { "\(JSON.string(hex).jcsText) is not 64 lowercase hex digits" }
}

public struct IdentityError: Error, Equatable, CustomStringConvertible {
  public let description: String

  init(_ description: String) {
    self.description = description
  }
}

public struct RegistryError: Error, CustomStringConvertible {
  public let description: String

  init(_ description: String) {
    self.description = description
  }

  init(context: String, underlying: any Error) {
    self.description = "\(context): \(underlying)"
  }
}
