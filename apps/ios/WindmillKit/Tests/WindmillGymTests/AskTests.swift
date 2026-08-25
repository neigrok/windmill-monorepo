import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

private func refusal(_ status: Int, code: String = "", message: String = "") -> WindmillApiError {
    var fields: [String] = []
    if !message.isEmpty { fields.append(#""error":"\#(message)""#) }
    if !code.isEmpty { fields.append(#""code":"\#(code)""#) }
    return .refused(status, Refusal(Data("{\(fields.joined(separator: ","))}".utf8)))
}

private func answered(_ question: String, _ text: String,
                      read: ReadTally = ReadTally(sets: 1, sessions: 1, weeks: 1)) -> AskExchange {
    AskExchange(question: question,
                outcome: .answered(AskAnswer(answer: text, read: read)))
}

final class AskWireTests: XCTestCase {
    func testTheAnswerDecodesFromTheWiresOwnShape() throws {
        let wire = """
        {"answer":"Three sessions at the same top set, and the fourth lost a rep.",
         "steps":[{"tool":"get_stats","failed":false},{"tool":"get_session","failed":true}],
         "read":{"sets":214,"sessions":34,"weeks":12},
         "proposals":["prop_0a1b2c3d"]}
        """
        let answer = try JSONDecoder().decode(AskAnswer.self, from: Data(wire.utf8))

        XCTAssertEqual(answer.answer, "Three sessions at the same top set, and the fourth lost a rep.")
        XCTAssertEqual(answer.steps, [AskStep(tool: "get_stats", failed: false),
                                      AskStep(tool: "get_session", failed: true)])
        XCTAssertEqual(answer.read, ReadTally(sets: 214, sessions: 34, weeks: 12))
        XCTAssertEqual(answer.proposals, ["prop_0a1b2c3d"])
    }

    func testAnAnswerWithNoStepsAndNoProposalsIsStillAnAnswer() throws {
        let wire = #"{"answer":"Nothing has moved.","read":{"sets":0,"sessions":0,"weeks":0}}"#
        let answer = try JSONDecoder().decode(AskAnswer.self, from: Data(wire.utf8))

        XCTAssertEqual(answer.answer, "Nothing has moved.")
        XCTAssertEqual(answer.steps, [])
        XCTAssertEqual(answer.proposals, [])
        XCTAssertEqual(answer.read, ReadTally(sets: 0, sessions: 0, weeks: 0))
    }

    func testProseWithNoReceiptIsNotAnAnswer() {
        let wire = #"{"answer":"Your bench is fine.","steps":[],"proposals":[]}"#
        XCTAssertThrowsError(try JSONDecoder().decode(AskAnswer.self, from: Data(wire.utf8)))
    }

}

final class AskReceiptTests: XCTestCase {
    func testTheReadLineIsTheDesignsOwnSentence() {
        XCTAssertEqual(ReadTally(sets: 214, sessions: 34, weeks: 12).line,
                       "read 214 sets · 12 weeks · 34 sessions")
    }

    func testTheReadLineCountsOneOfEachInTheSingular() {
        XCTAssertEqual(ReadTally(sets: 1, sessions: 1, weeks: 1).line,
                       "read 1 set · 1 week · 1 session")
    }

    func testAZeroIsOmittedAndReadingNothingSaysSo() {
        XCTAssertEqual(ReadTally(sets: 40, sessions: 0, weeks: 3).line, "read 40 sets · 3 weeks")
        XCTAssertEqual(ReadTally(sets: 0, sessions: 0, weeks: 0).line, "read nothing from your log")
    }

    func testAStepIsSaidInWordsAndAFailureSaysNothingCameBack() {
        XCTAssertEqual(AskStep(tool: "get_stats").line, "read your movement history")
        XCTAssertEqual(AskStep(tool: "get_stats", failed: true).line,
                       "read your movement history (nothing came back)")
        XCTAssertEqual(AskStep(tool: "list_notes").line, "read your notes")
    }

    func testAToolThisBuildHasNoPhraseForPrintsNothingAndTheReceiptStays() throws {
        XCTAssertNil(AskStep(tool: "get_bodyweight").line)
        XCTAssertNil(AskStep(tool: "").line)

        let wire = """
        {"answer":"Fine.","steps":[{"tool":"get_bodyweight"},{"tool":"get_stats"}],
         "read":{"sets":10,"sessions":2,"weeks":1}}
        """
        let answer = try JSONDecoder().decode(AskAnswer.self, from: Data(wire.utf8))
        XCTAssertEqual(Ask.stepLines(answer.steps), ["read your movement history"])
        XCTAssertEqual(answer.read.line, "read 10 sets · 1 week · 2 sessions")
    }

    func testThePhraseTableIsTheWebsWordForWordPlusTheNotesRead() {
        XCTAssertEqual(Ask.phrase, [
            "list_sessions": "read your recent workouts",
            "get_session": "read one workout",
            "last_time": "read the last time you trained a movement",
            "list_exercises": "read your movement list",
            "list_routines": "read your program",
            "get_stats": "read your movement history",
            "list_notes": "read your notes",
            "propose_routine_change": "wrote a proposal for one of your routines",
            "propose_routine_removal": "wrote a proposal to remove a routine",
        ])
    }

    func testTheStepListSaysEachPhraseOnceInCallOrder() {
        let steps = [AskStep(tool: "list_notes"), AskStep(tool: "get_stats"),
                     AskStep(tool: "get_stats"), AskStep(tool: "list_sessions"),
                     AskStep(tool: "get_stats", failed: true)]
        XCTAssertEqual(Ask.stepLines(steps), ["read your notes", "read your movement history",
                                              "read your recent workouts",
                                              "read your movement history (nothing came back)"])
        XCTAssertEqual(Ask.stepLines([]), [])
    }
}

final class AskConversationTests: XCTestCase {
    func testAMintedThreadIdIsOneTheServerWillTake() {
        let allowed = CharacterSet(charactersIn:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")

        for _ in 0..<50 {
            let minted = Ask.mintThreadId()
            XCTAssertTrue(minted.hasPrefix("thr_"), minted)
            XCTAssertGreaterThanOrEqual(minted.count, 8, minted)
            XCTAssertLessThanOrEqual(minted.count, 64, minted)
            XCTAssertNil(minted.rangeOfCharacter(from: allowed.inverted), minted)
        }
    }

    func testEveryConversationOpensItsOwnThread() {
        let ids = Set((0..<200).map { _ in AskConversation().threadId })

        XCTAssertEqual(ids.count, 200)
    }

    func testOpeningAFreshThreadKeepsWhatIsAlreadyOnScreen() {
        var conversation = AskConversation(exchanges: [answered("first?", "first answer.")])
        let opened = conversation.threadId

        conversation.openAFreshThread()

        XCTAssertNotEqual(conversation.threadId, opened)
        XCTAssertEqual(conversation.exchanges.count, 1)
        XCTAssertEqual(conversation.exchanges[0].question, "first?")
    }

    func testAQuestionPastTheCeilingIsNotSentShortened() {
        let long = String(repeating: "squat 5x5 at 100kg, ", count: 80)     // 1600 bytes
        XCTAssertGreaterThan(long.utf8.count, Ask.maxTurnBytes)

        XCTAssertNil(Ask.question(from: long))
        XCTAssertFalse(Ask.fits(long))
    }

    func testAQuestionIsAdmittedByBytesAndTheCeilingIsInclusive() {
        XCTAssertEqual(Ask.question(from: String(repeating: "a", count: 1_000))?.utf8.count, 1_000)
        XCTAssertNil(Ask.question(from: String(repeating: "a", count: 1_001)))
        XCTAssertNil(Ask.question(from: String(repeating: "🏋", count: 251)))    // 1004 bytes
    }

    func testAnAdmittedQuestionIsTheLiftersOwnWordsAndBlankIsNotAQuestion() {
        XCTAssertEqual(Ask.question(from: "  Bench has been stuck at 82.5. \n"),
                       "Bench has been stuck at 82.5.")
        XCTAssertNil(Ask.question(from: "   \n  "))
        XCTAssertNil(Ask.question(from: ""))
    }

    func testAnAnswerOfAnyLengthNeverGoesBackOutAndCannotRefuseTheNextQuestion() {
        let long = String(repeating: "a", count: 1_400)
        let conversation = AskConversation(exchanges: [answered("q", long)])

        XCTAssertEqual(Ask.question(from: "next?"), "next?")
        XCTAssertEqual(conversation.exchanges.count, 1)
    }
}

final class AskDoorTests: XCTestCase {
    func testTheDoorIsNotThereWhileAWorkoutIsOpen() {
        XCTAssertFalse(Ask.doorIsOpen(signedIn: true, sessionIsOpen: true, onThisDeployment: true))
        XCTAssertTrue(Ask.doorIsOpen(signedIn: true, sessionIsOpen: false, onThisDeployment: true))
    }

    func testTheDoorIsNotThereWithoutAnAccountOrWithoutAnAskOnThisDeployment() {
        XCTAssertFalse(Ask.doorIsOpen(signedIn: false, sessionIsOpen: false, onThisDeployment: true))
        XCTAssertFalse(Ask.doorIsOpen(signedIn: true, sessionIsOpen: false, onThisDeployment: false))
        XCTAssertFalse(Ask.doorIsOpen(signedIn: false, sessionIsOpen: true, onThisDeployment: false))
    }

    func testTheTabStancesAreQuietStatementsOfFact() {
        XCTAssertEqual(Ask.needsSignIn, "Coach reads your log, so it needs you signed in.")
        XCTAssertEqual(Ask.signIn, "Sign in")
        XCTAssertEqual(Ask.absentLine, "Coach isn’t part of this Windmill. Your log is still yours to read.")
    }

    func testTheRoomIsCalledCoachAndTheWordNamesNothingElse() {
        XCTAssertEqual(Ask.title, "Coach")
        XCTAssertEqual(Ask.subtitle, "reads your log · proposes only")
        XCTAssertEqual(Ask.notesDoor, "Notes")
        XCTAssertEqual(Coach.shareTitle, "Share this workout")
        XCTAssertFalse(Coach.offer.lowercased().contains("coach"))
        XCTAssertEqual(ProposalSource(door: "ask").agentName, "Coach")
    }

    // "Ask about…" stays a verb in the scope and the placeholder; the noun that names the room is Coach.
    func testNothingALifterReadsNamesTheRoomAskOrShipsAStraightApostrophe() {
        let named = [Ask.title, Ask.subtitle, Ask.needsSignIn, Ask.absentLine, Ask.noAnswer, Ask.tooLong,
                     Ask.allowance, Ask.capReached, Ask.threadCeiling, Ask.threadTaken,
                     Ask.freeDoor, Ask.proposalNote, Ask.waiting, Ask.connect, Ask.notesDoor,
                     Settings.coachReads, Notes.honesty, Notes.purpose, Notes.needsSignIn]
        for sentence in named {
            XCTAssertNil(sentence.range(of: #"\bAsk\b"#, options: .regularExpression), sentence)
        }
        for sentence in named + [Ask.scope, Ask.placeholder, AskThreads.askSomethingNew, Notes.full,
                                 Proposal.turnDownBody, Finish.Discard.body,
                                 AskRefusal(WindmillApiError.offline).line,
                                 AskRefusal(WindmillApiError.malformed).line,
                                 NotesRefusal(WindmillApiError.offline).line,
                                 NotesRefusal(WindmillApiError.malformed).line] {
            XCTAssertFalse(sentence.contains("'"), sentence)
        }
    }
}

final class AskRefusalTests: XCTestCase {
    // The fixtures are the server's bytes exactly (`AskApi.cpp`); the client repeats them and never rewrites them.
    func testEveryRefusalTheServerWritesIsRepeatedVerbatimAndNotRetried() {
        let ladder: [(WindmillApiError, String)] = [
            (refusal(401, message: "sign in to open your training log"),
             "sign in to open your training log"),
            (refusal(400, message: "that isn’t a conversation Coach can answer"),
             "that isn’t a conversation Coach can answer"),
            (refusal(400, message: "ask something about your training"),
             "ask something about your training"),
            (refusal(400, message: "that question is longer than Coach takes"),
             "that question is longer than Coach takes"),
            (refusal(400, message: "that question has characters Coach can’t store"),
             "that question has characters Coach can’t store"),
            (refusal(409, code: "ask-session-open",
                     message: "finish your workout first — Coach reads a log that has stopped moving"),
             "finish your workout first — Coach reads a log that has stopped moving"),
            (refusal(429, code: "ask-daily-limit",
                     message: "the next question frees up in a couple of hours"),
             "the next question frees up in a couple of hours"),
            (refusal(429, code: "ask-out-of-budget",
                     message: "this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on"),
             "this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on"),
            (refusal(503, code: "ask-not-configured",
                     message: "Coach isn’t part of this Windmill. Your log is still yours to read."),
             "Coach isn’t part of this Windmill. Your log is still yours to read."),
        ]

        for (error, said) in ladder {
            let refused = AskRefusal(error)
            XCTAssertEqual(refused.line, said)
            XCTAssertFalse(refused.mayRetry, said)
            XCTAssertFalse(refused.closesTheDoor, said)
            XCTAssertFalse(refused.opensAFreshThread, said)
        }
    }

    func testTheDailyCapIsTheOneRefusalThatReplacesTheComposer() {
        let capped = AskRefusal(refusal(429, code: "ask-daily-limit",
                                        message: "the next question frees up in a couple of hours"))
        XCTAssertTrue(capped.capReached)
        XCTAssertEqual(capped.line, "the next question frees up in a couple of hours")
        XCTAssertFalse(capped.mayRetry)

        let silent = AskRefusal(refusal(429, code: "ask-daily-limit"))
        XCTAssertTrue(silent.capReached)
        XCTAssertEqual(silent.line, Ask.capReached)

        let budget = AskRefusal(refusal(429, code: "ask-out-of-budget", message: "ceiling"))
        XCTAssertFalse(budget.capReached)
        XCTAssertFalse(AskRefusal(refusal(500)).capReached)
        XCTAssertFalse(AskRefusal(WindmillApiError.offline).capReached)
    }

    // No clock: the state stands on the conversation that met the 429, and a new conversation is the way back.
    func testTheCapReachedStateStandsUntilANewConversationOpens() {
        let capped = AskRefusal(refusal(429, code: "ask-daily-limit",
                                        message: "the next question frees up in a couple of hours"))
        var conversation = AskConversation()
        XCTAssertFalse(conversation.capReached)

        conversation.exchanges.append(AskExchange(question: "why did bench stall",
                                                  outcome: .refused(AskRefusal(refusal(500)))))
        XCTAssertFalse(conversation.capReached)

        conversation.exchanges.append(AskExchange(question: "and squat", outcome: .refused(capped)))
        XCTAssertTrue(conversation.capReached)

        conversation = AskConversation()
        XCTAssertTrue(conversation.exchanges.isEmpty)
        XCTAssertFalse(conversation.capReached)
    }

    func testTheThreeSilencesOfferTheDoorAgain() {
        let bad = AskRefusal(refusal(502, message: "Coach didn’t answer. Try again in a moment"))
        XCTAssertEqual(bad.line, "Coach didn’t answer. Try again in a moment")
        XCTAssertTrue(bad.mayRetry)

        let offline = AskRefusal(WindmillApiError.offline)
        XCTAssertEqual(offline.line, "Can’t reach windmill.works")
        XCTAssertTrue(offline.mayRetry)

        let unreadable = AskRefusal(WindmillApiError.malformed)
        XCTAssertEqual(unreadable.line, "Coach didn’t answer. Try again in a moment")
        XCTAssertTrue(unreadable.mayRetry)
        XCTAssertFalse(unreadable.closesTheDoor)
    }

    func testAFullOrTakenThreadOpensANewConversationRatherThanFailing() {
        let full = AskRefusal(refusal(409, code: "ask-thread-full",
                                      message: "this conversation holds four questions — start a new one"))
        XCTAssertEqual(full.line, "this conversation holds four questions — start a new one")
        XCTAssertTrue(full.opensAFreshThread)
        XCTAssertTrue(full.mayRetry)
        XCTAssertFalse(full.closesTheDoor)

        let taken = AskRefusal(refusal(409, code: "ask-thread-taken",
                                       message: "that conversation id is already in use — start a new one"))
        XCTAssertEqual(taken.line, "that conversation id is already in use — start a new one")
        XCTAssertTrue(taken.opensAFreshThread)
        XCTAssertTrue(taken.mayRetry)

        let midSession = AskRefusal(refusal(409, code: "ask-session-open",
                                            message: "finish your workout first"))
        XCTAssertFalse(midSession.opensAFreshThread)
        XCTAssertFalse(midSession.mayRetry)
    }

    func testTheThreadCeilingSaysFourEverywhereAndEightNowhere() {
        XCTAssertEqual(AskRefusal(refusal(409, code: "ask-thread-full")).line,
                       "This conversation holds four questions. Start a new one.")
        XCTAssertEqual(AskRefusal(refusal(409, code: "ask-thread-taken")).line, Ask.threadTaken)

        let spoken = [Ask.threadCeiling, Ask.threadTaken, Ask.allowance, Ask.capReached, Ask.scope,
                      AskThreads.empty, AskThreads.deleteNote]
        for sentence in spoken {
            XCTAssertFalse(sentence.lowercased().contains("eight"), sentence)
            XCTAssertFalse(sentence.contains("8"), sentence)
        }
    }

    func testNoCoachOnThisDeploymentClosesTheDoorRatherThanFailing() {
        let absent = AskRefusal(refusal(404))

        XCTAssertEqual(absent.line, "Coach isn’t part of this Windmill. Your log is still yours to read.")
        XCTAssertTrue(absent.closesTheDoor)
        XCTAssertFalse(absent.mayRetry)
    }

    func testARefusalWithNoSentenceStillSaysSomethingAPersonCanRead() {
        XCTAssertEqual(AskRefusal(refusal(500)).line, "That didn’t go through")
        XCTAssertFalse(AskRefusal(refusal(500)).mayRetry)
    }

    func testNoSurfaceOfAskEverOffersAPurchase() {
        let sold = ["upgrade", "Upgrade", "subscribe", "Subscribe", "$", "€", "£", "/month",
                    "per month", "Windmill One", "free trial", "checkout", "Checkout", "buy", "Buy"]
        let spoken = [Ask.title, Ask.subtitle, Ask.scope, Ask.allowance, Ask.capReached, Ask.threadCeiling,
                      Ask.freeDoor, Ask.connect, Ask.proposalNote, Ask.placeholder, Ask.waiting,
                      Ask.tooLong, Ask.notesDoor, Notes.honesty, Notes.purpose, Notes.full,
                      AskRefusal(refusal(429, code: "ask-daily-limit",
                                         message: "the next question frees up in a couple of hours")).line,
                      AskRefusal(refusal(404)).line,
                      ReadTally(sets: 214, sessions: 34, weeks: 12).line]

        for sentence in spoken {
            for word in sold {
                XCTAssertFalse(sentence.contains(word), "\(sentence) offers \(word)")
            }
        }
    }

    // The promise is one line above the composer; the cap-reached moment says what to do next, not the rule again.
    func testTheDailyCapIsSaidInOneLineAndTheCapReachedMomentSaysWhatToDoNext() {
        XCTAssertEqual(Ask.allowance, "Ten questions a day, three back to back.")
        XCTAssertEqual(Ask.capReached, "The next question frees up in a couple of hours.")
    }

    // The cap-reached state replaces the input and the send control only: the allowance line is drawn above
    // whichever half stands, so the promise and the moment sit together.
    func testTheAllowanceLineStaysDrawnAboveTheCapReachedState() throws {
        let screen = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/AskScreen.swift")
        let source = try String(contentsOf: screen, encoding: .utf8)
        let composer = try XCTUnwrap(source.range(of: "private var composer: some View"))
        let allowance = try XCTUnwrap(source.range(of: "Text(Ask.allowance)",
                                                   range: composer.upperBound..<source.endIndex))
        let branch = try XCTUnwrap(source.range(of: "if conversation.capReached { capReachedState } else { input }",
                                                range: allowance.upperBound..<source.endIndex))
        let nextView = try XCTUnwrap(source.range(of: "private var ", range: composer.upperBound..<source.endIndex))
        XCTAssertLessThan(branch.lowerBound, nextView.lowerBound, "the branch is the composer's, not another view's")
        XCTAssertEqual(source.components(separatedBy: "Text(Ask.allowance)").count, 2, "the allowance line is drawn once")
        XCTAssertEqual(source.components(separatedBy: "conversation.capReached").count, 2,
                       "the only cap-reached branch is the one below the allowance line")
    }

    func testAQuestionPastTheCeilingIsToldRatherThanCutDown() {
        XCTAssertEqual(Ask.tooLong, "That question is longer than Coach takes. Shorten it to send.")
    }

    func testTheEmptyStateNamesWhatAskCanNeverDo() {
        XCTAssertTrue(Ask.scope.contains("It can never change what you lifted"))
        XCTAssertTrue(Ask.scope.contains("a set that needs fixing is yours, in the log"))
        XCTAssertTrue(Ask.subtitle.contains("proposes only"))
    }

    func testTheEmptyStatePointsAtTheFreeDoor() {
        XCTAssertTrue(Ask.freeDoor.contains("Claude, Cursor, Codex or anything else that speaks MCP"))
        XCTAssertTrue(Ask.freeDoor.contains("connect it instead"))
        XCTAssertTrue(Ask.freeDoor.contains("it’s free"))
        XCTAssertTrue(Ask.freeDoor.contains("it reaches what Coach can’t: it knows the rest of your life"))
        XCTAssertFalse(Ask.freeDoor.contains("better"), "the contrast is scope, never quality")
        XCTAssertFalse(Ask.freeDoor.contains("ChatGPT"))
        XCTAssertFalse(ConnectedLog.precondition.contains("ChatGPT"))
    }

    func testTheProposalNoteNamesBothHalvesOfThePromise() {
        XCTAssertEqual(Ask.proposalNote, "Nothing changes until you tap Apply on the diff. "
                       + "Your logged sets are never part of a proposal.")
    }
}

final class AskDiffRowTests: XCTestCase {
    private func proposal(_ changes: [ProposalChange], baseName: String = "Push A",
                          name: String? = nil) -> Proposal {
        Proposal(head: ProposalHead(id: "prop_1", routineId: "rt_1",
                                    changeCount: changes.filter { $0.kind != .kept }.count,
                                    createdAtMs: 1_000, source: ProposalSource(door: "ask")),
                 baseRevision: 1, baseName: baseName, name: name ?? baseName, changes: changes)
    }

    private let catalog = [Exercise(id: "bench-press", name: "Bench Press"),
                           Exercise(id: "incline-db-press", name: "Incline DB Press"),
                           Exercise(id: "cable-fly", name: "Cable Fly")]

    func testTheCompactDiffSpellsEachChangeTheWayTheDiffScreenDoes() {
        let changes = [
            ProposalChange(position: 1, kind: .retargeted, exerciseId: "bench-press",
                           before: ProposalChange.Targets(sets: 5, reps: 5, weightKg: 82.5),
                           after: ProposalChange.Targets(sets: 5, reps: 3, weightKg: 87.5)),
            ProposalChange(position: 2, kind: .added, exerciseId: "incline-db-press",
                           after: ProposalChange.Targets(sets: 3, reps: 10, weightKg: 24)),
            ProposalChange(position: 3, kind: .removed, exerciseId: "cable-fly",
                           before: ProposalChange.Targets(sets: 3, reps: 12, weightKg: 22.5),
                           loggedSets: 41),
        ]
        let rows = Ask.diffRows(of: proposal(changes), in: catalog)

        XCTAssertEqual(rows, [
            AskDiffRow(name: "Bench Press", change: "5 × 5 → 5 × 3 · 82.5 → 87.5"),
            AskDiffRow(name: "Incline DB Press", change: "+ added · 3 × 10 · 24"),
            AskDiffRow(name: "Cable Fly", change: "− removed from the routine · 41 logged sets kept"),
        ])
    }

    func testAKeptEntryIsNotARowAndARenameIs() {
        let changes = [
            ProposalChange(position: 1, kind: .kept, exerciseId: "bench-press",
                           before: ProposalChange.Targets(sets: 5, reps: 5),
                           after: ProposalChange.Targets(sets: 5, reps: 5)),
        ]
        let rows = Ask.diffRows(of: proposal(changes, name: "Push A2"), in: catalog)

        XCTAssertEqual(rows, [AskDiffRow(name: "name", change: "Push A → Push A2")])
    }

    func testAMovementTheCatalogHasNotAnsweredForKeepsItsId() {
        let changes = [ProposalChange(position: 1, kind: .removed, exerciseId: "front-squat")]
        let rows = Ask.diffRows(of: proposal(changes), in: catalog)

        XCTAssertEqual(rows, [AskDiffRow(name: "front-squat", change: "− removed from the routine")])
    }
}
