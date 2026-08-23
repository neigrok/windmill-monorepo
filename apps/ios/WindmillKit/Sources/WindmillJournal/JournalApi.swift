import Foundation
import WindmillPlatform

// PageStore depends on this protocol, not on JournalApi.
public protocol PageSyncing {
    func put(_ page: Page) async throws -> Page
    func range(from: LocalDay, to: LocalDay) async throws -> [Page]
}

public struct JournalApi: PageSyncing {
    private let api: WindmillApi

    public init(api: WindmillApi) {
        self.api = api
    }

    // A day never written is a 404, returned as nil rather than thrown.
    public func page(_ day: LocalDay) async throws -> Page? {
        do {
            return try await api.get("/v1/journal/page/\(day.iso)", as: Page.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    // Answers with whatever page won.
    public func put(_ page: Page) async throws -> Page {
        try await api.send("PUT", "/v1/journal/page/\(page.day.iso)", body: Write(page), as: Page.self)
    }

    // A window of the canvas [from, to], oldest first.
    public func range(from: LocalDay, to: LocalDay) async throws -> [Page] {
        try await api.get("/v1/journal/pages?from=\(from.iso)&to=\(to.iso)", as: Pages.self).pages
    }

    // Everything past an HLC cursor, ascending; `Hlc.zero` asks for the whole history.
    public func since(_ cursor: Hlc, limit: Int = 500) async throws -> [Page] {
        let encoded = cursor.description.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "0:0:"
        return try await api.get("/v1/journal/pages?since=\(encoded)&limit=\(limit)", as: Pages.self).pages
    }

    struct Pages: Decodable { let pages: [Page] }

    // `updatedAt` is server time; a client must not send one.
    struct Write: Encodable {
        let body: String
        let mood: Int
        let energy: Int
        let source: String
        let stamp: String

        init(_ page: Page) {
            body = page.body
            mood = page.mood.rawValue
            energy = page.energy.rawValue
            source = page.source.rawValue
            stamp = page.stamp.description
        }
    }
}
