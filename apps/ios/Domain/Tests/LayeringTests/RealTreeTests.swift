import Foundation
import Testing

// The rules over the real apps/ios, its CI workflows and each app project that exists: the probe app's and, once built, the app's.
@Suite struct RealTreeTests {
  static let world = Result { try World.read(root: Checkout.iosRoot, build: try RunningBuild.current.get()) }
  static let apps = [AppProject.App.product, .product(at: "App/project.yml"), .probe].filter { FileManager.default.fileExists(atPath: Checkout.iosRoot.appending(path: $0.spec).path) }

  @Test func readsTheEngineAndTheKit() throws {
    #expect(Set(try Self.world.get().packages.map(\.placement.directory)).isSuperset(of: ["Sync", "Domain"]))
  }

  @Test func packagesFormTheClosedWorld() throws {
    let findings = ClosedWorld.findings(in: try Self.world.get()).sorted().map(\.description)
    #expect(findings == [])
  }

  @Test func edgesKeepTheLayers() throws {
    let findings = Layers.findings(in: try Self.world.get()).sorted().map(\.description)
    #expect(findings == [])
  }

  @Test func targetsTakeTheirRowsSettings() throws {
    let findings = Settings.findings(in: try Self.world.get()).sorted().map(\.description)
    #expect(findings == [])
  }

  @Test func sourcesKeepTheirRows() throws {
    let findings = SourceRules.findings(in: try Self.world.get()).sorted().map(\.description)
    #expect(findings == [])
  }

  @Test func parserMatchesTheCompiler() throws {
    let resolved = try String(contentsOf: Checkout.iosRoot.appending(path: "Domain/Package.resolved"), encoding: .utf8)
    let compiler = try RunningBuild.current.get().compilerVersion
    let findings = SourceRules.parserVersionFindings(resolved: resolved, file: "Domain/Package.resolved", compilerVersion: compiler)
    #expect(findings.map(\.description) == [])
  }

  @Test func workflowsPassNoOverrides() throws {
    let findings = try Workflows.findings(in: Checkout.repositoryRoot.appending(path: ".github/workflows")).sorted().map(\.description)
    #expect(findings == [])
  }

  @Test func judgesTheProbeApp() {
    #expect(Self.apps.map(\.spec).contains(AppProject.App.probe.spec))
  }

  @Test(.enabled(if: Shell.isInstalled("xcodegen"), "XcodeGen is installed"), arguments: apps)
  func appResolvesThePinnedSettings(_ app: AppProject.App) throws {
    let sourcePackages = Checkout.sourcePackages.map(app.directory(in:))
    let findings = try AppProject.findings(root: Checkout.iosRoot, app: app, sourcePackages: sourcePackages).sorted().map(\.description)
    #expect(findings == [], "App settings: \(findings)")
  }
}
