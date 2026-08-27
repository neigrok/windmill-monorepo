import XCTest
@testable import WindmillGym

// A set's rating and its note: the wire shape, the local bound, and the line the session row prints.
// The wire rule is the load-bearing half — the log has no concurrency guard, so a fix that posted
// its whole state would silently overwrite whatever another device wrote since.
final class SetRecordTests: XCTestCase {
    private let stored = TrainingSet(id: "set_1", exerciseId: "bench-press", setNumber: 2,
                                     weightKg: 100, reps: 4, kind: .working, rpe: 8.5,
                                     note: "felt heavy", completedAtMs: 3_000)

    private func wire(_ fix: SetFix) throws -> [String: Any] {
        let encoded = try JSONEncoder().encode(fix)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    }

    func testAFixSendsOnlyWhatTheLifterMoved() throws {
        let untouched = SetFix(of: stored, weightKg: 100, reps: 4, kind: .working,
                               rpe: 8.5, note: "felt heavy")
        XCTAssertTrue(untouched.isEmpty)
        XCTAssertEqual(try wire(untouched).count, 0, "nothing moved, so nothing is named")

        let heavier = SetFix(of: stored, weightKg: 102.5, reps: 4, kind: .working,
                             rpe: 8.5, note: "felt heavy")
        let sent = try wire(heavier)
        XCTAssertEqual(Array(sent.keys), ["weightKg"])
        XCTAssertEqual(sent["weightKg"] as? Double, 102.5)
    }

    func testClearingANoteSendsAnEmptyStringAndNotTouchingItSendsNothing() throws {
        let cleared = SetFix(of: stored, weightKg: 100, reps: 4, kind: .working, rpe: 8.5, note: "")
        let sent = try wire(cleared)
        XCTAssertEqual(Array(sent.keys), ["note"])
        XCTAssertEqual(sent["note"] as? String, "", "an empty note is the clear; null is a type error")

        let kept = SetFix(of: stored, weightKg: 100, reps: 4, kind: .drop, rpe: 8.5, note: "felt heavy")
        XCTAssertFalse(try wire(kept).keys.contains("note"))
    }

    func testClearingARatingNamesItNullAndKeepingItNamesItNotAtAll() throws {
        let cleared = SetFix(of: stored, weightKg: 100, reps: 4, kind: .working, rpe: nil,
                             note: "felt heavy")
        let sent = try wire(cleared)
        XCTAssertEqual(Array(sent.keys), ["rpe"])
        XCTAssertTrue(sent["rpe"] is NSNull, "named and empty is what clears a rating")

        let kept = SetFix(of: stored, weightKg: 90, reps: 4, kind: .working, rpe: 8.5,
                          note: "felt heavy")
        XCTAssertFalse(try wire(kept).keys.contains("rpe"))
    }

    func testARatingSetForTheFirstTimeRidesAsANumber() throws {
        let unrated = TrainingSet(id: "set_2", exerciseId: "bench-press", weightKg: 60, reps: 10,
                                  completedAtMs: 4_000)
        let rated = SetFix(of: unrated, weightKg: 60, reps: 10, kind: .working, rpe: 7, note: "")
        let sent = try wire(rated)
        XCTAssertEqual(Array(sent.keys), ["rpe"])
        XCTAssertEqual(sent["rpe"] as? Double, 7)
    }

    // The queue replays the row this device holds rather than a diff against a copy nobody kept.
    func testAReplayedFixNamesEveryFieldOfTheRowThisDeviceHolds() throws {
        let sent = try wire(SetFix(whole: stored))
        XCTAssertEqual(Set(sent.keys), ["weightKg", "reps", "kind", "note", "rpe"])
        XCTAssertEqual(sent["weightKg"] as? Double, 100)
        XCTAssertEqual(sent["reps"] as? Int, 4)
        XCTAssertEqual(sent["kind"] as? String, "working")
        XCTAssertEqual(sent["note"] as? String, "felt heavy")
        XCTAssertEqual(sent["rpe"] as? Double, 8.5)
    }

    func testAnOmittedFieldLeavesTheStoredValueStanding() {
        XCTAssertEqual(stored.corrected(by: SetFix(reps: 5)),
                       TrainingSet(id: "set_1", exerciseId: "bench-press", setNumber: 2,
                                   weightKg: 100, reps: 5, kind: .working, rpe: 8.5,
                                   note: "felt heavy", completedAtMs: 3_000))
        XCTAssertEqual(stored.corrected(by: SetFix(note: "", rpeNamed: true, rpe: nil)),
                       TrainingSet(id: "set_1", exerciseId: "bench-press", setNumber: 2,
                                   weightKg: 100, reps: 4, kind: .working, rpe: nil,
                                   note: "", completedAtMs: 3_000))
    }

