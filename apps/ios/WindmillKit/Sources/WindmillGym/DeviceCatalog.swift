import Foundation

// THE MOVEMENT NAMES, KEPT BESIDE THE QUEUE — and, at the foot of this file, the sixty-four the app
// SHIPS with, which is where the anonymous room gets its catalog. A movement is a stable id
// everywhere except on screen, and the id is a slug — so a cold launch in a basement gym, with the
// queue holding a live session and the catalog read still in flight, draws `bench-press` where
// `Bench Press` belongs: in the movement head at 28pt, in the jump sheet, and in the refusal banner
// that is the last copy of a set somebody lifted.
//
// WHOSE NAMES THEY ARE IS PART OF THE FILE, and it has to be. The catalog ROWS are global — the 64
// seeds belong to nobody — but what an account CALLS one is not: renaming a seed writes a
// per-account display override (§H's identity proof), and a movement somebody created is theirs
// alone. So a file written under one account is not a stale copy of the truth, it is somebody
// else's, and opening it under another seat falls back to THE SEEDS. That costs a renamed seed and a
// created movement their name for one read — which is the worst this file was ever allowed to cost —
// and it never spells one lifter's private name in another lifter's room, or in the anonymous room,
// where no catalog read ever comes to replace it.
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
    //
    // What is let go of falls back to the SEEDS rather than to nothing, which is what makes the
    // anonymous room work at all — nobody's seat has no file and no read coming. Empty is never an
    // answer here now: a room that cannot name a movement cannot log a set.
    public func open(under seat: String?) -> [Exercise] {
        guard held.seat == seat else {
            held = Held(seat: seat, movements: nil)
            return Self.seeded
        }
        return held.movements ?? Self.seeded
    }

    public func hold(_ movements: [Exercise]) {
        guard movements != held.movements else { return }
        held.movements = movements
        guard let data = try? JSONEncoder().encode(held) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
// ── the catalog this app SHIPS WITH ────────────────────────────────────────────────────────────

// THE SIXTY-FOUR SEEDS, in the app bundle, because the anonymous room has nowhere else to get them.
// Signed out there is no catalog read — `TrainingStore.connect` has no client to make one with — so
// before this table a fresh install opened the picker onto "the catalog didn't load", with no row to
// tap and no door to mint one. A room that cannot name a movement cannot log a set, which made the
// whole anonymous-first promise (auth canon §2, README "What is real") untrue on the one launch it
// is made on.
//
// They are the same rows as `backend/db/schema.sql`'s seed, id for id: the ids are the product's
// stable identities, the server's own insert is ON CONFLICT DO NOTHING, and the claim replays sets
// against these ids and lands on the rows that are already there. Nothing here is minted and nothing
// here is `custom` — a seed belongs to nobody, which is exactly what makes it safe to ship.
//
// A served catalog REPLACES this the moment one arrives, because a name is what one account calls a
// movement (see `open(under:)` above): a renamed seed and a movement somebody created both come back
// on that read, and `hold` writes them over these.
public extension DeviceCatalog {
    static let seeded: [Exercise] = rows.map {
        Exercise(id: $0.0, name: $0.1, pattern: $0.2, equipment: $0.3, stepKg: $0.4)
    }

    private static let rows: [(String, String, String, String, Double)] = [
        ("back-squat", "Back Squat", "squat", "barbell", 2.5),
        ("front-squat", "Front Squat", "squat", "barbell", 2.5),
        ("goblet-squat", "Goblet Squat", "squat", "dumbbell", 2.0),
        ("bulgarian-split-squat", "Bulgarian Split Squat", "squat", "dumbbell", 2.0),
        ("walking-lunge", "Walking Lunge", "squat", "dumbbell", 2.0),
        ("step-up", "Step Up", "squat", "dumbbell", 2.0),
        ("leg-press", "Leg Press", "squat", "machine", 5.0),
        ("hack-squat", "Hack Squat", "squat", "machine", 5.0),
        ("deadlift", "Deadlift", "hinge", "barbell", 2.5),
        ("sumo-deadlift", "Sumo Deadlift", "hinge", "barbell", 2.5),
        ("romanian-deadlift", "Romanian Deadlift", "hinge", "barbell", 2.5),
        ("trap-bar-deadlift", "Trap Bar Deadlift", "hinge", "barbell", 2.5),
        ("good-morning", "Good Morning", "hinge", "barbell", 2.5),
        ("hip-thrust", "Hip Thrust", "hinge", "barbell", 2.5),
        ("back-extension", "Back Extension", "hinge", "bodyweight", 2.5),
        ("kettlebell-swing", "Kettlebell Swing", "hinge", "kettlebell", 4.0),
        ("bench-press", "Bench Press", "press", "barbell", 2.5),
        ("incline-bench-press", "Incline Bench Press", "press", "barbell", 2.5),
        ("close-grip-bench-press", "Close Grip Bench Press", "press", "barbell", 2.5),
        ("overhead-press", "Overhead Press", "press", "barbell", 2.5),
        ("push-press", "Push Press", "press", "barbell", 2.5),
        ("dumbbell-bench-press", "Dumbbell Bench Press", "press", "dumbbell", 2.0),
        ("incline-dumbbell-press", "Incline Dumbbell Press", "press", "dumbbell", 2.0),
        ("dumbbell-shoulder-press", "Dumbbell Shoulder Press", "press", "dumbbell", 2.0),
        ("machine-chest-press", "Machine Chest Press", "press", "machine", 5.0),
        ("machine-shoulder-press", "Machine Shoulder Press", "press", "machine", 5.0),
        ("dip", "Dip", "press", "bodyweight", 2.5),
        ("push-up", "Push Up", "press", "bodyweight", 2.5),
        ("pull-up", "Pull Up", "pull", "bodyweight", 2.5),
        ("chin-up", "Chin Up", "pull", "bodyweight", 2.5),
        ("muscle-up", "Muscle Up", "pull", "bodyweight", 2.5),
        ("lat-pulldown", "Lat Pulldown", "pull", "cable", 2.5),
        ("barbell-row", "Barbell Row", "pull", "barbell", 2.5),
        ("dumbbell-row", "Dumbbell Row", "pull", "dumbbell", 2.0),
        ("chest-supported-row", "Chest Supported Row", "pull", "machine", 5.0),
        ("seated-cable-row", "Seated Cable Row", "pull", "cable", 2.5),
        ("face-pull", "Face Pull", "pull", "cable", 2.5),
        ("barbell-shrug", "Barbell Shrug", "pull", "barbell", 2.5),
        ("inverted-row", "Inverted Row", "pull", "bodyweight", 2.5),
        ("farmers-carry", "Farmers Carry", "carry", "dumbbell", 2.0),
        ("suitcase-carry", "Suitcase Carry", "carry", "dumbbell", 2.0),
        ("overhead-carry", "Overhead Carry", "carry", "dumbbell", 2.0),
        ("plank", "Plank", "core", "bodyweight", 2.5),
        ("hanging-leg-raise", "Hanging Leg Raise", "core", "bodyweight", 2.5),
        ("ab-wheel-rollout", "Ab Wheel Rollout", "core", "bodyweight", 2.5),
        ("cable-crunch", "Cable Crunch", "core", "cable", 2.5),
        ("pallof-press", "Pallof Press", "core", "cable", 2.5),
        ("weighted-sit-up", "Weighted Sit Up", "core", "bodyweight", 2.5),
        ("barbell-curl", "Barbell Curl", "isolation", "barbell", 2.5),
        ("dumbbell-curl", "Dumbbell Curl", "isolation", "dumbbell", 2.0),
        ("hammer-curl", "Hammer Curl", "isolation", "dumbbell", 2.0),
        ("triceps-pushdown", "Triceps Pushdown", "isolation", "cable", 2.5),
        ("skull-crusher", "Skull Crusher", "isolation", "barbell", 2.5),
        ("overhead-triceps-extension", "Overhead Triceps Extension", "isolation", "dumbbell", 2.0),
        ("lateral-raise", "Lateral Raise", "isolation", "dumbbell", 2.0),
        ("rear-delt-fly", "Rear Delt Fly", "isolation", "dumbbell", 2.0),
        ("dumbbell-fly", "Dumbbell Fly", "isolation", "dumbbell", 2.0),
        ("cable-fly", "Cable Fly", "isolation", "cable", 2.5),
        ("leg-extension", "Leg Extension", "isolation", "machine", 5.0),
        ("lying-leg-curl", "Lying Leg Curl", "isolation", "machine", 5.0),
        ("standing-calf-raise", "Standing Calf Raise", "isolation", "machine", 5.0),
        ("seated-calf-raise", "Seated Calf Raise", "isolation", "machine", 5.0),
        ("wrist-curl", "Wrist Curl", "isolation", "barbell", 2.5),
        ("hip-abduction", "Hip Abduction", "isolation", "machine", 5.0),
    ]
}
