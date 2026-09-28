import SwiftUI

// The probe host app (design §10): a dev and test build over the probe product. Launched with `-scenario <name>` it runs
// that scenario headless and exits; otherwise it shows the screens, each one tab.
@main
struct ProbeApp: App {
  let probe: Probe
  let scenario: ScenarioRun?

  init() {
    let settings = LaunchSettings()
    let probe: Probe
    do {
      probe = try Probe(settings: settings)
    } catch {
      fatalError("the probe could not compose its engine: \(error)")
    }
    self.probe = probe
    scenario = settings.scenario.map { ScenarioRun(name: $0, probe: probe) }
  }

  var body: some Scene {
    WindowGroup {
      if let scenario {
        Text("Running \(scenario.name)").task { await scenario.run() }
      } else {
        ProbeScreens(probe: probe).task { await probe.engine.start() }
      }
    }
  }
}

struct ProbeScreens: View {
  let probe: Probe

  var body: some View {
    TabView {
      Tab("Replicas", systemImage: "externaldrive") { ReplicasScreen(probe: probe) }
      Tab("Outbox", systemImage: "tray.and.arrow.up") { OutboxScreen(probe: probe) }
      Tab("Cursors", systemImage: "arrow.down.circle") { CursorsScreen(probe: probe) }
      Tab("Views", systemImage: "rectangle.split.2x1") { ViewsScreen(probe: probe) }
      Tab("Notices", systemImage: "exclamationmark.bubble") { NoticesScreen(probe: probe) }
      Tab("Actions", systemImage: "hand.tap") { ActionsScreen(probe: probe) }
      Tab("Lifecycle", systemImage: "person.crop.circle") { LifecycleScreen(probe: probe) }
      Tab("Faults", systemImage: "bolt.trianglebadge.exclamationmark") { FaultsScreen(probe: probe) }
    }
  }
}
