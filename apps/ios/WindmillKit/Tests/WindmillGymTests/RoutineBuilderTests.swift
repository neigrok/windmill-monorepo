import XCTest
@testable import WindmillGym

final class RoutineDraftTests: XCTestCase {
    func testAMovementIsAddedOpenAndTheDraftIsStillSavable() {
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        draft.add("deadlift")
        XCTAssertEqual(draft.lines.count, 1)
        XCTAssertEqual(draft.entries[0].sets, [])
        XCTAssertTrue(draft.entries[0].isOpen)
        XCTAssertTrue(draft.isSavable, "rows with no targets ask at the rack — they do not block Save")
    }

    func testANameIsRequiredAndAMovementIsRequiredAndNothingElseIs() {
        XCTAssertFalse(RoutineDraft(name: "  \n ", entries: [.init(exerciseId: "deadlift")],
                                    position: 0).isSavable)
        XCTAssertFalse(RoutineDraft(name: "Heavy Thursday", position: 0).isSavable)
        XCTAssertTrue(RoutineDraft(name: " Heavy Thursday ",
                                   entries: [.init(exerciseId: "deadlift")], position: 0).isSavable)
    }

    // An empty scheme is the open line: the whole target goes, and rest stays.
    func testSettingAnEmptySchemeLeavesTheLineOpenAndKeepsItsRest() {
        var draft = RoutineDraft(name: "Heavy Thursday",
                                 entries: [.init(exerciseId: "deadlift", restSeconds: 180)], position: 0)
        let line = draft.lines[0].id
        draft.set(line, sets: Array(repeating: SetTarget(reps: 5, weightKg: 140), count: 3))
        XCTAssertEqual(draft.entries[0].sets, Array(repeating: SetTarget(reps: 5, weightKg: 140), count: 3))
        XCTAssertEqual(draft.entries[0].restSeconds, 180)

        draft.set(line, sets: [])
        XCTAssertEqual(draft.entries[0], RoutineWrite.Entry(exerciseId: "deadlift", restSeconds: 180))
        XCTAssertTrue(draft.entries[0].isOpen)
    }

