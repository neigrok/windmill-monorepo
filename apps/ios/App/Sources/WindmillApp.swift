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
  let suite: String?
  let preferences: UserDefaults
  init() {
    OfflineFixture.install()
    let settings = AppSettings()
    self.settings = settings
    suite = settings.board.map { "board-\($0)" } ?? settings.scenario.map { "scenario-\($0)" }
    preferences = suite.map { UserDefaults(suiteName: $0)! } ?? .standard
    #if DEBUG
    let debug = true
    #else
    let debug = false
    #endif
    telemetry = WorkoutActivityIntentHandler.telemetry ?? AppTelemetry(info: settings.telemetryInfo, baseURL: settings.baseURL,
                             directory: URL.applicationSupportDirectory.appending(path: "WindmillTelemetry"), debug: debug)
    WorkoutActivityIntentHandler.telemetry = telemetry
    telemetry.event("app_started")
    // An open iOS 26 menu never lets UIKit animations settle, so XCTest would stall after every menu tap.
    if settings.automated { UIView.setAnimationsEnabled(false) }
  }
  var body: some Scene {
    WindowGroup {
      Group {
        if let model {
          if introduction {
            OnboardingScreen(replay: false, telemetry: telemetry) { introduction = false }
          } else { RootScreen(model: model) }
        } else if let failure {
          ZStack { ShellPalette.canvas.ignoresSafeArea(); Text(failure).foregroundStyle(ShellPalette.ink).padding(24) }
        } else { ShellPalette.canvas.ignoresSafeArea() }
      }.background {
        WindowChrome(tint: windowTint, style: OnboardingFixture.appearance.map(UIUserInterfaceStyle.init)
          ?? (model?.appearance ?? AppModel.Appearance(preferences: preferences)).style)
      }
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
          let runtime = try WorkoutActivityIntentHandler.model?.runtime ?? OfflineFixture.runtime(settings: settings, telemetry: telemetry) ?? AppRuntime(settings: settings, telemetry: telemetry)
          if !settings.restoreBoard, let suite { preferences.removePersistentDomain(forName: suite) }
          let authenticationTime = settings.appleFixture == "hello-failure" ? Date() : nil
          let created = try WorkoutActivityIntentHandler.model ?? AppModel(runner: runtime.runner, preferences: preferences, runtime: runtime, telemetry: telemetry,
            authRetryNow: { authenticationTime ?? Date() })
          WorkoutActivityIntentHandler.model = created
          created.gym.startWorkoutActivity()
          var onboardingFixture = false
          if let board = settings.board, !settings.restoreBoard {
            onboardingFixture = await OnboardingFixture.prepare(board, model: created)
            if !onboardingFixture, await !ShellFixture.prepare(board, model: created) { await BoardFixture.prepare(board, model: created) }
          }
          try await OfflineFixture.prepare(created)
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

extension WindmillApp {
  // The front room's accent: the shell's brand while You, Keep or Where to start? is in front.
  var windowTint: UIColor {
    guard let model, !introduction, !model.welcome, model.sheet == nil else { return ShellPalette.uiBrand }
    return model.selectedRoom == .journal ? JournalPalette.uiLamp : GymPalette.uiAccent
  }
}

extension AppModel.Appearance {
  var style: UIUserInterfaceStyle {
    switch self {
    case .light: .light
    case .dark: .dark
    case .system: .unspecified
    }
  }
}

// The keyboard, selection, share sheet and status bar take the window's tint and appearance, outside the SwiftUI tree.
struct WindowChrome: UIViewRepresentable {
  let tint: UIColor
  let style: UIUserInterfaceStyle
  func makeUIView(context: Context) -> ChromeView { ChromeView() }
  func updateUIView(_ view: ChromeView, context: Context) {
    view.tint = tint; view.style = style
    view.apply()
  }
  final class ChromeView: UIView {
    var tint: UIColor?
    var style = UIUserInterfaceStyle.unspecified
    override func didMoveToWindow() { super.didMoveToWindow(); apply() }
    func apply() {
      guard let window else { return }
      if window.tintColor != tint { window.tintColor = tint }
      if window.overrideUserInterfaceStyle != style { window.overrideUserInterfaceStyle = style }
    }
  }
}

// Plain UIKit over whatever is in front: a view controller in the tree joins SwiftUI's focus graph and cycles on focus.
enum UpdateRequiredAlert {
  static func present(for model: AppModel) {
    guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows)
            .first(where: \.isKeyWindow), var front = window.rootViewController else { return }
    while let next = front.presentedViewController, !next.isBeingDismissed { front = next }
    guard !(front is UIAlertController) else { return }
    if let transition = front.transitionCoordinator {
      transition.animate(alongsideTransition: nil) { _ in if model.updateAlert { present(for: model) } }
      return
    }
    let alert = UIAlertController(title: "Update required", message: "Update Windmill to keep syncing. Your work is saved on this phone.",
                                  preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Keep working on this phone", style: .cancel) { _ in model.keepWorkingWithoutUpdate() })
    let update = UIAlertAction(title: "Get the update", style: .default) { _ in
      UIApplication.shared.open(AppSettings.updateDestination) { model.updateOpened($0) }
    }
    alert.addAction(update); alert.preferredAction = update
    front.present(alert, animated: true)
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
      if model.runtime?.settings.board == "01-launch" { ShellPalette.canvas.ignoresSafeArea() }
      else if model.welcome { welcome.onAppear { model.screenViewed("welcome") } }
      else if model.selectedRoom == .journal { JournalScreen(model: model.journal, app: model) }
      else { GymRoom(gym: model.gym, app: model) }
    }
    .onChange(of: model.updateAlert, initial: true) { _, show in if show { UpdateRequiredAlert.present(for: model) } }
    .overlay(alignment: .bottom) {
      if model.updateOpenFailed && model.sheet == nil {
        UpdateFailure(model: model).padding(.bottom, RoomSpace.minimumTarget + 2 * RoomSpace.inset)
      }
    }
    .background {
      #if DEBUG && targetEnvironment(simulator)
      if model.runtime?.settings.scenario == "gym-e2e-conflict" {
        GymConflictFixtureStatus(model: model).frame(width: 1, height: 1).allowsHitTesting(false)
      }
      #endif
    }
    .sheet(isPresented: Binding(get: { model.sheet != nil }, set: { if !$0 { model.cancelAuthentication(); model.sheet = nil } }), onDismiss: { model.dismissSheet() }) { AccountSheet(model: model) }
      .environment(\.dynamicTypeSize, model.runtime?.settings.board?.contains("AX3") == true ? .accessibility3 : typeSize)
  }

  var welcome: some View {
    GeometryReader { geo in
      ZStack {
        ShellPalette.canvas.ignoresSafeArea()
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: max(40, geo.size.height * 0.18))
            Text("WINDMILL").font(ShellType.caption).foregroundStyle(ShellPalette.inkDim).padding(.bottom, 8)
            Text("Where to start?").font(ShellType.display).foregroundStyle(ShellPalette.ink).padding(.bottom, 8)
            Text("Your journal and training, no account needed.").font(ShellType.body).foregroundStyle(ShellPalette.inkDim).padding(.bottom, 24)
            VStack(spacing: 12) {
              RoomDoor(room: .journal, line: "Write tonight’s page") { model.openJournal() }
              RoomDoor(room: .gym, line: "Log sets · see last time") { model.openRoom(.gym) }
            }.padding(.horizontal, -8)
            if model.canSignIn { Button("Sign in") { model.choose("keep", screen: "welcome"); model.sheet = .keep }.font(ShellType.action).foregroundStyle(ShellPalette.inkDim).frame(maxWidth: .infinity, minHeight: 52).padding(.top, 10) }
            if model.keptWork {
              Text("Changes you kept will return when you sign in to the same account.").font(ShellType.meta).foregroundStyle(ShellPalette.inkDim).padding(.top, 8)
            }
          }.padding(.horizontal, 24).padding(.bottom, 30).frame(minHeight: geo.size.height, alignment: .top)
        }
      }
    }
  }
}

