import SwiftUI

struct Find: ViewModifier {
    let variant: String
    @Binding var query: String
    @Binding var isSearching: Bool
    @Binding var showsSearch: Bool

    func body(content: Content) -> some View {
        if variant.hasPrefix("drawerminimize") {
            content
                .searchable(text: $query, isPresented: $isSearching, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Find a step")
                .searchToolbarBehavior(.minimize)
        } else if variant.hasPrefix("minimize") {
            content
                .searchable(text: $query, isPresented: $isSearching, prompt: "Find a step")
                .searchToolbarBehavior(.minimize)
        } else if variant.hasPrefix("toolbar") {
            content.searchable(text: $query, isPresented: $isSearching, placement: .toolbar, prompt: "Find a step")
        } else if variant.hasPrefix("drawer") {
            content.searchable(text: $query, isPresented: $isSearching, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Find a step")
        } else if variant.hasPrefix("conditionalauto"), showsSearch {
            content
                .searchable(text: $query, isPresented: $isSearching, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Find a step")
                .onChange(of: isSearching) { _, isSearchingNow in
                    if !isSearchingNow { showsSearch = false }
                }
        } else if variant.hasPrefix("conditional"), showsSearch {
            content
                .searchable(text: $query, isPresented: $isSearching, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a step")
                .onChange(of: isSearching) { _, isSearchingNow in
                    if !isSearchingNow { showsSearch = false }
                }
        } else {
            content
        }
    }
}

struct RoomProbe: View {
    let variant: String
    @State private var query = ""
    @State private var isSearching = false
    @State private var showsSearch = false
    @State private var lens = "Board"
    @State private var draft = ""
    @State private var position = ScrollPosition()

    var body: some View {
        NavigationStack {
            ScrollViewReader { list in
                List {
                    ForEach(0..<20, id: \.self) { index in
                        StepRow(symbol: "wind", title: "Step \(index + 1)").id(index)
                    }
                }
                .scrollPosition($position)
                .task {
                    try? await Task.sleep(for: .milliseconds(400))
                    if variant.contains("scrolled") { list.scrollTo(1, anchor: .top) }
                    if variant.contains("nudged") { position.scrollTo(y: 60) }
                }
            }
            .navigationTitle("Learn to sail")
            .navigationBarTitleDisplayMode(.inline)
            .navigationSubtitle("3 of 8 done")
            .toolbarTitleMenu {
                Button("Rename", systemImage: "pencil") {}
                Button("Guide", systemImage: "text.book.closed") {}
            }
            .modifier(Find(variant: variant, query: $query, isSearching: $isSearching, showsSearch: $showsSearch))
            .searchPresentationToolbarBehavior(variant.contains("avoidhiding") ? .avoidHidingContent : .automatic)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {} label: {
                        HStack(spacing: 4) {
                            Text("Roadmap")
                            Image(systemName: "chevron.down").font(.caption.weight(.semibold))
                        }
                    }
                }
                if variant.contains("searchtop") {
                    DefaultToolbarItem(kind: .search, placement: .topBarTrailing)
                }
                if variant.contains("searchbottom") {
                    DefaultToolbarItem(kind: .search, placement: .bottomBar)
                }
                if !variant.contains("notrailing") {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Account", systemImage: "person.crop.circle") {}
                    }
                }
            }
            .safeAreaBar(edge: .top) {
                HStack {
                    Picker("View", selection: $lens) {
                        Text("Board").tag("Board")
                        Text("Graph").tag("Graph")
                    }
                    .pickerStyle(.segmented)
                    Button("Find", systemImage: "magnifyingglass") {
                        showsSearch = true
                        isSearching = true
                    }
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
            guard variant.contains("active") || variant.contains("dismissed") || variant.contains("shown") else { return }
            try? await Task.sleep(for: .milliseconds(900))
            showsSearch = true
            guard !variant.contains("shown") else { return }
            try? await Task.sleep(for: .milliseconds(variant.contains("slow") ? 1800 : 400))
            query = "reef"
            isSearching = true
            guard variant.contains("dismissed") else { return }
            try? await Task.sleep(for: .milliseconds(2500))
            isSearching = false
            query = ""
            showsSearch = false
        }
    }
}

struct SystemTitleMenu: ViewModifier {
    let isShown: Bool

    func body(content: Content) -> some View {
        if isShown {
            content
                .navigationSubtitle("3 of 8 done")
                .toolbarTitleMenu {
                    Button("Rename", systemImage: "pencil") {}
                    Button("Guide", systemImage: "text.book.closed") {}
                }
        } else {
            content
        }
    }
}

struct LongTitleProbe: View {
    let variant: String

    private var title: String {
        if let override = UserDefaults.standard.string(forKey: "title") { return override }
        if variant.contains("pretruncated") { return "Coastal navigat…" }
        if variant.contains("short") { return "Learn to sail" }
        return "Coastal navigation handbook"
    }

    var body: some View {
        NavigationStack {
            List { StepRows(count: 14) }
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .modifier(SystemTitleMenu(isShown: !variant.contains("principal")))
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {} label: {
                            HStack(spacing: 4) {
                                Text("Roadmap")
                                Image(systemName: "chevron.down").font(.caption.weight(.semibold))
                            }
                        }
                    }
                    if variant.contains("principal") {
                        ToolbarItem(placement: .principal) {
                            Menu {
                                Button("Rename", systemImage: "pencil") {}
                                Button("Guide", systemImage: "text.book.closed") {}
                            } label: {
                                if variant.contains("styled") {
                                    VStack(spacing: 0) {
                                        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                                        Text("3 of 8 done").font(.caption).foregroundStyle(.secondary)
                                    }
                                    .frame(maxWidth: 150)
                                } else {
                                    VStack {
                                        Text(title).lineLimit(1)
                                        Text("3 of 8 done")
                                    }
                                    .frame(maxWidth: 150)
                                }
                            }
                        }
                    }
                    if !variant.contains("one") {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Add", systemImage: "plus") {}
                        }
                    }
                    if variant.contains("spacer") {
                        ToolbarSpacer(.fixed, placement: .topBarTrailing)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Account", systemImage: "person.crop.circle") {}
                    }
                }
        }
    }
}
