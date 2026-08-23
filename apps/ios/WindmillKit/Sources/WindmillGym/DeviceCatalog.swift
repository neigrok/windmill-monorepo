import Foundation

// Movement names cached beside the queue, per seat: a file written under another seat is dropped for the seeds.
public final class DeviceCatalog {
    private struct Held: Codable {
        var seat: String?
        var movements: [Exercise]?
    }

    private let url: URL
    private var held: Held

    public init(url: URL = DeviceCatalog.defaultURL()) {
        self.url = url
        let data = (try? Data(contentsOf: url)) ?? Data()
        held = (try? JSONDecoder().decode(Held.self, from: data)) ?? Held()
    }

    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("windmill-gym-catalog.json")
    }

    // `nil` is a seat like any other. A file this seat did not write falls back to the seeds, never to empty.
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

// Same rows as backend/db/schema.sql's seed, id for id. A served catalog replaces them.
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
