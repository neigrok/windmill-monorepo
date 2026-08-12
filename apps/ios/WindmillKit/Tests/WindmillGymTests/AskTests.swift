import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

// WHAT HAS TO BE TRUE FOR A CHAT TO BE ALLOWED IN THIS PRODUCT AT ALL. Ask is the second door onto
// the engine the connected log already describes, and every way it could quietly stop being that is
// pinned here:
//
//   · the receipt under an answer is the SERVER's count and this surface never adds one up,
//   · the door is not there mid-session, on any screen, for any account,
//   · a refusal repeats the log's own sentence and NOTHING is sold against it — no price, no
//     upgrade, no checkout, in any state Ask can be in,
//   · the thread that goes back out is a thread the server will accept: alternating, lifter at both
//     ends, inside both of its bounds,
//   · and nothing a lifter reads says coach.

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
    // The 200 as the contract spells it, decoded whole. Written out as bytes rather than built with
    // initialisers, because a CodingKey that drifted from the server's name is the one failure a
    // round trip through our own encoder could never catch.
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

    // An answer that called no tools and minted nothing is an ordinary answer, and both arrays are
    // simply absent on the wire — the room draws no evidence card and no proposal, never a failure.
    func testAnAnswerWithNoStepsAndNoProposalsIsStillAnAnswer() throws {
        let wire = #"{"answer":"Nothing has moved.","read":{"sets":0,"sessions":0,"weeks":0}}"#
        let answer = try JSONDecoder().decode(AskAnswer.self, from: Data(wire.utf8))

        XCTAssertEqual(answer.answer, "Nothing has moved.")
        XCTAssertEqual(answer.steps, [])
        XCTAssertEqual(answer.proposals, [])
        XCTAssertEqual(answer.read, ReadTally(sets: 0, sessions: 0, weeks: 0))
    }

    // THE RECEIPT IS NOT OPTIONAL. §L's rule is that every answer states what it read, and the count
    // is printable only because those rows were served to this connection. A body with no receipt is
    // prose this build cannot check, so it fails the read and becomes "Ask didn't answer" rather
    // than an answer drawn with the line quietly missing.
    func testProseWithNoReceiptIsNotAnAnswer() {
        let wire = #"{"answer":"Your bench is fine.","steps":[],"proposals":[]}"#
        XCTAssertThrowsError(try JSONDecoder().decode(AskAnswer.self, from: Data(wire.utf8)))
    }

    // What goes OUT: `from` is exactly `lifter` or `ask`, never `user`/`assistant` and never `coach`.
    func testATurnGoesOutInTheWiresOwnVocabulary() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let sent = try encoder.encode([AskTurn(from: .lifter, text: "hi"),
                                       AskTurn(from: .ask, text: "hello")])

        XCTAssertEqual(String(decoding: sent, as: UTF8.self),
                       #"[{"from":"lifter","text":"hi"},{"from":"ask","text":"hello"}]"#)
    }
}

final class AskReceiptTests: XCTestCase {
    // The design's own line, in the design's own order — sets, then weeks, then sessions.
    func testTheReadLineIsTheDesignsOwnSentence() {
        XCTAssertEqual(ReadTally(sets: 214, sessions: 34, weeks: 12).line,
                       "read 214 sets · 12 weeks · 34 sessions")
    }

    // One of each, spelled singular. A count that read "1 sets" under an answer about one workout
    // would be the room miscounting the one thing this line exists to state.
    func testTheReadLineCountsOneOfEachInTheSingular() {
        XCTAssertEqual(ReadTally(sets: 1, sessions: 1, weeks: 1).line,
                       "read 1 set · 1 week · 1 session")
    }

    // A zero is OMITTED rather than printed: "0 sessions" is a fact nobody needs and reads as a
    // failure. An answer that served no log rows at all says so in words instead of printing a line
    // of zeros — the honest version of "I read nothing".
    func testAZeroIsOmittedAndReadingNothingSaysSo() {
        XCTAssertEqual(ReadTally(sets: 40, sessions: 0, weeks: 3).line, "read 40 sets · 3 weeks")
        XCTAssertEqual(ReadTally(sets: 0, sessions: 0, weeks: 0).line, "read nothing from your log")
    }

    // THE STEPS ARE THE TOOLS' OWN MCP NAMES. The two doors share one catalog, and renaming a tool
    // for this screen would put a second vocabulary on it — a tool a lifter's own Claude calls
    // `get_stats` may not be called something else here.
    func testAStepIsTheToolsOwnNameAndAFailureSaysSo() {
        XCTAssertEqual(AskStep(tool: "get_stats").line, "get_stats")
        XCTAssertEqual(AskStep(tool: "get_stats", failed: true).line, "get_stats · no answer")
    }
}

