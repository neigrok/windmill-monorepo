import XCTest
@testable import WindmillGym
@testable import WindmillPlatform

private func refusal(_ status: Int, code: String = "", message: String = "") -> WindmillApiError {
    var fields: [String] = []
    if !message.isEmpty { fields.append(#""error":"\#(message)""#) }
    if !code.isEmpty { fields.append(#""code":"\#(code)""#) }
    return .refused(status, Refusal(Data("{\(fields.joined(separator: ","))}".utf8)))
}

final class NoteWireTests: XCTestCase {
    func testANoteDecodesFromTheWiresOwnShape() throws {
        let wire = """
        {"id":"note_0a1b2c3d","position":2,"title":"How I want to be talked to",
         "body":"Blunt. No praise.\\nSkip the warm-up talk.","updatedAt":1754000000000}
        """
        let note = try JSONDecoder().decode(Note.self, from: Data(wire.utf8))

        XCTAssertEqual(note, Note(id: "note_0a1b2c3d", position: 2, title: "How I want to be talked to",
                                  body: "Blunt. No praise.\nSkip the warm-up talk.",
                                  updatedAtMs: 1_754_000_000_000))
        XCTAssertEqual(note.firstLine, "Blunt. No praise.")
    }

    func testAnEmptyBodyIsANoteAndItsRowCarriesNoMeta() throws {
        let wire = #"{"id":"note_1","position":0,"title":"Goal","body":""}"#
        let note = try JSONDecoder().decode(Note.self, from: Data(wire.utf8))

        XCTAssertEqual(note.body, "")
        XCTAssertEqual(note.firstLine, "")
        XCTAssertEqual(note.updatedAtMs, 0)
    }

    func testTheWriteIsATitleAndABodyAndNothingElse() throws {
        let sent = try JSONEncoder().encode(NoteWrite(title: "Goal", body: "Squat 140 by winter"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: String])

        XCTAssertEqual(json, ["title": "Goal", "body": "Squat 140 by winter"])
    }

    func testAMintedNoteIdIsOneTheServerWillTake() {
        let allowed = CharacterSet(charactersIn:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")

        for _ in 0..<50 {
            let minted = Notes.mintNoteId()
            XCTAssertTrue(minted.hasPrefix("note_"), minted)
            XCTAssertNil(minted.rangeOfCharacter(from: allowed.inverted), minted)
        }
        XCTAssertEqual(Set((0..<200).map { _ in Notes.mintNoteId() }).count, 200)
    }
}

final class NoteBoundsTests: XCTestCase {
    func testTheThreeBoundsAreTheServersExactly() {
        XCTAssertEqual(Notes.maxNotes, 10)
        XCTAssertEqual(Notes.maxTitleCharacters, 60)
        XCTAssertEqual(Notes.maxBodyBytes, 500)
    }

    func testADraftWithinBoundsIsWrittenTrimmed() {
        XCTAssertEqual(Notes.write(title: "  Goal \n", body: "\nSquat 140 by winter  "),
                       NoteWrite(title: "Goal", body: "Squat 140 by winter"))
        XCTAssertEqual(Notes.write(title: "Goal", body: ""), NoteWrite(title: "Goal", body: ""))
        XCTAssertNil(Notes.refusal(title: String(repeating: "a", count: 60), body: ""))
        XCTAssertNil(Notes.refusal(title: "Goal", body: String(repeating: "a", count: 500)))
    }

    // Refused in place, in the server's own sentence, before anything goes out.
    func testOverTheBoundIsRefusedInTheServersOwnSentence() {
        XCTAssertEqual(Notes.refusal(title: "", body: "x"), "a note needs a title")
        XCTAssertEqual(Notes.refusal(title: "   \n", body: "x"), "a note needs a title")
        XCTAssertEqual(Notes.refusal(title: String(repeating: "a", count: 61), body: ""),
                       "a title runs to 60 characters")
        XCTAssertEqual(Notes.refusal(title: "Goal", body: String(repeating: "a", count: 501)),
                       "a note runs to 500 bytes")
        XCTAssertEqual(Notes.refusal(title: "Goal", body: String(repeating: "🏋", count: 126)),   // 504 bytes
                       "a note runs to 500 bytes")
        XCTAssertNil(Notes.write(title: "", body: "x"))
    }

    func testTheTitleIsBoundedInCharactersAndTheBodyInBytes() {
        XCTAssertNil(Notes.refusal(title: String(repeating: "🏋", count: 60), body: ""))
        XCTAssertEqual(Notes.bodyBytes(String(repeating: "🏋", count: 100)), 400)
        XCTAssertEqual(Notes.bodyBytes("  abc  "), 3)
    }

    func testTheByteCounterAppearsOnlyInTheLastFifth() {
        XCTAssertNil(Notes.counter(bytes: 0))
        XCTAssertNil(Notes.counter(bytes: 70))
        XCTAssertNil(Notes.counter(bytes: 399))
        XCTAssertEqual(Notes.counter(bytes: 400), "400 of 500 bytes")
        XCTAssertEqual(Notes.counter(bytes: 500), "500 of 500 bytes")
        XCTAssertEqual(Notes.counter(bytes: 512), "512 of 500 bytes")
    }

    // The same rule as the byte counter: the last fifth of the bound, alarm past it, code points counted.
    func testTheTitleCounterAppearsOnlyInTheLastFifthAndCountsCodePoints() {
        XCTAssertEqual(Notes.counterFromCharacters, 48)
        XCTAssertNil(Notes.counter(characters: 0))
        XCTAssertNil(Notes.counter(characters: 47))
        XCTAssertEqual(Notes.counter(characters: 48), "48 of 60 characters")
        XCTAssertEqual(Notes.counter(characters: 53), "53 of 60 characters")
        XCTAssertEqual(Notes.counter(characters: 60), "60 of 60 characters")
        XCTAssertEqual(Notes.counter(characters: 61), "61 of 60 characters")

        XCTAssertEqual(Notes.titleCharacters(String(repeating: "a", count: 53)), 53)
        XCTAssertEqual(Notes.titleCharacters("\u{1F3CB}\u{FE0F}\u{200D}\u{2640}\u{FE0F}"), 5)
    }

    func testTheAddRowStopsOfferingAtTenAndSaysSoInNumerals() {
        XCTAssertTrue(Notes.canAdd(0))
        XCTAssertTrue(Notes.canAdd(9))
        XCTAssertFalse(Notes.canAdd(10))
        XCTAssertEqual(Notes.full, "10 of 10 notes. Delete one to add another.")
    }

    func testARefusalFromTheLogIsRepeatedVerbatimAndASilenceIsSaidPlainly() {
        XCTAssertEqual(NotesRefusal(refusal(409, code: "notes-full",
                                            message: "10 of 10 notes. Delete one to add another.")).line,
                       "10 of 10 notes. Delete one to add another.")
        XCTAssertEqual(NotesRefusal(refusal(400, message: "a title runs to 60 characters")).line,
                       "a title runs to 60 characters")
        XCTAssertEqual(NotesRefusal(refusal(500)).line, "the log didn’t answer — nothing changed")
        XCTAssertEqual(NotesRefusal(WindmillApiError.malformed).line, "the log didn’t answer — nothing changed")
        XCTAssertEqual(NotesRefusal(WindmillApiError.offline).line, "Can’t reach windmill.works")
    }
}

final class NotesScreenWordsTests: XCTestCase {
    func testTheHeadIsTheHonestyLineAndWhatTheNotesAreFor() {
        XCTAssertEqual(Notes.honesty, "Any agent you connect can read these too.")
        XCTAssertEqual(Notes.purpose, "what you write for Coach")
        XCTAssertEqual(Notes.precedence, "Top note wins.")
        XCTAssertEqual(Notes.add, "Add a note")
        XCTAssertEqual(Notes.title, "Notes")
    }

    func testTheTwoPlaceholdersAreAddressedToTheAgentAndNeitherIsAboutABody() {
        XCTAssertEqual(Notes.placeholders, ["How I want to be talked to", "What I am training for"])
        for title in Notes.placeholders {
            XCTAssertFalse(title.lowercased().contains("body"), title)
        }
    }

    func testAPlaceholderOpensTheEditorWithItsTitleAndStoresNothing() {
        let draft = NoteDraft(placeholder: "What I am training for")

        XCTAssertEqual(draft.title, "What I am training for")
        XCTAssertEqual(draft.body, "")
        XCTAssertFalse(draft.stored)
        XCTAssertTrue(draft.id.hasPrefix("note_"))

        let editing = NoteDraft(editing: Note(id: "note_9", position: 0, title: "Goal", body: "b"))
        XCTAssertTrue(editing.stored)
        XCTAssertEqual(editing.id, "note_9")
    }

    func testDeletingANoteIsAskedFirst() {
        XCTAssertEqual(Notes.delete, "Delete note")
        XCTAssertEqual(Notes.deleteTitle, "Delete this note?")
        XCTAssertEqual(Notes.deleteConfirm, "Delete")
        XCTAssertEqual(Notes.keep, "Keep it")
    }

    func testSignedOutTheScreenIsASignInDoorInOneSentence() {
        XCTAssertEqual(Notes.needsSignIn, "Notes live with your account, so they need you signed in.")
        XCTAssertEqual(Notes.signIn, "Sign in")
    }

    func testTheSettingsLineNamesWhatCoachExcludes() {
        XCTAssertEqual(Settings.coachReads, "Coach reads your notes, not your settings.")
    }
}
