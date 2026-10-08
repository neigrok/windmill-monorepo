import SwiftUI
import SyncEngine

@main
struct WindmillApp: App {
  @Environment(\.scenePhase) var scenePhase
  @State var model: AppModel?
  @State var failure: String?
  @State var introduction = false
  @State var launchLink = false
  @State var workoutLink = false
  @UIApplicationDelegateAdaptor(OnboardingLaunchDelegate.self) var launchDelegate
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
    telemetry = WorkoutActivityIntentHandler.telemetry ?? AppTelemetry(info: settings.telemetryInfo, baseURL: settings.baseURL,
                             directory: URL.applicationSupportDirectory.appending(path: "WindmillTelemetry"), debug: debug)
    WorkoutActivityIntentHandler.telemetry = telemetry
    telemetry.event("app_started")
  }
  var body: some Scene {
    WindowGroup {
      Group {
        if let model {
          if introduction {
            OnboardingScreen(replay: false, telemetry: telemetry) { introduction = false }
          } else { RootScreen(model: model).preferredColorScheme(model.selectedRoom == .gym && !model.welcome ? OnboardingFixture.appearance : .dark) }
        } else if let failure {
          ZStack { Design.shell.ignoresSafeArea(); Text(failure).foregroundStyle(Design.ink).padding(24) }
        } else { Color("ShellCanvas").ignoresSafeArea() }
      }.preferredColorScheme(OnboardingFixture.appearance)
        .onOpenURL { url in
          launchLink = true; introduction = false
          if url.scheme == "windmill", url.host == "workout" { workoutLink = true; model?.openActivityWorkout() }
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { _ in launchLink = true; introduction = false }
        .onChange(of: scenePhase) { _, phase in
        model?.scenePhaseChanged(phase)
        if phase == .background { telemetry.event("app_backgrounded") }
        else if phase == .active { telemetry.event("app_foregrounded") }
      }.modifier(AppStartup(model: model))
      .task(id: scenePhase) {
        guard scenePhase == .active, model == nil else { return }
        await Task.yield()
        guard !Task.isCancelled else { return }
        do {
          let runtime = try WorkoutActivityIntentHandler.model?.runtime ?? AppRuntime(settings: settings, telemetry: telemetry)
          let suite = settings.board.map { "board-\($0)" } ?? settings.scenario.map { "scenario-\($0)" }
          let preferences = suite.map { UserDefaults(suiteName: $0)! } ?? .standard
          if settings.scenario != nil, !settings.restoreBoard, let suite { preferences.removePersistentDomain(forName: suite) }
          if !settings.restoreBoard, let board = settings.board { preferences.removePersistentDomain(forName: "board-\(board)") }
          let authenticationTime = settings.appleFixture == "hello-failure" ? Date() : nil
          let created = try WorkoutActivityIntentHandler.model ?? AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime, telemetry: telemetry,
            authRetryNow: { authenticationTime ?? Date() })
          WorkoutActivityIntentHandler.model = created
          created.gym.startWorkoutActivity()
          var onboardingFixture = false
          if let board = settings.board, !settings.restoreBoard {
            onboardingFixture = await OnboardingFixture.prepare(board, model: created)
            if !onboardingFixture { await BoardFixture.prepare(board, model: created) }
          }
          if settings.board == nil && settings.scenario == nil || onboardingFixture {
            introduction = try OnboardingLaunch.shouldPresent(model: created, deepLink: launchLink || launchDelegate.deepLink || settings.board == "onboarding-deep-link")
          }
          if workoutLink { created.openActivityWorkout() }
          model = created
        } catch { failure = "Couldn't open the journal on this phone. \(error.localizedDescription)" }
      }
    }
  }
}

// Scene changes may cancel launch gating, but must not interrupt account recovery.
struct AppStartup: ViewModifier {
  let model: AppModel?
  func body(content: Content) -> some View {
    content.task(id: model != nil) {
      guard let model else { return }
      await model.start()
      if model.runtime?.settings.scenario != nil { await AppScenario.run(model: model) }
    }
  }
}