    func testACommitCarriesTheAbsencesRatherThanFillingThem() throws {
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        let line = draft.add("chin-up")
        draft.set(line.id, sets: Array(repeating: SetTarget(), count: 3))
        XCTAssertFalse(draft.entries[0].isOpen, "no reps is `3 × max`, which is a target and not an open row")
        XCTAssertEqual(Readout.target(draft.entries[0].sets), "3 × max")

        let body = try XCTUnwrap(String(data: JSONEncoder().encode(draft.write), encoding: .utf8))
        XCTAssertTrue(body.contains(#""sets":[{},{},{}]"#), "three sets naming nothing, never a null")
    }

    func testARowOpenedAndCommittedUntouchedComesBackTheWayItWentIn() {
        var draft = RoutineDraft(name: "Heavy Thursday",
                                 entries: [.init(exerciseId: "back-squat", sets: Array(repeating: SetTarget(reps: 5), count: 5)),
                                           .init(exerciseId: "chin-up", sets: Array(repeating: SetTarget(), count: 3))],
                                 position: 0)
        let opened = draft
        for line in draft.lines {
            let sheet = TargetEntry.Draft(line.entry.sets)
            draft.set(line.id, sets: sheet.scheme ?? [])
        }
        XCTAssertEqual(draft, opened)
    }

    func testEditKeepsTheIdAndPosition() {
        let routine = Routine(id: "rt_1", name: "Heavy Thursday", position: 2,
                              entries: [RoutineEntry(position: 1, exerciseId: "deadlift",
                                                     sets: Array(repeating: SetTarget(reps: 5, weightKg: 140), count: 3))])
        let edit = RoutineDraft(editing: routine)
        XCTAssertEqual(edit.id, "rt_1")
        XCTAssertEqual(edit.position, 2)
        XCTAssertEqual(edit.name, "Heavy Thursday")
        XCTAssertEqual(edit.entries.map(\.exerciseId), ["deadlift"])
        XCTAssertEqual(edit.entries.map(\.sets), [Array(repeating: SetTarget(reps: 5, weightKg: 140), count: 3)])
    }

    // The counter's silence below the last fifth is `RoutineEditorCopyTests`; this is what it counts
    // once it does speak.
    func testTheCounterIsCharactersAgainstTheClientsOwnCap() {
        XCTAssertNil(RoutineDraft.counter("Heavy Thursday"))
        XCTAssertNil(RoutineDraft.counter(""))
        XCTAssertNil(RoutineDraft.counter("Тяжёлый четверг"))
        XCTAssertEqual(RoutineDraft.counter("Heavy Thursday " + String(repeating: "a", count: 33)),
                       "48/60")
        XCTAssertEqual(RoutineDraft.maxNameLength, 60, "the board's bound, in the unit it is drawn in")
    }

    // The store's ceiling is 240 BYTES and sixty accented characters weigh 120, so an accent costs a
    // name nothing: it is bounded and counted in characters here exactly as on web and Android.
    func testAnAccentedNameGetsAllSixtyCharactersAndCountsAgainstSixty() {
        let accented = String(repeating: "ü", count: 60)
        XCTAssertEqual(accented.count, 60)
        XCTAssertEqual(accented.utf8.count, 120)

        XCTAssertEqual(RoutineDraft.capped(accented), accented, "no byte cuts a character off this name")
        XCTAssertEqual(RoutineDraft.counter(accented), "60/60")

        let draft = RoutineDraft(name: accented, entries: [.init(exerciseId: "deadlift")], position: 0)
        XCTAssertTrue(draft.isSavable)
        XCTAssertNil(draft.saveRefusal)
        XCTAssertEqual(draft.write.name, accented, "the whole name reaches the log, all 120 bytes of it")

        let overCap = String(repeating: "ü", count: 61)
        XCTAssertEqual(RoutineDraft.capped(overCap), accented, "the sixty-first character is the only one refused")
    }

    func testACyrillicNameIsBoundedAndCountedByItsLettersAlone() {
        let cyrillic = String(repeating: "я", count: 45)
        XCTAssertEqual(cyrillic.count, 45)
        XCTAssertEqual(cyrillic.utf8.count, 90)

        XCTAssertEqual(RoutineDraft.capped(cyrillic), cyrillic, "ninety bytes is not a bound this field has")
        XCTAssertNil(RoutineDraft.counter(cyrillic), "45 letters is below the last fifth, whatever it weighs")
        XCTAssertEqual(RoutineDraft.counter(String(repeating: "я", count: 48)), "48/60")
        XCTAssertEqual(RoutineDraft.counter(String(repeating: "я", count: 60)), "60/60")
        XCTAssertNil(RoutineDraft.counter(String(repeating: "я", count: 20)))
    }

    func testALatinNameIsCappedAtSixtyLettersAndCountsAgainstSixty() {
        let long = String(repeating: "a", count: 61)
        XCTAssertEqual(RoutineDraft.capped(long), String(repeating: "a", count: 60))
        XCTAssertEqual(RoutineDraft.counter(RoutineDraft.capped(long)), "60/60")
        XCTAssertEqual(RoutineDraft.capped("Heavy Thursday"), "Heavy Thursday")
    }

    // The cut is CODE POINTS, and this is the shape that tells that apart from anything else: one
    // lifter emoji is one thing on screen and five code points underneath, so sixty code points is
    // twelve of them. Cutting by what the eye counts would have let sixty of these through at 960
    // bytes, four times the store's 240; cutting by code points bounds the bytes by construction.
    func testTheCutIsCodePointsAndNeverHalvesOne() {
        let lifter = "🏋️‍♀️"
        XCTAssertEqual(lifter.unicodeScalars.count, 5)
        XCTAssertEqual(lifter.count, 1)

        let kept = RoutineDraft.capped(String(repeating: lifter, count: 61))
        XCTAssertEqual(kept.unicodeScalars.count, RoutineDraft.maxNameLength)
        XCTAssertEqual(kept, String(repeating: lifter, count: 12),
                       "sixty code points is twelve of these, kept whole off the front")
        XCTAssertEqual(kept.utf8.count, 192)
        XCTAssertLessThanOrEqual(kept.utf8.count, 240, "the cap bounds the bytes; what the eye counts never did")
    }

    // The suggestion chips died with the naming step: a lifter naming their own training block does
    // not need three guesses from us, and nothing validates a name against a list.
    func testAnyNameAtAllIsANameAndTheEditorProposesNone() {
        XCTAssertTrue(RoutineDraft(name: "the slanty one day",
                                   entries: [.init(exerciseId: "deadlift")], position: 0).isSavable)
    }

    func testThePlaceIsWhereYouAreInTheDayAndNotAStepCounter() {
        let draft = RoutineDraft(name: "Heavy Thursday",
                                 entries: [.init(exerciseId: "back-squat"),
                                           .init(exerciseId: "deadlift"),
                                           .init(exerciseId: "barbell-row"),
                                           .init(exerciseId: "chin-up")],
                                 position: 0)
        XCTAssertEqual(draft.place(of: draft.lines[1].id), "2 of 4 · Heavy Thursday")
    }
}

// The target sheet's typed fields and its draft: six refusals under the field or row that carries the
// fault, two bands that are not the logger's, a head that writes every row and a ladder that is hidden
// rather than thrown away.
final class TargetEntryTests: XCTestCase {
    func testAnEmptyFieldIsTheNullTargetAndNotARefusal() {
        for typed in ["", "   "] {
            XCTAssertNil(TargetEntry.readSets(typed).value)
            XCTAssertNil(TargetEntry.readSets(typed).refusal)
            XCTAssertNil(TargetEntry.readReps(typed).value)
            XCTAssertNil(TargetEntry.readReps(typed).refusal)
            XCTAssertNil(TargetEntry.readWeight(typed).value)
            XCTAssertNil(TargetEntry.readWeight(typed).refusal)
        }
        XCTAssertEqual(TargetEntry.setsPlaceholder, "open")
        XCTAssertEqual(TargetEntry.repsPlaceholder, "max")
        XCTAssertEqual(TargetEntry.weightPlaceholder, "last time")
    }

    func testASecondDecimalPointIsTheFirstRefusalATypistMeets() {
        XCTAssertEqual(TargetEntry.readWeight("10,2,5").refusal, "One decimal point only.")
        XCTAssertEqual(TargetEntry.readWeight("10.2.5").refusal, "One decimal point only.")
        XCTAssertEqual(TargetEntry.readReps("5.5.5").refusal, "One decimal point only.")
    }

    func testAnEntryThatIsNotYetANumberSaysSo() {
        XCTAssertEqual(TargetEntry.readWeight("-").refusal, "That is not a number yet.")
        XCTAssertEqual(TargetEntry.readWeight("12kg").refusal, "That is not a number yet.")
        XCTAssertEqual(TargetEntry.readSets(".").refusal, "That is not a number yet.")
    }

    // Both separators are taken, and nothing on the sheet has to say so.
    func testACommaAndAPointBothReadAsADecimal() {
        XCTAssertEqual(TargetEntry.readWeight("72,5").value, 72.5)
        XCTAssertEqual(TargetEntry.readWeight("72.5").value, 72.5)
    }

    func testALoadBeyondTheStoredRangeIsQuestionedAndABandAssistedOneIsNot() {
        XCTAssertEqual(TargetEntry.readWeight("501").refusal, "Over 500 kg — check the number.")
        XCTAssertEqual(TargetEntry.readWeight("500").value, 500)
        XCTAssertEqual(TargetEntry.readWeight("-20").value, -20)
        XCTAssertEqual(TargetEntry.readWeight("\u{2212}20").value, -20,
                       "the readout is typographic, so the field has to read its own minus back")
        XCTAssertNil(TargetEntry.readWeight("-501").value)
    }

    // 1–100 here, and 1–99 at the rack. Two fields, two screens, two named bands (ledger `2i`).
    func testTheRoutineTargetsRepsBandIsNotTheLiveLoggers() {
        XCTAssertEqual(TargetEntry.repsBand, 1...100)
        XCTAssertEqual(KeypadEntry.repsBand, 1...99)
        XCTAssertEqual(TargetEntry.readReps("100").value, 100)
        XCTAssertEqual(TargetEntry.readReps("101").refusal, "Whole reps, 1 to 100.")
        XCTAssertEqual(TargetEntry.readReps("7.5").refusal, "Whole reps, 1 to 100.")
        XCTAssertNil(KeypadEntry.read(KeypadEntry.Pad(opening: "100"), as: .reps, keeping: 5).value)
    }

    func testTheSetsBandIsTheDomainsOwn() {
        XCTAssertEqual(TargetEntry.setsBand, 1...20)
        XCTAssertEqual(TargetEntry.readSets("20").value, 20)
        XCTAssertEqual(TargetEntry.readSets("21").refusal, "Sets, 1 to 20.")
    }

    // A zero is not a small target, it is no target — and there is already a way to say that.
    func testATypedZeroPointsAtTheClearRatherThanTheBand() {
        XCTAssertEqual(TargetEntry.readSets("0").refusal,
                       "A zero target is no target — clear the field instead.")
        XCTAssertEqual(TargetEntry.readReps("0").refusal,
                       "A zero target is no target — clear the field instead.")
        XCTAssertEqual(TargetEntry.readWeight("0").refusal,
                       "A zero target is no target — clear the field instead.")
        XCTAssertEqual(TargetEntry.readWeight("0,0").refusal,
                       "A zero target is no target — clear the field instead.")
    }

    // Every refusal the six name is one sentence, ending in a full stop, and none of them is a hint.
    func testTheSixRefusalsAreThePinnedSentences() {
        XCTAssertEqual([TargetEntry.oneDecimalPoint, TargetEntry.notANumber, TargetEntry.overWeight,
                        TargetEntry.outOfRepsBand, TargetEntry.outOfSetsBand, TargetEntry.zeroTarget],
                       ["One decimal point only.",
                        "That is not a number yet.",
                        "Over 500 kg — check the number.",
                        "Whole reps, 1 to 100.",
                        "Sets, 1 to 20.",
                        "A zero target is no target — clear the field instead."])
    }

    // A typed load lands on the same grid the rack's ladder moves on.
    func testATypedWeightIsRoundedOnTheLaddersGrid() {
        XCTAssertEqual(TargetEntry.readWeight("102,505").value, 102.51)
    }

    private let ramp = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80),
                        SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100),
                        SetTarget(reps: 5, weightKg: 80)]

    // Ramp up: two typed ends and one tap; the loads between on their band's plate grid, reps to the
    // nearest whole. F10: 60 → 100 over 5 is 60/70/80/90/100; 20 → 22.5 over 3 puts 21.25 on the
    // 2.5 grid of its band, 22.5 — half away from zero, never to hundredths.
    func testRampUpInterpolatesRepsAndLoadFromSetOneToSetN() {
        let ends = [SetTarget(reps: 5, weightKg: 60), SetTarget(), SetTarget(), SetTarget(), SetTarget(reps: 1, weightKg: 100)]
        XCTAssertEqual(TargetEntry.rampUp(ends).map(\.weightKg), [60, 70, 80, 90, 100])
        XCTAssertEqual(TargetEntry.rampUp(ends).map(\.reps), [5, 4, 3, 2, 1])
        XCTAssertEqual(TargetEntry.rampUp([SetTarget(reps: 5, weightKg: 20), SetTarget(), SetTarget(reps: 5, weightKg: 22.5)]).map(\.weightKg),
                       [20, 22.5, 22.5])
        XCTAssertEqual(TargetEntry.rampUp([SetTarget(reps: 5, weightKg: -20), SetTarget(), SetTarget(reps: 5, weightKg: -22.5)]).map(\.weightKg),
                       [-20, -22.5, -22.5], "half away from zero below zero too")
        XCTAssertEqual(TargetEntry.rampUp([SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 8, weightKg: 70),
                                           SetTarget(reps: 1, weightKg: 100)]).map(\.weightKg), [60, 80, 100])
        XCTAssertEqual(TargetEntry.rampUp([SetTarget(reps: 8, weightKg: 60), SetTarget(), SetTarget(reps: 1, weightKg: 62)]).map(\.weightKg),
                       [60, 60, 62], "61 is not on the 2.5 grid; the typed ends stay as typed")
        XCTAssertEqual(TargetEntry.rampUp([SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 9, weightKg: 70), SetTarget(reps: 1)]).map(\.weightKg),
                       [60, 70, nil], "a column with an absent end is left as it is")
        XCTAssertEqual(TargetEntry.rampUp([SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 9, weightKg: 70), SetTarget(reps: 1)]).map(\.reps), [5, 3, 1])
        XCTAssertEqual(TargetEntry.rampUp([SetTarget(reps: 5, weightKg: 60)]), [SetTarget(reps: 5, weightKg: 60)])
    }

    // F6: two rows have nothing between their ends.
    func testRampUpNeedsThreeRows() {
        let two = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 1, weightKg: 100)]
        XCTAssertEqual(TargetEntry.rampUp(two), two)
        XCTAssertFalse(TargetEntry.Draft(two).canRamp)
        XCTAssertTrue(TargetEntry.Draft(two + [SetTarget(reps: 1, weightKg: 100)]).canRamp)
    }

    func testMatchSetOneWritesTheFirstRowIntoEveryRow() {
        XCTAssertEqual(TargetEntry.matchSetOne(ramp), Array(repeating: SetTarget(reps: 5, weightKg: 60), count: 5))
        XCTAssertEqual(TargetEntry.matchSetOne([]), [])
    }

    func testTheDraftOpensOnTheSchemeAndCommitsItBackUnchanged() {
        let draft = TargetEntry.Draft(ramp)
        XCTAssertEqual(draft.sets, "5")
        XCTAssertEqual(draft.ladder.map(\.reps), ["5", "5", "3", "1", "5"])
        XCTAssertEqual(draft.ladder.map(\.weight), ["60", "80", "90", "100", "80"])
        XCTAssertEqual(draft.headReps, "")
        XCTAssertEqual(draft.headWeight, "")
        XCTAssertEqual(draft.repsPlaceholder, "varies")
        XCTAssertEqual(draft.weightPlaceholder, "varies")
        XCTAssertEqual(draft.scheme, ramp)
        XCTAssertEqual(draft.commitLabel, "Set · 5 sets")
        XCTAssertTrue(draft.canRamp)

        let straight = TargetEntry.Draft(Array(repeating: SetTarget(reps: 8, weightKg: 60), count: 3))
        XCTAssertEqual(straight.headReps, "8")
        XCTAssertEqual(straight.headWeight, "60")
        XCTAssertEqual(straight.repsPlaceholder, "max")
        XCTAssertEqual(straight.weightPlaceholder, "last time")
        XCTAssertEqual(straight.commitLabel, "Set · 3 × 8 · 60")
        XCTAssertFalse(straight.canRamp, "set 1 and set n agree — nothing to ramp between")
    }

    func testSetsGrowsTheLadderByCopyingTheRowAboveAndNeverThrowsRowsAway() {
        var draft = TargetEntry.Draft(ramp)
        draft.typeSets("6")
        XCTAssertEqual(draft.scheme, ramp + [SetTarget(reps: 5, weightKg: 80)])

        draft.typeSets("1")
        XCTAssertEqual(draft.scheme, [SetTarget(reps: 5, weightKg: 60)])
        draft.typeSets("12")
        XCTAssertEqual(draft.scheme, ramp + Array(repeating: SetTarget(reps: 5, weightKg: 80), count: 7),
                       "typing 5 → 1 → 12 keeps rows 2–5 and copies row 5 into 6–12")

        var fresh = TargetEntry.Draft([])
        fresh.typeSets("3")
        XCTAssertEqual(fresh.scheme, Array(repeating: SetTarget(), count: 3))
        XCTAssertEqual(fresh.commitLabel, "Set · 3 × max")
    }

    func testAnEmptySetsHidesTheLadderWithoutDiscardingIt() {
        var draft = TargetEntry.Draft(ramp)
        draft.typeSets("")
        XCTAssertTrue(draft.isOpen)
        XCTAssertEqual(draft.ladder, [])
        XCTAssertEqual(draft.scheme, [])
        XCTAssertEqual(draft.commitLabel, "Set · open")
        XCTAssertNil(draft.refusal, "the open line is a target, not a fault")

        draft.typeSets("5")
        XCTAssertEqual(draft.scheme, ramp, "the ladder was hidden, not thrown away")
    }

    func testTheHeadWritesEveryRow() {
        var draft = TargetEntry.Draft(ramp)
        draft.typeReps("5")
        XCTAssertEqual(draft.ladder.map(\.reps), Array(repeating: "5", count: 5))
        XCTAssertEqual(draft.headReps, "5")
        XCTAssertEqual(draft.repsPlaceholder, "max")
        XCTAssertEqual(draft.headWeight, "", "the loads still disagree")
        draft.typeWeight("80")
        XCTAssertEqual(draft.scheme, Array(repeating: SetTarget(reps: 5, weightKg: 80), count: 5))
        XCTAssertEqual(draft.commitLabel, "Set · 5 × 5 · 80")
    }

    func testARowEditsThatSetAlone() {
        var draft = TargetEntry.Draft(Array(repeating: SetTarget(reps: 8, weightKg: 60), count: 3))
        draft.typeWeight("65", row: 2)
        draft.typeReps("6", row: 2)
        XCTAssertEqual(draft.scheme, [SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 6, weightKg: 65)])
        XCTAssertEqual(draft.headReps, "")
        XCTAssertEqual(draft.repsPlaceholder, "varies")
        XCTAssertEqual(draft.commitLabel, "Set · 3 sets")
    }

    func testAddSetCopiesTheLastRowAndIsInertAtTwenty() {
        var draft = TargetEntry.Draft(ramp)
        draft.addSet()
        XCTAssertEqual(draft.sets, "6")
        XCTAssertEqual(draft.scheme, ramp + [SetTarget(reps: 5, weightKg: 80)])

        var full = TargetEntry.Draft(Array(repeating: SetTarget(reps: 5, weightKg: 80), count: 20))
        full.addSet()
        XCTAssertEqual(full.ladder.count, 20)
        XCTAssertEqual(full.refusal, TargetEntry.Refusal(field: .addSet, said: "Sets, 1 to 20."))
        XCTAssertNil(full.scheme)
        XCTAssertEqual(full.commitLabel, "Set")
        full.typeReps("6", row: 0)
        XCTAssertNil(full.refusal, "any keystroke clears it")
    }

    // F3: a shrunken count hides rows and never discards them — Add set reveals the next hidden row,
    // a Delete takes one row out of the array, and the rows past the count are still there after both.
    func testAShrunkenCountKeepsItsHiddenRowsThroughAddSetAndDelete() {
        var draft = TargetEntry.Draft(ramp)
        draft.typeSets("1")
        draft.addSet()
        XCTAssertEqual(draft.sets, "2")
        XCTAssertEqual(draft.scheme, [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80)],
                       "Add set reveals row 2 rather than copying row 1")
        draft.typeSets("12")
        XCTAssertEqual(draft.scheme, ramp + Array(repeating: SetTarget(reps: 5, weightKg: 80), count: 7),
                       "5 → 1 → Add set → 12 keeps 60/80/90/100/80")

        var trimmed = TargetEntry.Draft(ramp)
        trimmed.typeSets("2")
        trimmed.delete(row: 0)
        XCTAssertEqual(trimmed.sets, "1")
        XCTAssertEqual(trimmed.scheme, [SetTarget(reps: 5, weightKg: 80)])
        trimmed.typeSets("4")
        XCTAssertEqual(trimmed.scheme, [SetTarget(reps: 5, weightKg: 80), SetTarget(reps: 3, weightKg: 90),
                                        SetTarget(reps: 1, weightKg: 100), SetTarget(reps: 5, weightKg: 80)],
                       "the delete took row 1 out and the hidden rows 3–5 moved up behind the count")

        var opened = TargetEntry.Draft(ramp)
        opened.typeSets("")
        opened.addSet()
        XCTAssertEqual(opened.scheme, [SetTarget(reps: 5, weightKg: 60)], "Add set on the open line reveals row 1")
    }

    func testDeletingARowDecrementsSetsAndDeletingTheLastLandsOnTheOpenLine() {
        var draft = TargetEntry.Draft(ramp)
        draft.delete(row: 2)
        XCTAssertEqual(draft.sets, "4")
        XCTAssertEqual(draft.scheme, [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 5, weightKg: 80),
                                      SetTarget(reps: 1, weightKg: 100), SetTarget(reps: 5, weightKg: 80)])

        var one = TargetEntry.Draft([SetTarget(reps: 8, weightKg: 60)])
        one.delete(row: 0)
        XCTAssertEqual(one.sets, "")
        XCTAssertTrue(one.isOpen)
        XCTAssertEqual(one.scheme, [])
        XCTAssertEqual(one.commitLabel, "Set · open")
    }

    func testRampUpAndMatchSetOneRewriteTheLadderInPlace() {
        var draft = TargetEntry.Draft([SetTarget(reps: 5, weightKg: 60), SetTarget(), SetTarget(), SetTarget(), SetTarget(reps: 1, weightKg: 100)])
        draft.rampUp()
        XCTAssertEqual(draft.ladder.map(\.weight), ["60", "70", "80", "90", "100"])
        XCTAssertEqual(draft.ladder.map(\.reps), ["5", "4", "3", "2", "1"])
        draft.matchSetOne()
        XCTAssertEqual(draft.scheme, Array(repeating: SetTarget(reps: 5, weightKg: 60), count: 5))
        XCTAssertFalse(draft.canRamp)
    }

    // The one refusal, under the field that carries the fault: the head when every row shares it,
    // the row when it was typed there; sets first, then the ladder top to bottom, reps before weight.
    // F7: while any refusal stands the commit reads `Set` and has nothing to commit.
    func testTheOneRefusalSitsUnderTheFieldThatCarriesTheFault() {
        var draft = TargetEntry.Draft(ramp)
        draft.typeSets("21")
        XCTAssertEqual(draft.refusal, TargetEntry.Refusal(field: .sets, said: "Sets, 1 to 20."))
        XCTAssertEqual(draft.scheme, nil)
        XCTAssertEqual(draft.ladder.count, 5, "an unreadable count leaves the rows alone")
        XCTAssertEqual(draft.commitLabel, "Set")

        draft.typeSets("5")
        XCTAssertEqual(draft.commitLabel, "Set · 5 sets")
        draft.typeReps("101", row: 2)
        XCTAssertEqual(draft.refusal, TargetEntry.Refusal(field: .rowReps(2), said: "Whole reps, 1 to 100."))
        XCTAssertEqual(draft.commitLabel, "Set")
        draft.typeWeight("501", row: 0)
        XCTAssertEqual(draft.refusal, TargetEntry.Refusal(field: .rowWeight(0), said: "Over 500 kg — check the number."),
                       "topmost first, and never two at once")

        var head = TargetEntry.Draft(Array(repeating: SetTarget(reps: 8, weightKg: 60), count: 3))
        head.typeReps("0")
        XCTAssertEqual(head.refusal, TargetEntry.Refusal(field: .reps, said: "A zero target is no target — clear the field instead."))
        XCTAssertEqual(head.commitLabel, "Set")
        head.typeReps("8")
        head.typeWeight("10.2.5")
        XCTAssertEqual(head.refusal, TargetEntry.Refusal(field: .weight, said: "One decimal point only."))
        XCTAssertEqual(head.commitLabel, "Set")
    }
}

