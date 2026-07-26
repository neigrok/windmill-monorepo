import WindmillPlatform
import WindmillRoadmap
import WindmillNotes
import WindmillGym

// The composition root — the only place that knows all three products exist, exactly like
// web/src/shell/products.js. A future SwiftUI App swaps this print for a TabView over the modules.
let app = Superapp(
    account: Account(apiBaseURL: "https://windmill.app"),
    products: [RoadmapModule(), NotesModule(), GymModule()]
)
print("Windmill superapp — mounted products: \(app.mounted.joined(separator: ", "))")
