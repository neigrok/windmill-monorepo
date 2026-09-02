import XCTest
@testable import WindmillGym

final class RoutineDraftTests: XCTestCase {
    func testAMovementIsAddedOpenAndTheDraftIsStillSavable() {
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        draft.add("deadlift")
        XCTAssertEqual(draft.lines.count, 1)
        XCTAssertNil(draft.entries[0].targetSets)
        XCTAssertNil(draft.entries[0].targetReps)
        XCTAssertNil(draft.entries[0].targetWeightKg)
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

    func testLeaveItOpenClearsTheRepsAndTheWeightAndNotJustTheSets() {
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        let line = draft.add("deadlift")
        draft.set(line.id, sets: 3, reps: 5, weightKg: 140)
        XCTAssertEqual(draft.entries[0].targetSets, 3)
        XCTAssertEqual(draft.entries[0].targetReps, 5)
        XCTAssertEqual(draft.entries[0].targetWeightKg, 140)

        draft.leaveOpen(line.id)
        XCTAssertNil(draft.entries[0].targetSets)
        XCTAssertNil(draft.entries[0].targetReps)
        XCTAssertNil(draft.entries[0].targetWeightKg)
    }

    func testACommitCarriesTheAbsencesRatherThanFillingThem() {
        var draft = RoutineDraft(name: "Heavy Thursday", position: 0)
        let line = draft.add("chin-up")
        draft.set(line.id, sets: 3, reps: nil, weightKg: nil)
        XCTAssertEqual(draft.entries[0].targetSets, 3)
        XCTAssertNil(draft.entries[0].targetReps)
        XCTAssertNil(draft.entries[0].targetWeightKg)
        XCTAssertFalse(draft.entries[0].isOpen, "no reps is `3 × max`, which is a target and not an open row")
        XCTAssertEqual(Readout.target(sets: draft.entries[0].targetSets,
                                      reps: draft.entries[0].targetReps,
                                      weightKg: draft.entries[0].targetWeightKg), "3 × max")
    }

    func testARowOpenedAndCommittedUntouchedComesBackTheWayItWentIn() throws {
        var draft = RoutineDraft(name: "Heavy Thursday",
                                 entries: [.init(exerciseId: "back-squat", targetSets: 5, targetReps: 5),
                                           .init(exerciseId: "chin-up", targetSets: 3)],
                                 position: 0)
        // The sheet opens on what the row holds and commits the same three fields back.
        for line in draft.lines {
            let held = line.entry
            draft.set(line.id, sets: held.targetSets ?? 0, reps: held.targetReps,
                      weightKg: held.targetWeightKg)
        }
        XCTAssertEqual(draft.entries.map(\.targetSets), [5, 3])
        XCTAssertEqual(draft.entries.map(\.targetReps), [5, nil])
        XCTAssertEqual(draft.entries.map(\.targetWeightKg), [nil, nil])

        let body = try XCTUnwrap(String(data: JSONEncoder().encode(draft.write), encoding: .utf8))
        XCTAssertFalse(body.contains("targetWeightKg"), "no weight named is no weight sent")
        XCTAssertEqual(body.components(separatedBy: "targetReps").count - 1, 1,
                       "one of the two lines names reps, and only that one sends them")
    }

    func testRestIsCarriedThroughBothWrites() {
        var draft = RoutineDraft(name: "Heavy Thursday",
                                 entries: [.init(exerciseId: "deadlift", restSeconds: 180)],
                                 position: 0)
        let line = draft.lines[0].id
        draft.set(line, sets: 3, reps: 5, weightKg: 140)
        XCTAssertEqual(draft.entries[0].restSeconds, 180)
        draft.leaveOpen(line)
        XCTAssertEqual(draft.entries[0].restSeconds, 180)
    }

    func testEditKeepsTheIdAndPositionAndDuplicateTakesFreshOnes() {
        let routine = Routine(id: "rt_1", name: "Heavy Thursday", position: 2,
                              entries: [RoutineEntry(position: 1, exerciseId: "deadlift",
                                                     targetSets: 3, targetReps: 5,
                                                     targetWeightKg: 140)])
        let edit = RoutineDraft(editing: routine)
        XCTAssertEqual(edit.id, "rt_1")
        XCTAssertEqual(edit.position, 2)
        XCTAssertEqual(edit.name, "Heavy Thursday")
        XCTAssertEqual(edit.entries.map(\.exerciseId), ["deadlift"])
        XCTAssertEqual(edit.entries.map(\.targetSets), [3])

        let copy = RoutineDraft(duplicating: edit, position: 5)
        XCTAssertNotEqual(copy.id, "rt_1")
        XCTAssertEqual(copy.position, 5)
        XCTAssertEqual(copy.name, "Heavy Thursday",
                       "seeded from the day on screen — a starting point to type over in the inline field")
        XCTAssertEqual(copy.entries.map(\.targetWeightKg), [140])
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

// The routine target's three typed fields. Six refusals, two bands that are not the logger's, and a
// clear that is refused rather than cascaded.
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

    // `Routine.cpp:18`: an open entry names no sets, so it names no reps and no weight either.
    func testClearingSetsIsRefusedWhileEitherOfTheOtherTwoHoldsAValue() {
        XCTAssertEqual(TargetEntry.clearingSets(reps: "5", weight: ""),
                       "Clear reps and weight first — an open line names neither.")
        XCTAssertEqual(TargetEntry.clearingSets(reps: "", weight: "100"),
                       "Clear reps and weight first — an open line names neither.")
        XCTAssertEqual(TargetEntry.clearingSets(reps: "5", weight: "100"),
                       "Clear reps and weight first — an open line names neither.")
        XCTAssertNil(TargetEntry.clearingSets(reps: "", weight: ""))
        XCTAssertNil(TargetEntry.clearingSets(reps: "  ", weight: " "))
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
        let named = routine([RoutineEntry(position: 1, exerciseId: "back-squat", targetSets: 5,
                                          targetReps: 3, targetWeightKg: 110),
                             RoutineEntry(position: 2, exerciseId: "barbell-row")])
        XCTAssertEqual(named.entries.filter(\.isOpen).map(\.exerciseId), ["barbell-row"])

        let none = routine([RoutineEntry(position: 1, exerciseId: "back-squat", targetSets: 5,
                                         targetReps: 3, targetWeightKg: 110)])
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
    func testAnOpenEntryOmitsItsSetCountRatherThanSendingZero() throws {
        let write = RoutineWrite(id: "rt_1", name: "Heavy Thursday", position: 0,
                                 entries: [RoutineWrite.Entry(exerciseId: "barbell-row",
                                                              restSeconds: 120),
                                           RoutineWrite.Entry(exerciseId: "deadlift", targetSets: 3,
                                                              targetReps: 5, targetWeightKg: 140)])
        let sent = String(data: try JSONEncoder().encode(write), encoding: .utf8) ?? ""
        XCTAssertFalse(sent.contains("targetSets\":0"), "a zero is a target of nothing")
        XCTAssertTrue(sent.contains("\"restSeconds\":120"),
                      "rest is legal on an open line — it is how long you wait, not what you are asked to do")
        XCTAssertTrue(sent.contains("\"targetSets\":3"))
    }

    func testAnOpenEntryComesBackAsAnAbsenceAndReadsAsOneWord() throws {
        let wire = """
        {"id":"rt_1","name":"Heavy Thursday","position":1,"revision":4,
         "entries":[{"position":1,"exerciseId":"barbell-row","restSeconds":120},
                    {"position":2,"exerciseId":"deadlift","targetSets":3,"targetReps":5,
                     "targetWeightKg":140}],
         "history":[{"kind":"proposal","at":1000,
                     "proposal":{"id":"pr_1","routineId":"rt_1","intent":"revise","state":"applied",
                                 "summary":"","changeCount":3,"createdAt":900,"settledAt":1000,
                                 "source":{"door":"mcp"}}},
                    {"kind":"created","at":500,"movements":2}]}
        """
        let routine = try JSONDecoder().decode(Routine.self, from: Data(wire.utf8))
        XCTAssertTrue(routine.entries[0].isOpen)
        XCTAssertNil(routine.entries[0].targetSets)
        XCTAssertEqual(routine.entries[0].restSeconds, 120)
        XCTAssertEqual(Readout.target(sets: routine.entries[0].targetSets,
                                      reps: routine.entries[0].targetReps,
                                      weightKg: routine.entries[0].targetWeightKg), "open")
        XCTAssertEqual(Readout.target(sets: routine.entries[1].targetSets,
                                      reps: routine.entries[1].targetReps,
                                      weightKg: routine.entries[1].targetWeightKg), "3 × 5 · 140")

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
        XCTAssertEqual(counter.plan, "no target")
    }

    func testTheFinishComparisonDoesNotDrawAnArrowFromAnOpenTarget() {
        let against = Against(sessionId: "ses_1", routine: "Heavy Thursday", startedAtMs: 0,
                              movements: [Against.Movement(
                                  exerciseId: "barbell-row",
                                  now: Against.Effort(weightKg: 70, reps: 8, sets: 3),
                                  before: Against.Effort(weightKg: 65, reps: 8, sets: 3),
                                  planned: Against.Target())])
        let rows = Finish.comparison(against, catalog: [Exercise(id: "barbell-row", name: "Barbell Row")])
        XCTAssertEqual(rows?.rows.map(\.detail), ["3×8 @ 65 → 3×8 @ 70"])
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
        draft.set(squat.id, sets: 5, reps: 3, weightKg: 110)

        guard case .success(let made) = await store.create(draft) else {
            return XCTFail("a routine can be written on this device")
        }
        XCTAssertEqual(made.name, "Heavy Thursday")
        XCTAssertEqual(made.entries.map(\.position), [1, 2])
        XCTAssertEqual(made.entries.map(\.targetSets), [5, nil])
        XCTAssertTrue(made.isUntested)
        XCTAssertEqual(store.routines.map(\.id), [made.id])
        XCTAssertEqual(LocalLog(url: localURL, deviceHolds: nil).routine(made.id)?.entries.map(\.targetSets), [5, nil],
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
        draft.set(squat.id, sets: 5, reps: 3, weightKg: 110)
        guard case .success(let made) = await store.create(draft) else { return XCTFail("no routine") }

        var renamed = RoutineDraft(editing: made)
        renamed.name = "Thursday"
        guard case .success = await store.replace(renamed) else { return XCTFail("no replace") }
        XCTAssertEqual(store.routines.first?.name, "Thursday")
        XCTAssertEqual(store.routines.first?.id, made.id, "a rename never forks the record")
        XCTAssertEqual(store.routines.first?.entries.map(\.targetSets), [5, nil])
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