    // The server's 400 is the generic `could not read that fix`, so this sentence is the only one a
    // lifter will ever read about the bound.
    func testANoteOverTheServersBoundIsRefusedHereInBytes() {
        XCTAssertEqual(SetRecord.maxNoteBytes, 4_000)
        XCTAssertNil(SetRecord.refusal(note: String(repeating: "a", count: 4_000)))
        XCTAssertEqual(SetRecord.refusal(note: String(repeating: "a", count: 4_001)),
                       "A set note runs to 4000 bytes.")
        // Bytes, not characters: a Cyrillic note is two bytes a letter and the column counts bytes.
        XCTAssertEqual(SetRecord.refusal(note: String(repeating: "я", count: 2_001)),
                       "A set note runs to 4000 bytes.")
        XCTAssertNil(SetRecord.refusal(note: String(repeating: "я", count: 2_000)))
    }

    func testTheCounterAppearsOnlyInTheLastFifthOfTheBound() {
        XCTAssertNil(SetRecord.counter(bytes: 3_199))
        XCTAssertEqual(SetRecord.counter(bytes: 3_200), "3200 of 4000 bytes")
        XCTAssertEqual(SetRecord.counter(bytes: 4_001), "4001 of 4000 bytes",
                       "the counter keeps counting past the bound, like the note editor's")
    }

    // A byte counter over its bound goes alarm wherever it is drawn. The note editor one screen away
    // already does it, and the fix sheet used to swallow the counter whole and print the refusal
    // alone — one room with two rules for one shape.
    func testTheCounterGoesAlarmOverTheBoundAndTheCaptionStandsDownForIt() {
        XCTAssertEqual(SetRecord.foot(note: "felt heavy"),
                       SetRecord.Foot(counter: nil, refusal: nil,
                                      caption: "A record for you — not an instruction to Coach."))
        XCTAssertFalse(SetRecord.foot(note: "felt heavy").alarms)

        let nearly = SetRecord.foot(note: String(repeating: "a", count: 4_000))
        XCTAssertEqual(nearly, SetRecord.Foot(counter: "4000 of 4000 bytes", refusal: nil,
                                              caption: nil))
        XCTAssertFalse(nearly.alarms, "at the bound it is still within it")

        let over = SetRecord.foot(note: String(repeating: "a", count: 4_001))
        XCTAssertEqual(over, SetRecord.Foot(counter: "4001 of 4000 bytes",
                                            refusal: "A set note runs to 4000 bytes.",
                                            caption: nil))
        XCTAssertTrue(over.alarms, "the counter over the bound is drawn quiet")
    }

    func testTheRatingsAreSixToTenByHalves() {
        XCTAssertEqual(SetRecord.ratings, [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10])
        XCTAssertEqual(SetRecord.ratings.map(Readout.rpe),
                       ["6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10"])
    }

    func testTheSessionRowPrintsWhatTheLifterWroteAndNothingWhenTheyWroteNothing() {
        XCTAssertEqual(Performed.said(of: stored), "RPE 8.5 · felt heavy")
        XCTAssertEqual(Performed.said(of: stored.corrected(by: SetFix(note: ""))), "RPE 8.5")
        XCTAssertEqual(Performed.said(of: stored.corrected(by: SetFix(rpeNamed: true, rpe: nil))),
                       "felt heavy")
        XCTAssertNil(Performed.said(of: stored.corrected(by: SetFix(note: "", rpeNamed: true, rpe: nil))))
        XCTAssertEqual(Performed.said(of: stored.corrected(by: SetFix(note: "  felt heavy  "))),
                       "RPE 8.5 · felt heavy", "a note is printed trimmed, never padded")
        let blank = stored.corrected(by: SetFix(note: "   ", rpeNamed: true, rpe: nil))
        XCTAssertNil(Performed.said(of: blank), "whitespace is not a record")
    }

    func testTheRowCarriesTheRecordThroughTheGrouping() {
        let rows = Performed.movements([stored], catalog: []).flatMap(\.rows)
        XCTAssertEqual(rows.map(\.said), ["RPE 8.5 · felt heavy"])
    }

    func testTheCaptionSaysWhoTheNoteIsFor() {
        XCTAssertEqual(SetRecord.noteField, "Set note")
        XCTAssertEqual(SetRecord.noteCaption, "A record for you — not an instruction to Coach.")
    }

    // Four sentences this surface minted for states no brief covered, pinned to the byte so the
    // three surfaces cannot drift into four spellings of the same fact.
    func testTheMintedSentencesAreOneSpellingEach() {
        XCTAssertEqual(SetRecord.noteTooLong, "A set note runs to 4000 bytes.")
        // The unrated seat is a word, never a bare dash: a dash is read out as nothing.
        XCTAssertEqual(SetRecord.rpeUnrated, "Not rated")
        XCTAssertFalse(SetRecord.rpeUnrated.contains("—"))
        XCTAssertFalse(SetRecord.rpeUnrated.contains("-"))
        XCTAssertEqual(LiveLines.oneWalkAtATime("Back Squat"),
                       "Back Squat first — that question is still open.")
        // Said at the moment of the act, and it is the DETAIL beside `Conversation deleted.`,
        // never folded into the sentence itself.
        XCTAssertEqual(WithheldWords.threadDetail,
                       "a change you applied stays in the routine’s history")
        XCTAssertFalse(WithheldWords.thread.contains(WithheldWords.threadDetail))
    }
}
