import SwiftUI
import Sentry
import WindmillGym
import WindmillJournal
import WindmillPlatform
import WindmillRoadmap

@main
struct WindmillApp: App {
    init() {
        if let options = CrashReports.options(info: Bundle.main.infoDictionary ?? [:]) {
            SentrySDK.start(options: options)
        }
    }

    var body: some Scene {
        WindowGroup {
            SuperappView(products: [JournalModule(), RoadmapModule(), GymModule()])
        }
    }
}
