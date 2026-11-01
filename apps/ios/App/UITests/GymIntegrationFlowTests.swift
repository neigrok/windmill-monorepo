import XCTest

@MainActor final class GymIntegrationFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  var server: String? { ProcessInfo.processInfo.environment["WM_GYM_E2E_SERVER"] }
  var identities: [String: [String: String]] {
    guard let file = ProcessInfo.processInfo.environment["WM_GYM_E2E_IDENTITIES"],
          let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
          let values = try? JSONSerialization.jsonObject(with: data) as? [String: [String: String]] else { return [:] }
    return values
  }
  func launch(anonymous: Bool = false, appearance: String? = nil, conflict: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-scenario", anonymous ? "gym-e2e-anonymous" : "gym-e2e"]
    if conflict, server == nil { app.launchArguments[1] = "gym-e2e-conflict" }
    if let appearance { app.launchArguments += ["-onboarding-appearance", appearance] }
    if let server {
      app.launchArguments += ["-server", server, "-telemetry"]
      if let dsn = ProcessInfo.processInfo.environment["WM_GYM_E2E_SENTRY"] { app.launchArguments += ["-sentry-dsn", dsn] }
      if !anonymous { app.launchArguments += ["-code-file", ProcessInfo.processInfo.environment["WM_GYM_E2E_SESSION"]!] }
    } else { app.launchArguments += ["-model-server", "-server", "http://127.0.0.1:1"] }
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Routines"].waitForExistence(timeout: 20)); app.tabBars.buttons["Routines"].tap()
    XCTAssertTrue(app.buttons["new-routine"].waitForExistence(timeout: 20))
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["new-routine"])
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed)
    return app
  }
  func replace(_ field: XCUIElement, _ text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap()
    if let value = field.value as? String, !["Routine name", "open", "max", "last time"].contains(value) {
      field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
    }
    field.typeText(text)
  }

  func gymRequest(_ path: String, identity: [String: String]) throws -> URLRequest {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let data = try Data(contentsOf: root.appendingPathComponent("packages/api-contract/sync/gym.registry.json"))
    let registry = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let schema = try XCTUnwrap(registry["version"] as? Int)
    var request = URLRequest(url: try XCTUnwrap(URL(string: try XCTUnwrap(server) + "/v1/gym/" + path)))
    request.setValue("Bearer " + (try XCTUnwrap(identity["token"])), forHTTPHeaderField: "Authorization")
    request.setValue(String(schema), forHTTPHeaderField: "Sync-Schema")
    return request
  }

  func testFiniteLoadsKeepTheirValueOnThePadAndSyncBeyondTheOldLimitIncludingZero() async throws {
    guard server != nil, let file = ProcessInfo.processInfo.environment["WM_GYM_LOAD_CASES"] else {
      throw XCTSkip("requires the isolated schema10 load fixture")
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: file))
    let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    let identity = try XCTUnwrap(identities["signed"])
    func get(_ path: String) async throws -> [String: Any] {
      let (data, response) = try await URLSession.shared.data(for: gymRequest(path, identity: identity))
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    func shown(_ field: XCUIElement) throws -> Double {
      let value = try XCTUnwrap(field.value as? String)
      return try XCTUnwrap(Double(value.replacingOccurrences(of: ",", with: ".").replacingOccurrences(of: "−", with: "-")))
    }
    for item in cases {
      let load = try XCTUnwrap(item["weightKg"] as? Double), routine = try XCTUnwrap(item["routineId"] as? String)
      let before = try await get("sessions")["sessions"] as? [[String: Any]] ?? []
      let earlier = Set(before.compactMap { $0["id"] as? String })
      let app = launch()
      let row = app.buttons["routine-" + routine]
      XCTAssertTrue(row.waitForExistence(timeout: 15)); row.tap()
      XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 5)); app.buttons["routine-start"].tap()
      XCTAssertTrue(app.buttons["workout-weight"].waitForExistence(timeout: 10)); app.buttons["workout-weight"].tap()
      let field = app.textFields["workout-load"]
      XCTAssertTrue(field.waitForExistence(timeout: 5)); XCTAssertEqual(try shown(field), load)
      app.buttons["workout-load-done"].tap()
      XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5)); app.buttons["workout-log"].tap()
      XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch.waitForExistence(timeout: 5))
      app.buttons["workout-finish"].tap()
      XCTAssertTrue(app.buttons["workout-done"].waitForExistence(timeout: 15)); app.buttons["workout-done"].tap()
      var confirmed = false
      for _ in 0..<80 {
        let sessions = try await get("sessions")["sessions"] as? [[String: Any]] ?? []
        for session in sessions where session["finishedAt"] is NSNumber && !earlier.contains(session["id"] as? String ?? "") {
          let detail = try await get("sessions/" + (try XCTUnwrap(session["id"] as? String)))
          let sets = detail["sets"] as? [[String: Any]] ?? []
          confirmed = sets.count == 1 && sets.first?["weightKg"] as? Double == load
          if confirmed { break }
        }
        if confirmed { break }
        try await Task.sleep(for: .milliseconds(250))
      }
      XCTAssertTrue(confirmed, "The installed app's exact finite load must reach the schema10 backend")
      app.terminate()
    }
  }
  func pickBench(_ app: XCUIApplication, routineEditor: Bool = false) {
    let search = routineEditor ? app.textFields["gym-movement-search"] : app.searchFields.firstMatch
    XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Bench")
    XCTAssertTrue(app.buttons["gym-movement-bench-press"].waitForExistence(timeout: 5)); app.buttons["gym-movement-bench-press"].tap()
    if routineEditor {
      XCTAssertTrue(app.buttons["gym-movement-editor-commit"].waitForExistence(timeout: 5))
      app.buttons["gym-movement-editor-commit"].tap()
    }
  }
  func back(_ app: XCUIApplication) { app.navigationBars.buttons.element(boundBy: 0).tap() }
  func logAndFinish(_ app: XCUIApplication, close: Bool = true, count: Int = 4, keep: Bool = false) {
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    for _ in 0..<count { app.buttons["workout-log"].tap() }
    let set = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch
    XCTAssertTrue(set.waitForExistence(timeout: 5)); set.tap()
    app.typeLoad("62.5", into: "workout-fix-load")
    app.buttons["workout-fix-save"].tap()
    XCTAssertTrue(app.buttons["workout-finish"].waitForExistence(timeout: 5)); app.buttons["workout-finish"].tap()
    XCTAssertTrue(app.staticTexts[count < 4 ? "Ended early." : "Well done."].waitForExistence(timeout: 20))
    let options = app.buttons["workout-receipt-options"]
    XCTAssertTrue(options.waitForExistence(timeout: 5)); options.tap()
    let discard = app.buttons["Discard workout"]
    XCTAssertTrue(discard.waitForExistence(timeout: 5))
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(discard.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-share-coach"].exists)
    XCTAssertTrue(app.buttons["workout-done"].exists)
    if keep { XCTAssertEqual(app.buttons["workout-keep"].label, "Only on this phone · Keep it") }
    if !close { return }
    app.buttons["workout-done"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-session-detail"].waitForExistence(timeout: 10))
  }
  func testRoutineWorkoutReceiptLogRecordWeightNoteAndEdit() throws {
    let app = launch()
    app.buttons["new-routine"].tap(); replace(app.textFields["routine-name"], "Integration A")
    app.buttons["add-movement"].tap()
    pickBench(app, routineEditor: true)
    app.buttons["builder-movement-bench-press"].tap()
    for (identifier, value) in [("gym-target-sets", "4"), ("gym-target-reps", "8"), ("gym-target-weight", "60")] {
      let field = app.textFields[identifier], commit = app.buttons["gym-movement-editor-commit"]
      let navigation = app.navigationBars["Edit movement"]
      XCTAssertTrue(field.waitForExistence(timeout: 5))
      for _ in 0..<8 {
        let top = navigation.frame.maxY + 8, bottom = commit.frame.minY - 8
        if field.frame.minY >= top && field.frame.maxY <= bottom { break }
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0))
          .withOffset(CGVector(dx: 0, dy: (top + bottom) / 2))
        let distance: CGFloat = field.frame.maxY > bottom ? -80 : 80
        start.press(forDuration: 0.01, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance)), withVelocity: .slow, thenHoldForDuration: 0.1)
      }
      XCTAssertGreaterThanOrEqual(field.frame.minY, navigation.frame.maxY)
      XCTAssertLessThanOrEqual(field.frame.maxY, commit.frame.minY)
      field.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      if let previous = field.value as? String, !["open", "max", "last time"].contains(previous) {
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count))
      }
      field.typeText(value)
      XCTAssertTrue(field.waitForValue(value))
      app.buttons["gym-target-keyboard-done"].tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    }
    app.buttons["gym-movement-editor-commit"].tap(); app.buttons["save-routine"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["routine-detail"].waitForExistence(timeout: 5))
    // Start spans the summary sheet's reach band, never a content-sized capsule.
    let start = app.buttons["routine-start"]
    XCTAssertGreaterThanOrEqual(start.frame.width, app.windows.firstMatch.frame.width * 0.85)
    start.tap()
    hideAndReturn(app)
    let rackWeight = app.buttons["workout-weight"].label
    let rackSet = app.descendants(matching: .any)["workout-current-set"].label
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-assembly-add"].waitForExistence(timeout: 5)); app.buttons["workout-assembly-add"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
    app.navigationBars.buttons["Cancel"].tap()
    XCTAssertTrue(app.searchFields.firstMatch.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons["workout-weight"].label, rackWeight)
    XCTAssertEqual(app.descendants(matching: .any)["workout-current-set"].label, rackSet)
    XCTAssertFalse(app.buttons["workout-assembly-add"].exists)
    logAndFinish(app)
    app.buttons["gym-session-movement"].firstMatch.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-movement-record"].waitForExistence(timeout: 5))
    back(app); back(app)
    let session = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
    XCTAssertTrue(session.waitForExistence(timeout: 10)); session.tap()
    let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-finished-set-")).firstMatch
    XCTAssertTrue(first.waitForExistence(timeout: 10)); first.tap()
    XCTAssertTrue(app.buttons["gym-fix-save"].waitForExistence(timeout: 5))
    app.typeLoad("70", into: "gym-fix-load"); app.buttons["gym-fix-save"].tap()
    XCTAssertTrue(first.waitForLabel("1 · 70 × 8, +10 over plan"), first.label)
    back(app)
    XCTAssertTrue(session.waitForExistence(timeout: 10))
    app.buttons["gym-weigh-in"].tap()
    let weight = app.textFields["gym-weigh-in-weight"]
    replace(weight, "82.4")
    let date = app.buttons["gym-weigh-in-date"], originalDate = app.buttons["gym-weigh-in-date"].value as? String
    date.tap()
    let calendar = app.descendants(matching: .any)["gym-weigh-in-calendar"]
    XCTAssertTrue(calendar.waitForExistence(timeout: 5))
    XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
    XCTAssertGreaterThan(calendar.frame.height, 250)
    XCTAssertGreaterThan(calendar.frame.width, app.frame.width * 0.8)
    app.buttons["gym-weigh-in-date-back"].tap()
    XCTAssertTrue(weight.waitForExistence(timeout: 5))
    XCTAssertEqual(weight.value as? String, "82.4")
    XCTAssertEqual(date.value as? String, originalDate)
    app.buttons["gym-weigh-in-save"].tap()
    app.tabBars.buttons["Routines"].tap()
    if !app.buttons["edit-routine"].exists {
      let routine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "routine-", "Integration A")).firstMatch
      XCTAssertTrue(routine.waitForExistence(timeout: 5)); routine.tap()
    }
    XCTAssertTrue(app.buttons["edit-routine"].waitForExistence(timeout: 5)); app.buttons["edit-routine"].tap(); replace(app.textFields["routine-name"], "Integration B"); app.buttons["save-routine"].tap(); app.buttons["routine-close"].tap()
    app.tabBars.buttons["Coach"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 5)); app.buttons["you"].tap()
    XCTAssertTrue(app.buttons["settings-notes"].waitForExistence(timeout: 5)); app.buttons["settings-notes"].tap()
    app.buttons["coach-add-note"].tap(); replace(app.textFields["coach-note-text"], "Training focus\nKeep the bench controlled.")
    app.buttons["coach-note-save"].tap()
    XCTAssertTrue(app.staticTexts["Training focus"].waitForExistence(timeout: 5)); XCTAssertTrue(app.staticTexts["Keep the bench controlled."].exists)
    back(app)
    XCTAssertTrue(app.navigationBars["You"].buttons["Done"].waitForExistence(timeout: 5))
    app.navigationBars["You"].buttons["Done"].tap()
    if server != nil {
      let question = app.descendants(matching: .any)["coach-question"]
      XCTAssertTrue(question.waitForExistence(timeout: 10)); question.tap(); question.typeText("How is my training?")
      app.buttons["coach-send"].tap()
      XCTAssertTrue(app.staticTexts["This Windmill does not have Coach. You can still read your log."].waitForExistence(timeout: 10))
      XCTAssertFalse(question.exists)
      verifyServer("signed", edited: true)
    }
    discardAskingFirst(app)
  }
  // A past workout's discard asks first: Cancel leaves it in the log, and only the question's Discard takes it out.
  func discardAskingFirst(_ app: XCUIApplication) {
    app.tabBars.buttons["The log"].tap()
    let session = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "gym-log-session-")).firstMatch
    XCTAssertTrue(session.waitForExistence(timeout: 10)); session.tap()
    let detail = app.descendants(matching: .any)["gym-session-detail"], question = app.alerts["Discard this workout?"]
    for answer in ["Cancel", "Discard"] {
      XCTAssertTrue(app.buttons["gym-session-more"].waitForExistence(timeout: 5)); app.buttons["gym-session-more"].tap()
      XCTAssertTrue(app.buttons["gym-session-discard"].waitForExistence(timeout: 5)); app.buttons["gym-session-discard"].tap()
      XCTAssertTrue(question.waitForExistence(timeout: 5))
      XCTAssertTrue(question.staticTexts["This deletes the workout and its 4 sets. You can’t undo this."].exists)
      question.buttons[answer].tap()
      XCTAssertTrue(question.waitForNonExistence(timeout: 5))
      if answer == "Cancel" { XCTAssertTrue(detail.exists) }
    }
    XCTAssertTrue(detail.waitForNonExistence(timeout: 10))
    XCTAssertTrue(session.waitForNonExistence(timeout: 10))
  }
  // iOS 26 keeps a hidden workout in the tab bar's accessory, which goes where the tab bar goes: a routine's summary over
  // the room draws neither, and back at the root one tap brings the logger back.
  func hideAndReturn(_ app: XCUIApplication) {
    XCTAssertTrue(app.buttons["workout-assembly"].waitForExistence(timeout: 10)); app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    let accessory = app.buttons["gym-hidden-workout"]
    XCTAssertTrue(accessory.waitForExistence(timeout: 5))
    XCTAssertEqual(accessory.label, "Integration A, in progress")
    let routine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "routine-", "Integration A,")).firstMatch
    XCTAssertTrue(routine.waitForExistence(timeout: 5)); routine.tap()
    XCTAssertTrue(app.buttons["routine-close"].waitForExistence(timeout: 5))
    XCTAssertFalse(accessory.isHittable)
    app.buttons["routine-close"].tap()
    XCTAssertTrue(accessory.wait(for: \.isHittable, toEqual: true, timeout: 5)); accessory.tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
  }
  func testAnonymousWorkoutAdoptedAtSignIn() throws {
    let app = launch(anonymous: true)
    XCTAssertTrue(app.buttons["new-routine"].waitForExistence(timeout: 15)); app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], "Training day\n")
    app.buttons["add-movement"].tap(); pickBench(app, routineEditor: true)
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 5)); app.buttons["routine-start"].tap()
    logAndFinish(app, keep: true); back(app)
    app.buttons["you"].tap()
    if let link = identities["adopt"]?["link"] {
      app.buttons["email-sign-in"].tap(); replace(app.textFields["email-address"], "gym-mail-failure@example.com")
      XCTAssertTrue(app.textFields["email-address"].waitForValue("gym-mail-failure@example.com")); app.buttons["Send code"].tap()
      XCTAssertTrue(app.staticTexts["Can't reach windmill.works. Nothing you've written is lost."].waitForExistence(timeout: 10))
      app.terminate(); app.launchArguments += ["-restore-board", "-sign-in-link-fixture"]; app.launch()
      app.launchArguments.removeAll { $0 == "-restore-board" || $0 == "-sign-in-link-fixture" }
      XCTAssertTrue(app.buttons["link-sign-in"].waitForExistence(timeout: 10)); app.buttons["link-sign-in"].tap()
      replace(app.textFields["sign-in-link"], link); app.buttons["sign-in-link-submit"].tap()
    } else {
      app.buttons["email-sign-in"].tap(); replace(app.textFields["email-address"], "gym-adopt@example.com")
      XCTAssertTrue(app.textFields["email-address"].waitForValue("gym-adopt@example.com")); app.buttons["Send code"].tap()
      replace(app.textFields["email-code"], "482913")
    }
    if app.alerts.buttons["Add"].waitForExistence(timeout: 5) { app.alerts.buttons["Add"].tap() }
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 15))
    if server != nil { verifyServer("adopt", edited: false) }
  }
  func testFinishedAndOpenAnonymousWorkoutsStaySeparateFromAccountsOpenWorkout() throws {
    let app = launch(anonymous: true, appearance: "light", conflict: true)
    let identity = try server == nil
      ? XCTUnwrap(conflictModelSnapshot(app, expectedSessions: 1)["identity"] as? [String: String])
      : XCTUnwrap(identities["conflict"])
    let accountWorkout = try XCTUnwrap(identity["openSession"])
    XCTAssertTrue(app.buttons["new-routine"].waitForExistence(timeout: 15)); app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], "Training day\n")
    app.buttons["add-movement"].tap(); pickBench(app, routineEditor: true)
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 5)); app.buttons["routine-start"].tap()
    logAndFinish(app, count: 2); back(app)
    app.tabBars.buttons["Routines"].tap()
    let routine = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "routine-", "Training day,")).firstMatch
    XCTAssertTrue(routine.waitForExistence(timeout: 5)); routine.tap()
    let start = app.buttons["routine-start"]
    XCTAssertTrue(start.waitForExistence(timeout: 5)); XCTAssertTrue(start.wait(for: \.isEnabled, toEqual: true, timeout: 10)); start.tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 5))
    let currentSet = app.descendants(matching: .any)["workout-current-set"]
    let loggedSets = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-"))
    app.buttons["workout-log"].tap()
    XCTAssertTrue(currentSet.waitForLabel("Set 2, current, open target"))
    XCTAssertEqual(loggedSets.count, 1)
    app.buttons["workout-log"].tap()
    XCTAssertTrue(currentSet.waitForLabel("Set 3, current, open target"))
    XCTAssertEqual(loggedSets.count, 2)
    app.buttons["workout-assembly"].tap()
    XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 5)); app.buttons["you"].tap()
    if server != nil {
      let link = try XCTUnwrap(identity["link"])
      app.terminate(); app.launchArguments += ["-restore-board", "-sign-in-link-fixture"]; app.launch()
      app.launchArguments.removeAll { $0 == "-restore-board" || $0 == "-sign-in-link-fixture" }
      XCTAssertTrue(app.buttons["link-sign-in"].waitForExistence(timeout: 10)); app.buttons["link-sign-in"].tap()
      replace(app.textFields["sign-in-link"], link); app.buttons["sign-in-link-submit"].tap()
    } else {
      let address = try XCTUnwrap(identity["email"])
      app.buttons["email-sign-in"].tap(); replace(app.textFields["email-address"], address)
      XCTAssertTrue(app.textFields["email-address"].waitForValue(address)); app.buttons["Send code"].tap(); replace(app.textFields["email-code"], "482913")
    }
    XCTAssertTrue(app.alerts.buttons["Add"].waitForExistence(timeout: 15)); app.alerts.buttons["Add"].tap()
    let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "recovery-row-"))
    openLog(app)
    let row = rows.firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 20))
    let recoveredID = String(row.identifier.dropFirst("recovery-row-".count))
    XCTAssertFalse(recoveredID.isEmpty); XCTAssertNotEqual(recoveredID, accountWorkout)
    XCTAssertTrue(row.label.hasSuffix("Your account has an open workout — keep this one as finished."), row.label)
    let keep = app.buttons["recovery-primary"]
    row.tap(); XCTAssertTrue(keep.waitForExistence(timeout: 10)); XCTAssertEqual(keep.label, "Keep as finished")
    let finishedSets = verifyConflictServer(app, identity: identity, stage: "before-keep")
    XCTAssertEqual(finishedSets.count, 2)
    app.terminate()
    if let appearance = app.launchArguments.firstIndex(of: "-onboarding-appearance") { app.launchArguments[appearance + 1] = "dark" }
    app.launchArguments += ["-restore-board"]; app.launch()
    openLog(app)
    let restoredRow = app.buttons["recovery-row-" + recoveredID]
    XCTAssertTrue(restoredRow.waitForExistence(timeout: 20)); restoredRow.tap()
    XCTAssertTrue(keep.waitForExistence(timeout: 10)); XCTAssertEqual(keep.label, "Keep as finished")
    XCTAssertEqual(verifyConflictServer(app, identity: identity, stage: "restored-before-keep"), finishedSets)
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in keep.isEnabled && keep.isHittable }, object: keep)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed); keep.tap()
    XCTAssertTrue(keep.waitForNonExistence(timeout: 10), "A queued Keep leaves the band")
    let adding = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@", "Adding ", " to your log.")).firstMatch
    XCTAssertTrue(adding.waitForNonExistence(timeout: 30), "Inspect says the workout is on its way only until the log confirms it")
    back(app)
    XCTAssertTrue(restoredRow.waitForNonExistence(timeout: 30), "A kept workout's row leaves once the log confirms it")
    let allAnonymousSets = verifyConflictServer(app, identity: identity, stage: "after-keep", recoveryID: recoveredID)
    XCTAssertEqual(allAnonymousSets.count, 4); XCTAssertTrue(allAnonymousSets.isSuperset(of: finishedSets))
    app.terminate(); app.launch()
    openLog(app)
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 20))
    XCTAssertEqual(rows.count, 0)
    XCTAssertEqual(verifyConflictServer(app, identity: identity, stage: "relaunch-after-keep", recoveryID: recoveredID), allAnonymousSets)
  }

  // Signed in, a workout the account has not taken waits under On this phone at the head of The log; the account's own
  // open workout, when it comes to the front, is hidden first.
  func openLog(_ app: XCUIApplication) {
    let log = app.tabBars.buttons["The log"], rack = app.buttons["workout-log"]
    let either = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in rack.exists || log.isHittable }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [either], timeout: 30), .completed)
    if rack.exists {
      app.buttons["workout-assembly"].tap()
      XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
    }
    XCTAssertTrue(log.wait(for: \.isHittable, toEqual: true, timeout: 30)); log.tap()
    XCTAssertTrue(app.descendants(matching: .any)["gym-log"].waitForExistence(timeout: 20))
  }

  func conflictModelSnapshot(_ app: XCUIApplication, expectedSessions: Int) throws -> [String: Any] {
    let status = app.descendants(matching: .any)["gym-conflict-server"]
    XCTAssertTrue(status.waitForExistence(timeout: 20))
    var snapshot: [String: Any]?
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let value = status.value as? String,
            let decoded = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else { return false }
      snapshot = decoded
      return decoded["error"] != nil || (decoded["ready"] as? Bool == true && (decoded["sessions"] as? [[String: Any]])?.count == expectedSessions)
    }, object: status)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 20), .completed)
    let confirmed = try XCTUnwrap(snapshot)
    XCTAssertNil(confirmed["error"], String(describing: confirmed["error"]))
    return confirmed
  }

  func verifyConflictServer(_ app: XCUIApplication, identity: [String: String], stage: String, recoveryID: String? = nil) -> Set<String> {
    if server == nil {
      if app.buttons["workout-log"].exists {
        app.buttons["workout-assembly"].tap()
        XCTAssertTrue(app.buttons["workout-hide"].waitForExistence(timeout: 5)); app.buttons["workout-hide"].tap()
        XCTAssertTrue(app.buttons["you"].waitForExistence(timeout: 5))
      }
      do {
        let snapshot = try conflictModelSnapshot(app, expectedSessions: recoveryID == nil ? 2 : 3)
        return try assertConflictSessions(XCTUnwrap(snapshot["sessions"] as? [[String: Any]]),
          identity: identity, stage: stage, recoveryID: recoveryID)
      } catch { XCTFail("Conflicting adoption model verification failed: \(error)"); return [] }
    }
    let confirmed = expectation(description: "Anonymous workouts retained separately and exactly once")
    var setIDs = Set<String>()
    Task {
      do { setIDs = try await verifyConflictServerAsync(identity: identity, stage: stage, recoveryID: recoveryID) }
      catch { XCTFail("Conflicting adoption REST verification failed: \(error)") }
      confirmed.fulfill()
    }
    wait(for: [confirmed], timeout: 30)
    return setIDs
  }
  func verifyConflictServerAsync(identity: [String: String], stage: String, recoveryID: String?) async throws -> Set<String> {
    let origin = try XCTUnwrap(server)
    let accountWorkout = try XCTUnwrap(identity["openSession"])
    let token = try XCTUnwrap(identity["token"])
    func get(_ path: String) async throws -> [String: Any] {
      var request = URLRequest(url: URL(string: origin + "/v1/gym/" + path)!); request.timeoutInterval = 5
      request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
      let (data, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    let expectedSessions = recoveryID == nil ? 2 : 3
    for _ in 0..<100 {
      let sessions = try await get("sessions")["sessions"] as? [[String: Any]] ?? []
      guard sessions.count == expectedSessions else { try await Task.sleep(for: .milliseconds(200)); continue }
      var details: [[String: Any]] = []
      for listed in sessions {
        let id = try XCTUnwrap(listed["id"] as? String), detail = try await get("sessions/" + id)
        XCTAssertEqual((detail["session"] as? [String: Any])?["id"] as? String, id)
        details.append(detail)
      }
      XCTAssertEqual(sessions.filter { $0["finishedAt"] == nil }.compactMap { $0["id"] as? String }, [accountWorkout])
      if let recoveryID { XCTAssertTrue(sessions.contains { $0["id"] as? String == recoveryID }) }
      return try assertConflictSessions(details, identity: identity, stage: stage, recoveryID: recoveryID)
    }
    XCTFail("The expected anonymous sessions did not reach the backend within 20 seconds.")
    return []
  }

  func assertConflictSessions(_ details: [[String: Any]], identity: [String: String], stage: String, recoveryID: String?) throws -> Set<String> {
    let accountWorkout = try XCTUnwrap(identity["openSession"]), accountSet = try XCTUnwrap(identity["openSet"])
    let startedAt = try XCTUnwrap(identity["openStartedAt"].flatMap(Int64.init)), completedAt = try XCTUnwrap(identity["openCompletedAt"].flatMap(Int64.init))
    var sessions: [[String: Any]] = [], anonymousSets: [[String: Any]] = []
    for detail in details {
      let session = try XCTUnwrap(detail["session"] as? [String: Any]), sets = try XCTUnwrap(detail["sets"] as? [[String: Any]])
      let id = try XCTUnwrap(session["id"] as? String)
      sessions.append(session)
      if id == accountWorkout {
        XCTAssertNil(session["finishedAt"]); XCTAssertEqual(sets.count, 1)
        XCTAssertEqual(session["startedAt"] as? Int64, startedAt); XCTAssertEqual(sets.first?["completedAt"] as? Int64, completedAt)
        XCTAssertNil(sets.first?["kind"]); XCTAssertEqual(sets.first?["note"] as? String, "")
        XCTAssertEqual(sets.first?["id"] as? String, accountSet)
        XCTAssertEqual(sets.first?["exerciseId"] as? String, "barbell-row")
        XCTAssertEqual(sets.first?["weightKg"] as? Double, 35); XCTAssertEqual(sets.first?["reps"] as? Int, 11)
      } else {
        XCTAssertNotNil(session["finishedAt"]); XCTAssertEqual(sets.count, 2)
        XCTAssertTrue(sets.allSatisfy { $0["exerciseId"] as? String == "bench-press" })
        if id == recoveryID {
          XCTAssertEqual(session["finishedAt"] as? Int64, sets.compactMap { $0["completedAt"] as? Int64 }.max())
        } else { XCTAssertTrue(sets.contains { $0["weightKg"] as? Double == 62.5 }) }
        anonymousSets += sets
      }
    }
    let ids = Set(anonymousSets.compactMap { $0["id"] as? String })
    XCTAssertEqual(ids.count, anonymousSets.count); XCTAssertFalse(ids.contains(accountSet))
    XCTAssertEqual(sessions.filter { $0["finishedAt"] == nil }.compactMap { $0["id"] as? String }, [accountWorkout])
    if let recoveryID { XCTAssertTrue(sessions.contains { $0["id"] as? String == recoveryID }) }
    let data = try JSONSerialization.data(withJSONObject: ["stage": stage, "sessions": details], options: [.prettyPrinted, .sortedKeys])
    let evidence = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    evidence.name = (server == nil ? "conflict-model-" : "conflict-rest-") + stage; evidence.lifetime = .keepAlways; add(evidence)
    return ids
  }

  // Coach over a signed-out workout leads out of it: Build my own closes the sheet, hides the workout and opens a new
  // routine in Routines, and the hidden workout comes back as it was.
  func testCoachOverTheWorkoutOpensItsDoorsBehindIt() {
    let app = XCUIApplication()
    app.launchArguments = ["-scenario", "gym-coach-doors-" + UUID().uuidString, "-model-server", "-server", "http://127.0.0.1:1"]
    app.launch()
    XCTAssertTrue(app.buttons["open-gym"].waitForExistence(timeout: 20)); app.buttons["open-gym"].tap()
    XCTAssertTrue(app.tabBars.buttons["Routines"].waitForExistence(timeout: 20)); app.tabBars.buttons["Routines"].tap()
    XCTAssertTrue(app.buttons["new-routine"].waitForExistence(timeout: 20)); app.buttons["new-routine"].tap()
    replace(app.textFields["routine-name"], "Training day\n")
    app.buttons["add-movement"].tap(); pickBench(app, routineEditor: true)
    app.buttons["save-routine"].tap()
    XCTAssertTrue(app.buttons["routine-start"].waitForExistence(timeout: 5)); app.buttons["routine-start"].tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10)); app.buttons["workout-log"].tap()
    let coach = app.buttons["workout-coach"]
    XCTAssertTrue(coach.wait(for: \.isHittable, toEqual: true, timeout: 5)); coach.tap()
    let build = app.buttons["coach-setup-build_manually"]
    XCTAssertTrue(build.waitForExistence(timeout: 10)); build.tap()
    XCTAssertTrue(app.textFields["routine-name"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["workout-log"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["coach-question"].exists)
    app.navigationBars.buttons["Cancel"].tap()
    let hidden = app.buttons["gym-hidden-workout"]
    XCTAssertTrue(hidden.waitForExistence(timeout: 10)); hidden.tap()
    XCTAssertTrue(app.buttons["workout-log"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "workout-set-")).firstMatch.exists, "The hidden workout keeps its set")
  }

  // Signed out, Share with Coach opens Keep your log; the sign-in it opens hands the receipt to Coach, which answers once.
  func testReceiptKeepsCoachAndAccountHandoffsThroughDismissal() {
    let anonymous = XCUIApplication()
    anonymous.launchArguments = ["-model-server", "-server", "http://127.0.0.1:1", "-scenario", "gym-e2e-anonymous", "-coach-fixture"]
    anonymous.launch()
    XCTAssertTrue(anonymous.tabBars.buttons["Routines"].waitForExistence(timeout: 15)); anonymous.tabBars.buttons["Routines"].tap()
    XCTAssertTrue(anonymous.buttons["new-routine"].waitForExistence(timeout: 15)); anonymous.buttons["new-routine"].tap()
    replace(anonymous.textFields["routine-name"], "Training day\n")
    anonymous.buttons["add-movement"].tap(); pickBench(anonymous, routineEditor: true)
    anonymous.buttons["save-routine"].tap()
    XCTAssertTrue(anonymous.buttons["routine-start"].waitForExistence(timeout: 5)); anonymous.buttons["routine-start"].tap()
    logAndFinish(anonymous, close: false)
    let anonymousShare = anonymous.buttons["workout-share-coach"]
    for _ in 0..<4 where !anonymousShare.isHittable { anonymous.swipeUp() }
    anonymousShare.tap()
    XCTAssertTrue(anonymous.staticTexts["Keep your log"].waitForExistence(timeout: 10))
    anonymous.buttons["email-sign-in"].tap()
    replace(anonymous.textFields["email-address"], "receipt-share@example.com")
    XCTAssertTrue(anonymous.textFields["email-address"].waitForValue("receipt-share@example.com"))
    anonymous.buttons["Send code"].tap(); replace(anonymous.textFields["email-code"], "482913")
    if anonymous.alerts.buttons["Add"].waitForExistence(timeout: 5) { anonymous.alerts.buttons["Add"].tap() }
    XCTAssertTrue(anonymous.descendants(matching: .any)["gym-coach"].waitForExistence(timeout: 15))
    XCTAssertTrue(anonymous.descendants(matching: .any)["coach-proposal-header"].waitForExistence(timeout: 15))
    XCTAssertTrue(anonymous.buttons["coach-stop"].waitForNonExistence(timeout: 10))
    let deferredQuestion = anonymous.staticTexts["Check my last workout."]
    for _ in 0..<4 where !deferredQuestion.isHittable { anonymous.swipeDown() }
    XCTAssertTrue(deferredQuestion.waitForExistence(timeout: 5))
    XCTAssertEqual(anonymous.staticTexts.matching(NSPredicate(format: "label == %@", "Check my last workout.")).count, 1)
  }

  func verifyServer(_ kind: String, edited: Bool) {
    let confirmed = expectation(description: "All UI changes confirmed through backend REST reads")
    Task {
      do { try await verifyServerAsync(kind, edited: edited) }
      catch { XCTFail("Backend verification failed: \(error)") }
      confirmed.fulfill()
    }
    wait(for: [confirmed], timeout: 30)
  }
  func verifyServerAsync(_ kind: String, edited: Bool) async throws {
    let identity = try XCTUnwrap(identities[kind])
    func get(_ path: String) async throws -> [String: Any] {
      let request = try gymRequest(path, identity: identity)
      let (data, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    for _ in 0..<100 {
      let listing = try await get("sessions")
      let sessions = listing["sessions"] as? [[String: Any]] ?? []
      if let session = sessions.first(where: { $0["finishedAt"] is NSNumber }), let id = session["id"] as? String {
        let detail = try await get("sessions/" + id)
        let sets = detail["sets"] as? [[String: Any]] ?? []
        var confirmed = sets.count == 4 && sets.contains { ($0["weightKg"] as? Double) == (edited ? 70 : 62.5) }
        if edited {
          let frozen = (detail["session"] as? [String: Any])?["plan"] as? [String: Any] ?? [:]
          let entries = frozen["entries"] as? [[String: Any]] ?? []
          let targets = entries.first?["sets"] as? [[String: Any]] ?? []
          confirmed = confirmed && frozen["routine"] as? String == "Integration A" && targets.count == 4
          confirmed = confirmed && targets.allSatisfy { ($0["weightKg"] as? Double) == 60 && ($0["reps"] as? Int) == 8 }
          let routines = try await get("routines"), weights = try await get("bodyweight"), notes = try await get("notes")
          confirmed = confirmed && (routines["routines"] as? [[String: Any]] ?? []).contains { $0["name"] as? String == "Integration B" }
          confirmed = confirmed && (weights["entries"] as? [[String: Any]] ?? []).contains { ($0["weightKg"] as? Double) == 82.4 }
          confirmed = confirmed && (notes["notes"] as? [[String: Any]] ?? []).contains {
            $0["title"] as? String == "Training focus" && $0["body"] as? String == "Keep the bench controlled."
          }
        }
        if confirmed { return }
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    XCTFail("The UI changes did not all reach the real backend within 20 seconds.")
  }
}