struct RootScreen: View {
  @Bindable var model: AppModel
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    Group {
      if model.runtime?.settings.board == "01-launch" { Design.shell.ignoresSafeArea() }
      else if model.welcome { welcome.onAppear { model.screenViewed("welcome") } }
      else if model.selectedRoom == .journal { JournalScreen(model: model.journal, app: model) }
      else { GymRoom(gym: model.gym, app: model) }
    }
    .background {
      #if DEBUG && targetEnvironment(simulator)
      if model.runtime?.settings.scenario == "gym-e2e-conflict" {
        GymConflictFixtureStatus(model: model).frame(width: 1, height: 1).allowsHitTesting(false)
      }
      #endif
    }
    .sheet(isPresented: Binding(get: { model.sheet != nil }, set: { if !$0 && !model.editorReadOnly { model.sheet = nil } }), onDismiss: { model.dismissSheet() }) { AccountSheet(model: model) }
      .environment(\.dynamicTypeSize, model.runtime?.settings.board?.contains("AX3") == true ? .accessibility3 : typeSize)
  }

  var welcome: some View {
    GeometryReader { geo in
      ZStack {
        Design.shell.ignoresSafeArea()
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: max(40, geo.size.height * 0.18))
            Text("WINDMILL").font(Design.mono(9)).tracking(3).foregroundStyle(Design.dim).padding(.bottom, 8)
            Text("Where to start?").font(Design.title(34)).foregroundStyle(Design.ink).padding(.bottom, 8)
            Text("Your journal and training, no account needed.").font(Design.text()).foregroundStyle(Design.dim).padding(.bottom, 24)
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
            Button { model.openRoom(.gym) } label: {
              HStack {
                VStack(alignment: .leading, spacing: 6) {
                  Image(systemName: "dumbbell").foregroundStyle(Design.brand)
                  Text("Gym").font(Design.title())
                  Text("Log sets · see last time").font(Design.text(14)).foregroundStyle(Design.dim)
                }
                Spacer()
                Image(systemName: "arrow.right").foregroundStyle(Design.brand)
              }.foregroundStyle(Design.ink).padding(24).frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 140)
                .background(Design.card, in: RoundedRectangle(cornerRadius: 28))
                .overlay(RoundedRectangle(cornerRadius: 28).stroke(Design.line, lineWidth: 1))
            }.buttonStyle(.plain).accessibilityIdentifier("open-gym").padding(.horizontal, -8).padding(.top, 12)
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

struct RoomSeat: View {
  @Bindable var app: AppModel
  var body: some View {
    Menu {
      Picker("Room", selection: Binding(get: { app.selectedRoom }, set: { app.switchRoom($0) })) {
        ForEach(AppModel.Room.allCases, id: \.self) { room in
          Label(room.title, systemImage: room.symbol).tag(room).accessibilityIdentifier("room-" + room.rawValue)
        }
      }.pickerStyle(.inline)
    } label: {
      HStack(spacing: 8) {
        Text(app.selectedRoom.title).font(Design.strong(17))
        Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
      }.foregroundStyle(app.selectedRoom == .gym ? Color.primary : Design.ink).padding(.horizontal, 16).frame(height: 44).modifier(Glass())
    }.buttonStyle(.plain).accessibilityLabel(app.selectedRoom.title).accessibilityIdentifier("room-menu")
      .simultaneousGesture(LongPressGesture(minimumDuration: 0).onChanged { pressed in
        if pressed, app.selectedRoom == .journal { app.journal.liftInk() }
      })
      .dynamicTypeSize(...DynamicTypeSize.large).disabled(app.editorReadOnly)
  }
}

struct AccountButton: View {
  @Bindable var app: AppModel
  var body: some View {
    Button { app.journal.done(); app.sheet = .you } label: {
      YouGlyph().stroke(app.selectedRoom == .gym ? Color.primary : Design.ink, lineWidth: 1.5).frame(width: 18, height: 18)
        .frame(width: 44, height: 44).modifier(Glass(capsule: false))
    }.buttonStyle(.plain).accessibilityLabel("You and settings").accessibilityIdentifier("you")
      .dynamicTypeSize(...DynamicTypeSize.large).disabled(app.editorReadOnly)
  }
}