final class RoutineReadoutTests: XCTestCase {
    private let catalog = [Exercise(id: "back-squat", name: "Back Squat"),
                           Exercise(id: "deadlift", name: "Deadlift"),
                           Exercise(id: "barbell-row", name: "Barbell Row")]

    private func routine(_ entries: [RoutineEntry], trained: Int64? = nil,
                         history: [RoutineEvent] = []) -> Routine {
        Routine(id: "rt_1", name: "Heavy Thursday", position: 1, lastTrainedAtMs: trained,
                entries: entries, history: history)
    }

    func testUntestedIsTheAbsenceOfALastTrainedStamp() {
        XCTAssertTrue(routine([]).isUntested)
        XCTAssertFalse(routine([], trained: 1_700_000_000_000).isUntested)
    }

    // The target column's `open` is what says which rows are open; the sentence about what that
    // means is the target sheet's (`RoutineEditorCopyTests`), and a list draws none.
    func testAnOpenRowIsOneThatNamesNoSets() {
        let named = routine([RoutineEntry(position: 1, exerciseId: "back-squat", sets: Array(repeating: SetTarget(reps: 3, weightKg: 110), count: 5)),
                             RoutineEntry(position: 2, exerciseId: "barbell-row")])
        XCTAssertEqual(named.entries.filter(\.isOpen).map(\.exerciseId), ["barbell-row"])

        let none = routine([RoutineEntry(position: 1, exerciseId: "back-squat", sets: Array(repeating: SetTarget(reps: 3, weightKg: 110), count: 5))])
        XCTAssertTrue(none.entries.filter(\.isOpen).isEmpty)
    }

