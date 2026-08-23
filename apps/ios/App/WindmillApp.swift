import SwiftUI
import WindmillGym
import WindmillJournal
import WindmillPlatform
import WindmillRoadmap

@main
struct WindmillApp: App {
    var body: some Scene {
        WindowGroup {
            SuperappView(products: [JournalModule(), RoadmapModule(), GymModule()])
        }
    }
}
