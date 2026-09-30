// §2.2, the Swift column: each module is in the one row listing it; test targets and swift-syntax's modules are the test layer.
enum Layer: String, Sendable {
  case engineAPI = "engine API"
  case engineRuntime = "engine runtime"
  case engineTestSupport = "engine test support"
  case kit
  case kitTestSupport = "kit test support"
  case productDomain = "product domain"
  case platform
  case productUI = "product UI"
  case test
}

struct LayerRow: Sendable {
  let layer: Layer
  let modules: Set<String>
  let mayDependOn: Set<Layer>
  let mayAlsoDependOn: Set<String>
}

enum Layers {
  static let table = [
    LayerRow(layer: .engineAPI, modules: ["SyncCore", "SyncAPI", "SyncSchema"], mayDependOn: [.engineAPI], mayAlsoDependOn: []),
    LayerRow(
      layer: .engineRuntime,
      modules: ["SyncReplica", "SyncStore", "SyncModelServer", "SyncEngine", "SyncIOS", "SyncSchemaGen", "GRDB"],
      mayDependOn: [.engineAPI, .engineRuntime], mayAlsoDependOn: []),
    LayerRow(layer: .engineTestSupport, modules: ["SyncTesting"], mayDependOn: [.engineAPI, .engineRuntime], mayAlsoDependOn: []),
    LayerRow(layer: .kit, modules: ["DomainKit", "DomainKitNFC"], mayDependOn: [.engineAPI, .kit], mayAlsoDependOn: []),
    LayerRow(
      layer: .kitTestSupport, modules: ["DomainKitTesting"], mayDependOn: [.kit, .engineAPI], mayAlsoDependOn: ["SyncEngine", "SyncTesting"]),
    LayerRow(layer: .productDomain, modules: ["GymDomain", "JournalDomain"], mayDependOn: [.kit, .engineAPI], mayAlsoDependOn: []),
    LayerRow(layer: .platform, modules: ["WindmillPlatform"], mayDependOn: [.kit, .engineAPI], mayAlsoDependOn: ["SyncEngine"]),
    LayerRow(
      layer: .productUI, modules: ["WindmillGym", "WindmillJournal"], mayDependOn: [.productDomain, .kit, .engineAPI, .platform],
      mayAlsoDependOn: ["SyncEngine"]),
  ]

  static let products = ["GymDomain": "Gym", "WindmillGym": "Gym", "JournalDomain": "Journal", "WindmillJournal": "Journal"]
  static let testMayNotDependOn: Set<Layer> = [.platform, .productUI]
  static let closureChecked: Set<Layer> = [.kit, .productDomain]
  static let closureStaysIn: Set<Layer> = [.kit, .engineAPI]

  static func row(of module: String) -> LayerRow? { table.first { $0.modules.contains(module) } }

  static func findings(in world: World) -> [Finding] {
    let swiftSyntax = Set(world.build.remotePackages["swift-syntax"]?.targets.map(\.name) ?? [])
    func layer(_ module: String) -> Layer? { swiftSyntax.contains(module) ? .test : row(of: module)?.layer }
    let edges = Dictionary(
      world.packages.flatMap { package in package.manifest.targets.map { ($0.name, world.dependencies(of: $0, in: package)) } }
    ) { first, _ in first }
    return world.packages.flatMap { package in
      package.manifest.targets.flatMap { target in
        let module = target.name, dependencies = edges[module] ?? []
        let own: Layer? = target.isTest ? .test : layer(module)
        let found = own.map { edgeFindings(module, $0, dependencies, layer) } ?? ["\(module) is in no row"]
        let closure = own.map { closureChecked.contains($0) } == true ? closureFindings(module, edges, layer) : []
        return found.map { Finding(package.placement.manifestPath, "layer", $0) }
          + closure.map { Finding(package.placement.manifestPath, "closure", $0) }
      }
    }
  }

  static func edgeFindings(_ module: String, _ own: Layer, _ dependencies: [String], _ layer: (String) -> Layer?) -> [String] {
    dependencies.compactMap { dependency in
      let other = layer(dependency), otherName = other?.rawValue ?? "no row"
      if dependency == "GRDB" && module != "SyncStore" { return "\(module) may not depend on GRDB (SyncStore only)" }
      if own == .test {
        let forbidden = other.map { testMayNotDependOn.contains($0) } == true && module != "\(dependency)Tests"
        return forbidden ? "\(module) (test) may not depend on \(dependency) (\(otherName))" : nil
      }
      guard let row = row(of: module) else { return nil }
      guard other.map({ row.mayDependOn.contains($0) }) == true || row.mayAlsoDependOn.contains(dependency) else {
        return "\(module) (\(own.rawValue)) may not depend on \(dependency) (\(otherName))"
      }
      let sameProduct = products[dependency] == nil || products[dependency] == products[module]
      return own == .productUI && !sameProduct ? "\(module) may not depend on another product's \(dependency)" : nil
    }
  }

  // §2.2: the transitive closure of every kit and product-domain module stays inside kit and engine API.
  static func closureFindings(_ module: String, _ edges: [String: [String]], _ layer: (String) -> Layer?) -> [String] {
    var reached: Set<String> = [], pending = edges[module] ?? [], found: [String] = []
    while let next = pending.popLast() {
      guard reached.insert(next).inserted else { continue }
      if !(layer(next).map { closureStaysIn.contains($0) } ?? false) { found.append("\(module) reaches \(next)") }
      pending += edges[next] ?? []
    }
    return found
  }
}