final class AskThreadTests: XCTestCase {
    // A first question is one turn, and it is the lifter's — the server refuses a thread that opens
    // any other way, and Ask does not speak first anywhere in this product.
    func testTheFirstQuestionGoesOutAlone() {
        let thread = Ask.turns(after: [], asking: "Bench has been stuck at 82.5.")

        XCTAssertEqual(thread, [AskTurn(from: .lifter, text: "Bench has been stuck at 82.5.")])
    }

    // The whole conversation goes back out every time, because the server keeps none of it.
    func testAnAnsweredExchangeGoesBackOutAsBothOfItsTurns() {
        let thread = Ask.turns(after: [answered("first?", "first answer.")], asking: "second?")

        XCTAssertEqual(thread, [AskTurn(from: .lifter, text: "first?"),
                                AskTurn(from: .ask, text: "first answer."),
                                AskTurn(from: .lifter, text: "second?")])
    }

    // A QUESTION THAT WAS REFUSED PRODUCED NO ANSWER, so it carries no `ask` turn — and resending it
    // as a bare lifter turn would put two of them side by side, a 400 about a conversation the
    // lifter never had. The same is true of one still in flight.
    func testARefusedOrUnansweredQuestionIsNotPartOfTheThread() {
        let history = [answered("first?", "first answer."),
                       AskExchange(question: "refused?", outcome: .refused(AskRefusal(line: "no"))),
                       AskExchange(question: "in flight?", outcome: .waiting)]
        let thread = Ask.turns(after: history, asking: "next?")

        XCTAssertEqual(thread, [AskTurn(from: .lifter, text: "first?"),
                                AskTurn(from: .ask, text: "first answer."),
                                AskTurn(from: .lifter, text: "next?")])
    }

    // THE THREAD STAYS INSIDE BOTH OF THE SERVER'S BOUNDS. Turns alternate and the lifter is at both
    // ends, so a valid thread always holds an ODD number — the most that fits under a ceiling of
    // eight is seven, which is three answered exchanges plus the question being asked.
    func testALongConversationIsCutToTheOldestTheServerWillTake() {
        let history = (1...6).map { answered("q\($0)", "a\($0)") }
        let thread = Ask.turns(after: history, asking: "q7")

        XCTAssertEqual(thread.count, 7)
        XCTAssertLessThanOrEqual(thread.count, Ask.maxTurns)
        XCTAssertEqual(thread.map(\.from), [.lifter, .ask, .lifter, .ask, .lifter, .ask, .lifter])
        XCTAssertEqual(thread.map(\.text), ["q4", "a4", "q5", "a5", "q6", "a6", "q7"])
    }

    // A QUESTION IS NEVER SHORTENED TO FIT. `Ask.question(from:)` is the whole of what the composer
    // will send, and past the server's ceiling it sends NOTHING — because a clipped question is
    // answered half-asked and then sits in the thread as words the lifter never finished typing,
    // which is the room telling them what they said.
    func testAQuestionPastTheCeilingIsNotSentShortened() {
        let long = String(repeating: "squat 5x5 at 100kg, ", count: 80)     // 1600 bytes
        XCTAssertGreaterThan(long.utf8.count, Ask.maxTurnBytes)

        XCTAssertNil(Ask.question(from: long))
        XCTAssertFalse(Ask.fits(long))
    }

    // The ceiling itself is inclusive and counted in BYTES, because that is what the server counts —
    // a question of 1000 one-byte characters goes, and a question of 334 emoji does not, however few
    // characters that is.
    func testAQuestionIsAdmittedByBytesAndTheCeilingIsInclusive() {
        XCTAssertEqual(Ask.question(from: String(repeating: "a", count: 1_000))?.utf8.count, 1_000)
        XCTAssertNil(Ask.question(from: String(repeating: "a", count: 1_001)))
        XCTAssertNil(Ask.question(from: String(repeating: "🏋", count: 251)))    // 1004 bytes
    }

    // What is admitted is what was typed, trimmed and otherwise untouched — and a draft of nothing is
    // not a question however much whitespace it is spelled with.
    func testAnAdmittedQuestionIsTheLiftersOwnWordsAndBlankIsNotAQuestion() {
        XCTAssertEqual(Ask.question(from: "  Bench has been stuck at 82.5. \n"),
                       "Bench has been stuck at 82.5.")
        XCTAssertNil(Ask.question(from: "   \n  "))
        XCTAssertNil(Ask.question(from: ""))
    }

    // A LONG ANSWER IS CLIPPED ON THE WAY BACK OUT, and this is the case that bites: a few paragraphs
    // of prose passes 1000 bytes easily, and carrying one back whole would refuse the lifter's next
    // question with a 400 about a turn they never typed.
    func testAnAnswerTooLongForTheWireIsClippedRatherThanRefusingTheNextQuestion() {
        let long = String(repeating: "a", count: 1_400)
        let thread = Ask.turns(after: [answered("q", long)], asking: "next?")

        XCTAssertEqual(thread.count, 3)
        XCTAssertEqual(thread[1].text.utf8.count, Ask.maxTurnBytes)
        for turn in thread {
            XCTAssertLessThanOrEqual(turn.text.utf8.count, Ask.maxTurnBytes)
        }
    }