    func testTheMetaDatesOffTheHistoryAndCountsWhatIsThereNow() {
        let now: Int64 = 1_700_000_000_000
        let built = routine([RoutineEntry(position: 1, exerciseId: "deadlift"),
                             RoutineEntry(position: 2, exerciseId: "barbell-row")],
                            history: [RoutineEvent(kind: .created, atMs: now, movements: 4)])
        XCTAssertEqual(RoutineReadout.meta(built, now: now), "built today · 2 movements")

        let shelved = routine([RoutineEntry(position: 1, exerciseId: "deadlift")])
        XCTAssertEqual(RoutineReadout.meta(shelved, now: now), "1 movement")
    }

    // Read off the other phone's source rather than off a copy of the sentence, so the two cannot
    // drift: no canon file holds these bytes for either surface to be checked against alone.
    func testTheUnreadHistoryLineIsTheOneTheOtherPhoneDraws() throws {
        XCTAssertEqual(RoutineReadout.historyOutOfReach,
                       "the log didn\u{2019}t answer — this routine\u{2019}s history is out of reach")
        XCTAssertEqual(TrainingStore.WriteFailure.refused("that routine is not yours to read")
                        .line(RoutineReadout.historySubject),
                       "that routine is not yours to read",
                       "a log that answered keeps its own sentence on both phones")
        let relative = "apps/android/gym/src/main/kotlin/works/windmill/gym/ui/RoutinesScreen.kt"
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var android = directory.appendingPathComponent(relative)
        while directory.path != "/", !FileManager.default.fileExists(atPath: android.path) {
            directory = directory.deletingLastPathComponent()
            android = directory.appendingPathComponent(relative)
        }
        guard FileManager.default.fileExists(atPath: android.path) else {
            return XCTFail("this suite reads the repo's \(relative); the whole monorepo has to be checked out")
        }
        let source = try String(contentsOf: android, encoding: .utf8)
        XCTAssertTrue(source.contains(RoutineReadout.historySubject),
                      "the other phone names the subject in different bytes")
    }