struct RoomDoor: View {
  let room: AppModel.Room
  let line: String
  let open: () -> Void
  var body: some View {
    let journal = room == .journal
    let accent = journal ? JournalPalette.lamp : GymPalette.accent
    let glow = journal ? JournalPalette.lampSoft : GymPalette.accentSoft
    Button(action: open) {
      HStack {
        VStack(alignment: .leading, spacing: 6) {
          Image(systemName: room.symbol).foregroundStyle(accent).accessibilityHidden(true)
          Text(room.title).font(ShellType.title).foregroundStyle(journal ? JournalPalette.ink : GymPalette.ink)
          Text(line).font(ShellType.subheadline).foregroundStyle(journal ? JournalPalette.inkDim : GymPalette.inkDim)
        }
        Spacer()
        Image(systemName: "arrow.right").foregroundStyle(accent).frame(width: 40, height: 40).background(glow, in: Circle())
      }.padding(24).frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 140)
        .background {
          ZStack { journal ? JournalPalette.canvas : GymPalette.card; LinearGradient(colors: [.clear, glow], startPoint: .topLeading, endPoint: .bottomTrailing) }
            .clipShape(RoundedRectangle(cornerRadius: 28))
        }
        .overlay(RoundedRectangle(cornerRadius: 28).stroke(journal ? JournalPalette.line : GymPalette.line, lineWidth: 1))
    }.buttonStyle(.plain).accessibilityIdentifier("open-" + room.rawValue)
  }
}

