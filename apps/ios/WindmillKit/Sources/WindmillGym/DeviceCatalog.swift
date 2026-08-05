import Foundation

// THE MOVEMENT NAMES, KEPT BESIDE THE QUEUE. A movement is a stable id everywhere except on screen,
// and the id is a slug — so a cold launch in a basement gym, with the queue holding a live session
// and the catalog read still in flight, draws `bench-press` where `Bench Press` belongs: in the
// movement head at 28pt, in the jump sheet, and in the refusal banner that is the last copy of a set
// somebody lifted.
//
// That is the whole reason ids are stable and names are display strings. The names are the same for
// everyone and change about never, so the device holds its own copy and redraws from it the instant
// the room opens; the read that follows replaces it whenever the log answers.
//
// One atomic file beside the queue's, written only when the catalog actually changed — the queue is
// flushed on every tap and this is not, because a name nobody edited is not news.
public final class DeviceCatalog {
    private let url: URL
    private var held: [Exercise]

    public init(url: URL = DeviceCatalog.defaultURL()) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        // A file this build cannot read opens EMPTY rather than taking the room down with it: the
        // names are a convenience and the ids are the truth, so the worst a lost file costs is the
        // slug it was there to replace.
        held = (try? JSONDecoder().decode([Exercise].self, from: data)) ?? []
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-catalog.json")
    }

    public var movements: [Exercise] { held }

    public func hold(_ movements: [Exercise]) {
        guard movements != held else { return }
        held = movements
        guard let data = try? JSONEncoder().encode(movements) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