    func testTheCreatedRowReadsTheAbsenceOfADoorAsTheLiftersOwnHand() {
        let at: Int64 = 1_754_697_600_000       // 9 Aug 2025
        XCTAssertEqual(RoutineReadout.created(RoutineEvent(kind: .created, atMs: at, movements: 4)),
                       "\(Readout.date(at)) · created by you · 4 movements")
        XCTAssertEqual(RoutineReadout.created(RoutineEvent(kind: .created, atMs: at)),
                       "\(Readout.date(at)) · created by you")
        XCTAssertEqual(RoutineReadout.created(RoutineEvent(kind: .created, atMs: at, by: "mcp",
                                                           movements: 4)),
                       "\(Readout.date(at)) · created by your connected agent · 4 movements")
        XCTAssertEqual(RoutineReadout.created(RoutineEvent(kind: .created, atMs: at, by: "ask")),
                       "\(Readout.date(at)) · created by Coach")
    }
}

final class OpenRoutineEntryWireTests: XCTestCase {
    func testAnOpenEntryOmitsItsSetsRatherThanSendingAnEmptyArray() throws {
        let write = RoutineWrite(id: "rt_1", name: "Heavy Thursday", position: 0,
                                 entries: [RoutineWrite.Entry(exerciseId: "barbell-row",
                                                              restSeconds: 120),
                                           RoutineWrite.Entry(exerciseId: "deadlift", sets: Array(repeating: SetTarget(reps: 5, weightKg: 140), count: 3))])
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let sent = String(data: try encoder.encode(write.entries), encoding: .utf8) ?? ""
        XCTAssertEqual(sent, #"[{"exerciseId":"barbell-row","restSeconds":120},{"exerciseId":"deadlift","sets":[{"reps":5,"weightKg":140},{"reps":5,"weightKg":140},{"reps":5,"weightKg":140}]}]"#,
                       "an open line has no `sets` key — rest is legal on it, an empty array is not")
    }

