import Foundation
import Combine

struct CoachRequest: Codable, Equatable, Sendable {
    let thread: String
    let question: String
    let requestId: String
    var attachmentIds: [String]? = nil
}

@MainActor
final class CoachRequests: ObservableObject {
    struct Seat: Codable {
        var thread = Ask.mintThreadId()
        var drafts: [String: String] = [:]
        var requests: [String: CoachRequest] = [:]
        var photos: [String: CoachPhotoDraft]?
    }

    private let url: URL
    private var seats: [String: Seat]
    private let unreadable: Bool

    init(url: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("windmill-gym-coach.json")) {
        self.url = url
        let data = try? Data(contentsOf: url)
        let decoded = data.flatMap { try? JSONDecoder().decode([String: Seat].self, from: $0) }
        unreadable = FileManager.default.fileExists(atPath: url.path) && decoded == nil
        seats = decoded ?? [:]
    }

    func seat(_ user: String) -> Seat { seats[user] ?? Seat() }

    func select(_ thread: String, user: String, draft: String) throws {
        var seat = seat(user)
        seat.thread = thread
        seat.drafts[thread] = draft
        try write(seat, user: user)
    }

    func save(_ request: CoachRequest, user: String, clearDraft: Bool = true) throws {
        var seat = seat(user)
        seat.thread = request.thread
        seat.requests[request.thread] = request
        if clearDraft { seat.drafts[request.thread] = "" }
        try write(seat, user: user)
    }

    func resolve(_ request: CoachRequest, user: String) throws {
        var seat = seat(user)
        guard seat.requests[request.thread]?.requestId == request.requestId else { return }
        seat.requests[request.thread] = nil
        try write(seat, user: user)
    }

    func savePhoto(_ photo: CoachPhotoDraft?, data: Data? = nil, thread: String, user: String) throws {
        var seat = seat(user)
        let previous = seat.photos?[thread]
        if let photo, let data {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: photoURL(photo.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        if seat.photos == nil { seat.photos = [:] }
        seat.photos?[thread] = photo
        try write(seat, user: user)
        if let previous, previous.id != photo?.id { try? FileManager.default.removeItem(at: photoURL(previous.id)) }
    }

    func photoData(_ id: String, thread: String, user: String) throws -> Data {
        guard seat(user).photos?[thread]?.id == id else { throw CocoaError(.fileReadNoPermission) }
        return try Data(contentsOf: photoURL(id))
    }

    private func photoURL(_ id: String) -> URL {
        url.deletingLastPathComponent().appendingPathComponent("coach-photo-\(id).jpg")
    }

    private func write(_ seat: Seat, user: String) throws {
        guard !unreadable else { throw CocoaError(.fileReadCorruptFile) }
        var next = seats
        next[user] = seat
        let data = try JSONEncoder().encode(next)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        seats = next
    }
}
