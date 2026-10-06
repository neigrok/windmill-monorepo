import SwiftUI
import UIKit
import SyncEngine

nonisolated enum OnboardingPage: Int, CaseIterable {
  case windmill, roadmap, journal, gym
  var name: String { ["windmill", "roadmap", "journal", "gym"][rawValue] }
  var title: String { ["Three ways to grow.", "Map what you're learning.", "A page a night.", "Log the set."][rawValue] }
  var message: String {
    ["One account keeps them together. You can start without one.",
     "Your goal as a skill tree. Each step opens the next, and you watch it grow.",
     "Write a line or a page, in your own words. Nothing is graded or shared.",
     "Two taps a set, and next time your numbers are already there."][rawValue]
  }
  var location: String? { [nil, "On the web", "In this app", "In this app"][rawValue] }
  var example: String {
    ["Example of three rooms: Roadmap, Journal, Gym",
     "Example of a skill tree: Learn to sail, three steps open, three locked",
     "Example of a journal page: yesterday above, tonight below, mood and energy unasked",
     "Example of a set being logged: squat, 100 kilograms for 5"][rawValue]
  }
}

struct OnboardingPalette {
  let dark: Bool
  func color(_ night: UInt32, _ day: UInt32) -> Color { Color(hex: dark ? night : day) }
  var ground: Color { color(0x0b0b0c, 0xf9f5eb) }
  var ink: Color { color(0xf2f0eb, 0x211b13) }
  var dim: Color { color(0xb4b2ac, 0x6f5f45) }
  var brand: Color { color(0xd08a5e, 0xbc6c42) }
  var raised: Color { color(0x222224, 0xfdfbf6) }
  var line: Color { color(0x2e2e32, 0xd3c2a0) }
  var onBrand: Color { dark ? Color(hex: 0x1b1408) : .white }
  var lamp: Color { color(0xe0b972, 0x986b1e) }
  var gym: Color { color(0x5fcdb4, 0x137a6c) }
}

// Device history is checked before the model enters the view tree.
enum OnboardingLaunch {
  static let shownKey = "windmillIntroductionShown"
  static func shouldPresent(model: AppModel, deepLink: Bool) throws -> Bool {
    guard !model.preferences.bool(forKey: shownKey) else { return false }
    defer { model.preferences.set(true, forKey: shownKey) }
    guard !deepLink, model.account == nil, !model.journal.readFailed, model.welcome,
          !model.journal.dirty, model.journal.room?.stance == .empty, model.journal.room?.days.isEmpty == true,
          !model.preferences.bool(forKey: "journalOpened"),
          model.preferences.string(forKey: "lastRoom") == nil, !model.gym.hasData, !model.gym.readFailed,
          !model.preferences.bool(forKey: "keepDismissed") else { return false }
    if let runtime = model.runtime {
      guard !runtime.hadInstallHistory, runtime.tokens.accounts().isEmpty, runtime.revocations.accounts().isEmpty else { return false }
      return try runtime.storageRead { tx in
        let device = try tx.device(rows: true)
        return device.meta.pendingSignIn == nil && device.replicas.count == 1 && device.replicas.allSatisfy {
          $0.meta.state == .anon && $0.outbox.isEmpty && $0.confirmed.values.allSatisfy { $0.all.isEmpty } &&
          $0.staging.values.allSatisfy { $0.rows.all.isEmpty } && $0.deviceRows.values.allSatisfy { $0.isEmpty }
        }
      }
    }
    return true
  }
}

final class OnboardingLaunchDelegate: NSObject, UIApplicationDelegate {
  var deepLink = false
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    deepLink = options?[.url] != nil || options?[.userActivityDictionary] != nil
    return true
  }
}

struct OnboardingScreen: View {
  let replay: Bool
  let telemetry: any Telemetry
  let finish: () -> Void
  @State var page = OnboardingPage.windmill
  @State var settled: OnboardingPage?
  @State var visit = UUID()
  @State var exited = false
  @State var overflowingPages: Set<OnboardingPage> = []
  @Environment(\.colorScheme) var scheme
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  var palette: OnboardingPalette { OnboardingPalette(dark: scheme == .dark) }
  var properties: [String: String] { ["page": page.name, "presentation": replay ? "replay" : "first_launch"] }

