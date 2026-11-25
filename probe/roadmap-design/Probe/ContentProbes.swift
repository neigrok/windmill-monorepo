import SwiftUI

struct StepRow: View {
    let symbol: String
    let title: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text("Unlocks 2 steps")
                    .font(.footnote.weight(.semibold))
                Text("Feel where the wind comes from before you touch a sheet, and call it out loud every time it shifts.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        } icon: {
            Image(systemName: symbol)
        }
    }
}

struct ListProbe: View {
    let variant: String
    @State private var isDoneExpanded = false

    var body: some View {
        NavigationStack {
            if variant == "sidebar" {
                sections.listStyle(.sidebar)
            } else {
                sections.listStyle(.insetGrouped)
            }
        }
    }

    private var sections: some View {
        List {
            Section {
                NavigationLink(value: 1) { StepRow(symbol: "wind", title: "Read the wind") }
                NavigationLink(value: 2) { StepRow(symbol: "point.topleft.down.to.point.bottomright.curvepath", title: "Tie a bowline") }
                NavigationLink(value: 3) { StepRow(symbol: "sailboat", title: "Rig the mainsail") }
            } header: {
                HStack {
                    Text("Up next")
                    Spacer()
                    Text("3")
                }
            }
            .headerProminence(.increased)
            Section("Done", isExpanded: $isDoneExpanded) {
                NavigationLink(value: 4) { StepRow(symbol: "checkmark.circle", title: "Learn the parts of a boat") }
            }
            Section("Locked") {
                NavigationLink(value: 5) { StepRow(symbol: "lock", title: "Reef in a blow") }
            }
        }
        .navigationTitle("Learn to sail")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct SwipeProbe: View {
    var body: some View {
        NavigationStack {
            List {
                StepRow(symbol: "wind", title: "Read the wind")
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button("Complete", systemImage: "checkmark") {}.tint(.orange)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Delete", systemImage: "trash", role: .destructive) {}
                    }
                    .accessibilityIdentifier("swipe-row")
                StepRow(symbol: "sailboat", title: "Rig the mainsail")
                Text("Tie a bowline")
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button("Complete", systemImage: "checkmark") {}.tint(.orange)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Delete", systemImage: "trash", role: .destructive) {}
                    }
                    .accessibilityIdentifier("swipe-short-row")
            }
            .navigationTitle("Learn to sail")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct PasteProbe: View {
    @State private var code = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Stock") {
                    HStack {
                        TextField("Sign-in code", text: $code)
                        PasteButton(payloadType: String.self) { _ in }
                    }
                    LabeledContent("Sign-in code") {
                        PasteButton(payloadType: String.self) { _ in }
                    }
                }
                Section("Icon only") {
                    LabeledContent("Sign-in code") {
                        PasteButton(payloadType: String.self) { _ in }
                            .labelStyle(.iconOnly)
                    }
                }
                Section("Capsule border shape") {
                    LabeledContent("Sign-in code") {
                        PasteButton(payloadType: String.self) { _ in }
                            .buttonBorderShape(.capsule)
                    }
                }
            }
            .navigationTitle("Sign in")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct UnavailableProbe: View {
    let variant: String

    var body: some View {
        NavigationStack {
            Group {
                if variant == "search" {
                    ContentUnavailableView.search(text: "reef")
                } else {
                    ContentUnavailableView {
                        Label("No steps yet", systemImage: "point.3.connected.trianglepath.dotted")
                    } description: {
                        Text("Add the first step and the roadmap grows from there.")
                    } actions: {
                        Button("Add a Step") {}.buttonStyle(.glass)
                        if variant == "buttons" {
                            Button("Add a Step") {}.buttonStyle(.bordered)
                            Button("Add a Step") {}.buttonStyle(.borderedProminent)
                            Button("Add a Step") {}
                        }
                    }
                }
            }
            .navigationTitle("Learn to sail")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct GlassButtons: View {
    var body: some View {
        HStack {
            Button("Glass") {}.buttonStyle(.glass)
            Button("Prominent") {}.buttonStyle(.glassProminent).tint(.orange)
            Button("Small") {}.buttonStyle(.glass).controlSize(.small)
            Button("Off") {}.buttonStyle(.glass).disabled(true)
        }
    }
}

struct GlassProbe: View {
    var body: some View {
        NavigationStack {
            List {
                Section("In a grouped card") {
                    GlassButtons()
                    Text("A plain row below the buttons")
                }
                Section("On the list background") {
                    GlassButtons().listRowBackground(Color.clear)
                }
                Section("Prominent, disabled and small") {
                    HStack {
                        Button("Prominent") {}.buttonStyle(.glassProminent)
                        Button("Off") {}.buttonStyle(.glassProminent).disabled(true)
                        Button("Small") {}.buttonStyle(.glassProminent).controlSize(.small)
                    }
                }
            }
            .navigationTitle("Glass buttons")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
