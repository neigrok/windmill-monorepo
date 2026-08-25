import Foundation
import WindmillPlatform

// A note is a title and a body, stored verbatim, account-only: nothing here is written to the device.
public struct Note: Equatable, Decodable, Sendable, Identifiable {
    public let id: String
    public let position: Int
    public let title: String
    public let body: String
    public let updatedAtMs: Int64

    public init(id: String, position: Int, title: String, body: String, updatedAtMs: Int64 = 0) {
        self.id = id
        self.position = position
        self.title = title
        self.body = body
        self.updatedAtMs = updatedAtMs
    }

    enum CodingKeys: String, CodingKey {
        case id, position, title, body
        case updatedAtMs = "updatedAt"
    }

    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        id = try fields.decode(String.self, forKey: .id)
        position = try fields.decodeIfPresent(Int.self, forKey: .position) ?? 0
        title = try fields.decode(String.self, forKey: .title)
        body = try fields.decodeIfPresent(String.self, forKey: .body) ?? ""
        updatedAtMs = try fields.decodeIfPresent(Int64.self, forKey: .updatedAtMs) ?? 0
    }

    // The row's meta: the body's first line, or nothing.
    public var firstLine: String {
        body.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    }
}

public struct NoteWrite: Equatable, Encodable, Sendable {
    public let title: String
    public let body: String

    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }
}

// The three bounds are the server's exactly; over-limit is refused here in the server's own sentence.
public enum Notes {
    public static let maxNotes = 10
    public static let maxTitleCharacters = 60
    public static let maxBodyBytes = 500
    // A counter is chrome a short note never carries: each appears in the last fifth of its bound.
    public static let counterFromBytes = 400
    public static let counterFromCharacters = 48

    public static let title = "Notes"
    public static let honesty = "Any agent you connect can read these too."
    public static let purpose = "what you write for Coach"
    public static let precedence = "Top note wins."
    public static let add = "Add a note"
    public static let full = "10 of 10 notes. Delete one to add another."
    public static let placeholders = ["How I want to be talked to", "What I am training for"]

    public static let titleField = "Title"
    public static let bodyField = "What Coach should know"
    public static let save = "Save"
    public static let delete = "Delete note"
    public static let deleteTitle = "Delete this note?"
    public static let deleteConfirm = "Delete"
    public static let keep = "Keep it"

    public static let needsSignIn = "Notes live with your account, so they need you signed in."
    public static let signIn = "Sign in"
    public static let reading = "reading your notes…"
    public static let noAnswer = "the log didn’t answer — nothing changed"

    public static let needsTitle = "a note needs a title"
    public static let titleTooLong = "a title runs to 60 characters"
    public static let bodyTooLong = "a note runs to 500 bytes"

    // The server's alphabet: [A-Za-z0-9_-], the same discipline as a thread id.
    public static func mintNoteId() -> String {
        "note_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    public static func canAdd(_ count: Int) -> Bool { count < maxNotes }

    // nil while the draft is within bounds; otherwise the sentence the server would answer with.
    public static func refusal(title: String, body: String) -> String? {
        let named = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if named.isEmpty { return needsTitle }
        if titleCharacters(named) > maxTitleCharacters { return titleTooLong }
        if body.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count > maxBodyBytes { return bodyTooLong }
        return nil
    }

    public static func write(title: String, body: String) -> NoteWrite? {
        guard refusal(title: title, body: body) == nil else { return nil }
        return NoteWrite(title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                         body: body.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public static func bodyBytes(_ body: String) -> Int {
        body.trimmingCharacters(in: .whitespacesAndNewlines).utf8.count
    }

    public static func counter(bytes: Int) -> String? {
        guard bytes >= counterFromBytes else { return nil }
        return "\(bytes) of \(maxBodyBytes) bytes"
    }

    // Code points, not grapheme clusters: `char_length` is what the column checks.
    public static func titleCharacters(_ title: String) -> Int {
        title.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
    }

    public static func counter(characters: Int) -> String? {
        guard characters >= counterFromCharacters else { return nil }
        return "\(characters) of \(maxTitleCharacters) characters"
    }
}

// The log's own sentence when it refused, a plain one when it did not answer; never rewritten.
public struct NotesRefusal: Equatable, Error, Sendable {
    public let line: String

    public init(line: String) {
        self.line = line
    }

    public init(_ error: Error) {
        guard let failure = error as? WindmillApiError else {
            self = NotesRefusal(line: Notes.noAnswer)
            return
        }
        switch failure {
        case .offline: self = NotesRefusal(line: failure.line)
        case .malformed: self = NotesRefusal(line: Notes.noAnswer)
        case .refused(_, let refusal): self = NotesRefusal(line: refusal.message ?? Notes.noAnswer)
        }
    }
}
