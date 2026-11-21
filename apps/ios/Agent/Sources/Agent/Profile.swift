import SyncCore

public struct Profile: Sendable {
  public struct Tool: Sendable {
    public let name: String
    public let description: String
    public let input: JSON
    public let countsAsWrite: Bool
  }
  public struct Group: Sendable {
    public let name: String
    public let tools: [String]
    public let maxSuccesses: Int
    public let code: String
  }
  public let value: JSON
  public let name: String
  public let version: Int
  public let tools: [Tool]
  public let groups: [Group]
  public let modelCalls: Int
  public let abilityCalls: Int
  public let writes: Int
  public let label: String
  let refusals: [String: String]

  public init(_ value: JSON) throws {
    self.value = value
    let object = try value.asObject()
    name = try object.member("name").asString()
    version = Int(try object.member("version").asInteger())
    label = try object.member("label").asString()
    let limits = try object.member("limits").asObject()
    modelCalls = Int(try limits.member("modelCalls").asInteger())
    abilityCalls = Int(try limits.member("abilityCalls").asInteger())
    writes = Int(try limits.member("writes").asInteger())
    tools = try object.member("tools").asArray().map { value in
      let tool = try value.asObject()
      return Tool(name: try tool.member("name").asString(), description: try tool.member("description").asString(),
                  input: try tool.member("input"), countsAsWrite: try tool.member("countsAsWrite").asBool())
    }
    groups = try object.member("groups").asArray().map { value in
      let group = try value.asObject()
      return Group(name: try group.member("name").asString(), tools: try group.member("tools").asArray().map { try $0.asString() },
                   maxSuccesses: Int(try group.member("maxSuccesses").asInteger()), code: try group.member("code").asString())
    }
    _ = try object.member("system").asArray().map { try $0.asString() }
    _ = try object.member("model").asString()
    _ = try object.member("effort").asString()
    let output = try object.member("output").asObject()
    let maximum = try output.member("maxTokens").asInteger()
    let minimumValue = try output.member("minTokens")
    let minimum = minimumValue == .null ? 0 : try minimumValue.asInteger()
    let first = try object.member("firstContent").asObject()
    for key in ["historyPrefix", "contextPrefix", "questionPrefix", "emptyQuestion"] { _ = try first.member(key).asString() }
    refusals = try Dictionary(uniqueKeysWithValues: object.member("refusals").asObject().members.map { ($0.key, try $0.value.asString()) })
    guard Self.label(name), Self.label(label), tools.allSatisfy({ Self.label($0.name) }),
          refusals.keys.allSatisfy(Self.label), version > 0, modelCalls > 0, abilityCalls >= 0, writes >= 0,
          maximum > 0, minimum >= 0, minimum <= maximum,
          Set(tools.map(\.name)).count == tools.count,
          Set(groups.map(\.name)).count == groups.count,
          groups.allSatisfy({ $0.maxSuccesses >= 0 && $0.tools.allSatisfy { name in tools.contains { $0.name == name } } })
    else { throw AiFailure(source: .wire, code: "invalid-profile") }
  }

  static func label(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 64 && value.utf8.allSatisfy {
      (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 95].contains($0)
    }
  }

  public func request(messages: [JSON]) throws -> JSON {
    let object = try value.asObject()
    let output = try object.member("output").asObject()
    return .object(.init(uniqueKeysWithValues: [
      ("model", try object.member("model")), ("system", try object.member("system")),
      ("tools", .array(tools.map { tool in .object(.init(uniqueKeysWithValues: [
        ("name", .string(tool.name)), ("description", .string(tool.description)), ("input", tool.input)])) })),
      ("messages", .array(messages)), ("effort", try object.member("effort")), ("cache", .bool(true)),
      ("output", .object(.init(uniqueKeysWithValues: [("maxTokens", try output.member("maxTokens")),
        ("minTokens", try output.member("minTokens")), ("schema", .null)]))),
    ]))
  }

  public func firstMessage(input: TurnInput, open: OpenTurn) throws -> JSON {
    let first = try value.asObject().member("firstContent").asObject()
    func text(_ value: String) -> JSON { .object(.init(uniqueKeysWithValues: [("text", .string(value))])) }
    var parts: [JSON] = []
    if !open.history.isEmpty { parts.append(text(try first.member("historyPrefix").asString() + open.history)) }
    for context in open.context where !context.isEmpty { parts.append(text(try first.member("contextPrefix").asString() + context)) }
    for picture in open.pictures { parts.append(.object(.init(uniqueKeysWithValues: [
      ("image", .object(.init(uniqueKeysWithValues: [("picture", .string(picture.pictureId))])))]))) }
    let question = input.question.isEmpty ? try first.member("emptyQuestion").asString() : try first.member("questionPrefix").asString() + input.question
    parts.append(text(question))
    return .object(.init(uniqueKeysWithValues: [("role", .string("user")), ("parts", .array(parts))]))
  }

  public func refusal(_ code: String) -> String {
    let code = refusalCode(code)
    return JSON.object(.init(uniqueKeysWithValues: [("code", .string(code)), ("message", .string(refusals[code] ?? code))])).jcsText
  }

  func refusalCode(_ code: String) -> String {
    refusals[code] == nil ? "product-refused" : code
  }
}
