import SwiftUI
import WindmillGym
import WindmillJournal
import WindmillPlatform
import WindmillRoadmap

// The composition root — the only place in the native app that knows all three products exist,
// exactly like web/src/shell/products.js. Mounting a fourth product is one entry in this array and
// a line in Package.swift; nothing in WindmillPlatform changes, because nothing there names a
// product. Journal leads because it is the room that is actually built for a phone.

@main
struct WindmillApp: App {
    var body: some Scene {
        WindowGroup {
            SuperappView(products: [JournalModule(), RoadmapModule(), GymModule()])
        }
    }
}
