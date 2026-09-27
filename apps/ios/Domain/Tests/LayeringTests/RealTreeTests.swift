import Foundation
import Testing

// The rules over the real apps/ios, its CI workflows and, when it exists, the app project.
@Suite struct RealTreeTests {
  static let world = Result { try World.read(root: Checkout.iosRoot, build: try RunningBuild.current.get()) }
  static let appSpec = "project.yml"
  static let hasAppProject = FileManager.default.fileExists(atPath: Checkout.iosRoot.appending(path: appSpec).path)

  @Test func readsTheEngineAndTheKit() throws {
    #expect(Set(try Self.world.get().packages.map(\.placement.directory)).isSuperset(of: ["Sync", "Domain"]))
  }

  @Test func packagesFormTheClosedWorld() throws {
    #expect(ClosedWorld.findings(in: try Self.world.get()).sorted().map(\.description) == [])
  }

  @Test func edgesKeepTheLayers() throws {
    #expect(Layers.findings(in: try Self.world.get()).sorted().map(\.description) == [])
  }

  @Test func targetsTakeTheirRowsSettings() throws {
    #expect(Settings.findings(in: try Self.world.get()).sorted().map(\.description) == [])
  }

  @Test func sourcesKeepTheirRows() throws {
    #expect(SourceRules.findings(in: try Self.world.get()).sorted().map(\.description) == [])
  }

  @Test func parserMatchesTheCompiler() throws {
    let resolved = try String(contentsOf: Checkout.iosRoot.appending(path: "Domain/Package.resolved"), encoding: .utf8)
    let compiler = try RunningBuild.current.get().compilerVersion
    let findings = SourceRules.parserVersionFindings(resolved: resolved, file: "Domain/Package.resolved", compilerVersion: compiler)
    #expect(findings.map(\.description) == [])
  }

  @Test func workflowsPassNoOverrides() throws {
    #expect(try Workflows.findings(in: Checkout.repositoryRoot.appending(path: ".github/workflows")).sorted().map(\.description) == [])
  }

  @Test(.enabled(if: hasAppProject && Shell.isInstalled("xcodegen"), "the app project exists and XcodeGen is installed"))
  func appResolvesThePinnedSettings() throws {
    #expect(try AppProject.findings(root: Checkout.iosRoot, spec: Self.appSpec).sorted().map(\.description) == [])
  }
}
