import XCTest
@testable import WindmillGym

// What the routine editor and its target sheet SAY, pinned in their bytes: the one refusal a sheet of
// three broken fields computes and the order it computes it in, the two sentences an open line is
// refused with, the one sentence a list of open rows draws, the name field's counter, and the two
// Save refusals.
//
// A sentence that drifts by a hyphen, a full stop or a straight quote is a different sentence on a
// surface that is supposed to say the same thing as the other two.
final class RoutineEditorCopyTests: XCTestCase {

    // ── C5 · one refusal for the sheet ──────────────────────────────────────────────────────────

    func testTheSheetComputesOneRefusalInTheOrderShapeThenSetsThenRepsThenWeight() {
        // Illegal shape first: the fields below it are nonsense until the line has a shape.
        XCTAssertEqual(TargetEntry.refusal(sets: "", reps: "101", weight: "501"),
                       TargetEntry.Refusal(field: .sets, said: TargetEntry.nameSetsFirst))
        // Then the fields, topmost first, and never two at once.
        XCTAssertEqual(TargetEntry.refusal(sets: "21", reps: "101", weight: "501"),
                       TargetEntry.Refusal(field: .sets, said: TargetEntry.outOfSetsBand))
        XCTAssertEqual(TargetEntry.refusal(sets: "3", reps: "101", weight: "501"),
                       TargetEntry.Refusal(field: .reps, said: TargetEntry.outOfRepsBand))
        XCTAssertEqual(TargetEntry.refusal(sets: "3", reps: "5", weight: "501"),
                       TargetEntry.Refusal(field: .weight, said: TargetEntry.overWeight))
        XCTAssertNil(TargetEntry.refusal(sets: "3", reps: "5", weight: "82.5"))
        XCTAssertNil(TargetEntry.refusal(sets: "", reps: "", weight: ""),
                     "three empty fields are the open line, which is a target and not a fault")
    }

    // The refused KEYSTROKE outranks the state it left behind: the lifter is told what they just did.
    func testARefusedClearIsSaidBeforeAnythingTheFieldsSay() {
        XCTAssertEqual(TargetEntry.refusal(sets: "", reps: "5", weight: "", clearRefused: true),
                       TargetEntry.Refusal(field: .sets, said: TargetEntry.clearOthersFirst))
        XCTAssertEqual(TargetEntry.refusal(sets: "3", reps: "5", weight: "", clearRefused: true),
                       TargetEntry.Refusal(field: .sets, said: TargetEntry.clearOthersFirst))
    }

    // The second way into an open line, and the opposite remedy: telling a lifter to clear what they
    // just typed would be telling them to abandon what they asked for.
    func testALineThatArrivedOpenRefusesATypedNumberByNameRatherThanByClear() {
        XCTAssertEqual(TargetEntry.nameSetsFirst, "Name the sets first — an open line names neither.")
        XCTAssertEqual(TargetEntry.clearOthersFirst,
                       "Clear reps and weight first — an open line names neither.")

        for (reps, weight) in [("8", ""), ("", "82.5"), ("8", "82.5")] {
            XCTAssertEqual(TargetEntry.refusal(sets: "", reps: reps, weight: weight),
                           TargetEntry.Refusal(field: .sets, said: TargetEntry.nameSetsFirst),
                           "reps \(reps) · weight \(weight) landed on an open line without a word")
        }
    }

    // ── C1 · the open line's one sentence, and the one screen that draws it ─────────────────────

    // The target sheet says what `open` means the moment a line is opened; the two lists of a
    // routine's movements draw `open` in the target column and nothing beneath.
    func testTheOpenSentenceIsTheTargetSheetsAloneAndNoListDrawsIt() throws {
        XCTAssertEqual(TargetEntry.openLine, "You decide the numbers at the rack.")

        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym")
        let editor = try String(contentsOf: sources.appendingPathComponent("RoutineBuilderScreens.swift"),
                                encoding: .utf8)
        let sheet = try XCTUnwrap(editor.range(of: "private struct TargetSheet: View"))
        XCTAssertFalse(editor[..<sheet.lowerBound].contains("TargetEntry.openLine"),
                       "the editor's list draws the sentence beneath the movements")
        XCTAssertEqual(editor[sheet.upperBound...].components(separatedBy: "Text(TargetEntry.openLine)").count - 1, 1,
                       "the sheet draws it once")
        let routine = try String(contentsOf: sources.appendingPathComponent("RoutineScreen.swift"), encoding: .utf8)
        XCTAssertFalse(routine.contains("TargetEntry.openLine"), "the saved routine's screen draws it too")
    }

    // ── C8 · the counter is chrome a short name never carries ───────────────────────────────────

    func testTheNameCounterIsSilentUntilTheLastFifth() {
        XCTAssertNil(RoutineDraft.counter("Heavy Thursday"))
        XCTAssertNil(RoutineDraft.counter(""))
        XCTAssertNil(RoutineDraft.counter(String(repeating: "a", count: 47)))
        XCTAssertEqual(RoutineDraft.counter(String(repeating: "a", count: 48)), "48/60")
        XCTAssertEqual(RoutineDraft.counter(String(repeating: "a", count: 53)), "53/60")
        XCTAssertEqual(RoutineDraft.counterFromCharacters, 48)
    }

    // This field has ONE bound, so it has one threshold, and bytes are never the unit: the store's
    // ceiling is 240 BYTES and sixty Cyrillic characters weigh 120. A name that weighs more than it
    // reads is silent and uncut exactly like the Latin one of the same length.
    func testTheCounterWatchesLettersAndNeverTheBytesTheyWeigh() {
        let heavy = String(repeating: "я", count: 33)
        XCTAssertEqual(heavy.utf8.count, 66)
        XCTAssertNil(RoutineDraft.counter(heavy), "33 letters is below the last fifth, whatever it weighs")

        let long = String(repeating: "я", count: 45)
        XCTAssertEqual(long.utf8.count, 90)
        XCTAssertEqual(RoutineDraft.capped(long), long, "no byte bound cuts this name short")

        XCTAssertEqual(RoutineDraft.counter(String(repeating: "я", count: 48)), "48/60")
        XCTAssertEqual(RoutineDraft.counter(String(repeating: "я", count: 60)), "60/60",
                       "the denominator is the one cap there is")
    }

    // ── C4 · the two Save refusals ──────────────────────────────────────────────────────────────

    func testTheTwoSaveRefusalsComeOneAtATimeInTheOrderTheEditorMeetsThem() {
        XCTAssertEqual(RoutineDraft.nameItToSaveIt, "Name it to save it.")
        XCTAssertEqual(RoutineDraft.atLeastOneMovement, "A routine is at least one movement.")

        var draft = RoutineDraft(position: 0)
        XCTAssertEqual(draft.saveRefusal, RoutineDraft.nameItToSaveIt,
                       "no screen before the editor asked for a name, so the name is first")
        XCTAssertFalse(draft.isSavable)

        draft.name = "Heavy Thursday"
        XCTAssertEqual(draft.saveRefusal, RoutineDraft.atLeastOneMovement)
        XCTAssertFalse(draft.isSavable)

        draft.add("back-squat")
        XCTAssertNil(draft.saveRefusal)
        XCTAssertTrue(draft.isSavable)

        draft.name = "   "
        XCTAssertEqual(draft.saveRefusal, RoutineDraft.nameItToSaveIt,
                       "whitespace is not a name, and it is the first thing missing again")
    }
}
