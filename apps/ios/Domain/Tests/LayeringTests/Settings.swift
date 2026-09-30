// §2.4 item 3, the packages: tools 6.2 or later, language mode 6 only, every non-test target's settings exactly its row's.
enum Settings {
  static let memberImportVisibility = ["enableUpcomingFeature(MemberImportVisibility)"]
  static let memberImportVisibilityTargets: Set<String> = ["DomainKit", "GymDomain", "JournalDomain", "SyncCore", "SyncAPI", "SyncSchema"]
  static let userInterface = ["defaultIsolation(MainActor)", "treatAllWarnings(error)", "treatWarning(DeprecatedDeclaration, warning)"]
  static let userInterfacePackage = "WindmillKit"
  static let minimumToolsVersion = [6, 2]
  static let languageModes = ["6"]

  static func expected(for target: String, in package: PackagePlacement) -> [String] {
    if memberImportVisibilityTargets.contains(target) { return memberImportVisibility }
    return package.name == userInterfacePackage ? userInterface : []
  }

  static func findings(in world: World) -> [Finding] {
    world.packages.flatMap { package in
      packageFindings(package) + package.manifest.targets.filter { !$0.isTest }.flatMap { targetFindings($0, in: package) }
    }
  }

  static func packageFindings(_ package: LocalPackage) -> [Finding] {
    let manifest = package.manifest, file = package.placement.manifestPath
    let version = manifest.toolsVersion.split(separator: ".").compactMap { Int($0) }
    let tools = version.lexicographicallyPrecedes(minimumToolsVersion) ? [Finding(file, "tools-version", "\(manifest.toolsVersion), below 6.2")] : []
    let modes = listed(manifest.languageModes), expectedModes = listed(languageModes)
    return tools + (modes == expectedModes ? [] : [Finding(file, "language-modes", "\(modes), not \(expectedModes)")])
  }

  static func targetFindings(_ target: PackageDump.Target, in package: LocalPackage) -> [Finding] {
    let file = package.placement.manifestPath
    let settings = target.settings.map(\.description), expectedSettings = expected(for: target.name, in: package.placement)
    let plugins = (target.pluginUsages ?? []).map(\.description)
    let wrong = settings == expectedSettings ? [] : [Finding(file, "settings", "\(target.name) is \(listed(settings)), not \(listed(expectedSettings))")]
    return wrong + (plugins.isEmpty ? [] : [Finding(file, "plugins", "\(target.name) uses \(plugins.joined(separator: ", "))")])
  }

  static func listed(_ items: [String]) -> String { "[\(items.joined(separator: ", "))]" }
}