  var body: some View {
    GeometryReader { geometry in
      VStack(spacing: 0) {
        HStack {
          if page == .windmill {
            HStack(spacing: 10) {
              Image("OnboardingBrandMark").resizable().frame(width: 42.45, height: 44).accessibilityHidden(true)
              Text("Windmill").font(.custom("Baloo2-Bold", fixedSize: 30)).foregroundStyle(Design.brand).accessibilityHidden(true)
            }.accessibilityElement(children: .ignore).accessibilityLabel("Windmill").accessibilityIdentifier("onboarding-identity").accessibilitySortPriority(90)
          }
          Spacer(minLength: 4)
          if replay || page != .gym {
            Button(replay ? "Done" : "Skip") {
              exit(skipped: !replay)
            }.font(Design.strong(17)).foregroundStyle(palette.ink).buttonStyle(.plain)
              .padding(.horizontal, 16).frame(minHeight: 52)
              .accessibilityIdentifier("onboarding-exit").accessibilitySortPriority(80)
          }
        }.frame(minHeight: 52).padding(.horizontal, 24).padding(.top, 4)
        VStack(spacing: 0) {
          TabView(selection: $page) {
            ForEach(OnboardingPage.allCases, id: \.self) { item in
              ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                  OnboardingGlimpse(page: item, active: settled == item, visit: visit, palette: palette)
                    .frame(height: typeSize.isAccessibilitySize ? 260 : item == .windmill ? 320 : 340)
                    .accessibilityRepresentation {
                      Text(item.example).accessibilityIdentifier("onboarding-glimpse").accessibilitySortPriority(30)
                    }.accessibilitySortPriority(30)
                  VStack(alignment: .leading, spacing: 10) {
                    if item != .windmill {
                      HStack(spacing: 8) {
                        Circle().fill(item == .roadmap ? palette.brand : item == .journal ? palette.lamp : palette.gym).frame(width: 7, height: 7).accessibilityHidden(true)
                        Text(item.name.uppercased()).font(Design.mono(10)).tracking(2.4).foregroundStyle(palette.dim)
                          .accessibilityIdentifier("onboarding-eyebrow").accessibilitySortPriority(70)
                      }
                    }
                    Text(item.title).font(Design.title(34)).tracking(0.2).foregroundStyle(palette.ink)
                      .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("onboarding-title").accessibilityAddTraits(.isHeader).accessibilitySortPriority(60)
                    Text(item.message).font(Design.text(17)).tracking(-0.3).foregroundStyle(palette.dim)
                      .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("onboarding-body").accessibilitySortPriority(50)
                    if let location = item.location {
                      Text(location).font(Design.strong(12)).foregroundStyle(item == .journal ? palette.brand : palette.dim)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(item == .journal ? palette.brand.opacity(0.16) : palette.raised, in: Capsule())
                        .overlay(Capsule().stroke(item == .journal ? palette.brand : palette.line, lineWidth: 1))
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("onboarding-tag").accessibilitySortPriority(40)
                    }
                  }
                }.padding(.horizontal, 24).padding(.top, item == .windmill ? 16 : 6).padding(.bottom, 16)
              }.scrollDisabled(!overflowingPages.contains(item)).scrollBounceBehavior(.basedOnSize)
                .onScrollGeometryChange(for: Bool.self) { geometry in
                  geometry.contentSize.height > geometry.containerSize.height
                } action: { _, overflows in
                  if overflows { overflowingPages.insert(item) }
                  else { overflowingPages.remove(item) }
                }
                .tag(item).accessibilityElement(children: .contain).accessibilitySortPriority(60)
            }
          }.tabViewStyle(.page(indexDisplayMode: .never))
            .indexViewStyle(.page(backgroundDisplayMode: .never))
            .accessibilityElement(children: .contain).accessibilitySortPriority(70)
          OnboardingPageControl(page: $page, palette: palette, change: changePage)
            .frame(width: 100, height: 36).accessibilitySortPriority(20)
        }.accessibilityElement(children: .contain).accessibilitySortPriority(70)
        Button {
          if page == .gym { exit(skipped: false) }
          else { changePage(OnboardingPage(rawValue: page.rawValue + 1)!) }
        } label: {
          Text(page == .gym ? replay ? "Done" : "Get started" : "Next")
            .font(Design.strong(17)).foregroundStyle(palette.onBrand)
            .frame(maxWidth: .infinity, minHeight: 38)
        }.buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
          .tint(palette.brand).padding(.horizontal, 24).padding(.top, 14).padding(.bottom, 16)
          .accessibilityIdentifier("onboarding-next").accessibilitySortPriority(10)
      }.frame(width: geometry.size.width, height: geometry.size.height).accessibilityElement(children: .contain)
    }.background(palette.ground.ignoresSafeArea())
      .onChange(of: page, initial: true) { _, value in
        settled = nil
        telemetry.event("onboarding_screen_viewed", properties: properties)
      }
      .task(id: page) {
        do { try await Task.sleep(for: .milliseconds(320)) } catch { return }
        settled = page; visit = UUID()
      }
      .sensoryFeedback(.selection, trigger: visit)
      .onDisappear { if replay && !exited { telemetry.event("onboarding_finished", properties: properties) } }
  }

  func exit(skipped: Bool) {
    guard !exited else { return }
    exited = true
    telemetry.event(skipped ? "onboarding_skipped" : "onboarding_finished", properties: properties)
    finish()
  }

  func changePage(_ next: OnboardingPage) {
    if reduceMotion { page = next }
    else { withAnimation { page = next } }
  }
}

// The native control also supplies an adjustable VoiceOver element after the glimpse.
struct OnboardingPageControl: UIViewRepresentable {
  @Binding var page: OnboardingPage
  let palette: OnboardingPalette
  let change: (OnboardingPage) -> Void
  func makeUIView(context: Context) -> UIPageControl {
    let control = UIPageControl()
    control.numberOfPages = 4
    control.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
    control.accessibilityIdentifier = "onboarding-page-control"
    return control
  }
  func updateUIView(_ control: UIPageControl, context: Context) {
    control.currentPage = page.rawValue
    control.currentPageIndicatorTintColor = UIColor(palette.ink)
    control.pageIndicatorTintColor = UIColor(palette.ink.opacity(0.28))
    control.accessibilityLabel = "Page \(page.rawValue + 1) of 4"
    context.coordinator.change = change
  }
  func makeCoordinator() -> Coordinator { Coordinator(change: change) }
  final class Coordinator: NSObject {
    var change: (OnboardingPage) -> Void
    init(change: @escaping (OnboardingPage) -> Void) { self.change = change }
    @objc func changed(_ sender: UIPageControl) { if let page = OnboardingPage(rawValue: sender.currentPage) { change(page) } }
  }
}
