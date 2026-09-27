// domain-kit.md §2 and INV-1: every rule family over one World, each in its own file named for what it judges.
enum Layering {
  static func findings(in world: World) -> [Finding] {
    (ClosedWorld.findings(in: world) + Layers.findings(in: world) + Settings.findings(in: world) + SourceRules.findings(in: world))
      .sorted()
  }
}

struct Finding: Hashable, Comparable, Sendable, CustomStringConvertible {
  let file: String
  let line: Int?
  let rule: String
  let detail: String

  init(_ file: String, line: Int? = nil, _ rule: String, _ detail: String = "") {
    self.file = file
    self.line = line
    self.rule = rule
    self.detail = detail
  }

  var description: String {
    let place = line.map { "\(file):\($0)" } ?? file
    return detail.isEmpty ? "\(place): \(rule)" : "\(place): \(rule) \(detail)"
  }

  var withoutFile: String {
    let what = detail.isEmpty ? rule : "\(rule) \(detail)"
    return line.map { "\($0): \(what)" } ?? what
  }

  static func < (a: Finding, b: Finding) -> Bool {
    (a.file, a.line ?? 0, a.rule, a.detail) < (b.file, b.line ?? 0, b.rule, b.detail)
  }
}