    func testAnOpenEntryComesBackAsAnAbsenceAndReadsAsOneWord() throws {
        let wire = """
        {"id":"rt_1","name":"Heavy Thursday","position":1,"revision":4,
         "entries":[{"position":1,"exerciseId":"barbell-row","restSeconds":120},
                    {"position":2,"exerciseId":"deadlift","sets":[{"reps":5,"weightKg":140},
                     {"reps":5,"weightKg":140},{"reps":5,"weightKg":140}]}],
         "history":[{"kind":"proposal","at":1000,
                     "proposal":{"id":"pr_1","routineId":"rt_1","intent":"revise","state":"applied",
                                 "summary":"","changeCount":3,"createdAt":900,"settledAt":1000,
                                 "source":{"door":"mcp"}}},
                    {"kind":"created","at":500,"movements":2}]}
        """
        let routine = try JSONDecoder().decode(Routine.self, from: Data(wire.utf8))
        XCTAssertTrue(routine.entries[0].isOpen)
        XCTAssertEqual(routine.entries[0].sets, [])
        XCTAssertEqual(routine.entries[0].restSeconds, 120)
        XCTAssertEqual(Readout.target(routine.entries[0].sets), "open")
        XCTAssertEqual(Readout.target(routine.entries[1].sets), "3 × 5 · 140")

        XCTAssertEqual(routine.history.map(\.kind), [.proposal, .created])
        XCTAssertEqual(routine.history[0].proposal?.id, "pr_1")
        XCTAssertNil(routine.history[1].by, "no door named is the lifter's own hand")
        XCTAssertEqual(routine.history[1].movements, 2)
    }

    func testAHistoryRowThisBuildCannotClassifyDoesNotBecomeACreationRow() throws {
        let wire = """
        {"id":"rt_1","name":"Heavy Thursday","position":1,"entries":[],
         "history":[{"kind":"merged","at":900},{"kind":"created","at":500}]}
        """
        let routine = try JSONDecoder().decode(Routine.self, from: Data(wire.utf8))
        XCTAssertEqual(routine.history.map(\.kind), [.unknown, .created])
    }

    func testARoutineIsWrittenToTheDeviceWithoutItsHistory() throws {
        let routine = Routine(id: "rt_1", name: "Heavy Thursday", position: 1,
                              entries: [RoutineEntry(position: 1, exerciseId: "deadlift")],
                              history: [RoutineEvent(kind: .created, atMs: 500, movements: 1)])
        let held = String(data: try JSONEncoder().encode(routine), encoding: .utf8) ?? ""
        XCTAssertFalse(held.contains("history"))
        XCTAssertTrue(held.contains("\"entries\""))
    }

