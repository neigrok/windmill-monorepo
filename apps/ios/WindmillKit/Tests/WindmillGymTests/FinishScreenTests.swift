import XCTest
@testable import WindmillGym

private let catalog = [
    Exercise(id: "back-squat", name: "Back Squat"),
    Exercise(id: "leg-press", name: "Leg Press"),
]

final class FinishTests: XCTestCase {
    private let started: Int64 = 1_754_308_320_000     // Tue 4 Aug 2025, 18:12 local
    private var finished: Int64 { started + 3_720_000 }

    // The head congratulates, and a short one does not: a congratulation on two sets would be a
    // small lie. Both titles are Android's to the byte, stop included.
    func testAFinishedSessionIsCongratulatedAndAShortOneIsNot() {
        let ordinary = Finish.head(startedAtMs: started, finishedAtMs: finished,
                                   routine: "Legs", slight: false, first: false)
        XCTAssertEqual(ordinary.title, "Well done.")
        XCTAssertEqual(ordinary.subtitle, "Legs")
        XCTAssertEqual(ordinary.when,
                       "\(Readout.day(started)) · \(Readout.time(started)) – \(Readout.time(finished))")

        let short = Finish.head(startedAtMs: started, finishedAtMs: finished,
                                routine: "Pull A", slight: true, first: false)
        XCTAssertEqual(short.title, "Ended early.", "a short session is never congratulated")
        XCTAssertEqual(short.subtitle, "Pull A")
    }

    func testASessionWithNoRoutineIsNamedByWhetherItIsTheFirstOne() {
        XCTAssertEqual(Finish.head(startedAtMs: started, finishedAtMs: finished,
                                   routine: nil, slight: false, first: true).subtitle,
                       "Your first session")
        XCTAssertEqual(Finish.head(startedAtMs: started, finishedAtMs: finished,
                                   routine: nil, slight: false, first: false).subtitle,
                       "No routine")
    }

    func testTheThreeFactsAreDurationWorkingSetsAndTopE1rm() {
        let tiles = Finish.tiles(Review.Stats(durationMs: 3_720_000, workingSets: 16, topE1rm: 122.5))
        XCTAssertEqual(tiles.map(\.label), ["Duration", "Working sets", "Top e1RM"])
        XCTAssertEqual(tiles.map(\.value), ["1h 02m", "16", "122.5"])
    }

    func testASessionWithNoLoadedSetShowsADashRatherThanAZero() {
        let tiles = Finish.tiles(Review.Stats(durationMs: 660_000, workingSets: 3, topE1rm: nil))
        XCTAssertEqual(tiles.map(\.value), ["11m", "3", "—"])
    }

    func testNoRecordDrawsNoLineAtAll() {
        XCTAssertNil(Finish.recordSentence(nil, catalog: catalog))
    }

    func testEachKindOfRecordNamesWhatItBeatAndWhen() {
        let past: Int64 = 1_750_723_200_000
        let e1rm = PersonalRecord(kind: .e1rm, exerciseId: "back-squat", value: 122.5,
                                  weightKg: 105, reps: 5, previous: 116.7, previousAtMs: past)
        XCTAssertEqual(Finish.recordSentence(e1rm, catalog: catalog),
                       "Back Squat e1RM 122.5 kg — past 116.7 from \(Readout.day(past)).")

        let heaviest = PersonalRecord(kind: .heaviest, exerciseId: "back-squat", value: 140,
                                      weightKg: 140, reps: 1, previous: 135, previousAtMs: past)
        XCTAssertEqual(Finish.recordSentence(heaviest, catalog: catalog),
                       "Back Squat 140 kg × 1 — past 135 from \(Readout.day(past)).")

        let reps = PersonalRecord(kind: .repsAtWeight, exerciseId: "back-squat", value: 8,
                                  weightKg: 100, reps: 8, previous: 6, previousAtMs: past)
        XCTAssertEqual(Finish.recordSentence(reps, catalog: catalog),
                       "Back Squat 8 reps at 100 kg — past 6 from \(Readout.day(past)).")
    }

