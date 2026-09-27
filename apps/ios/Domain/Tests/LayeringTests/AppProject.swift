import Foundation

// §2.4 items 3 and 4, the app: project.yml as written, and what XcodeGen generates and xcodebuild resolves.
enum AppProject {
  static let targetTypes: Set<String> = [
    "com.apple.product-type.application", "com.apple.product-type.bundle.unit-test", "com.apple.product-type.bundle.ui-testing",
  ]
  static let localPackages: Set<String> = ["Sync", "Domain", "WindmillKit"]
  static let pinnedValues: Set<String> = ["SWIFT_VERSION", "SWIFT_TREAT_WARNINGS_AS_ERRORS", "SWIFT_WARNINGS_AS_WARNINGS_GROUPS"]
  static let pinnedUnset: Set<String> = ["OTHER_SWIFT_FLAGS", "SWIFT_EXEC", "SWIFT_USE_INTEGRATED_DRIVER", "TOOLCHAINS"]
  static let isolation = "SWIFT_DEFAULT_ACTOR_ISOLATION"
  static let pinned = pinnedValues.union(pinnedUnset).union([isolation])
  static let sdks = ["iphoneos", "iphonesimulator"]
  static let defaultToolchain = "com.apple.dt.toolchain.XcodeDefault"

  static func findings(root: URL, spec: String) throws -> [Finding] {
    let written = try JSONDecoder().decode(
      JSONValue.self, from: Data(try Shell.run(["xcodegen", "dump", "--type", "json", "--spec", root.appending(path: spec).path]).utf8))
    let resolved = try Scratch.withDirectory { scratch in try resolve(root: root, spec: spec, scratch: scratch) }
    return specFindings(written, root: root).map { Finding(spec, "project", $0) }
      + resolvedFindings(resolved).map { Finding(spec, "build-settings", $0) }
  }

  // Each target sets the pinned keys in its own settings, literally; nothing else sets one; no build rule compiles Swift.
  static func specFindings(_ spec: JSONValue, root: URL) -> [String] {
    var configurationFilesRead: Set<String> = []
    let groups = spec["settingGroups"]?.fields ?? []
    let packages: [String] = (spec["packages"]?.fields ?? []).compactMap { name, package in
      guard let path = package["path"]?.text, !localPackages.contains((path as NSString).standardizingPath) else { return nil }
      return "package \(name) at \(path) is not §2.1's"
    }
    let literal: [String] = literalFindings("settings", spec["settings"]) + groups.flatMap { literalFindings("settingGroups.\($0.key)", $0.value) }
    let outside: [String] = pinnedFindings("settings", spec["settings"], "is set outside a target")
      + groups.flatMap { pinnedFindings("settingGroups.\($0.key)", $0.value, "is set outside a target") }
    let files: [String] = (spec["configFiles"]?.fields ?? []).flatMap { configuration, file in
      configurationFileFindings(root.appending(path: file.text ?? ""), "configFiles.\(configuration)", &configurationFilesRead)
    }
    let targets: [String] = (spec["targets"]?.fields ?? []).flatMap { name, target in
      targetFindings(name, target, root: root, &configurationFilesRead)
    }
    return Array([packages, literal, outside, files, targets].joined())
  }

