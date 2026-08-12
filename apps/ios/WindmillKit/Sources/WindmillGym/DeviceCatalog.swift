import Foundation

// THE MOVEMENT NAMES, KEPT BESIDE THE QUEUE. A movement is a stable id everywhere except on screen,
// and the id is a slug — so a cold launch in a basement gym, with the queue holding a live session
// and the catalog read still in flight, draws `bench-press` where `Bench Press` belongs: in the
// movement head at 28pt, in the jump sheet, and in the refusal banner that is the last copy of a set
// somebody lifted.
//
// WHOSE NAMES THEY ARE IS PART OF THE FILE, and it has to be. The catalog ROWS are global — the 64
// seeds belong to nobody — but what an account CALLS one is not: renaming a seed writes a
// per-account display override (§H's identity proof), and a movement somebody created is theirs
// alone. So a file written under one account is not a stale copy of the truth, it is somebody
// else's, and opening it under another seat opens EMPTY. That costs the slug for one read — which is
// the worst this file was ever allowed to cost — and it never spells one lifter's private name in
// another lifter's room, or in the anonymous room, where no catalog read ever comes to replace it.
//
// One atomic file beside the queue's, written only when the names actually changed — the queue is
// flushed on every tap and this is not, because a name nobody edited is not news.
public final class DeviceCatalog {
    // Both halves optional, deliberately: a file written by a build with a different shape decodes
    // to NOTHING rather than to a wrong seat, and nothing is only ever worth a slug.
    private struct Held: Codable {
        var seat: String?
        var movements: [Exercise]?
    }

    private let url: URL
    private var held: Held

    public init(url: URL = DeviceCatalog.defaultURL()) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        // A file this build cannot read opens EMPTY rather than taking the room down with it: the
        // names are a convenience and the ids are the truth, so the worst a lost file costs is the
        // slug it was there to replace.
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-catalog.json")
    }

    // Opened under whoever is signed in, and `nil` — nobody — is a seat like any other. A file this
    // seat did not write is let go of here rather than drawn: the catalog read that follows fills it
    // back in, and everything held from now on is held under this seat.
    public func open(under seat: String?) -> [Exercise] {
        guard held.seat == seat else {
            held = Held(seat: seat, movements: [])
            return []
        }
        return held.movements ?? []
    }

    public func hold(_ movements: [Exercise]) {
        guard movements != held.movements else { return }
        held.movements = movements
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
