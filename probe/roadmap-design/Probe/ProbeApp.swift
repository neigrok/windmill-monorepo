import SwiftUI

@main
struct ProbeApp: App {
    var body: some Scene {
        WindowGroup {
            ProbeScreen(
                probe: UserDefaults.standard.string(forKey: "probe") ?? "",
                variant: UserDefaults.standard.string(forKey: "variant") ?? ""
            )
        }
    }
}

struct ProbeScreen: View {
    let probe: String
    let variant: String

    var body: some View {
        switch probe {
        case "menu": MenuProbe(subtitleShape: variant)
        case "title": TitleProbe(variant: variant)
        case "rename": RenameProbe()
        case "dialog": DialogProbe(source: variant)
        case "alert": AlertProbe(variant: variant)
        case "room": RoomProbe(variant: variant)
        case "longtitle": LongTitleProbe(variant: variant)
        case "search": SearchProbe(variant: variant)
        case "sheet": SheetProbe(variant: variant)
        case "list": ListProbe(variant: variant)
        case "swipe": SwipeProbe()
        case "edit": EditProbe(variant: variant)
        case "paste": PasteProbe()
        case "unavailable": UnavailableProbe(variant: variant)
        case "glass": GlassProbe()
        default: Text("No probe named “\(probe)”")
        }
    }
}

struct StepRows: View {
    let count: Int

    var body: some View {
        ForEach(0..<count, id: \.self) { index in
            Text("Step \(index + 1)")
        }
    }
}