    func testAnOpenLineFrozenIntoThePlanCountsTowardsNothing() throws {
        let plan = try JSONDecoder().decode(PlanEntry.self,
                                            from: Data(#"{"exerciseId":"barbell-row"}"#.utf8))
        XCTAssertTrue(plan.isOpen)
        let counter = LiveLines.counter(workingSetsToday: 2, planEntry: plan)
        XCTAssertEqual(counter.count, "set 3")
        XCTAssertNil(counter.target)
    }

    func testTheFinishComparisonDoesNotDrawAnArrowFromAnOpenTarget() {
        let against = Against(sessionId: "ses_1", routine: "Heavy Thursday", startedAtMs: 0,
                              movements: [Against.Movement(
                                  exerciseId: "barbell-row",
                                  now: Against.Effort(weightKg: 70, reps: 8, sets: 3),
                                  before: Against.Effort(weightKg: 65, reps: 8, sets: 3),
                                  planned: [])])
        let rows = Finish.comparison(against, catalog: [Exercise(id: "barbell-row", name: "Barbell Row")])
        XCTAssertEqual(rows?.rows.map(\.detail), ["3 × 8 · 65 → 3 × 8 · 70"])
    }
}

@MainActor
final class RoutineWritingTests: XCTestCase {
    private var localURL: URL!

    override func setUp() {
        super.setUp()
        localURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("gym-routines-\(UUID().uuidString).json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: localURL)
        super.tearDown()
    }

    private func store(on shelf: LocalLog) -> TrainingStore {
        TrainingStore(queue: SetQueue(url: FileManager.default.temporaryDirectory
                                          .appendingPathComponent("q-\(UUID().uuidString).json"),
                                      deviceHolds: nil),
                      deviceCatalog: DeviceCatalog(url: FileManager.default.temporaryDirectory
                                                       .appendingPathComponent("c-\(UUID().uuidString).json")),
                      accountCopy: AccountCopy(url: FileManager.default.temporaryDirectory
                                                   .appendingPathComponent("a-\(UUID().uuidString).json")),
                      localLog: shelf,
                      sync: { _ in nil })
    }

    func testARoutineBuiltAtHomeLandsOnTheDeviceWithItsOpenRows() async {
        let store = store(on: LocalLog(url: localURL, deviceHolds: nil))
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        let squat = draft.add("back-squat")
        draft.add("barbell-row")
        draft.set(squat.id, sets: Array(repeating: SetTarget(reps: 3, weightKg: 110), count: 5))

        guard case .success(let made) = await store.create(draft) else {
            return XCTFail("a routine can be written on this device")
        }
        XCTAssertEqual(made.name, "Heavy Thursday")
        XCTAssertEqual(made.entries.map(\.position), [1, 2])
        XCTAssertEqual(made.entries.map(\.sets.count), [5, 0])
        XCTAssertTrue(made.isUntested)
        XCTAssertEqual(store.routines.map(\.id), [made.id])
        XCTAssertEqual(LocalLog(url: localURL, deviceHolds: nil).routine(made.id)?.entries.map(\.sets.count), [5, 0],
                       "the absence survives the disk as well as the wire")
    }

    func testEditingATrainedRoutineDoesNotSendItBackToUntested() async {
        let shelf = LocalLog(url: localURL, deviceHolds: nil)
        let store = store(on: shelf)
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        draft.add("back-squat")
        guard case .success(let made) = await store.create(draft) else { return XCTFail("no routine") }

        shelf.trained(routine: made.id, atMs: 1_700_000_000_000)
        shelf.flush()

        var edit = RoutineDraft(editing: made)
        edit.name = "Thursday"
        edit.add("barbell-row")
        guard case .success(let changed) = await store.replace(edit) else { return XCTFail("no replace") }
        XCTAssertEqual(changed.name, "Thursday")
        XCTAssertEqual(changed.entries.count, 2)
        XCTAssertEqual(changed.lastTrainedAtMs, 1_700_000_000_000)
        XCTAssertFalse(changed.isUntested)
    }

    func testRenamingARoutineRewritesTheDocumentAndKeepsEveryLine() async {
        let store = store(on: LocalLog(url: localURL, deviceHolds: nil))
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        let squat = draft.add("back-squat")
        draft.add("barbell-row")
        draft.set(squat.id, sets: Array(repeating: SetTarget(reps: 3, weightKg: 110), count: 5))
        guard case .success(let made) = await store.create(draft) else { return XCTFail("no routine") }

        var renamed = RoutineDraft(editing: made)
        renamed.name = "Thursday"
        guard case .success = await store.replace(renamed) else { return XCTFail("no replace") }
        XCTAssertEqual(store.routines.first?.name, "Thursday")
        XCTAssertEqual(store.routines.first?.id, made.id, "a rename never forks the record")
        XCTAssertEqual(store.routines.first?.entries.map(\.sets.count), [5, 0])
    }

    func testTheDeviceAnswersForItsOwnRoutineAndCarriesNoHistoryForIt() async {
        let store = store(on: LocalLog(url: localURL, deviceHolds: nil))
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        draft.add("back-squat")
        guard case .success(let made) = await store.create(draft) else { return XCTFail("no routine") }

        guard case .read(let read) = await store.routine(made.id) else {
            return XCTFail("the device answers for a routine it is the only home of")
        }
        XCTAssertEqual(read.id, made.id)
        XCTAssertTrue(read.history.isEmpty)

        guard case .failed(let why) = await store.routine("rt_nobody") else {
            return XCTFail("a routine on neither is a routine that is gone")
        }
        XCTAssertEqual(why, .refused("that routine is on your account — sign in to read it"))
    }

    func testDeletingAShelfRoutineLetsGoOfItAndNothingElse() async {
        let shelf = LocalLog(url: localURL, deviceHolds: nil)
        let store = store(on: shelf)
        var one = RoutineDraft(name: "Heavy Thursday", position: 0)
        one.add("back-squat")
        var other = RoutineDraft(name: "Push A", position: 1)
        other.add("bench-press")
        guard case .success(let doomed) = await store.create(one),
              case .success(let kept) = await store.create(other) else {
            return XCTFail("two routines land on the shelf")
        }

        let gone = await store.deleteRoutine(doomed.id)
        XCTAssertNil(gone)
        XCTAssertEqual(store.routines.map(\.id), [kept.id])
        XCTAssertNil(shelf.routine(doomed.id), "the shelf let go, so no claim will ever replay it")
        XCTAssertNotNil(shelf.routine(kept.id))
    }
}

final class CreateMovementTests: XCTestCase {
    func testExactlyFourLoadingsAreOfferedAndTheirValuesAreTheWires() {
        XCTAssertEqual(Equipment.offered.map(\.0), ["barbell", "dumbbell", "machine", "bodyweight"])
        XCTAssertEqual(Equipment.offered.map(\.1), ["Barbell", "Dumbbell", "Machine", "Bodyweight"])
    }
}

final class RenameProofTests: XCTestCase {
    private let squat = Exercise(id: "back-squat", name: "Back Squat", equipment: "barbell")

    func testTheProofIsFourFactsOffTheRecordReadAndNotOneConstant() {
        let record = MovementRecord(
            exercise: squat, routineCount: 2, routines: ["Push A", "Legs"], sessionCount: 34,
            bestE1rm: MovementMark(weightKg: 110, reps: 3, atMs: 1_000, e1rm: 122.5),
            records: [MovementMark(weightKg: 110, reps: 3, atMs: 1_000, e1rm: 122.5),
                      MovementMark(weightKg: 105, reps: 3, atMs: 900, e1rm: 116.9),
                      MovementMark(weightKg: 100, reps: 5, atMs: 800, e1rm: 116.7)])
        XCTAssertEqual(Record.proof(record).map(\.label),
                       ["sessions", "records", "routines", "old name"])
        XCTAssertEqual(Record.proof(record).map(\.said),
                       ["34 · unchanged", "3 PRs · e1RM 122.5 kept", "Push A · Legs",
                        "searchable as an alias"])
    }

    func testAMovementNobodyHasLiftedProvesOnlyWhatIsTrueOfIt() {
        XCTAssertEqual(Record.proof(MovementRecord(exercise: squat)).map(\.label), ["old name"])
    }

    func testThePrLineCountsAndOnlyNamesAnEstimateWhereThereIsOne() {
        let bodyweight = MovementRecord(
            exercise: Exercise(id: "chin-up", name: "Chin Up", equipment: "bodyweight"),
            sessionCount: 9,
            records: [MovementMark(weightKg: 0, reps: 12, atMs: 1_000)])
        XCTAssertEqual(Record.proof(bodyweight).map(\.said),
                       ["9 · unchanged", "1 PR", "searchable as an alias"])
    }

    func testADeviceAnsweredPageDoesNotPromiseAnAlias() {
        let record = MovementRecord(exercise: squat, routineCount: 1, routines: ["Heavy Thursday"],
                                    sessionCount: 3)
        XCTAssertEqual(Record.proof(record, from: .thisDevice).map(\.label),
                       ["sessions", "routines"])
        XCTAssertTrue(Record.proof(record, from: .thisDevice).allSatisfy { $0.label != "old name" })
    }

    func testTheRecordPageCarriesTheProofItWasReadWith() {
        let page = Record.page(MovementRecord(exercise: squat, routineCount: 1,
                                              routines: ["Push A"], sessionCount: 12),
                               now: 2_000)
        XCTAssertEqual(page.proof.map(\.label), ["sessions", "routines", "old name"])
        XCTAssertEqual(page.proof.map(\.said), ["12 · unchanged", "Push A", "searchable as an alias"])
    }

    func testTheCountAndTheNamesComeOffOneRead() throws {
        let wire = """
        {"exercise":{"id":"back-squat","name":"Back Squat","pattern":"squat","equipment":"barbell",
                     "custom":false,"aliases":["High-bar squat"]},
         "routineCount":2,"routines":["Push A","Legs"],"sessionCount":34}
        """
        let record = try JSONDecoder().decode(MovementRecord.self, from: Data(wire.utf8))
        XCTAssertEqual(record.routines, ["Push A", "Legs"])
        XCTAssertEqual(record.routineCount, record.routines.count)
        XCTAssertEqual(record.exercise.aliases, ["High-bar squat"])
    }

    func testAnExerciseWithNoAliasesDecodesToNone() throws {
        let plain = try JSONDecoder().decode(
            Exercise.self, from: Data(#"{"id":"deadlift","name":"Deadlift"}"#.utf8))
        XCTAssertEqual(plain.aliases, [])
    }
}

final class MovementAliasTests: XCTestCase {
    private let catalog = [
        Exercise(id: "back-squat", name: "High-bar squat", aliases: ["Back Squat"]),
        Exercise(id: "bench-press", name: "Bench Press"),
    ]

    func testTypingTheOldNameStillFindsTheMovement() {
        let options = PickerOptions.matching(query: "back sq", catalog: catalog, taken: [])
        XCTAssertEqual(options.matches.map(\.id), ["back-squat"])
        XCTAssertNil(options.create, "there is something to pick, so there is nothing to mint")
    }

    func testOnlyTheRowTheTypingFoundByAnAliasNamesIt() {
        XCTAssertEqual(PickerOptions.matching(query: "back sq", catalog: catalog, taken: [])
                           .matches.map(\.was), ["Back Squat"])
        XCTAssertEqual(PickerOptions.matching(query: "high-bar", catalog: catalog, taken: [])
                           .matches.map(\.was), [nil])
        let unfiltered = PickerOptions.matching(query: "", catalog: catalog, taken: [])
        XCTAssertEqual(unfiltered.six.map(\.id), ["back-squat", "bench-press"])
        XCTAssertEqual(unfiltered.six.map(\.was), [nil, nil])
        XCTAssertTrue(unfiltered.matches.isEmpty)
    }

    func testANameNobodyHasEverUsedStillOffersTheDoorOut() {
        let options = PickerOptions.matching(query: "zercher", catalog: catalog, taken: [])
        XCTAssertEqual(options.empty, "No movement by that name.")
        XCTAssertEqual(options.create, "Create “zercher”")
    }
}
