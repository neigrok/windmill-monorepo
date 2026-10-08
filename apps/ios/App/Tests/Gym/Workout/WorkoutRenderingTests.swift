import XCTest
import SwiftUI
import DomainKit
import DomainKitTesting
import GymDomain
import SyncAPI
import SyncCore
import SyncModelServer
import SyncSchema
import SyncEngine
import SyncStore
import SyncTesting
@testable import Windmill

@MainActor final class WorkoutRenderingTests: XCTestCase {
  var models: [GymModel] = []
  override func tearDown() async throws {
    try await Task.sleep(for: .milliseconds(150))
    models = []
    try await super.tearDown()
  }
  func fixture(planned: Bool = true, count: Int = 3) throws -> (Harness, GymModel) {
    let at = Instant(ms: Int64(Date().timeIntervalSince1970 * 1_000) - 937_000)
    let harness = Harness(registry: SyncSchema.registry, start: at, account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let gym = GymModel(runner: harness.runner)
    models.append(gym)
    var routineId: ID<Routine>?
    if planned {
      var draft = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Lower A", entries: [
        RoutineEntry(exerciseId: ID("back-squat"), sets: Array(repeating: SetTarget(reps: 5, weightKg: 100), count: 4)),
        RoutineEntry(exerciseId: ID("romanian-deadlift"), sets: Array(repeating: SetTarget(reps: 6, weightKg: 82.5), count: 3)),
      ]))
      guard case .saved = gym.save(&draft) else { XCTFail("Fixture routine failed"); return (harness, gym) }
      routineId = draft.current.id
    }
    guard let id = gym.startWorkout(routineId: routineId) else { XCTFail("Fixture start failed"); return (harness, gym) }
    if !planned { gym.workout.add(ID("back-squat")) }
    for index in 0..<count {
      let set = TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: id, exerciseId: ID("back-squat"),
                            weightKg: index == 0 ? 80 : 100, reps: index == 0 ? 3 : 5,
                            kind: index == 0 ? "warmup" : "working", completedAt: Instant(ms: at.ms + Int64(index) * 60_000))
      XCTAssertNil(gym.run(AppendSet(set))?.refusal)
    }
    gym.workout.reconcile()
    return (harness, gym)
  }

  func host<V: View>(_ view: V, appearance: UIUserInterfaceStyle) throws -> UIWindow {
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = scene.screen.bounds
    window.overrideUserInterfaceStyle = appearance
    window.rootViewController = UIHostingController(rootView: view.environment(\.scenePhase, .active))
    window.makeKeyAndVisible()
    return window
  }

  func capture<V: View>(_ view: V, name: String, appearance: UIUserInterfaceStyle,
                        type: DynamicTypeSize = .large, bottom: Bool = false,
                        verify: () -> Void = {}) async throws {
    let window = try host(view.environment(\.dynamicTypeSize, type), appearance: appearance)
    defer { window.isHidden = true; window.rootViewController = nil }
    try await Task.sleep(for: .milliseconds(450))
    window.layoutIfNeeded()
    verify()
    if bottom {
      func scrolls(_ view: UIView) -> [UIScrollView] {
        (view as? UIScrollView).map { [$0] } ?? view.subviews.flatMap(scrolls)
      }
      if let scroll = scrolls(window).max(by: { $0.contentSize.height < $1.contentSize.height }) {
        scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)), animated: false)
        try await Task.sleep(for: .milliseconds(150))
      }
    }
    let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
    let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
    let attachment = XCTAttachment(image: image)
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    let directory = URL.documentsDirectory.appending(path: "WorkoutScreenshots")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try XCTUnwrap(image.pngData()).write(to: directory.appending(path: name + ".png"))
    XCTAssertEqual(image.size, window.bounds.size)
  }

  func testEveryWorkoutScreenInLightAndDark() async throws {
    for (name, appearance) in [("light", UIUserInterfaceStyle.light), ("dark", .dark)] {
      let (_, gym) = try fixture()
      try await capture(WorkoutScreen(gym: gym), name: "live-" + name, appearance: appearance)
      try await capture(WorkoutAssembly(workout: gym.workout, add: {}), name: "assembly-" + name, appearance: appearance)
      try await capture(WorkoutMovementPicker(gym: gym, workout: gym.workout), name: "movements-" + name, appearance: appearance)
      try await capture(NavigationStack { CreateMovementSheet(gym: gym, draft: .constant(MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: "New movement")), includesTargets: false, account: gym.account, anonymous: gym.isAnonymous, onCreated: { _ in }) }.modifier(GymPage()), name: "create-movement-" + name, appearance: appearance)
      try await capture(WorkoutKeypadSheet(field: .weight, value: 100, commit: { _ in }), name: "weight-keypad-" + name, appearance: appearance)
      try await capture(WorkoutKeypadSheet(field: .reps, value: 5, commit: { _ in }), name: "reps-keypad-" + name, appearance: appearance)
      try await capture(WorkoutKeypadSheet(field: .weight, value: 501, commit: { _ in }), name: "invalid-keypad-" + name, appearance: appearance)
      let set = try XCTUnwrap(gym.workout.sets.last)
      try await capture(WorkoutFixSheet(gym: gym, set: set, routine: "Lower A"), name: "fix-" + name, appearance: appearance)
      gym.workout.weightKg = 105; gym.workout.logSet(); gym.workout.select(ID("romanian-deadlift"))
      let offer = try XCTUnwrap(gym.workout.deviation)
      try await capture(WorkoutDeviationSheet(workout: gym.workout, offer: offer), name: "heavier-" + name, appearance: appearance)
      gym.workout.resolveDeviation(save: false)
      let (_, free) = try fixture(planned: false, count: 5)
      await free.workout.finish()
      let receipt = try XCTUnwrap(free.workout.receipt)
      receipt.reviewFailed = true
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "receipt-" + name, appearance: appearance)
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "receipt-routine-" + name, appearance: appearance, bottom: true)
      free.isAnonymous = false; free.workout.coachAvailable = true; receipt.reviewFailed = false
      receipt.review = try JSONDecoder().decode(WorkoutReview.self, from: Data(#"{"record":{"kind":"e1rm","exerciseId":"back-squat","value":116.7,"weightKg":100,"reps":5,"previous":110.8,"previousAt":1790000000000},"against":{"routine":"Lower A","movements":[{"exerciseId":"back-squat","now":{"sets":4,"reps":5,"weightKg":100},"before":{"sets":4,"reps":5,"weightKg":95}}]}}"#.utf8))
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "receipt-review-" + name, appearance: appearance)
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "receipt-coach-" + name, appearance: appearance, bottom: true)
      receipt.failure = "There is room for 10. Remove one before adding another."
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "routine-refused-" + name, appearance: appearance, bottom: true)
      receipt.failure = nil
      XCTAssertTrue(receipt.saveRoutine(free))
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "routine-kept-" + name, appearance: appearance, bottom: true)
      let (_, slight) = try fixture(planned: false, count: 1)
      await slight.workout.finish()
      try await capture(WorkoutReceipt(gym: slight, receipt: try XCTUnwrap(slight.workout.receipt)), name: "early-receipt-" + name, appearance: appearance)
      let (_, empty) = try fixture(planned: false, count: 0)
      empty.workout.remove(ID("back-squat"))
      try await capture(WorkoutScreen(gym: empty), name: "empty-" + name, appearance: appearance)
      gym.workout.select(ID("back-squat"))
      gym.isAnonymous = false; gym.authPaused = true
      try await capture(WorkoutScreen(gym: gym), name: "lapsed-" + name, appearance: appearance)
      gym.authPaused = false
      let readFault = GymStoreFault(), readRuntime = try GymModelTests().runtime(failing: readFault)
      let unreadable = GymModel(runner: readRuntime.runner, runtime: readRuntime); models.append(unreadable)
      let originalRoutine = try XCTUnwrap(gym.routines.first)
      var readRoutine = Draft(new: Routine(id: unreadable.runner.mint(Routine.self), name: originalRoutine.name, entries: originalRoutine.entries))
      guard case .saved = unreadable.save(&readRoutine) else { XCTFail("Read-failure fixture routine failed"); return }
      let readSession = unreadable.runner.mint(Session.self)
      let readStart = Instant(ms: try unreadable.runner.moment().now.ms - 937_000)
      XCTAssertNil(try XCTUnwrap(unreadable.run(StartSession(id: readSession, routineId: readRoutine.current.id, startedAt: readStart))).refusal)
      unreadable.workout.restore()
      for index in 0..<3 {
        let value = TrainingSet(id: unreadable.runner.mint(TrainingSet.self), sessionId: readSession, exerciseId: ID("back-squat"),
                                weightKg: index == 0 ? 80 : 100, reps: index == 0 ? 3 : 5,
                                kind: index == 0 ? "warmup" : "working", completedAt: Instant(ms: readStart.ms + Int64(index) * 60_000))
        XCTAssertNil(try XCTUnwrap(unreadable.run(AppendSet(value))).refusal)
      }
      unreadable.workout.reconcile()
      let retainedSets = unreadable.workout.sets, retainedWalk = unreadable.workout.walk
      XCTAssertTrue(unreadable.workout.canLog)
      readFault.point.withLock { $0 = .read }
      defer { readFault.point.withLock { $0 = nil } }
      unreadable.refresh()
      try await capture(WorkoutScreen(gym: unreadable), name: "read-failed-" + name, appearance: appearance) {
        XCTAssertTrue(unreadable.readFailed)
        XCTAssertEqual(unreadable.error, "Gym could not be read from this phone. Try again.")
        XCTAssertFalse(unreadable.workout.canLog)
        XCTAssertEqual(unreadable.workout.sets, retainedSets)
        XCTAssertEqual(unreadable.workout.walk, retainedWalk)
      }
      readFault.point.withLock { $0 = nil }
      unreadable.workout.retryRead()
      XCTAssertFalse(unreadable.readFailed)
      XCTAssertNil(unreadable.error)
      XCTAssertTrue(unreadable.workout.canLog)
      XCTAssertEqual(unreadable.workout.sets, retainedSets)
      XCTAssertEqual(unreadable.workout.walk, retainedWalk)
      XCTAssertNil(gym.run(DeleteSet(set.id))?.refusal)
      try await capture(WorkoutScreen(gym: gym), name: "delete-undo-" + name, appearance: appearance)
      let connectivity = SwitchedConnectivity(), transport = JournalModelTransport()
      let store = try Store.inMemory(registry: SyncSchema.registry), tokens = InMemoryTokenStore()
      let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: false), store: store,
                                  transport: transport, tokens: tokens, forkGuard: InMemoryForkGuardStore(),
                                  clock: .system, random: SeededRandomSource(seed: 24), connectivity: connectivity)
      let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0))
      let runtime = AppRuntime(settings: AppSettings(arguments: ["app", "-server", "https://gym.invalid"]), store: store, engine: engine,
                               auth: NativeAuth(baseURL: URL(string: "https://gym.invalid")), runner: runner,
                               tokens: tokens, revocations: InMemoryTokenStore(), telemetry: NoopTelemetry())
      let identity = transport.identity(email: "workout-capture@example.com")
      let admission = try await engine.signIn(account: identity.account, token: identity.token)
      XCTAssertTrue(admission.isComplete)
      connectivity.set(online: false)
      for _ in 0..<100 where engine.status.online { try await Task.sleep(for: .milliseconds(2)) }
      XCTAssertFalse(engine.status.online)
      let offline = GymModel(runner: runner, runtime: runtime); models.append(offline)
      XCTAssertNotNil(offline.startWorkout())
      offline.workout.add(ID("back-squat")); offline.workout.weightKg = 100; offline.workout.logSet()
      XCTAssertEqual(offline.workout.sets.count, 1)
      try await capture(WorkoutScreen(gym: offline), name: "offline-" + name, appearance: appearance)
      let fault = WorkoutFaultTransport(), failedRuntime = try WorkoutStateTests.faultRuntime(fault)
      let failedIdentity = fault.model.identity(email: "failed-push-capture@example.com")
      let failedAdmission = try await failedRuntime.engine.signIn(account: failedIdentity.account, token: failedIdentity.token)
      XCTAssertTrue(failedAdmission.isComplete)
      let failed = GymModel(runner: failedRuntime.runner, runtime: failedRuntime); models.append(failed)
      XCTAssertNotNil(failed.startWorkout())
      failed.workout.add(ID("back-squat")); failed.workout.logSet()
      fault.failure.withLock { $0 = 503 }
      await failedRuntime.engine.flushOnLeave()
      for _ in 0..<100 where !failed.workout.syncFailed { try await Task.sleep(for: .milliseconds(2)) }
      XCTAssertTrue(failed.workout.syncFailed)
      try await capture(WorkoutScreen(gym: failed), name: "server-behind-" + name, appearance: appearance)
    }
  }

  func testLargeNumeralsAtLargeAndLargestText() async throws {
    for (name, type) in [("large", DynamicTypeSize.xxxLarge), ("AX", .accessibility5)] {
      for (skin, appearance) in [("light", UIUserInterfaceStyle.light), ("dark", .dark)] {
        let (_, gym) = try fixture()
        gym.workout.weightKg = -500
        try await capture(WorkoutScreen(gym: gym), name: "live-\(name)-\(skin)", appearance: appearance, type: type)
        try await capture(WorkoutKeypadSheet(field: .weight, value: -500, commit: { _ in }), name: "keypad-\(name)-\(skin)", appearance: appearance, type: type)
        try await capture(WorkoutFixSheet(gym: gym, set: try XCTUnwrap(gym.sets.last), routine: "Lower A"), name: "fix-\(name)-\(skin)", appearance: appearance, type: type)
      }
    }
  }

  func testDynamicPaletteResolvesOffMainThreadInBothAppearances() async {
    let colours = [GymPalette.canvas, GymPalette.card, GymPalette.accent,
                   GymPalette.onAccent, GymPalette.done, GymPalette.record].map { UIColor($0) }
    let result = await Task.detached { @Sendable in
      let onMain = ({ @Sendable in Thread.isMainThread })()
      let values = [UIUserInterfaceStyle.dark, .light].map { appearance in
        let traits = UITraitCollection(userInterfaceStyle: appearance)
        return colours.map { colour -> UInt32? in
          var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
          guard colour.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha == 1 else { return nil }
          return UInt32((red * 255).rounded()) << 16 | UInt32((green * 255).rounded()) << 8 | UInt32((blue * 255).rounded())
        }
      }
      return (onMain, values)
    }.value
    XCTAssertFalse(result.0)
    XCTAssertEqual(result.1[0], [0x0b1111, 0x161c1d, 0x5fcdb4, 0x1b1408, 0x9aa859, 0xd9b04c])
    XCTAssertEqual(result.1[1], [0xebe7e3, 0xf8f6f4, 0x137a6c, 0xffffff, 0x7d8c43, 0x6e5217])
  }

  func testKeepAwakeStopsAtFinishAndRestoresPriorValue() async throws {
    let (_, gym) = try fixture()
    let prior = UIApplication.shared.isIdleTimerDisabled
    let window = try host(WorkoutScreen(gym: gym), appearance: .dark)
    defer { window.isHidden = true; window.rootViewController = nil; UIApplication.shared.isIdleTimerDisabled = prior }
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertTrue(UIApplication.shared.isIdleTimerDisabled)
    XCTAssertNil(gym.run(FinishSession(id: try XCTUnwrap(gym.openSession?.id)))?.refusal)
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(UIApplication.shared.isIdleTimerDisabled, prior)
  }
}
