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

    func testAStepIsTheToolsOwnNameAndAFailureSaysSo() {
        XCTAssertEqual(AskStep(tool: "get_stats").line, "get_stats")
        XCTAssertEqual(AskStep(tool: "get_stats", failed: true).line, "get_stats · no answer")
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
        XCTAssertEqual(Ask.needsSignIn, "Ask reads your log, so it needs you signed in.")
        XCTAssertEqual(Ask.signIn, "Sign in")
        XCTAssertEqual(Ask.absentLine, "Ask isn’t available on this Windmill.")
    }
}

final class AskRefusalTests: XCTestCase {
    func testEveryRefusalTheServerWritesIsRepeatedVerbatimAndNotRetried() {
        let ladder: [(WindmillApiError, String)] = [
            (refusal(401, message: "sign in to open your training log"),
             "sign in to open your training log"),
            (refusal(400, message: "ask a question first"), "ask a question first"),
            (refusal(409, code: "ask-session-open",
                     message: "finish your workout first — Ask reads a log that has stopped moving"),
             "finish your workout first — Ask reads a log that has stopped moving"),
            (refusal(429, code: "ask-daily-limit",
                     message: "that’s Ask for now — it answers about ten questions a day"),
             "that’s Ask for now — it answers about ten questions a day"),
            (refusal(429, code: "ask-out-of-budget",
                     message: "this account has reached its AI ceiling for the last 30 days"),
             "this account has reached its AI ceiling for the last 30 days"),
            (refusal(503, message: "Ask isn’t available right now"), "Ask isn’t available right now"),
        ]

        for (error, said) in ladder {
            let refused = AskRefusal(error)
            XCTAssertEqual(refused.line, said)
            XCTAssertFalse(refused.mayRetry, said)
            XCTAssertFalse(refused.closesTheDoor, said)
        }
    }

    func testTheThreeSilencesOfferTheDoorAgain() {
        let bad = AskRefusal(refusal(502, message: "Ask didn’t answer. Try again in a moment"))
        XCTAssertEqual(bad.line, "Ask didn’t answer. Try again in a moment")
        XCTAssertTrue(bad.mayRetry)

        let offline = AskRefusal(WindmillApiError.offline)
        XCTAssertEqual(offline.line, "Can't reach windmill.works")
        XCTAssertTrue(offline.mayRetry)

        let unreadable = AskRefusal(WindmillApiError.malformed)
        XCTAssertEqual(unreadable.line, "Ask didn’t answer. Try again in a moment")
        XCTAssertTrue(unreadable.mayRetry)
        XCTAssertFalse(unreadable.closesTheDoor)
    }

    func testAFullOrTakenThreadOpensANewConversationRatherThanFailing() {
        let full = AskRefusal(refusal(409, code: "ask-thread-full",
                                      message: "that conversation is full — this starts a new one"))
        XCTAssertEqual(full.line, "that conversation is full — this starts a new one")
        XCTAssertTrue(full.opensAFreshThread)
        XCTAssertTrue(full.mayRetry)
        XCTAssertFalse(full.closesTheDoor)

        let taken = AskRefusal(refusal(409, code: "ask-thread-taken", message: "mint a new one"))
        XCTAssertTrue(taken.opensAFreshThread)
        XCTAssertTrue(taken.mayRetry)

        let midSession = AskRefusal(refusal(409, code: "ask-session-open",
                                            message: "finish your workout first"))
        XCTAssertFalse(midSession.opensAFreshThread)
        XCTAssertFalse(midSession.mayRetry)
    }

    func testNoAskOnThisDeploymentClosesTheDoorRatherThanFailing() {
        let absent = AskRefusal(refusal(404))

        XCTAssertEqual(absent.line, "Ask isn’t available on this Windmill.")
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
        let spoken = [Ask.title, Ask.subtitle, Ask.scope, Ask.dailyLimit, Ask.freeDoor, Ask.connect,
                      Ask.proposalNote, Ask.placeholder, Ask.waiting, Ask.tooLong,
                      AskRefusal(refusal(429, code: "ask-daily-limit", message: "that’s Ask for now")).line,
                      AskRefusal(refusal(404)).line,
                      ReadTally(sets: 214, sessions: 34, weeks: 12).line]

        for sentence in spoken {
            for word in sold {
                XCTAssertFalse(sentence.contains(word), "\(sentence) offers \(word)")
            }
        }
    }

    func testNothingALifterReadsInAskSaysCoach() {
        let spoken = [Ask.title, Ask.subtitle, Ask.scope, Ask.dailyLimit, Ask.freeDoor, Ask.connect,
                      Ask.proposalNote, Ask.placeholder, Ask.waiting, Ask.tooLong]

        for sentence in spoken {
            XCTAssertFalse(sentence.lowercased().contains("coach"), sentence)
        }
    }

    func testTheDailyCapIsSaidOnScreenBeforeARefusalEverSaysIt() {
        XCTAssertTrue(Ask.dailyLimit.contains("about ten questions a day"))
        XCTAssertTrue(Ask.dailyLimit.contains("three back to back"))
        XCTAssertTrue(Ask.dailyLimit.contains("it answers again later"))
        XCTAssertTrue(Ask.dailyLimit.contains("keeps Ask open to everyone"))
    }

    func testAQuestionPastTheCeilingIsToldRatherThanCutDown() {
        XCTAssertEqual(Ask.tooLong, "That question is longer than Ask takes. Shorten it to send.")
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
        XCTAssertTrue(Ask.freeDoor.contains("it knows the rest of your life"))
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
