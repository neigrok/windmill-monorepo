import Foundation
import WindmillPlatform

// The weigh-ins as this device holds them, one shelf per seat beside the log's other shelves. A row
// lands here first and is owed to the log until the server answers for it; signing in claims the
// anonymous shelf the way the sessions shelf is claimed, and the claim replays it LAST, after every
// session has landed. Whole-file atomic writes; a file this build cannot read opens EMPTY.
public final class BodyweightStore {
    public struct Row: Equatable, Codable, Sendable {
        public var entry: BodyweightEntry
        public var owed: Bool
        // A deletion still owed: the row stays, hidden, until the log confirms it is gone.
        public var deleted: Bool

        public init(entry: BodyweightEntry, owed: Bool, deleted: Bool = false) {
            self.entry = entry
            self.owed = owed
            self.deleted = deleted
        }
    }

    private struct Held: Codable {
        var shelves: [String: [Row]]?
    }

    private let url: URL
    private var held: Held
    private var key = LocalLog.anonymousShelf

    public init(url: URL = BodyweightStore.defaultURL()) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-bodyweight.json")
    }

    // The only place a seat is named; a seat is `anon` or `u.<id>`, the same key the log's shelves use.
    public func open(under seat: String?) {
        key = seat.map { "u.\($0)" } ?? LocalLog.anonymousShelf
    }

    // Moves, never copies: the anonymous rows follow whoever signs in, and for a day both shelves hold the
    // newer write stands.
    public func adoptTheAnonymousShelf() {
        guard key != LocalLog.anonymousShelf, let anonymous = held.shelves?[LocalLog.anonymousShelf] else { return }
        var mine = shelf
        for row in anonymous {
            guard let index = mine.firstIndex(where: { $0.entry.dateLocal == row.entry.dateLocal }) else {
                mine.append(row)
                continue
            }
            if row.entry.supersedes(mine[index].entry) { mine[index] = row }
        }
        shelf = mine
        held.shelves?[LocalLog.anonymousShelf] = nil
        flush()
    }

    private var shelf: [Row] {
        get { held.shelves?[key] ?? [] }
        set {
            var shelves = held.shelves ?? [:]
            shelves[key] = newValue
            held.shelves = shelves
        }
    }

    // What the screens draw: every row not deleted, ascending by day.
    public var entries: [BodyweightEntry] {
        shelf.filter { !$0.deleted }.map(\.entry).sorted { $0.dateLocal < $1.dateLocal }
    }

    public var latest: BodyweightEntry? { entries.last }

    // What the claim replays, ascending by day, deletions included.
    public var owed: [Row] {
        shelf.filter(\.owed).sorted { $0.entry.dateLocal < $1.entry.dateLocal }
    }

    public var isEmpty: Bool { shelf.isEmpty }

    public func row(on dateLocal: String) -> Row? {
        shelf.first { $0.entry.dateLocal == dateLocal }
    }

    // The lifter's own write for a day replaces whatever the day held: it is the newest tap by construction.
    public func keep(_ entry: BodyweightEntry, owed: Bool) {
        var rows = shelf.filter { $0.entry.dateLocal != entry.dateLocal }
        rows.append(Row(entry: entry, owed: owed))
        shelf = rows
    }

    // The log answered for the day: its row is the truth, and nothing is owed for it any more.
    public func claimed(on dateLocal: String, as stored: BodyweightEntry) {
        var rows = shelf.filter { $0.entry.dateLocal != dateLocal }
        rows.append(Row(entry: stored, owed: false))
        shelf = rows
    }

    // The log answered for one write. It settles the day only while that write is still what the day holds; a
    // deletion or a newer save made while the reply was in flight stays, and stays owed. False says so.
    @discardableResult
    public func claimed(_ sent: BodyweightEntry, as stored: BodyweightEntry) -> Bool {
        guard let held = row(on: sent.dateLocal), held.owed, !held.deleted,
              held.entry.recordedAt == sent.recordedAt else { return false }
        claimed(on: sent.dateLocal, as: stored)
        return true
    }

    // The day left the shelf while the log was still answering a write for it: the log may now hold what the
    // lifter deleted, so the deletion is owed again until the claim tells it.
    public func oweDeletion(of stored: BodyweightEntry, at deletedAt: Int64) {
        guard row(on: stored.dateLocal) == nil else { return }
        keep(stored, owed: true)
        markDeleted(on: stored.dateLocal, at: deletedAt)
    }

    // The log holds a row newer than the deletion: the correction wins, the tombstone goes, and the day is drawn
    // again as the log has it — only while the day still holds that tombstone, and only for a row that is newer.
    @discardableResult
    public func withdrawDeletion(_ tombstone: BodyweightEntry, for stored: BodyweightEntry) -> Bool {
        guard stored.supersedes(tombstone), let held = row(on: tombstone.dateLocal), held.deleted,
              held.entry.recordedAt == tombstone.recordedAt else { return false }
        claimed(on: tombstone.dateLocal, as: stored)
        return true
    }

    // A deletion the log has confirmed, or a write it refused for good: the day leaves the shelf.
    public func letGo(on dateLocal: String) {
        shelf = shelf.filter { $0.entry.dateLocal != dateLocal }
    }

    // The same, for the reply to one write or to its deletion: the day leaves only while it still holds that write
    // (a tombstone keeps its write's `recordedAt`); a newer save made while the reply was in flight stands.
    public func letGo(_ sent: BodyweightEntry) {
        guard row(on: sent.dateLocal)?.entry.recordedAt == sent.recordedAt else { return }
        letGo(on: sent.dateLocal)
    }

    // A deletion this device could not tell the log yet: hidden here, stamped with the instant it was made so a
    // correction the log took later outranks it, and replayed by the claim. The tombstone is what the reply settles.
    @discardableResult
    public func markDeleted(on dateLocal: String, at deletedAt: Int64) -> BodyweightEntry? {
        guard let held = row(on: dateLocal) else { return nil }
        let tombstone = BodyweightEntry(dateLocal: dateLocal, weightKg: held.entry.weightKg, recordedAt: deletedAt)
        shelf = shelf.map { row in
            guard row.entry.dateLocal == dateLocal else { return row }
            return Row(entry: tombstone, owed: true, deleted: true)
        }
        return tombstone
    }

    // A served series lands over the shelf: a row still owed keeps standing where it is the newer write, or
    // where it is a deletion made after the row the log holds; every settled row is replaced by what the log
    // holds, and a settled row the log no longer holds is gone.
    public func served(_ entries: [BodyweightEntry]) {
        var rows: [Row] = []
        for stored in entries {
            guard let mine = row(on: stored.dateLocal), mine.owed else {
                rows.append(Row(entry: stored, owed: false))
                continue
            }
            let stands = mine.deleted ? !stored.supersedes(mine.entry) : mine.entry.supersedes(stored)
            rows.append(stands ? mine : Row(entry: stored, owed: false))
        }
        let known = Set(entries.map(\.dateLocal))
        for mine in shelf where mine.owed && !known.contains(mine.entry.dateLocal) && !mine.deleted {
            rows.append(mine)
        }
        shelf = rows
    }

    public func flush() {
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