    // Cut on a CHARACTER boundary and never on a byte one: half an emoji is not a word, and the
    // ceiling is counted in UTF-8 bytes rather than in characters because that is what the server
    // counts.
    func testClippingCutsWholeCharactersAndCountsBytes() {
        let emoji = String(repeating: "🏋️", count: 400)     // well past 1000 bytes
        let clipped = Ask.clipped(emoji)

        XCTAssertLessThanOrEqual(clipped.utf8.count, Ask.maxTurnBytes)
        XCTAssertTrue(emoji.hasPrefix(clipped))
        XCTAssertFalse(clipped.contains("\u{FFFD}"))
        XCTAssertEqual(Ask.clipped("  spaced out \n"), "spaced out")
        XCTAssertEqual(Ask.clipped("   \n  "), "")
    }
}

final class AskDoorTests: XCTestCase {
    // NEVER OFFERED MID-SESSION, and the rule is stated once so Today and the proposal card cannot
    // come to different answers about it. The server enforces the same thing (409 `ask-session-open`)
    // — three clients each getting it right is not a rule.
    func testTheDoorIsNotThereWhileAWorkoutIsOpen() {
        XCTAssertFalse(Ask.doorIsOpen(signedIn: true, sessionIsOpen: true, onThisDeployment: true))
        XCTAssertTrue(Ask.doorIsOpen(signedIn: true, sessionIsOpen: false, onThisDeployment: true))
    }

    // Signed out there is no account for Ask to read, so the door is absent rather than drawn onto a
    // 401 — the same reason a proposal card is never on a signed-out Today.
    func testTheDoorIsNotThereWithoutAnAccountOrWithoutAnAskOnThisDeployment() {
        XCTAssertFalse(Ask.doorIsOpen(signedIn: false, sessionIsOpen: false, onThisDeployment: true))
        XCTAssertFalse(Ask.doorIsOpen(signedIn: true, sessionIsOpen: false, onThisDeployment: false))
        XCTAssertFalse(Ask.doorIsOpen(signedIn: false, sessionIsOpen: true, onThisDeployment: false))
    }
}

final class AskRefusalTests: XCTestCase {
    // THE LOG'S OWN WORDS. Every sentence in the ladder is written on the server, so the three
    // surfaces cannot drift apart in tone, and none of them is retried into: a refusal the server
    // MEANT is a fact, not a connection problem.
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

    // The three that are worth trying again: a silence on the wire, a bad gateway, and a 2xx whose
    // body this build could not read. The lifter's consequence is identical in all three — no answer
    // — so all three say so and offer the door back.
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

    // THE ONE REFUSAL THAT TAKES THE DOOR AWAY. A deployment with no Anthropic key does not mount the
    // route, so the framework's own 404 comes back with no body at all — there is no Ask here to try
    // again at, and the entry goes rather than staying as a door onto a sentence.
    func testNoAskOnThisDeploymentClosesTheDoorRatherThanFailing() {
        let absent = AskRefusal(refusal(404))

        XCTAssertEqual(absent.line, "Ask isn’t available on this Windmill.")
        XCTAssertTrue(absent.closesTheDoor)
        XCTAssertFalse(absent.mayRetry)
    }

    // A refusal the server sent no sentence with still says something a person can act on, and never
    // a status code — a number is not a thing anyone can do anything about.
    func testARefusalWithNoSentenceStillSaysSomethingAPersonCanRead() {
        XCTAssertEqual(AskRefusal(refusal(500)).line, "That didn’t go through")
        XCTAssertFalse(AskRefusal(refusal(500)).mayRetry)
    }

    // NOTHING IS SOLD AGAINST A REFUSAL, and the two that would tempt it most are the daily limit and
    // the AI ceiling. Windmill One cannot be bought — `paidPlansOpen()` is a hardcoded false and
    // BillingApi 503s — so an upgrade offered here would advertise a purchase that fails, which is
    // the trade this brand's mission forecloses. This walks every sentence Ask can put on screen.
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

    // THE WORD LEAVES EVERY SURFACE A LIFTER READS. There is no coach — there is your agent — and the
    // coach SHARE is a different object that keeps the word honestly, which is why this walks Ask's
    // own copy rather than the whole product's.
    func testNothingALifterReadsInAskSaysCoach() {
        let spoken = [Ask.title, Ask.subtitle, Ask.scope, Ask.dailyLimit, Ask.freeDoor, Ask.connect,
                      Ask.proposalNote, Ask.placeholder, Ask.waiting, Ask.tooLong]

        for sentence in spoken {
            XCTAssertFalse(sentence.lowercased().contains("coach"), sentence)
        }
    }

