import Foundation
import SwiftSyntax

// domain-kit.md §10.1: UI code saves a held draft on the main actor only. Swift refuses a closure that reaches the draft off
// the main actor, but where a `@preconcurrency` declaration or import downgrades the refusal it only warns, and warnings as
// errors leave that warning a warning: the SDK's `DispatchQueue.async` and `asyncAfter`, or `@preconcurrency import` of a
// §2.1 module. So the app and every platform and product UI module reach no Dispatch queue but `DispatchQueue.main`, and the
// app imports §2.1's modules without an attribute, as §2.3 already holds §2.1's own packages to.
enum MainActorDrafts {
  static let userInterfaceLayers: Set<Layer> = [.platform, .productUI]
  static let app = "App"
  static let appOutsideTheBuild: Set<String> = ["Tests", "UITests", "Tools"]

  static func findings(in world: World) throws -> [Finding] {
    let modules = world.packages.flatMap { package in
      package.sources.filter { module, _ in Layers.row(of: module).map { userInterfaceLayers.contains($0.layer) } == true }.values
    }
    let kit = modules.joined().flatMap { queueFindings(in: $0.text, file: $0.path) }
    let appFiles = world.tree.entries.filter { path, kind in
      let parts = path.split(separator: "/").map(String.init)
      return kind == .file && parts.first == app && path.hasSuffix(".swift") && !appOutsideTheBuild.contains(parts.dropFirst().first ?? "")
    }.keys.sorted()
    let packageModules = world.packageModules
    let appFindings = try appFiles.flatMap { path in
      let text = try String(contentsOf: world.root.appending(path: path), encoding: .utf8)
      return queueFindings(in: text, file: path) + importFindings(in: text, file: path, packageModules: packageModules)
    }
    return kit + appFindings
  }

  // `DispatchQueue` names only its main queue, and no implicit `.global(…)` stands in for one.
  static func queueFindings(in text: String, file: String) -> [Finding] {
    SourceParser.inspect(source: text) { tree in
      let converter = SourceLocationConverter(fileName: file, tree: tree)
      let tokens = Array(tree.tokens(viewMode: .sourceAccurate))
      return tokens.indices.compactMap { index -> Finding? in
        let token = tokens[index], line = token.startLocation(converter: converter).line
        func word(_ offset: Int) -> String? { tokens.indices.contains(index + offset) ? tokens[index + offset].text : nil }
        if token.text == "DispatchQueue" {
          let member = word(1) == "." ? word(2) : nil
          if member == "main" { return nil }
          return Finding(file, line: line, "dispatch-queue", member.map { "DispatchQueue.\($0)" } ?? "DispatchQueue")
        }
        let implicitGlobal = word(-2) != "DispatchQueue" && word(-1) == "." && token.text == "global" && word(1) == "("
        return implicitGlobal ? Finding(file, line: line, "dispatch-queue", ".global(…)") : nil
      }
    }
  }

  static func importFindings(in text: String, file: String, packageModules: Set<String>) -> [Finding] {
    SourceParser.inspect(source: text) { tree in
      let converter = SourceLocationConverter(fileName: file, tree: tree)
      let collector = ModuleSourceRules.ImportCollector(viewMode: .sourceAccurate)
      collector.walk(tree)
      return collector.imports.compactMap { declaration in
        let module = declaration.path.first?.name.text ?? ""
        guard !declaration.attributes.isEmpty, packageModules.contains(module) else { return nil }
        return Finding(file, line: declaration.startLocation(converter: converter).line, "import-modifier", module)
      }
    }
  }
}
