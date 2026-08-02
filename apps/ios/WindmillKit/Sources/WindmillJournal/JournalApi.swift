import Foundation
import WindmillPlatform

// The one place the native journal talks to the backend — the twin of
// web/src/products/journal/journalApi.js, against the same routes:
//   GET /v1/journal/page/:day   ·  PUT /v1/journal/page/:day
//   GET /v1/journal/pages?from=&to=   ·  GET /v1/journal/pages?since=&limit=
// The session rides as a Bearer header rather than a cookie (WindmillApi); nothing else differs.

// What the canvas needs of the network, and nothing more. PageStore depends on this rather than on
// JournalApi so the offline and claim paths — the two that decide whether someone's writing
// survives — can be driven in a test without a server, a socket, or a stubbed URLProtocol.
public protocol PageSyncing {
    func put(_ page: Page) async throws -> Page
    func range(from: LocalDay, to: LocalDay) async throws -> [Page]
}

public struct JournalApi: PageSyncing {
    private let api: WindmillApi

    public init(api: WindmillApi) {
        self.api = api
    }

    // A single day. A day never written is a 404, and that is not an error — the canvas draws a
    // gap, so the absence is folded into the type rather than thrown at the caller.
    public func page(_ day: LocalDay) async throws -> Page? {
        do {
            return try await api.get("/v1/journal/page/\(day.iso)", as: Page.self)
        } catch let error as WindmillApiError {
            if case .refused(404, _) = error { return nil }
            throw error
        }
    }

    // Write a day, and get back whatever WON. A client that raced another device sees the winning
    // body immediately rather than discovering it on the next read.
    public func put(_ page: Page) async throws -> Page {
        try await api.send("PUT", "/v1/journal/page/\(page.day.iso)", body: Write(page), as: Page.self)
    }

    // A window of the canvas [from, to], oldest first.
    public func range(from: LocalDay, to: LocalDay) async throws -> [Page] {
        try await api.get("/v1/journal/pages?from=\(from.iso)&to=\(to.iso)", as: Pages.self).pages
    }

    // The delta feed: everything past an HLC cursor, ascending. `Hlc.zero` asks for the whole
    // history — the read that fills a device that has just signed in.
    public func since(_ cursor: Hlc, limit: Int = 500) async throws -> [Page] {
        let encoded = cursor.description.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "0:0:"
        return try await api.get("/v1/journal/pages?since=\(encoded)&limit=\(limit)", as: Pages.self).pages
    }

    struct Pages: Decodable { let pages: [Page] }

    // What a PUT carries. Deliberately not `Page`: `updatedAt` is server time, stamped on store,
    // and a client that sent one would be claiming a fact it does not own.
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
