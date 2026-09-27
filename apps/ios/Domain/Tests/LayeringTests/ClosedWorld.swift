import SwiftParser
import SwiftSyntax

// §2.4 item 4: every package, dependency, module and kind is §2.1's, where §2.1 puts it; one constant manifest; no link.
enum ClosedWorld {
  static func findings(in world: World) -> [Finding] {
    let manifests = ConstantManifest(apiNames: world.build.packageDescriptionNames)
    return strayPackages(in: world.tree) + symbolicLinks(in: world.tree)
      + world.packages.flatMap { package in
        secondManifests(of: package, in: world.tree)
          + manifests.findings(in: package.manifestSource, file: package.placement.manifestPath)
          + placement(of: package, in: world)
      }
  }

  static func strayPackages(in tree: FileTree) -> [Finding] {
    let directories = PackagePlacement.all.map(\.directory)
    return tree.entries.keys.filter { $0 == "Package.swift" || $0.hasSuffix("/Package.swift") }.compactMap { manifest in
      let directory = String(manifest.dropLast("/Package.swift".count))
      if directories.contains(directory) { return nil }
      let inside = directories.contains { directory.hasPrefix("\($0)/") }
      return Finding(manifest, inside ? "nested-package" : "unknown-package")
    }
  }

  static func symbolicLinks(in tree: FileTree) -> [Finding] {
    tree.entries.filter { path, kind in
      kind == .symbolicLink && PackagePlacement.all.contains { path.hasPrefix("\($0.directory)/") }
    }.keys.map { Finding($0, "symbolic-link") }
  }

  static func secondManifests(of package: LocalPackage, in tree: FileTree) -> [Finding] {
    tree.manifests(in: package.placement.directory).filter { $0 != package.placement.manifestPath }.map { Finding($0, "second-manifest") }
  }

  static func placement(of package: LocalPackage, in world: World) -> [Finding] {
    let placement = package.placement, manifest = package.manifest
    func finding(_ rule: String, _ detail: String) -> Finding { Finding(placement.manifestPath, rule, detail) }
    let name = manifest.name == placement.name ? [] : [finding("package-name", "\(manifest.name), not \(placement.name)")]
    let dependencies = manifest.dependencies.map { world.location(of: $0, from: package) }.filter { placement.dependencies[$0] == nil }
      .map { finding("package-dependency", $0) }
    let modules = manifest.targets.filter { !$0.isTest }.compactMap { target -> Finding? in
      if !placement.modules.contains(target.name) { return finding("module", "\(target.name) is not §2.1's for \(placement.name)") }
      let kind = PackagePlacement.kind(of: target.name)
      return target.type == kind ? nil : finding("module-kind", "\(target.name) is \(target.type), not \(kind)")
    }
    let uses = manifest.targets.flatMap { target in
      target.dependencies.compactMap { world.productOwner(of: $0, in: package) }.compactMap { owner -> Finding? in
        let allowed =
          switch placement.dependencies[owner.package] {
          case .onlyByTarget(let user): user == target.name
          case .onlyProduct(let product): product == owner.product
          default: true
          }
        return allowed ? nil : finding("dependency-use", "\(target.name) uses \(owner.package)'s \(owner.product)")
      }
    }
    return name + dependencies + modules + uses
  }
}

// §2.4 item 4: a manifest is constant data: literals, PackageDescription calls, MainActor.self and its own top-level lets.
struct ConstantManifest {
  let apiNames: Set<String>

  static let allowedKinds: Set<SyntaxKind> = [
    .sourceFile, .codeBlockItemList, .codeBlockItem, .importDecl, .importPathComponentList, .importPathComponent,
    .variableDecl, .patternBindingList, .patternBinding, .identifierPattern, .typeAnnotation, .initializerClause,
    .identifierType, .memberType, .arrayType, .optionalType, .genericArgumentClause, .genericArgumentList, .genericArgument,
    .functionCallExpr, .labeledExprList, .labeledExpr, .memberAccessExpr, .declReferenceExpr, .declNameArguments,
    .declNameArgumentList, .declNameArgument, .stringLiteralExpr, .stringLiteralSegmentList, .stringSegment,
    .integerLiteralExpr, .floatLiteralExpr, .booleanLiteralExpr, .nilLiteralExpr, .arrayExpr, .arrayElementList,
    .arrayElement, .dictionaryExpr, .dictionaryElementList, .dictionaryElement, .multipleTrailingClosureElementList,
    .attributeList, .declModifierList, .tupleExpr, .token, .typeExpr,
  ]
  static let literalTypes: Set<String> = ["Bool", "Int", "String"]
  static let deniedNames: Set<String> = ["Context", "moduleAliases"]