    func testTheComparisonPointsFromThePlanAndFallsBackToLastTime() {
        let against = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1_750_723_200_000, movements: [
            Against.Movement(exerciseId: "back-squat",
                             now: Against.Effort(weightKg: 105, reps: 5, sets: 5),
                             before: Against.Effort(weightKg: 102.5, reps: 5, sets: 5),
                             planned: Array(repeating: SetTarget(reps: 5, weightKg: 102.5), count: 5)),
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 140, reps: 12, sets: 3),
                             before: Against.Effort(weightKg: 135, reps: 12, sets: 3)),
        ])
        let comparison = Finish.comparison(against, catalog: catalog)
        XCTAssertEqual(comparison?.title, "Against last Legs")
        XCTAssertEqual(comparison?.rows.map(\.movement), ["Back Squat", "Leg Press"])
        XCTAssertEqual(comparison?.rows.map(\.detail),
                       ["5 × 5 · 102.5 → 5 × 5 · 105", "3 × 12 · 135 → 3 × 12 · 140"])
    }

    func testAMovementThatFellShortOfThePlanSaysItPlainly() {
        let against = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 140, reps: 10, sets: 3),
                             planned: Array(repeating: SetTarget(reps: 12, weightKg: 140), count: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3 × 12 · 140 — did 3 × 10 · 140"])
    }

    func testABodyweightMovementPrintsNoLoad() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 8, sets: 3),
                             before: Against.Effort(weightKg: 0, reps: 7, sets: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail), ["3 × 7 → 3 × 8"])
    }

    func testAMovementWithNoRepTargetReadsAsMaxAndNeverAsAShortfall() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 6, sets: 3),
                             planned: Array(repeating: SetTarget(), count: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["3 × max → 3 × 6"])
    }

    func testAPlanThatNamesNoRepTargetCannotBeFallenShortOf() {
        let against = Against(sessionId: "ses_0", routine: "Pull A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 4, sets: 2),
                             planned: Array(repeating: SetTarget(), count: 3)),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["3 × max → 2 × 4"])
    }

    func testASessionThatRampedThroughItsWholePlanIsNeverToldItFellShort() {
        let ramped = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "back-squat",
                             now: Against.Effort(weightKg: 110, reps: 5, sets: 3),
                             before: Against.Effort(weightKg: 105, reps: 5, sets: 3),
                             planned: Array(repeating: SetTarget(reps: 5, weightKg: 100), count: 5)),
        ])
        XCTAssertEqual(Finish.comparison(ramped, catalog: catalog)?.rows.map(\.detail),
                       ["5 × 5 · 100 → 3 × 5 · 110"])
    }

    func testGoingHeavierForFewerRepsIsADifferentSessionAndNotASmallerOne() {
        let heavier = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 160, reps: 8, sets: 5),
                             planned: Array(repeating: SetTarget(reps: 12, weightKg: 140), count: 3)),
        ])
        XCTAssertEqual(Finish.comparison(heavier, catalog: catalog)?.rows.map(\.detail),
                       ["3 × 12 · 140 → 5 × 8 · 160"])
    }

    func testWhatIsCalledShortIsTheRepsAtALoadThatDidNotGoUp() {
        let heldLoad = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "leg-press",
                             now: Against.Effort(weightKg: 140, reps: 10, sets: 3),
                             planned: Array(repeating: SetTarget(reps: 12, weightKg: 140), count: 3)),
        ])
        XCTAssertEqual(Finish.comparison(heldLoad, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3 × 12 · 140 — did 3 × 10 · 140"])

        let noLoadNamed = Against(sessionId: "ses_0", routine: "Legs", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "chin-up",
                             now: Against.Effort(weightKg: 0, reps: 6, sets: 3),
                             planned: Array(repeating: SetTarget(reps: 8), count: 3)),
        ])
        XCTAssertEqual(Finish.comparison(noLoadNamed, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3 × 8 — did 3 × 6"])
    }

    // Lower A's ramp reads as its range on the left, and the top set stands against the plan's top set:
    // a 100 × 1 landed is the plan met, a 90 × 3 that never reached the top is a different session and
    // not a short one, and a 100 × 2 against a planned 100 × 3 is short.
    func testARampReadsAsItsRangeAndTheTopSetStandsAgainstThePlansTopSet() {
        let ramp = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80), SetTarget(reps: 3, weightKg: 90),
                    SetTarget(reps: 1, weightKg: 100), SetTarget(reps: 5, weightKg: 80)]
        func detail(_ now: Against.Effort, against planned: [SetTarget]) -> [String]? {
            let against = Against(sessionId: "ses_0", routine: "Lower A", startedAtMs: 1, movements: [
                Against.Movement(exerciseId: "back-squat", now: now, planned: planned),
            ])
            return Finish.comparison(against, catalog: catalog)?.rows.map(\.detail)
        }
        XCTAssertEqual(detail(Against.Effort(weightKg: 100, reps: 1, sets: 1), against: ramp),
                       ["5 × 1\u{2013}5 · 60\u{2013}100 → 1 × 1 · 100"])
        XCTAssertEqual(detail(Against.Effort(weightKg: 90, reps: 3, sets: 1), against: ramp),
                       ["5 × 1\u{2013}5 · 60\u{2013}100 → 1 × 3 · 90"])
        XCTAssertEqual(detail(Against.Effort(weightKg: 100, reps: 2, sets: 1),
                              against: [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80), SetTarget(reps: 3, weightKg: 100)]),
                       ["planned 3 × 3\u{2013}5 · 60\u{2013}100 — did 1 × 2 · 100"])
    }

    // A top set to max: the plan's top set is the FIRST at the heaviest load, so its 5 is the target a
    // 100 × 3 fell short of, and the max set never turns the shortfall off.
    func testATopSetToMaxIsMeasuredAgainstTheFirstSetAtTheHeaviestLoad() {
        let against = Against(sessionId: "ses_0", routine: "Lower A", startedAtMs: 1, movements: [
            Against.Movement(exerciseId: "back-squat",
                             now: Against.Effort(weightKg: 100, reps: 3, sets: 1),
                             planned: [SetTarget(reps: 5, weightKg: 100), SetTarget(reps: 5, weightKg: 100), SetTarget(weightKg: 100)]),
        ])
        XCTAssertEqual(Finish.comparison(against, catalog: catalog)?.rows.map(\.detail),
                       ["planned 3 × 5\u{2013}max · 100 — did 1 × 3 · 100"])
    }

    func testAnAdHocSessionHasNothingToCompareAgainst() {
        XCTAssertNil(Finish.comparison(nil, catalog: catalog))
    }

    // The keep-as-routine preview is one readout per movement, in the formula: the working sets are
    // transcribed set by set, so a ramp reads as its range and never as a flattened count.
    func testTheKeepAsRoutinePreviewReadsEachMovementsSchemeInTheFormula() throws {
        let squat = [(60.0, 5), (80.0, 5), (90.0, 3), (100.0, 1), (80.0, 5)]
        let ramped = squat.enumerated().map { index, set in
            TrainingSet(id: "sq\(index)", exerciseId: "back-squat", weightKg: set.0, reps: set.1,
                        completedAtMs: Int64(1_000 + index))
        }
        let pressed = (0..<3).map { index in
            TrainingSet(id: "lp\(index)", exerciseId: "leg-press", weightKg: 60, reps: 8,
                        completedAtMs: Int64(2_000 + index))
        }
        let write = try XCTUnwrap(RoutineWrite(named: "Tuesday", from: ramped + pressed, position: 0))

        XCTAssertEqual(write.entries.map { Readout.target($0.sets) }, ["5 × 1–5 · 60–100", "3 × 8 · 60"])
        XCTAssertTrue(try Self.source.contains("Text(Readout.target(entry.sets))"),
                      "the preview draws the scheme's readout and nothing per set: the ladder is the routine screen's")
    }

    // Emptying the name makes `Save routine` grey, and the sheet says why in the routine editor's
    // own sentence rather than in a fourth spelling of it — and by the editor's own predicate, in the
    // editor's own unit. The fixture carries newlines because spaces cannot tell the two units apart:
    // `.whitespaces` is `Zs` plus tab, so it calls a pasted "\n" a name where the editor does not.
    func testAnEmptyRoutineNameIsRefusedInTheEditorsOwnWords() {
        for blank in ["", "   ", "\t", "\n", "\r\n", "\u{2028}"] {
            XCTAssertEqual(Finish.keepRefusal(name: blank, failure: nil), RoutineDraft.nameItToSaveIt,
                           "the keep took \(blank.debugDescription) for a name")
            XCTAssertFalse(RoutineDraft(name: blank, position: 0).isNamed,
                           "the editor took \(blank.debugDescription) for a name")
        }
        XCTAssertNil(Finish.keepRefusal(name: "Tuesday", failure: nil),
                     "a named routine is refused nothing")
    }

    // The keep is the one thing the receipt does that writes, so it is the one thing the receipt owes
    // an answer for — the same answer on both phones, since the room's own line is behind the sheet
    // on each of them. Android's `Finish.keptAs` to the byte, stop included.
    func testAKeptRoutineIsConfirmedInTheWordsBothPhonesUse() {
        XCTAssertEqual(Finish.keptAs("Tuesday"), "Kept as Tuesday.")
        XCTAssertEqual(Finish.keptAs("  Tuesday\n"), "Kept as Tuesday.",
                       "the confirmation reads back the padding the log never stored")
    }

    // The card never says two things at once, and the empty field wins: it is why the button is
    // dead right now, where a refusal the log raised is about a name that has since been cleared —
    // and Save being dead is what makes that older one unrepeatable.
    func testTheEmptyFieldBeatsARefusalTheLogRaisedBeforeItWasCleared() {
        let refused = "the log didn’t answer — the routine wasn’t kept"
        XCTAssertEqual(Finish.keepRefusal(name: "Tuesday", failure: refused), refused)
        XCTAssertEqual(Finish.keepRefusal(name: "", failure: refused), RoutineDraft.nameItToSaveIt)
    }

    // A name minted on the receipt is bounded the way a name minted in the editor is: sixty CODE
    // POINTS, `RoutineDraft.capped`'s own rule. The fixture is what tells the three units apart —
    // one thing on screen, five code points, six UTF-16 units — so a field capped at sixty graphemes
    // would take all thirteen of them and one capped at sixty UTF-16 units would have cut at ten.
    func testTheReceiptsRoutineNameTakesTheRoomsCapCountedInCodePoints() throws {
        let twelve = String(repeating: "\u{1F3CB}\u{FE0F}\u{200D}\u{2640}\u{FE0F}", count: 12)
        let thirteen = String(repeating: "\u{1F3CB}\u{FE0F}\u{200D}\u{2640}\u{FE0F}", count: 13)
        XCTAssertEqual(thirteen.count, 13, "thirteen graphemes, which a grapheme cap would keep whole")
        XCTAssertEqual(thirteen.unicodeScalars.count, 65)
        XCTAssertEqual(twelve.utf16.count, 72, "seventy-two UTF-16 units: that cap would cut at ten")
        XCTAssertEqual(RoutineDraft.capped(thirteen), twelve, "sixty code points is the room's cap")

        let screen = try Self.source
        let field = try XCTUnwrap(screen.range(of: "TextField(\"\", text: $routineName)"),
                                  "the receipt's name field moved")
        XCTAssertNotNil(screen.range(of: "let kept = RoutineDraft.capped(typed)",
                                     range: field.upperBound..<screen.endIndex),
                        "the receipt's field caps by the editor's rule and not by a number of its own")
        XCTAssertFalse(screen.contains("RoutineDraft.counter"),
                       "and takes no counter with it: the counter earns its place on the surface a "
                       + "lifter works a name on, and a receipt mints one in passing")
    }

    // The alarm ink is for a write that failed and for nothing else (`GymSkin`). This one slot carries
    // both refusals, so the ink follows the same predicate the sentence does: the empty name is faint,
    // and only the log's own refusal is the alarm.
    func testTheEmptyNameIsFaintAndOnlyTheLogsRefusalIsTheAlarm() throws {
        let screen = try Self.source
        XCTAssertNotNil(screen.range(of: "ink: unnamed ? skin.inkFaint : skin.alarmInk"),
                        "a form that is not finished has sent nothing and been refused nothing")
    }

    private static var source: String {
        get throws { try gymSource("FinishScreen.swift") }
    }
}

