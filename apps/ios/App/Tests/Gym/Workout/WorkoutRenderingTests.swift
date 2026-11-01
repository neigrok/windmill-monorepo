import XCTest
import SwiftUI
import Vision
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
  struct SetFieldsProbe: View {
    @State var load: Double
    @State var reps: Int
    let changed: (Double, Int) -> Void
    @FocusState var focused: Bool
    var body: some View {
      Form { SetFields(weightKg: $load, reps: $reps, basis: MovementEquipment("other"), focus: $focused, identifier: "probe") }
        .onChange(of: load) { _, value in changed(value, reps) }
        .onChange(of: reps) { _, value in changed(load, value) }
    }
  }
  var models: [GymModel] = []
  override func tearDown() async throws {
    try await Task.sleep(for: .milliseconds(150))
    models = []
    try await super.tearDown()
  }
  func fixture(planned: Bool = true, count: Int = 3) throws -> (Harness, GymModel) {
    let at = Instant(ms: Int64(Date().timeIntervalSince1970 * 1_000) - 937_000)
    let harness = Harness(holdRemovals: false, registry: SyncSchema.registry, start: at, account: nil,
                          rules: ComposedServerRules.windmill(registry: SyncSchema.registry))
    let gym = GymModel(runner: harness.runner)
    models.append(gym)
    let started: ID<Session>?
    if planned {
      var draft = Draft(new: Routine(id: gym.runner.mint(Routine.self), name: "Lower A", entries: [
        RoutineEntry(exerciseId: ID("back-squat"), sets: Array(repeating: SetTarget(reps: 5, weightKg: 100), count: 4)),
        RoutineEntry(exerciseId: ID("romanian-deadlift"), sets: Array(repeating: SetTarget(reps: 6, weightKg: 82.5), count: 3)),
      ]))
      guard case .saved = gym.save(&draft) else { XCTFail("Fixture routine failed"); return (harness, gym) }
      started = gym.startWorkout(routineId: draft.current.id)
    } else { started = gym.startWorkout(following: ID("back-squat")) }
    guard let id = started else { XCTFail("Fixture start failed"); return (harness, gym) }
    for index in 0..<count {
      let set = TrainingSet(id: gym.runner.mint(TrainingSet.self), sessionId: id, exerciseId: ID("back-squat"),
                            weightKg: index == 0 ? 80 : 100, reps: index == 0 ? 3 : 5,
                            completedAt: Instant(ms: at.ms + Int64(index) * 60_000))
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

  // The two screenshot walks below draw every workout screen for design review and assert only that each drew; like the
  // design capture suite they run when the runner sees WM_DESIGN_CAPTURE=1.
  func skipUnlessCapturing() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["WM_DESIGN_CAPTURE"] == "1", "Set WM_DESIGN_CAPTURE=1 to draw the workout screens")
  }

  func testEveryWorkoutScreenInLightAndDark() async throws {
    try skipUnlessCapturing()
    for (name, appearance) in [("light", UIUserInterfaceStyle.light), ("dark", .dark)] {
      let (_, gym) = try fixture()
      try await capture(WorkoutScreen(gym: gym), name: "live-" + name, appearance: appearance)
      try await capture(WorkoutAssembly(workout: gym.workout, add: {}), name: "assembly-" + name, appearance: appearance)
      try await capture(WorkoutMovementPicker(gym: gym, workout: gym.workout), name: "movements-" + name, appearance: appearance)
      try await capture(NavigationStack { CreateMovementSheet(gym: gym, draft: .constant(MovementCreationDraft(id: gym.runner.mint(Exercise.self), name: "New movement")), purpose: .workout, account: gym.account, anonymous: gym.isAnonymous, onCreated: { _ in }) }.modifier(GymPage()), name: "create-movement-" + name, appearance: appearance)
      try await capture(RepsWheelSheet(title: "Set 4", movement: "Back squat", reps: 5, commit: { _ in }), name: "wheel-" + name, appearance: appearance)
      let set = try XCTUnwrap(gym.workout.sets.last)
      try await capture(SetEditor(gym: gym, set: set, identifier: "workout-fix"), name: "fix-" + name, appearance: appearance)
      let (_, free) = try fixture(planned: false, count: 5)
      await free.workout.finish()
      let receipt = try XCTUnwrap(free.workout.receipt)
      receipt.reviewFailed = true
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "receipt-" + name, appearance: appearance)
      free.isAnonymous = false; free.workout.coachAvailable = true; receipt.reviewFailed = false
      receipt.review = try JSONDecoder().decode(WorkoutReview.self, from: Data(#"{"record":{"kind":"e1rm","exerciseId":"back-squat","value":116.7,"weightKg":100,"reps":5,"previous":110.8,"previousAt":1790000000000},"against":{"routine":"Lower A","movements":[{"exerciseId":"back-squat","now":{"sets":4,"reps":5,"weightKg":100},"before":{"sets":4,"reps":5,"weightKg":95}}]}}"#.utf8))
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "receipt-review-" + name, appearance: appearance)
      try await capture(WorkoutReceipt(gym: free, receipt: receipt), name: "receipt-coach-" + name, appearance: appearance, bottom: true)
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
                                completedAt: Instant(ms: readStart.ms + Int64(index) * 60_000))
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
      try await capture(WorkoutScreen(gym: gym), name: "delete-" + name, appearance: appearance)
      let connectivity = SwitchedConnectivity(), transport = JournalModelTransport()
      let store = try Store.inMemory(registry: SyncSchema.registry), tokens = InMemoryTokenStore()
      let engine = try SyncEngine(config: EngineConfig(appVersion: "test", surface: .ios, drivesLoops: false), store: store,
                                  transport: transport, tokens: tokens, forkGuard: InMemoryForkGuardStore(),
                                  clock: .system, random: SeededRandomSource(seed: 24), connectivity: connectivity)
      let runner = ActionRunner(replica: engine, registry: SyncSchema.registry, zone: FixedZone(offsetSeconds: 0), holdRemovals: false)
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
      XCTAssertNotNil(offline.startWorkout(following: ID("back-squat")))
      offline.workout.weightKg = 100; offline.workout.logSet()
      XCTAssertEqual(offline.workout.sets.count, 1)
      try await capture(WorkoutScreen(gym: offline), name: "offline-" + name, appearance: appearance)
      let fault = WorkoutFaultTransport(), failedRuntime = try WorkoutStateTests.faultRuntime(fault)
      let failedIdentity = fault.model.identity(email: "failed-push-capture@example.com")
      let failedAdmission = try await failedRuntime.engine.signIn(account: failedIdentity.account, token: failedIdentity.token)
      XCTAssertTrue(failedAdmission.isComplete)
      let failed = GymModel(runner: failedRuntime.runner, runtime: failedRuntime); models.append(failed)
      XCTAssertNotNil(failed.startWorkout(following: ID("back-squat")))
      failed.workout.logSet()
      fault.failure.withLock { $0 = 503 }
      await failedRuntime.engine.flushOnLeave()
      for _ in 0..<100 where !failed.workout.syncFailed { try await Task.sleep(for: .milliseconds(2)) }
      XCTAssertTrue(failed.workout.syncFailed)
      try await capture(WorkoutScreen(gym: failed), name: "server-behind-" + name, appearance: appearance)
    }
  }

  // VoiceOver hears each ledger row's place and its numbers in words: a logged set as it was lifted, the current and
  // planned rows as the load the rack will offer by the plan's reps, and an open target past the plan.
  func testLedgerRowsSpeakTheirPlaceAndNumbersInWords() {
    let set = { (id: String, kg: Double, reps: Int) in
      TrainingSet(id: ID(RecordID(id)), sessionId: ID("session"), exerciseId: ID("back-squat"), weightKg: kg, reps: reps, completedAt: Instant(ms: 0))
    }
    let ledger = MovementLedger(sets: [set("first", 100, 1)],
                                plan: RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(reps: 1, weightKg: 100), SetTarget(reps: 5, weightKg: 102.5), SetTarget(reps: 5), SetTarget()]),
                                lastTime: LastTime(exerciseId: ID("back-squat")))
    XCTAssertEqual(ledger.rows.map { WorkoutLedgerRow(row: $0, unsent: $0.set?.id == ID("first")).spoken }, [
      "Set 1, logged, 100 kilograms, 1 rep, on this phone",
      "Set 2, current, 102.5 kilograms, 5 reps", "Set 3, planned, 102.5 kilograms, 5 reps", "Set 4, planned, 102.5 kilograms, max reps",
    ])
    let unread = MovementLedger(sets: [], plan: RoutineEntry(exerciseId: ID("back-squat"), sets: [SetTarget(), SetTarget()]),
                                lastTime: LastTime(exerciseId: ID("back-squat"), isComplete: false))
    XCTAssertEqual(unread.rows.map { WorkoutLedgerRow(row: $0, unsent: false).spoken },
                   ["Set 1, current, no load yet, max reps", "Set 2, planned, no load yet, max reps"])
    let open = MovementLedger(sets: [], plan: nil, lastTime: LastTime(exerciseId: ID("back-squat")))
    XCTAssertEqual(open.rows.map { WorkoutLedgerRow(row: $0, unsent: false).spoken }, ["Set 1, current, open target"])
  }

  // A row still to lift reads the load its rack will offer, a dash while there is none, and never the word last.
  func testRowsStillToLiftReadTheOfferedLoad() {
    let bench = ID<Exercise>("bench-press"), plan = RoutineEntry(exerciseId: bench, sets: Array(repeating: SetTarget(), count: 3))
    let first = TrainingSet(id: ID(RecordID("first")), sessionId: ID("session"), exerciseId: bench, weightKg: 22.5, reps: 5, completedAt: Instant(ms: 0))
    let afterOne = MovementLedger(sets: [first], plan: plan, lastTime: LastTime(exerciseId: bench))
    XCTAssertEqual(afterOne.rows.map(\.reading), ["22.5 × 5", "22.5 × max", "22.5 × max"])
    let firstTime = MovementLedger(sets: [], plan: plan, lastTime: LastTime(exerciseId: bench))
    XCTAssertEqual(firstTime.rows.map(\.reading), ["20 × max", "20 × max", "20 × max"])
    let unread = MovementLedger(sets: [], plan: plan, lastTime: LastTime(exerciseId: bench, isComplete: false))
    XCTAssertEqual(unread.rows.map(\.reading), ["— × max", "— × max", "— × max"])
    XCTAssertEqual([afterOne, firstTime, unread].flatMap(\.rows).filter { $0.reading.contains("last") }, [])
  }

  // The rack speaks its numeral in the movement's load basis and Log set with the whole set it logs.
  func testTheRackSpeaksItsLoadInItsBasis() {
    XCTAssertEqual([MovementEquipment("barbell"), MovementEquipment("dumbbell"), MovementEquipment("dumbbell", loadCount: 1), MovementEquipment("bodyweight")]
      .map { WorkoutRack.spokenWeight(100, basis: $0) }, ["Weight, 100 kg total", "Weight, 100 kg each", "Weight, 100 kg", "Weight, 100 kg added"])
    XCTAssertEqual([WorkoutRack.spokenLog(100, reps: 5), WorkoutRack.spokenLog(67.5, reps: 1)],
                   ["Log set, 100 kilograms, 5 reps", "Log set, 67.5 kilograms, 1 rep"])
  }

  // Fix set's numbers are one decimal-pad field and one native wheel: the field opens on the load, a typed load in either
  // separator lands, and an empty one gives way to the load before it; the wheel holds the reps alone.
  func testSetFieldsTypeTheLoadAndTurnOneRepsWheel() async throws {
    func views<V: UIView>(_ view: UIView, _ type: V.Type) -> [V] {
      if let match = view as? V { return [match] }
      return view.subviews.flatMap { views($0, type) }
    }
    var seen = (load: -5.0, reps: 8)
    let window = try host(SetFieldsProbe(load: -5, reps: 8, changed: { seen = ($0, $1) }), appearance: .light)
    defer { window.isHidden = true; window.rootViewController = nil }
    try await Task.sleep(for: .milliseconds(300))
    window.layoutIfNeeded()
    let pickers = views(window, UIPickerView.self)
    XCTAssertEqual(pickers.count, 1)
    let picker = try XCTUnwrap(pickers.first)
    XCTAssertEqual(picker.numberOfComponents, 1)
    XCTAssertEqual(picker.numberOfRows(inComponent: 0), 99)
    XCTAssertEqual(picker.selectedRow(inComponent: 0), 7)
    let field = try XCTUnwrap(views(window, UITextField.self).first)
    XCTAssertEqual(field.keyboardType, .decimalPad)
    XCTAssertEqual(field.text, "−5")
    for (typed, expected) in [("12,5", 12.5), ("", 12.5), ("abc", 12.5), ("-7.25", -7.25)] {
      XCTAssertTrue(field.becomeFirstResponder())
      try await Task.sleep(for: .milliseconds(150))
      field.selectAll(nil)
      if typed.isEmpty { field.deleteBackward() } else { field.insertText(typed) }
      try await Task.sleep(for: .milliseconds(150))
      XCTAssertTrue(field.resignFirstResponder())
      try await Task.sleep(for: .milliseconds(150))
      XCTAssertEqual(seen.load, expected, "after typing \(typed)")
      XCTAssertEqual(field.text, LoadText.typed(expected))
    }
    picker.selectRow(11, inComponent: 0, animated: false)
    picker.delegate?.pickerView?(picker, didSelectRow: 11, inComponent: 0)
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(seen.reps, 12)
  }

  func testUnavailableEstimateNeverRendersAnIneligibilityClaim() async throws {
    for unavailable in [false, true] {
      let helpers = TrainingLogUITests(), (_, gym) = helpers.fixture()
      _ = try helpers.session(gym, daysAgo: 100)
      _ = try helpers.session(gym, daysAgo: 1, kg: unavailable ? .greatestFiniteMagnitude : 60, reps: unavailable ? 2 : 11)
      let log = try XCTUnwrap(gym.log), exercise = SeedExercises.all.first!.id
      let progress = log.progress.movement(exercise)
      let view = MovementRecordScreen(gym: gym, exerciseID: exercise, selected: nil)
      let window = try host(List { view.strength(progress, log: log, dates: gym.dates) }.modifier(GymPage()), appearance: .light)
      try await Task.sleep(for: .milliseconds(250)); window.layoutIfNeeded()
      let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate; request.recognitionLanguages = ["en-US"]
      try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
      let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
      XCTAssertTrue(text.contains("12 weeks"))
      XCTAssertEqual(text.contains("no eligible estimate"), !unavailable)
      window.isHidden = true; window.rootViewController = nil
    }
  }

  func testLargeNumeralsAtLargeAndLargestText() async throws {
    try skipUnlessCapturing()
    for (name, type) in [("large", DynamicTypeSize.xxxLarge), ("AX", .accessibility5)] {
      for (skin, appearance) in [("light", UIUserInterfaceStyle.light), ("dark", .dark)] {
        let (_, gym) = try fixture()
        gym.workout.weightKg = -500
        try await capture(WorkoutScreen(gym: gym), name: "live-\(name)-\(skin)", appearance: appearance, type: type)
        try await capture(RepsWheelSheet(title: "Set 4", movement: "Pull-up", reps: 5, commit: { _ in }), name: "wheel-\(name)-\(skin)", appearance: appearance, type: type)
        try await capture(SetEditor(gym: gym, set: try XCTUnwrap(gym.sets.last), identifier: "workout-fix"), name: "fix-\(name)-\(skin)", appearance: appearance, type: type)
      }
    }
  }

  func testConnectionWarningLeadsTheRackAtLargestText() async throws {
    let (_, gym) = try fixture()
    gym.workout.message = "Finish needs a connection — keep logging, or hide the workout."
    let window = try host(WorkoutScreen(gym: gym).environment(\.dynamicTypeSize, .accessibility5), appearance: .light)
    defer { window.isHidden = true; window.rootViewController = nil }
    try await Task.sleep(for: .milliseconds(450))
    window.layoutIfNeeded()
    var captures = 0
    func visibleText() throws -> String {
      let image = UIGraphicsImageRenderer(bounds: window.bounds).image {
        _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      }
      let attachment = XCTAttachment(image: image)
      attachment.name = "connection-warning-AX5-\(captures)"
      attachment.lifetime = .keepAlways; add(attachment); captures += 1
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.recognitionLanguages = ["en-US"]
      try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
      return (request.results ?? []).sorted { $0.boundingBox.minY > $1.boundingBox.minY }
        .compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
        .split(separator: " ").filter { $0 != "x" }.joined(separator: " ")
    }
    func scrolls(_ view: UIView) -> [UIScrollView] {
      (view as? UIScrollView).map { [$0] } ?? view.subviews.flatMap(scrolls)
    }
    let unscrolled = try visibleText()
    for phrase in ["needs a connection", "log set"] {
      XCTAssertTrue(unscrolled.contains(phrase), "The warning hid ‘\(phrase)’ before any scroll: \(unscrolled)")
    }
    var rendered = unscrolled
    for scroll in scrolls(window) where scroll.contentSize.height > scroll.bounds.height {
      let end = scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom
      for offset in stride(from: CGFloat(40), through: end + 40, by: 40) {
        scroll.setContentOffset(CGPoint(x: 0, y: min(offset, end)), animated: false)
        try await Task.sleep(for: .milliseconds(100))
        rendered += " " + (try visibleText())
      }
    }
    for phrase in ["keep logging", "or hide"] {
      XCTAssertTrue(rendered.contains(phrase), "The warning never showed ‘\(phrase)’: \(rendered)")
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
    XCTAssertEqual(result.1[1], [0xebe7e3, 0xf8f6f4, 0x106b5f, 0xffffff, 0x7d8c43, 0x6e5217])
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
