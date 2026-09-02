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

    // No question, on any surface: the row leaves the drawn list, the editor closes in the same handler,
    // and the nine-second window carries the way back — the room's answer for every other delete.
    func testDeletingANoteTakesTheWindowRatherThanAskingFirst() throws {
        XCTAssertEqual(Notes.delete, "Delete note")
        XCTAssertEqual(WithheldWords.note, "Note deleted.")
        XCTAssertTrue(Withheld.Kind.note.isDelete)
        XCTAssertFalse(Withheld.Kind.note.isHeldOnDisk, "a note has no hold on disk to wait in")

        let screen = try source("NotesScreen.swift")
        XCTAssertFalse(screen.contains("confirmationDialog"), "the delete asks nothing first")
        XCTAssertTrue(screen.contains("doors.delete(draft.id)\n        dismiss()"),
                      "withhold, then leave the editor in the same handler")
    }

    // The cap counts what the STORE holds. Read off the drawn rows, ten notes would become nine while the
    // window held one: the cap line would stop being drawn while it is still true and `Add a note` would
    // stand over a store that refuses.
    func testTheNotesCapIsCountedOffTheStoreAndNotOffTheDrawnRows() throws {
        XCTAssertTrue(Notes.canAdd(9))
        XCTAssertFalse(Notes.canAdd(10))
        XCTAssertEqual(Notes.full, "10 of 10 notes. Delete one to add another.")

        let screen = try source("NotesScreen.swift")
        XCTAssertTrue(screen.contains("list(standing: Self.standing(notes, outside: withheld))"),
                      "the state is read off the store's list, and only the rows are filtered")
        XCTAssertTrue(screen.contains("private func list(standing: [Note]) -> some View"))
        XCTAssertTrue(screen.contains("let count = standing.count"))
        XCTAssertTrue(screen.contains("private func foot(stored count: Int)"))
        XCTAssertTrue(screen.contains("if Notes.canAdd(count) {"))
    }

    private func source(_ name: String) throws -> String {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/WindmillGym/\(name)")
        return try String(contentsOf: file, encoding: .utf8)
    }

    func testSignedOutTheScreenIsASignInDoorInOneSentence() {
        XCTAssertEqual(Notes.needsSignIn, "Notes live with your account, so they need you signed in.")
        XCTAssertEqual(Notes.signIn, "Sign in")
    }
}

// The cap counts what the STORE holds, so it has to hear the settle as well as the hold. A count read
// off the list the server last served freezes at the pre-delete number for the rest of the visit: at
// the cap the room goes on drawing `10 of 10 notes. Delete one to add another.` over nine rows, with
// no Add row — a refusal naming the way out the lifter has already taken.
@MainActor
final class NotesCapTests: XCTestCase {
    private func ten() -> [Note] {
        (0..<10).map { Note(id: "note_\($0)", position: $0, title: "n\($0)", body: "") }
    }

    private func waitForWindowsToClose(_ open: WithheldWindow, timeout: TimeInterval = 4) async {
        let deadline = Date().addingTimeInterval(timeout)
        while open.isOpen, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testASettledDeleteLeavesTheRowGoneAndGivesTheAddRowBack() async {
        let open = WithheldWindow(windowMs: 80)
        let served = ten()
        XCTAssertFalse(Notes.canAdd(NotesScreen.standing(served, outside: open).count),
                       "ten notes is the cap, and the cap line stands")

        await open.hold(Withheld(.note, subject: "note_3", line: WithheldWords.note))

        XCTAssertEqual(NotesScreen.standing(served, outside: open).count, 10,
                       "inside its window the note is still stored, so the cap line is still true")
        XCTAssertFalse(Notes.canAdd(NotesScreen.standing(served, outside: open).count))
        XCTAssertTrue(open.hides(.note, "note_3"), "and the row it holds is out of the drawn list")

        await waitForWindowsToClose(open)
        XCTAssertFalse(open.isOpen, "the window closed and the delete went")

        let standing = NotesScreen.standing(served, outside: open)
        XCTAssertEqual(standing.map(\.id),
                       ["note_0", "note_1", "note_2", "note_4", "note_5",
                        "note_6", "note_7", "note_8", "note_9"],
                       "nine rows, and the one the delete took is not one of them")
        XCTAssertTrue(Notes.canAdd(standing.count), "and Add a note is offered again")
    }

    // A settle the log refused is not a delete that landed: the note is still the store's, the row is
    // drawn again, and the cap stays exactly where it was.
    func testADeleteTheLogRefusedLeavesTheNoteStoredAndTheCapWhereItWas() async {
        let open = WithheldWindow(windowMs: 80)
        let served = ten()

        await open.hold(Withheld(.note, subject: "note_3", line: WithheldWords.note,
                                 settle: { false }))
        await waitForWindowsToClose(open)

        let standing = NotesScreen.standing(served, outside: open)
        XCTAssertEqual(standing.count, 10, "the log kept it, so the store still holds ten")
        XCTAssertFalse(Notes.canAdd(standing.count))
        XCTAssertFalse(open.hides(.note, "note_3"), "and the row is drawn again")
    }
}
