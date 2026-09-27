import Foundation

// §2.4 item 4: xcodebuild and swift in .github/workflows/ios*.yml pass only listed settings, no -xcconfig, no -Xswiftc.
enum Workflows {
  static let allowedBuildSettings: Set<String> = [
    "DEVELOPMENT_TEAM", "CODE_SIGN_STYLE", "CODE_SIGNING_ALLOWED", "CURRENT_PROJECT_VERSION", "IOS_SENTRY_DSN",
  ]
  static let tools: Set<String> = ["xcodebuild", "swift"]
  static let forbiddenFlags: Set<String> = ["-xcconfig", "-Xswiftc"]
  static let configurationFileVariable = "XCODE_XCCONFIG_FILE"

  static func findings(in directory: URL) throws -> [Finding] {
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
      .filter { $0.hasPrefix("ios") && $0.hasSuffix(".yml") }.sorted()
    return try files.flatMap { file in findings(in: try yaml(directory.appending(path: file)), file: file) }
  }

  static func yaml(_ file: URL) throws -> JSONValue {
    let json = try Shell.run(["ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV[0]))", file.path])
    return try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
  }

  static func findings(in workflow: JSONValue, file: String) -> [Finding] {
    let jobs = workflow["jobs"]?.fields.map(\.value) ?? []
    let steps = jobs.flatMap { $0["steps"]?.elements ?? [] }
    let environments = [workflow["env"]] + jobs.map { $0["env"] } + steps.map { $0["env"] }
    let configured = environments.compactMap { $0?[configurationFileVariable] }.map { _ in "\(configurationFileVariable) in an env" }
    let invocations = steps.compactMap { $0["run"]?.text }.flatMap(invocationFindings)
    return (invocations + configured).map { Finding(file, "workflow", $0) }
  }

  static func invocationFindings(in script: String) -> [String] {
    let lines = script.replacing(/\\\n\s*/, with: " ").split(separator: "\n")
    return lines.flatMap { line -> [String] in
      let words = shellWords(String(line))
      guard let at = words.firstIndex(where: tools.contains) else { return [] }
      return words[(at + 1)...].compactMap { argument in
        if forbiddenFlags.contains(argument) { return "\(words[at]) \(argument)" }
        guard let setting = argument.firstMatch(of: /^([A-Z_][A-Z0-9_]*)=/)?.1, !allowedBuildSettings.contains(String(setting)) else { return nil }
        return "\(words[at]) sets \(setting)"
      }
    }
  }

  // Shell words: quotes group, a backslash escapes, `#` starts a comment; an unclosed quote splits the line at whitespace.
  static func shellWords(_ line: String) -> [String] {
    var words: [String] = [], word = "", quote: Character? = nil, escaped = false, started = false
    for character in line {
      if escaped { word.append(character); escaped = false; continue }
      switch (quote, character) {
      case (_, "\\") where quote != "'": escaped = true; started = true
      case (nil, "'"), (nil, "\""): quote = character; started = true
      case (let open?, _) where character == open: quote = nil
      case (nil, "#") where !started: return words
      case (nil, _) where character.isWhitespace:
        if started { words.append(word) }
        word = ""; started = false
      default: word.append(character); started = true
      }
    }
    guard quote == nil else { return line.split(whereSeparator: \.isWhitespace).map(String.init) }
    return started ? words + [word] : words
  }
}