  static func targetFindings(_ name: String, _ target: JSONValue, root: URL, _ configurationFilesRead: inout Set<String>) -> [String] {
    let settings = target["settings"] ?? .object([:])
    let grouped = ["base", "configs", "groups"].contains { settings[$0] != nil }
    let own = grouped ? settings["base"]?.fields ?? [] : settings.fields
    let elsewhere = JSONValue.object(Dictionary(uniqueKeysWithValues: grouped ? settings.fields.filter { $0.key != "base" } : []))
    let wanted = pinnedValues.union(target["type"]?.text == "application" ? [isolation] : [])
    let literal = literalFindings("\(name).settings", target["settings"])
    let outside = pinnedFindings("\(name).settings", elsewhere, "is set outside the target's own settings")
    let missing = wanted.subtracting(own.map(\.key)).sorted().map { "\(name): \($0) is not set in the target's own settings" }
    let set = pinnedUnset.intersection(own.map { bareKey($0.key) }).sorted().map { "\(name): sets \($0)" }
    let files: [String] = (target["configFiles"]?.fields ?? []).flatMap { configuration, file in
      configurationFileFindings(root.appending(path: file.text ?? ""), "\(name).configFiles.\(configuration)", &configurationFilesRead)
    }
    let rules: [String] = (target["buildRules"]?.elements ?? []).map { rule in
      "\(name): a build rule (\(rule["filePattern"]?.text ?? rule["fileType"]?.text ?? "?"))"
    }
    let scripts: [String] = ["preBuildScripts", "postCompileScripts", "postBuildScripts"].flatMap { target[$0]?.elements ?? [] }
      .filter { script in (script["outputFiles"]?.elements ?? []).contains { [".swift", ".o"].contains(where: $0.description.hasSuffix) } }
      .map { _ in "\(name): a script phase outputs Swift or objects" }
    return Array([literal, outside, missing, set, files, rules, scripts].joined())
  }

  // A pinned key is literal: no `[…]` condition and no `$(…)` reference.
  static func literalFindings(_ place: String, _ settings: JSONValue?) -> [String] {
    (settings?.fields ?? []).flatMap { key, value -> [String] in
      let upperCase = key == key.uppercased() && key.contains(where: \.isLetter)
      if case .object = value, ["base", "configs", "Debug", "Release"].contains(key) || !upperCase {
        return literalFindings("\(place).\(key)", value)
      }
      guard pinned.contains(bareKey(key)) else { return [] }
      let conditional = key.contains("[") ? ["\(place): \(key) is conditional"] : []
      let text = value.description
      let referenced = text.contains("$(") || text.contains("${") ? ["\(place): \(key) = \(text) is not literal"] : []
      return conditional + referenced
    }
  }

  static func pinnedFindings(_ place: String, _ settings: JSONValue?, _ why: String) -> [String] {
    (settings?.fields ?? []).flatMap { key, value -> [String] in
      if case .object = value { return pinnedFindings("\(place).\(key)", value, why) }
      return pinned.contains(bareKey(key)) ? ["\(place): \(key) \(why)"] : []
    }
  }

  static func configurationFileFindings(_ file: URL, _ place: String, _ read: inout Set<String>) -> [String] {
    guard read.insert(file.standardizedFileURL.path).inserted, let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
    return text.split(separator: "\n").flatMap { raw -> [String] in
      let line = (raw.components(separatedBy: "//").first ?? "").trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("#include") {
        let included = line.split(separator: "\"").dropFirst().first.map(String.init) ?? String(line.split(separator: " ").last ?? "")
        return configurationFileFindings(file.deletingLastPathComponent().appending(path: String(included.drop { $0 == "?" })), place, &read)
      }
      let key = bareKey(line.prefix { $0 != "=" }.trimmingCharacters(in: .whitespaces))
      return line.contains("=") && pinned.contains(key) ? ["\(place): \(file.lastPathComponent) sets \(key)"] : []
    }
  }

  static func bareKey(_ key: String) -> String { String(key.prefix { $0 != "[" }).trimmingCharacters(in: .whitespaces) }

  struct Resolved {
    let target: String
    let configuration: String
    let sdk: String
    let settings: [String: String]

    var place: String { "\(target) [\(configuration), \(sdk)]" }
    var isApplication: Bool { settings["PRODUCT_TYPE"]?.hasSuffix("application") == true }
  }