  func findings(in source: String, file: String) -> [Finding] {
    let tree = Parser.parse(source: source)
    let lets = tree.statements.compactMap { $0.item.as(VariableDeclSyntax.self) }.flatMap(\.bindings)
      .compactMap { $0.pattern.as(IdentifierPatternSyntax.self).map { Self.bare($0.identifier.text) } }
    let names = apiNames.union(Self.literalTypes).subtracting(Self.deniedNames)
    let walk = Walk(names: names, lets: Set(lets), converter: SourceLocationConverter(fileName: file, tree: tree))
    walk.walk(tree)
    let packages = tree.tokens(viewMode: .sourceAccurate).filter { token in
      Self.bare(token.text) == "Package" && token.parent?.is(DeclReferenceExprSyntax.self) == true
    }
    let calls = packages.count == 1 ? [] : [(1, "manifest-syntax", "\(packages.count) Package(…) calls")]
    return (walk.found + calls).map { Finding(file, line: $0.0, $0.1, $0.2) }
  }

  static func bare(_ text: String) -> String {
    text.hasPrefix("`") && text.hasSuffix("`") && text.count > 2 ? String(text.dropFirst().dropLast()) : text
  }

  final class Walk: SyntaxAnyVisitor {
    let names: Set<String>
    let lets: Set<String>
    let converter: SourceLocationConverter
    var found: [(Int, String, String)] = []

    init(names: Set<String>, lets: Set<String>, converter: SourceLocationConverter) {
      self.names = names
      self.lets = lets
      self.converter = converter
      super.init(viewMode: .sourceAccurate)
    }

    func flag(_ node: some SyntaxProtocol, _ rule: String, _ what: String) {
      found.append((node.startLocation(converter: converter).line, rule, what))
    }

    override func visitAny(_ node: Syntax) -> SyntaxVisitorContinueKind {
      guard ConstantManifest.allowedKinds.contains(node.kind) else {
        flag(node, "manifest-syntax", "\(node.kind)")
        return .skipChildren
      }
      return .visitChildren
    }

    override func visit(_ node: ImportDeclSyntax) -> SyntaxVisitorContinueKind {
      let path = node.path.map { ConstantManifest.bare($0.name.text) }
      if path != ["PackageDescription"] || !node.attributes.isEmpty || !node.modifiers.isEmpty || node.importKindSpecifier != nil {
        flag(node, "manifest-import", node.path.map(\.name.text).joined(separator: "."))
      }
      return .skipChildren
    }

    override func visit(_ node: LabeledExprSyntax) -> SyntaxVisitorContinueKind {
      if let label = node.label, ConstantManifest.bare(label.text) == "moduleAliases" { flag(node, "manifest-name", "moduleAliases") }
      return .visitChildren
    }

    override func visit(_ node: VariableDeclSyntax) -> SyntaxVisitorContinueKind {
      if node.bindingSpecifier.tokenKind != .keyword(.let) || !node.attributes.isEmpty || !node.modifiers.isEmpty {
        flag(node, "manifest-syntax", "not a plain let")
      }
      return .visitChildren
    }

    override func visit(_ node: DeclReferenceExprSyntax) -> SyntaxVisitorContinueKind {
      let name = ConstantManifest.bare(node.baseName.text)
      if ConstantManifest.deniedNames.contains(name) || !(names.contains(name) || lets.contains(name) || name == "MainActor") {
        flag(node, "manifest-name", name)
      }
      return .skipChildren
    }

    override func visit(_ node: MemberAccessExprSyntax) -> SyntaxVisitorContinueKind {
      let name = ConstantManifest.bare(node.declName.baseName.text)
      let mainActorSelf = name == "self" && node.base?.trimmedDescription == "MainActor"
      if !(names.contains(name) || mainActorSelf) { flag(node, "manifest-name", name) }
      if let base = node.base { walk(base) }
      return .skipChildren
    }

    override func visit(_ node: IdentifierTypeSyntax) -> SyntaxVisitorContinueKind {
      let name = ConstantManifest.bare(node.name.text)
      if !names.contains(name) { flag(node, "manifest-name", name) }
      return .visitChildren
    }

    override func visit(_ node: MemberTypeSyntax) -> SyntaxVisitorContinueKind {
      let name = ConstantManifest.bare(node.name.text)
      if !names.contains(name) { flag(node, "manifest-name", name) }
      return .visitChildren
    }
  }
}