func gymSource(_ file: String) throws -> String {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/WindmillGym/\(file)")
    return try String(contentsOf: url, encoding: .utf8)
}

final class DiscardTests: XCTestCase {
    // The confirmation is gone with the thing it was defending: discarding is withheld for nine
    // seconds and taken back on the transient, so the screen asks nothing and promises nothing.
    func testDiscardAsksNothingAndSaysNothingItCannotUndo() {
        XCTAssertEqual(Finish.Discard.action, "Discard session")
        XCTAssertEqual(WithheldWords.session, "Session deleted.")
        XCTAssertEqual(WithheldWords.undo, "Undo")
    }

    // The receipt itself carries no discard and no `Keep it`: the session detail page and the log
    // row's menu draw the discard, so the gesture still has a drawn door beside it (Law 1).
    func testTheReceiptDrawsNeitherHalfOfTheOldDecidedPair() throws {
        let screen = try gymSource("FinishScreen.swift")
        XCTAssertFalse(screen.contains("\"Keep it\""))
        XCTAssertFalse(screen.contains("Finish.Discard.action, action:"),
                       "the receipt draws a discard of its own again")
        XCTAssertTrue(try gymSource("SessionScreen.swift").contains("Finish.Discard.action"),
                      "the session detail page is where the discard is drawn")
    }
}