    // THE CAP IS STATED BEFORE IT IS HIT, not discovered as a 429 (contract §4). It is a design
    // artifact rather than an ops detail — Ask is the first thing here with a marginal cost per use —
    // and both numbers are the server's own (`kAskPerDay` / `kAskBackToBack`, AskService.h), said in
    // the same words the refusal will use if a lifter ever reaches it.
    func testTheDailyCapIsSaidOnScreenBeforeARefusalEverSaysIt() {
        XCTAssertTrue(Ask.dailyLimit.contains("about ten questions a day"))
        XCTAssertTrue(Ask.dailyLimit.contains("three back to back"))
        XCTAssertTrue(Ask.dailyLimit.contains("it answers again later"))
        // A cap that keeps it open to everybody, and nothing offered against reaching it.
        XCTAssertTrue(Ask.dailyLimit.contains("keeps Ask open to everyone"))
    }

    // A QUESTION TOO LONG IS TOLD, NOT TRIMMED. The composer says it while the words can still be
    // edited, in the server's own terms — the 400 a lifter would otherwise spend a question to read.
    func testAQuestionPastTheCeilingIsToldRatherThanCutDown() {
        XCTAssertEqual(Ask.tooLong, "That question is longer than Ask takes. Shorten it to send.")
    }

    // The free door is the strongest proof we have that the MCP thesis is real, and it costs one
    // paragraph: an in-app chat that tells you how to stop needing it. Shipping Ask without it would
    // be the retreat, so the sentence itself is pinned.
    // THE THIRD RUNG OF THE SAFEGUARD LADDER, said before Ask has said anything: it cannot edit or
    // delete a logged set. The empty state names the boundary AND where the job actually gets done,
    // because "it refuses" is only half an answer to somebody holding a set typed as 105 that was 100.
    func testTheEmptyStateNamesWhatAskCanNeverDo() {
        XCTAssertTrue(Ask.scope.contains("It can never change what you lifted"))
        XCTAssertTrue(Ask.scope.contains("a set that needs fixing is yours, in the log"))
        XCTAssertTrue(Ask.subtitle.contains("proposes only"))
    }

    // AND IT NAMES THE SAME TOOLS THE DOOR IT OPENS NAMES. `Ask.connect` pushes the room's
    // invitation, whose precondition lists what web/src/shell/connect/ConnectPage.jsx actually
    // carries a recipe for — Claude Desktop, Claude Code, Cursor, Codex, any MCP client, and nothing
    // for ChatGPT. Two lists on one surface is how a promise gets made that no page keeps.
    func testTheEmptyStatePointsAtTheFreeDoor() {
        XCTAssertTrue(Ask.freeDoor.contains("Claude, Cursor, Codex or anything else that speaks MCP"))
        XCTAssertTrue(Ask.freeDoor.contains("connect it instead"))
        XCTAssertTrue(Ask.freeDoor.contains("it’s free"))
        XCTAssertTrue(Ask.freeDoor.contains("it knows the rest of your life"))
        XCTAssertFalse(Ask.freeDoor.contains("ChatGPT"))
        XCTAssertFalse(ConnectedLog.precondition.contains("ChatGPT"))
    }

    // What is promised under a proposal in the stream, before the lifter has walked to the diff.
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

    // The compact card §L draws in the stream, and every word of it is the diff screen's own. A card
    // and the document it opens describing one removal two different ways is exactly the drift this
    // product keeps a single `Readout` to prevent.
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

    // A kept entry is the document rather than a change, so it is not a row here either — four rows
    // of nothing between the lifter and the two that matter is the failure this drops.
    func testAKeptEntryIsNotARowAndARenameIs() {
        let changes = [
            ProposalChange(position: 1, kind: .kept, exerciseId: "bench-press",
                           before: ProposalChange.Targets(sets: 5, reps: 5),
                           after: ProposalChange.Targets(sets: 5, reps: 5)),
        ]
        let rows = Ask.diffRows(of: proposal(changes, name: "Push A2"), in: catalog)

        XCTAssertEqual(rows, [AskDiffRow(name: "name", change: "Push A → Push A2")])
    }

    // A movement the catalog has not answered for keeps its id on screen rather than a blank: a slug
    // a lifter can still recognise beats a hole where the movement should be.
    func testAMovementTheCatalogHasNotAnsweredForKeepsItsId() {
        let changes = [ProposalChange(position: 1, kind: .removed, exerciseId: "front-squat")]
        let rows = Ask.diffRows(of: proposal(changes), in: catalog)

        XCTAssertEqual(rows, [AskDiffRow(name: "front-squat", change: "− removed from the routine")])
    }
}