struct UpdateFailure: View {
  let model: AppModel
  var body: some View {
    RoomTransient(message: "Couldn't open the update. Try again.", room: .shell, actionTitle: "Dismiss", actionSymbol: "xmark",
                  actionIdentifier: "update-failure-dismiss", action: model.dismissUpdateFailure)
      .padding(.horizontal, RoomSpace.inset)
  }
}

struct RoomMenu: View {
  @Bindable var app: AppModel
  var inkEnabled = false
  var inkFrames: Binding<[String: CGRect]> = .constant([:])
  var body: some View {
    Menu {
      Picker("Room", selection: Binding(get: { app.selectedRoom }, set: { app.switchRoom($0) })) {
        ForEach(AppModel.Room.allCases, id: \.self) { room in
          Label(room.title, systemImage: room.symbol).tag(room).accessibilityIdentifier("room-" + room.rawValue)
        }
      }.pickerStyle(.inline)
      Divider()
      Button("You", systemImage: "person.crop.circle") { app.openYou() }
      if app.selectedRoom == .journal {
        Button("Show ink notes") {
          app.journal.done()
          app.journal.inkVisible = true
          app.journal.screenViewed("ink_notes")
        }
      }
    } label: {
      HStack(spacing: 6) {
        Text(app.selectedRoom.title).font(.body.weight(.semibold))
        Image(systemName: "chevron.down").font(.caption.weight(.semibold))
      }.inkAnchor("title", enabled: inkEnabled, frames: inkFrames)
    }.accessibilityLabel(app.selectedRoom.title).accessibilityIdentifier("room-menu")
      .disabled(app.editorReadOnly)
  }
}

struct RoomAccountButton: View {
  let action: () -> Void
  var inkEnabled = false
  var inkFrames: Binding<[String: CGRect]> = .constant([:])
  var body: some View {
    Button(action: action) {
      Image(systemName: "person.crop.circle")
        .inkAnchor("you", enabled: inkEnabled, frames: inkFrames)
    }.accessibilityLabel("You and settings").accessibilityIdentifier("you")
  }
}
