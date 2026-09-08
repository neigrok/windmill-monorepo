import Foundation

// How a store reads the document it wrote last time — possibly under an older build. Two things
// happen before the strict decode: a document written by the app version that spelled a target as
// `targetSets/targetReps/targetWeightKg` (a routine entry) or as scalar `sets/reps/weightKg` (a plan
// entry) is rewritten to the one shape, `sets: [{reps?, weightKg?}]`, as a JSON-tree rewrite; and
// every list is then decoded item by item, so one row this build cannot read costs that row and
// never the shelf or the queue. The migrated document reaches the disk on the store's next flush.
enum DeviceDocument {
    static func read<Document: Decodable>(_ type: Document.Type, from data: Data) -> Document? {
        guard let tree = try? JSONSerialization.jsonObject(with: data) else { return nil }
        guard let migrated = try? JSONSerialization.data(withJSONObject: rewritten(tree)) else { return nil }
        return try? JSONDecoder().decode(type, from: migrated)
    }

    // The old shapes are told apart by their keys alone: the triple never appears on the new wire,
    // and the new `sets` is always an array — a number there is the old plan entry.
    static func rewritten(_ node: Any) -> Any {
        if let list = node as? [Any] { return list.map(rewritten) }
        guard let fields = node as? [String: Any] else { return node }
        var entry = fields.mapValues(rewritten)
        let triple = ["targetSets", "targetReps", "targetWeightKg"]
        if triple.contains(where: { entry[$0] != nil }) {
            let scheme = oldScheme(count: entry["targetSets"], reps: entry["targetReps"], weightKg: entry["targetWeightKg"])
            for key in triple { entry[key] = nil }
            if let scheme { entry["sets"] = scheme }
            return entry
        }
        if entry["sets"] is NSNumber {
            let scheme = oldScheme(count: entry["sets"], reps: entry["reps"], weightKg: entry["weightKg"])
            for key in ["sets", "reps", "weightKg"] { entry[key] = nil }
            if let scheme { entry["sets"] = scheme }
            return entry
        }
        return entry
    }

    // `n` identical sets carrying whatever the old line named; a null count was the open line.
    private static func oldScheme(count: Any?, reps: Any?, weightKg: Any?) -> [[String: Any]]? {
        guard let count = count as? Int, count > 0 else { return nil }
        var set: [String: Any] = [:]
        if let reps, !(reps is NSNull) { set["reps"] = reps }
        if let weightKg, !(weightKg is NSNull) { set["weightKg"] = weightKg }
        return Array(repeating: set, count: count)
    }
}

// One stored item read on its own: nil where this build cannot read it.
struct Kept<Item: Decodable>: Decodable {
    let item: Item?

    init(from decoder: Decoder) throws {
        item = try? Item(from: decoder)
    }
}

extension KeyedDecodingContainer {
    func decodeKept<Item: Decodable>(_ type: [Item].Type, forKey key: Key) throws -> [Item]? {
        try decodeIfPresent([Kept<Item>].self, forKey: key)?.compactMap(\.item)
    }

    func decodeKept<Item: Decodable>(_ type: [String: Item].Type, forKey key: Key) throws -> [String: Item]? {
        try decodeIfPresent([String: Kept<Item>].self, forKey: key)?.compactMapValues(\.item)
    }
}