// The receipt's one primary hands the closed workout to Coach. The bytes are Android's exactly, the
// caption's quotes are canon's typographic ones, and the question carries its period: the thread is
// titled by it verbatim.
final class FinishCoachTests: XCTestCase {
    func testTheFourConstantsAreTheOnesBothPhonesPin() {
        XCTAssertEqual(FinishCoach.action, "Share with Coach")
        XCTAssertEqual(FinishCoach.caption,
                       "Sends Coach one line — “Check my last session.” — and opens the answer.")
        XCTAssertEqual(FinishCoach.question, "Check my last session.")
        XCTAssertEqual(Finish.head(startedAtMs: 0, finishedAtMs: 0, routine: nil,
                                   slight: false, first: false).title, "Well done.")
        XCTAssertEqual(Finish.head(startedAtMs: 0, finishedAtMs: 0, routine: nil,
                                   slight: true, first: false).title, "Ended early.")
    }

    func testTheCaptionQuotesTheQuestionItSendsAndNothingElseNamesASessionId() {
        XCTAssertTrue(FinishCoach.caption.contains("“\(FinishCoach.question)”"))
        XCTAssertFalse(FinishCoach.question.contains("ses_"), "no session id travels with the line")
        XCTAssertFalse(FinishCoach.caption.contains("\""), "straight quotes are not canon's")
    }