  // Generated into scratch (its path shown as $(SRCROOT), its derived data kept there); nil when it does not resolve.
  static func resolve(root: URL, spec: String, scratch: URL) throws -> [Resolved]? {
    let project = scratch.appending(path: "project"), derivedData = "-IDECustomDerivedDataLocation=\(scratch.appending(path: "derived").path)"
    try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
    _ = try Shell.run([
      "xcodegen", "generate", "--quiet", "--spec", root.appending(path: spec).path, "--project", project.path, "--project-root", root.path,
    ])
    guard let generated = try FileManager.default.contentsOfDirectory(atPath: project.path).first(where: { $0.hasSuffix(".xcodeproj") }),
      let listing = try? Shell.run(["xcodebuild", derivedData, "-list", "-json", "-project", project.appending(path: generated).path])
    else { return nil }
    let configurations = try JSONDecoder().decode(JSONValue.self, from: Data(listing.utf8))["project"]?["configurations"]?.elements ?? []
    let named = { (value: String) in
      [project.resolvingSymlinksInPath().path, project.path].reduce(value) { $0.replacingOccurrences(of: $1, with: "$(SRCROOT)") }
    }
    return try configurations.compactMap(\.text).flatMap { configuration in
      try sdks.flatMap { sdk in
        let json = try Shell.run([
          "xcodebuild", derivedData, "-showBuildSettings", "-json", "-project", project.appending(path: generated).path, "-alltargets",
          "-configuration", configuration, "-sdk", sdk,
        ])
        let shown = try JSONDecoder().decode([ShownSettings].self, from: Data(json.utf8))
        let targets = shown.enumerated().filter { index, entry in !shown[..<index].contains { $0.target == entry.target } }.map(\.element)
        return targets.map { Resolved(target: $0.target, configuration: configuration, sdk: sdk, settings: $0.buildSettings.mapValues(named)) }
      }
    }
  }

  struct ShownSettings: Decodable {
    let target: String
    let buildSettings: [String: String]
  }

  // Every target, configuration and SDK: Swift 6.0, warnings as errors, no flags or compiler of its own; one app target.
  static func resolvedFindings(_ resolved: [Resolved]?) -> [String] {
    guard let resolved else { return ["the project does not resolve"] }
    let first = resolved.first
    let apps = resolved.filter { $0.isApplication && $0.configuration == first?.configuration && $0.sdk == first?.sdk }.count
    return resolved.flatMap(settingFindings) + (resolved.isEmpty || apps == 1 ? [] : ["\(apps) app targets"])
  }

  static func settingFindings(_ entry: Resolved) -> [String] {
    let settings = entry.settings, kind = settings["PRODUCT_TYPE"] ?? ""
    guard targetTypes.contains(kind) else { return ["\(entry.place): a \(kind)"] }
    let groups = settings["SWIFT_WARNINGS_AS_WARNINGS_GROUPS"] ?? "", toolchain = settings["TOOLCHAINS"] ?? ""
    let unset = ["OTHER_SWIFT_FLAGS", "SWIFT_EXEC", "SWIFT_USE_INTEGRATED_DRIVER"].map { key in
      let value = (settings[key] ?? "").trimmingCharacters(in: .whitespaces)
      return (!value.isEmpty, "\(key) \(value)")
    }
    let checks = [
      (settings["SWIFT_VERSION"] != "6.0", "SWIFT_VERSION \(settings["SWIFT_VERSION"] ?? "unset")"),
      (settings["SWIFT_TREAT_WARNINGS_AS_ERRORS"] != "YES", "warnings are not errors"),
      (groups.split(separator: " ") != ["DeprecatedDeclaration"], "warning groups \(groups)"),
    ] + unset + [
      (!["", defaultToolchain].contains(toolchain), "TOOLCHAINS \(toolchain)"),
      (entry.isApplication && settings[isolation] != "MainActor", "default isolation \(settings[isolation] ?? "unset")"),
    ]
    return checks.filter(\.0).map { "\(entry.place): \($0.1)" }
  }
}
