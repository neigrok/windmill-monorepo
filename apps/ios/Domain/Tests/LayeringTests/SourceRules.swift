import Foundation
import SwiftParser
import SwiftSyntax

// §2.3 over each file dump-package assigns a module: imports by syntax, names and the lint by token, literal text skipped.
enum SourceRules {
  // §2.3's table: the modules it lists by name and the imports each may write; every other non-test module is the last row.
  static let namedImports: [String: Set<String>] = [
    "DomainKitNFC": ["Foundation"],
    "DomainKit": ["SyncCore", "SyncAPI", "DomainKitNFC"],
    "GymDomain": productDomainImports,
    "JournalDomain": productDomainImports,
    "SyncCore": ["CryptoKit"],
    "SyncAPI": ["SyncCore"],
    "SyncSchema": ["SyncCore"],
  ]
  static let productDomainImports: Set<String> = ["SyncCore", "SyncAPI", "SyncSchema", "DomainKit"]
  static let digestModule = "SyncCore"
  static let digestFile = "Digest.swift"

  static let lintedModules: Set<String> = ["DomainKit", "GymDomain", "JournalDomain"]
  static let lintTokens: Set<String> = [
    "random", "randomElement", "shuffle", "shuffled", "SystemRandomNumberGenerator", "hashValue", "ContinuousClock", "SuspendingClock",
    "continuous", "suspending", "CommandLine", "readLine", "print", "debugPrint", "dump", "Task", "async", "await", "MainActor",
    "nonisolated", "@unchecked", "finalize", "ObjectIdentifier",
  ]
  static let unsafePrefixes = ["Unsafe", "unsafe", "withUnsafe"]
  static let branches: Set<String> = ["#if", "#elseif", "#available", "#unavailable", "@available"]

  static let noUserInterfaceLayers: Set<Layer> = [.kit, .kitTestSupport, .productDomain, .engineAPI, .engineRuntime, .engineTestSupport]
  static let userInterfaceFrameworks: Set<String> = [
    "SwiftUI", "UIKit", "AppKit", "Combine", "AuthenticationServices", "StoreKit", "SafariServices", "LinkPresentation", "QuickLook",
    "PhotosUI", "MapKit", "AVKit", "WebKit", "PassKit",
  ]
  static let userInterfaceExceptions = ["SyncIOS": "UIKit"]
  static let combineNames: Set<String> = ["ObservableObject", "Published", "AnyCancellable", "PassthroughSubject", "CurrentValueSubject"]
  static let storageFrameworks: Set<String> = ["SQLite3", "CoreData", "SwiftData"]
  static let storageModule = "SyncStore"

  static let nfcModule = "DomainKitNFC"
  static let nfcSource = "import Foundation\n\npublic func nfc(_ s: String) -> String { s.precomposedStringWithCanonicalMapping }\n"

  static func findings(in world: World) -> [Finding] {
    let packageModules = world.packageModules
    return world.packages.flatMap { package in
      package.manifest.targets.filter { !$0.isTest }.flatMap { target in
        let files = package.sources[target.name] ?? []
        let rules = ModuleSourceRules(
          module: target.name, declaredDependencies: Set(world.dependencies(of: target, in: package)), packageModules: packageModules)
        return files.flatMap { rules.findings(in: $0.text, file: $0.path) }
          + unscanned(target, files: files, manifest: package.placement.manifestPath)
      }
    }
  }

  // §2.4 item 5: a module §2.3 names that the scan did not read fails; DomainKitNFC is exactly one file.
  static func unscanned(_ target: PackageDump.Target, files: [SourceFile], manifest: String) -> [Finding] {
    guard namedImports[target.name] != nil else { return [] }
    if target.type != "regular" { return [Finding(manifest, "unscanned", "\(target.name) is a \(target.type) target")] }
    if files.isEmpty { return [Finding(manifest, "unscanned", "\(target.name) has no Swift file")] }
    if target.name == nfcModule && files.count != 1 { return [Finding(manifest, "nfc-pin", "\(nfcModule) has \(files.count) files, not 1")] }
    return []
  }

  // §2.3: the parser's major version matches the compiler's (602 for Swift 6.2).
  static func parserVersionFindings(resolved: String, file: String, compilerVersion: String) -> [Finding] {
    let pins = (try? JSONDecoder().decode(JSONValue.self, from: Data(resolved.utf8)))?["pins"]?.elements ?? []
    let pinned = pins.first { $0["identity"]?.text == "swift-syntax" }?["state"]?["version"]?.text ?? "none"
    let compiler = compilerVersion.split(separator: ".").compactMap { Int($0) }
    let expected = compiler.count >= 2 ? compiler[0] * 100 + compiler[1] : 0
    let major = Int(pinned.split(separator: ".").first ?? "")
    return major == expected ? [] : [Finding(file, "parser-version", "swift-syntax \(pinned) for Swift \(compilerVersion) (\(expected))")]
  }
}

// §2.3 for one module: its row of the table, and the layer rules on UI frameworks, storage and Combine names.
struct ModuleSourceRules {
  let module: String
  let declaredDependencies: Set<String>
  let packageModules: Set<String>

  var isNamed: Bool { SourceRules.namedImports[module] != nil }
  var isLinted: Bool { SourceRules.lintedModules.contains(module) }
  var bansUserInterface: Bool { Layers.row(of: module).map { SourceRules.noUserInterfaceLayers.contains($0.layer) } ?? false }

