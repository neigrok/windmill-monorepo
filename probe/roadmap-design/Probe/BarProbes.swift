import SwiftUI

struct MenuProbe: View {
    let subtitleShape: String
    @State private var lens = "Board"

    private let lenses = [
        ("Board", "Steps by status"),
        ("Graph", "The whole tree"),
        ("List", "Everything in order"),
    ]

    var body: some View {
        NavigationStack {
            List { StepRows(count: 14) }
                .navigationTitle("Learn to sail")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu("More", systemImage: "ellipsis") {
                            Picker("View", selection: $lens) {
                                ForEach(lenses, id: \.0) { title, subtitle in
                                    if subtitleShape == "symbols" {
                                        Label {
                                            Text(title)
                                            Text(subtitle)
                                        } icon: {
                                            Image(systemName: "square.grid.2x2")
                                        }
                                        .tag(title)
                                    } else {
                                        Button {} label: {
                                            Text(title)
                                            Text(subtitle)
                                        }
                                        .tag(title)
                                    }
                                }
                            }
                            .pickerStyle(.inline)
                            Divider()
                            Button("New Roadmap", systemImage: "plus") {}
                            Button("Guide", systemImage: "text.book.closed") {}
                            Button("Rename", systemImage: "pencil") {}
                            Divider()
                            Button("Delete Roadmap", systemImage: "trash", role: .destructive) {}
                        }
                    }
                }
        }
    }
}

struct TitleProbe: View {
    let variant: String

    var body: some View {
        NavigationStack {
            List { StepRows(count: 14) }
                .navigationTitle(variant.contains("long") ? "Coastal navigation handbook" : "Learn to sail")
                .navigationBarTitleDisplayMode(variant.contains("large") ? .large : .inline)
                .navigationSubtitle("3 of 8 done")
                .toolbarTitleMenu {
                    Button("Rename", systemImage: "pencil") {}
                    Button("Guide", systemImage: "text.book.closed") {}
                }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {} label: {
                            HStack(spacing: 4) {
                                Text("Roadmap")
                                Image(systemName: "chevron.down")
                                    .font(.caption.weight(.semibold))
                            }
                        }
                    }
                    if variant.contains("split") {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Add", systemImage: "plus") {}
                        }
                        ToolbarSpacer(.fixed, placement: .topBarTrailing)
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Account", systemImage: "person.crop.circle") {}
                        }
                    } else {
                        ToolbarItemGroup(placement: .topBarTrailing) {
                            Button("Add", systemImage: "plus") {}
                            Button("Account", systemImage: "person.crop.circle") {}
                        }
                    }
                }
        }
    }
}

struct RenameProbe: View {
    @State private var name = "Learn to sail"

    var body: some View {
        NavigationStack {
            List { StepRows(count: 14) }
                .navigationTitle($name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarTitleMenu {
                    RenameButton()
                    Button("Guide", systemImage: "text.book.closed") {}
                }
        }
    }
}

struct SearchProbe: View {
    let variant: String
    @State private var query = ""
    @State private var isSearching = false
    @State private var lens = "Board"
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            List { StepRows(count: 20) }
                .navigationTitle("Learn to sail")
                .navigationBarTitleDisplayMode(variant.contains("large") ? .large : .inline)
                .searchable(
                    text: $query,
                    isPresented: $isSearching,
                    placement: .navigationBarDrawer(displayMode: variant.contains("always") ? .always : .automatic),
                    prompt: "Find a step"
                )
                .safeAreaBar(edge: .top) {
                    HStack {
                        Picker("View", selection: $lens) {
                            Text("Board").tag("Board")
                            Text("Graph").tag("Graph")
                        }
                        .pickerStyle(.segmented)
                        Button("Filter", systemImage: "line.3.horizontal.decrease") {}
                            .labelStyle(.iconOnly)
                            .buttonStyle(.glass)
                    }
                    .padding(.horizontal)
                }
                .safeAreaBar(edge: .bottom) {
                    HStack {
                        Button("Attach", systemImage: "plus") {}
                            .labelStyle(.iconOnly)
                            .buttonStyle(.glass)
                        TextField("Ask Coach", text: $draft)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .glassEffect(.regular, in: .capsule)
                    }
                    .padding(.horizontal)
                }
        }
        .task {
            guard variant.contains("active") else { return }
            try? await Task.sleep(for: .milliseconds(700))
            query = "reef"
            isSearching = true
        }
    }
}
