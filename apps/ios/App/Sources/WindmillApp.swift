import SwiftUI
import SyncEngine

@main
struct WindmillApp: App {
  @Environment(\.scenePhase) var scenePhase
  @State var model: JournalModel?
  @State var failure: String?
  let settings: AppSettings
  let telemetry: AppTelemetry
  init() {
    let settings = AppSettings()
    self.settings = settings
    #if DEBUG
    let debug = true
    #else
    let debug = false
    #endif
    telemetry = AppTelemetry(info: settings.telemetryInfo, baseURL: settings.baseURL,
                             directory: URL.applicationSupportDirectory.appending(path: "WindmillTelemetry"), debug: debug)
    telemetry.event("app_started")
  }
  var body: some Scene {
    WindowGroup {
      Group {
        if let model {
          RootScreen(model: model)
        } else if let failure {
          ZStack { Design.shell.ignoresSafeArea(); Text(failure).foregroundStyle(Design.ink).padding(24) }
        } else { Design.shell.ignoresSafeArea() }
      }.preferredColorScheme(.dark).onChange(of: scenePhase) { _, phase in
        if phase != .active { model?.background() }
        if phase == .background { telemetry.event("app_backgrounded") }
        else if phase == .active { telemetry.event("app_foregrounded"); model?.refresh() }
      }.task {
        guard model == nil else { return }
        do {
          let runtime = try AppRuntime(settings: settings, telemetry: telemetry)
          let suite = settings.board.map { "board-\($0)" } ?? settings.scenario.map { "scenario-\($0)" }
          let preferences = suite.map { UserDefaults(suiteName: $0)! } ?? .standard
          if settings.scenario != nil, let suite { preferences.removePersistentDomain(forName: suite) }
          let created = try JournalModel(runner: runtime.runner, preferences: preferences, runtime: runtime, telemetry: telemetry)
          if let board = settings.board, !settings.restoreBoard { await BoardFixture.prepare(board, model: created) }
          model = created
          await created.start()
          if settings.scenario != nil { await AppScenario.run(model: created) }
        } catch { failure = "Couldn't open the journal on this phone. \(error.localizedDescription)" }
      }
    }
  }
}

struct RootScreen: View {
  @Bindable var model: JournalModel
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    Group {
      if model.runtime?.settings.board == "01-launch" { Design.shell.ignoresSafeArea() }
      else if model.welcome { welcome.onAppear { model.screenViewed("welcome") } }
      else { JournalScreen(model: model) }
    }.sheet(isPresented: Binding(get: { model.sheet != nil }, set: { if !$0 && !model.editorReadOnly { model.sheet = nil } }), onDismiss: { model.dismissSheet() }) { AccountSheet(model: model) }
      .environment(\.dynamicTypeSize, model.runtime?.settings.board?.contains("AX3") == true ? .accessibility3 : typeSize)
  }

  var welcome: some View {
    GeometryReader { geo in
      ZStack {
        Design.shell.ignoresSafeArea()
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: max(40, geo.size.height * 0.323))
            Text("WINDMILL").font(Design.mono(9)).tracking(3).foregroundStyle(Design.dim).padding(.bottom, 8)
            Text("Where to start?").font(Design.title(34)).foregroundStyle(Design.ink).padding(.bottom, 8)
            Text("Your journal, no account needed.").font(Design.text()).foregroundStyle(Design.dim).padding(.bottom, 61)
            Button { model.openJournal() } label: {
              HStack {
                VStack(alignment: .leading, spacing: 6) {
                  RoundedRectangle(cornerRadius: 1).fill(Design.lamp).frame(width: 3, height: 24).padding(.bottom, 2)
                  Text("Journal").font(Design.title())
                  Text("Write tonight’s page").font(Design.text(14)).foregroundStyle(Design.dim)
                }
                Spacer()
                Image(systemName: "arrow.right").foregroundStyle(Design.lamp).frame(width: 40, height: 40).background(Design.lamp.opacity(0.18), in: Circle())
              }.foregroundStyle(Design.ink).padding(24).frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 140)
                .background { ZStack { Design.canvas; LinearGradient(colors: [.clear, Design.lamp.opacity(0.2)], startPoint: .topLeading, endPoint: .bottomTrailing) }.clipShape(RoundedRectangle(cornerRadius: 28)) }
                .overlay(RoundedRectangle(cornerRadius: 28).stroke(Design.line, lineWidth: 1))
            }.buttonStyle(.plain).accessibilityIdentifier("open-journal")
              .padding(.horizontal, -8)
            if model.canSignIn { Button("Sign in") { model.choose("keep", screen: "welcome"); model.sheet = .keep }.font(Design.strong()).foregroundStyle(Design.dim).frame(maxWidth: .infinity, minHeight: 52).padding(.top, 10) }
            if model.keptWork {
              Text("Changes you kept will return when you sign in to the same account.").font(Design.text(13)).foregroundStyle(Design.dim).padding(.top, 8)
            }
          }.padding(.horizontal, 24).padding(.bottom, 30).frame(minHeight: geo.size.height, alignment: .top)
        }
      }
    }
  }
}