    // The tap is a sequence of the room's own `@State` writes, which no harness can host, so the
    // order is pinned off the source: the sheet comes down, the same reset the thread list's door
    // performs, and then the one line through the room's ONE send path. The question is placed
    // waiting before the task starts (`AskConversation.open`, proved in `AskConversationTests`), so
    // the Coach tab shows it the instant it shows at all.
    func testTheTapDismissesThenResetsThenSendsTheOneLineThroughTheOneSendPath() throws {
        let room = try gymSource("GymRoom.swift")
        let handler = try XCTUnwrap(room.range(of: "private func shareWithCoach() {"),
                                    "the receipt's primary has no handler in the room")
        let dismiss = try XCTUnwrap(room.range(of: "finished = nil", range: handler.upperBound..<room.endIndex))
        let reset = try XCTUnwrap(room.range(of: "askSomethingNew()", range: dismiss.upperBound..<room.endIndex))
        let send = try XCTUnwrap(room.range(of: "ask(FinishCoach.question, replacing: nil)",
                                            range: reset.upperBound..<room.endIndex))
        XCTAssertLessThan(dismiss.lowerBound, reset.lowerBound)
        XCTAssertLessThan(reset.lowerBound, send.lowerBound)

        let fresh = try XCTUnwrap(room.range(of: "private func askSomethingNew() {"))
        for line in ["conversation = AskConversation()", "paths[.ask] = []", "tab = .ask"] {
            XCTAssertNotNil(room.range(of: line, range: fresh.upperBound..<send.lowerBound),
                            "the reset the receipt reuses no longer \(line)")
        }

        XCTAssertEqual(room.components(separatedBy: "gym.ask(").count, 2,
                       "the wire is reached from exactly one place in the room")
        XCTAssertFalse(try gymSource("AskScreen.swift").contains("gym.ask("),
                       "the screen sends nothing of its own; it asks the room to")
        XCTAssertFalse(try gymSource("AskScreen.swift").contains("closesTheDoor"),
                       "refusal handling lives on the one send path, not in the screen too")
    }