  func findings(in text: String, file: String) -> [Finding] {
    let tree = Parser.parse(source: text)
    let converter = SourceLocationConverter(fileName: file, tree: tree)
    let tokens = isNamed || bansUserInterface ? tokenFindings(in: tree, file: file, converter: converter) : []
    let pinned = module != SourceRules.nfcModule || text == SourceRules.nfcSource
    let pin = pinned ? [] : [Finding(file, "nfc-pin", "the text is not §2.3's constant")]
    return importFindings(in: tree, file: file, converter: converter) + tokens + pin
  }

  func importFindings(in tree: SourceFileSyntax, file: String, converter: SourceLocationConverter) -> [Finding] {
    let collector = ImportCollector(viewMode: .sourceAccurate)
    collector.walk(tree)
    return collector.imports.flatMap { declaration in
      let name = declaration.path.map(\.name.text).joined(separator: ".")
      let line = declaration.startLocation(converter: converter).line
      let modifier = declaration.attributes.isEmpty ? [] : [Finding(file, line: line, "import-modifier", name)]
      let imported = declaration.path.first?.name.text ?? ""
      return modifier + (allows(imported, in: file) ? [] : [Finding(file, line: line, "import", name)])
    }
  }

  func allows(_ imported: String, in file: String) -> Bool {
    if let row = SourceRules.namedImports[module] {
      let digestOnly = module == SourceRules.digestModule && (file as NSString).lastPathComponent != SourceRules.digestFile
      return !digestOnly && row.contains(imported)
    }
    if packageModules.contains(imported) && !declaredDependencies.contains(imported) { return false }
    if SourceRules.storageFrameworks.contains(imported) && module != SourceRules.storageModule { return false }
    let userInterface = SourceRules.userInterfaceFrameworks.contains(imported) && SourceRules.userInterfaceExceptions[module] != imported
    return !(userInterface && bansUserInterface)
  }

  func tokenFindings(in tree: SourceFileSyntax, file: String, converter: SourceLocationConverter) -> [Finding] {
    let tokens = Array(tree.tokens(viewMode: .sourceAccurate))
    var found: [Finding] = []
    var index = 0
    while index < tokens.count {
      let token = tokens[index], next = index + 1 < tokens.count ? tokens[index + 1] : nil
      let line = token.startLocation(converter: converter).line
      index += 1
      if case .stringSegment = token.tokenKind { continue }
      if case .regexLiteralPattern = token.tokenKind { continue }
      let hits: [(rule: String, detail: String)]
      if let attribute = attributeName(token, next) {
        index += attribute.spansNext ? 1 : 0
        hits = attributeHits(attribute.name)
      } else {
        hits = identifierHits(token, next)
      }
      found += hits.map { Finding(file, line: line, $0.rule, $0.detail) }
    }
    return found
  }

  func attributeName(_ token: TokenSyntax, _ next: TokenSyntax?) -> (name: String, spansNext: Bool)? {
    let sigil = token.tokenKind == .atSign || token.tokenKind == .pound
    if sigil, let next, next.leadingTrivia.isEmpty, next.isNameToken { return (token.text + next.text, true) }
    if token.text.hasPrefix("#") && token.text.count > 1 { return (token.text, false) }
    return nil
  }

  func attributeHits(_ name: String) -> [(rule: String, detail: String)] {
    let combine = SourceRules.combineNames.contains(String(name.dropFirst())) ? [("combine", name)] : []
    guard isNamed else { return combine }
    let underscore = name.hasPrefix("@_") || name.hasPrefix("#_") ? [("underscore-attribute", name)] : []
    let branch = SourceRules.branches.contains(name) ? [("branch", name)] : []
    let linted = isLinted && (SourceRules.lintTokens.contains(name) || SourceRules.lintTokens.contains(String(name.dropFirst())))
    return combine + underscore + branch + (linted ? [("token", name)] : [])
  }

  func identifierHits(_ token: TokenSyntax, _ next: TokenSyntax?) -> [(rule: String, detail: String)] {
    guard token.isNameToken else { return [] }
    let text = ConstantManifest.bare(token.text)
    let combine = SourceRules.combineNames.contains(text) ? [("combine", text)] : []
    guard isLinted else { return combine }
    let lint = SourceRules.lintTokens.contains(text) ? [("token", text)] : []
    let underscore = text.hasPrefix("_") && text != "_" ? [("underscore-identifier", text)] : []
    let unsafe = SourceRules.unsafePrefixes.contains { text.hasPrefix($0) } ? [("unsafe", text)] : []
    let hasher = text == "Hasher" && next?.tokenKind == .leftParen ? [("Hasher(", text)] : []
    return combine + lint + underscore + unsafe + hasher
  }

  final class ImportCollector: SyntaxVisitor {
    var imports: [ImportDeclSyntax] = []

    override func visit(_ node: ImportDeclSyntax) -> SyntaxVisitorContinueKind {
      imports.append(node)
      return .skipChildren
    }
  }
}

extension TokenSyntax {
  var isNameToken: Bool {
    switch tokenKind {
    case .identifier, .keyword, .dollarIdentifier: true
    default: false
    }
  }
}