    // Drawn only when Coach can be reached, and "reached" is spelled once in the room: the Coach tab
    // mounts its screen on `coachReachable` and the receipt draws its primary on the same name, so
    // the two cannot drift. When it cannot be reached, nothing stands in its place.
    func testThePrimaryAndTheCoachTabReadOnePredicate() throws {
        let room = try gymSource("GymRoom.swift")
        let sheet = try XCTUnwrap(room.range(of: ".sheet(item: $finished"))
        XCTAssertNotNil(room.range(of: "onShareWithCoach: coachReachable ? shareWithCoach : nil",
                                   range: sheet.upperBound..<room.endIndex))

        let tab = try XCTUnwrap(room.range(of: "case .ask:\n                if coachReachable {\n"))
        XCTAssertNotNil(room.range(of: "AskScreen(store: store, conversation: $conversation",
                                   range: tab.upperBound..<room.endIndex))
        XCTAssertNotNil(room.range(of: "private var coachReachable: Bool {\n        account.isSignedIn && askOnThisDeployment\n    }"))
    }

    // The sheet stays tappable while it animates down, so the hand-off is one-shot per receipt:
    // armed on the tap, cleared only when the sheet is down.
    func testASecondTapWhileTheSheetIsComingDownHandsOffNothing() throws {
        let room = try gymSource("GymRoom.swift")
        let handler = try XCTUnwrap(room.range(of: "private func shareWithCoach() {"))
        let guarded = try XCTUnwrap(room.range(of: "guard !handingToCoach else { return }",
                                               range: handler.upperBound..<room.endIndex))
        let armed = try XCTUnwrap(room.range(of: "handingToCoach = true", range: guarded.upperBound..<room.endIndex))
        XCTAssertNotNil(room.range(of: "finished = nil", range: armed.upperBound..<room.endIndex))
        XCTAssertTrue(room.contains("onDismiss: { finishFailure = nil; handingToCoach = false }"),
                      "the flag is cleared when the sheet is down and nowhere earlier")
    }
}

final class FinishedSessionTests: XCTestCase {
    private func session(routineId: String?) -> Session {
        Session(id: "ses_1", startedAtMs: 1_000, finishedAtMs: 900_000, routineId: routineId)
    }

    private let lifted = [TrainingSet(id: "set_1", exerciseId: "back-squat", weightKg: 100, reps: 5,
                                      completedAtMs: 2_000)]

    func testKeepingASessionAsARoutineIsOfferedOnlyWhenThereWasNoRoutine() {
        XCTAssertTrue(FinishedSession(session: session(routineId: nil), sets: lifted,
                                      review: nil, isFirst: true).offersRoutine)
        XCTAssertFalse(FinishedSession(session: session(routineId: "rt_1"), sets: lifted,
                                       review: nil, isFirst: false).offersRoutine)
    }

    func testASessionOfNothingButWarmupsIsNotOfferedAsARoutine() {
        let warmups = [TrainingSet(id: "set_1", exerciseId: "back-squat", weightKg: 60, reps: 5,
                                   kind: .warmup, completedAtMs: 2_000)]
        XCTAssertFalse(FinishedSession(session: session(routineId: nil), sets: warmups,
                                       review: nil, isFirst: true).offersRoutine)
    }

    func testAShortSessionIsNeverAlsoOfferedAsARoutine() {
        let short = Review(stats: Review.Stats(durationMs: 660_000, workingSets: 3), slight: true)
        let ended = FinishedSession(session: session(routineId: nil), sets: lifted,
                                    review: short, isFirst: true)

        XCTAssertTrue(ended.slight)
        XCTAssertFalse(ended.offersRoutine,
                       "too slight to say anything about is too slight to keep as a routine")
        XCTAssertEqual(Finish.head(startedAtMs: 1_000, finishedAtMs: 900_000, routine: nil,
                                   slight: ended.slight, first: ended.isFirst).title, "Ended early.")
    }

    func testWithoutAReviewASessionIsNeverCalledShort() {
        XCTAssertFalse(FinishedSession(session: session(routineId: nil), sets: lifted,
                                       review: nil, isFirst: false).slight)

        let short = Review(stats: Review.Stats(durationMs: 660_000, workingSets: 3), slight: true)
        XCTAssertTrue(FinishedSession(session: session(routineId: nil), sets: lifted,
                                      review: short, isFirst: false).slight)
    }
}
