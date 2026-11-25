import SwiftUI

struct DeleteStepDialog: ViewModifier {
    @Binding var isPresented: Bool

    func body(content: Content) -> some View {
        content.confirmationDialog("Delete Read the wind?", isPresented: $isPresented, titleVisibility: .visible) {
            Button("Delete Step", role: .destructive) {}
        } message: {
            Text("Removes this step · 1 branch resplices")
        }
    }
}

struct DialogProbe: View {
    let source: String
    @State private var isPresented = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(0..<14, id: \.self) { index in
                    if index == 6 {
                        Text("Read the wind")
                            .modifier(DeleteStepDialog(isPresented: source == "row" ? $isPresented : .constant(false)))
                    } else {
                        Text("Step \(index + 1)")
                    }
                }
            }
            .navigationTitle("Learn to sail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("More", systemImage: "ellipsis") {}
                        .modifier(DeleteStepDialog(isPresented: source == "toolbar" ? $isPresented : .constant(false)))
                }
            }
            .safeAreaInset(edge: .bottom) {
                if source == "bottom" {
                    Button(role: .destructive) {} label: {
                        Text("Delete Step").frame(maxWidth: .infinity)
                    }
                    .glassProminentButton()
                    .controlSize(.large)
                    .padding(.horizontal)
                    .modifier(DeleteStepDialog(isPresented: $isPresented))
                }
            }
        }
        .task {
            try? await Task.sleep(for: .milliseconds(700))
            isPresented = true
        }
    }
}

struct AlertProbe: View {
    let variant: String
    @State private var isPresented = false

    var body: some View {
        NavigationStack {
            List { StepRows(count: 14) }
                .navigationTitle("Learn to sail")
                .navigationBarTitleDisplayMode(.inline)
        }
        .alert("Add to your account?", isPresented: $isPresented) {
            if variant == "keep-as-cancel" {
                Button("Keep", role: .cancel) {}
                Button("Discard", role: .destructive) {}
            } else if variant == "keep-plain" {
                Button("Keep") {}
                Button("Discard") {}
            } else if variant.contains("keep") {
                Button("Keep") {}
                Button("Discard", role: .destructive) {}
                if variant.contains("cancel") {
                    Button("Cancel", role: .cancel) {}
                }
            } else {
                Button("Add") {}
                Button("Discard", role: .destructive) {}
                Button("Cancel Sign-In", role: .cancel) {}
            }
        } message: {
            Text("This phone holds 2 roadmaps made before you signed in. Add them to your account, or discard them from this phone.")
        }
        .task {
            try? await Task.sleep(for: .milliseconds(700))
            isPresented = true
        }
    }
}

struct SheetProbe: View {
    let variant: String
    @State private var isPresented = false

    var body: some View {
        NavigationStack {
            List { StepRows(count: 20) }
                .navigationTitle("Learn to sail")
                .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(isPresented: $isPresented) {
            if variant.contains("create") {
                CreateStepSheet(isCreateDisabled: variant.contains("disabled"), usesRoleButtons: variant.contains("roles"))
            } else {
                StepSheet(showsForm: variant == "form")
                    .presentationDetents([.medium, .large])
                    .presentationBackgroundInteraction(variant == "list-dim" ? .automatic : .enabled(upThrough: .medium))
            }
        }
        .task {
            try? await Task.sleep(for: .milliseconds(700))
            isPresented = true
        }
    }
}

struct StepSheet: View {
    let showsForm: Bool
    @State private var title = ""
    @State private var reason = ""
    @FocusState private var isTitleFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if showsForm {
                    Form {
                        TextField("Title", text: $title).focused($isTitleFocused)
                        TextField("Why it matters", text: $reason)
                    }
                    .task {
                        try? await Task.sleep(for: .milliseconds(700))
                        isTitleFocused = true
                    }
                } else {
                    List {
                        Label("Read the wind", systemImage: "wind")
                        Label("Unlocks 2 steps", systemImage: "lock.open")
                        Label("Added 12 May", systemImage: "calendar")
                    }
                }
            }
            .navigationTitle("Read the wind")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    CloseButton()
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("Complete", systemImage: "checkmark") {}
                    Button("More", systemImage: "ellipsis") {}
                }
            }
        }
    }
}

struct CreateStepSheet: View {
    let isCreateDisabled: Bool
    let usesRoleButtons: Bool
    @State private var title = "Read the wind"
    @State private var reason = ""
    @State private var kind = "Skill"

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                    TextField("Why it matters", text: $reason)
                    Picker("Kind", selection: $kind) {
                        Text("Skill").tag("Skill")
                        Text("Milestone").tag("Milestone")
                    }
                    .pickerStyle(.navigationLink)
                } footer: {
                    Text("A step unlocks when every step before it is done.")
                }
            }
            .navigationTitle("New Step")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if usesRoleButtons {
                        CancelButton()
                    } else {
                        Button("Cancel") {}
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if usesRoleButtons {
                        ConfirmButton().disabled(isCreateDisabled)
                    } else {
                        Button("Create") {}.disabled(isCreateDisabled)
                    }
                }
            }
        }
        .presentationDetents([.large])
    }
}

struct EditProbe: View {
    let variant: String
    @State private var isPresented = false

    var body: some View {
        NavigationStack {
            List { StepRows(count: 20) }
                .navigationTitle("Learn to sail")
                .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(isPresented: $isPresented) {
            EditStepsSheet(variant: variant)
        }
        .task {
            try? await Task.sleep(for: .milliseconds(700))
            isPresented = true
        }
    }
}

struct EditStepsSheet: View {
    let variant: String
    @State private var steps = ["Read the wind", "Tie a bowline", "Rig the mainsail", "Tack upwind", "Reef in a blow", "Pick up a mooring"]
    @State private var selection: Set<String> = ["Tie a bowline", "Tack upwind"]
    @State private var editMode = EditMode.inactive

    var body: some View {
        NavigationStack {
            Group {
                if variant.contains("select") {
                    List(steps, id: \.self, selection: $selection) { step in
                        Text(step)
                    }
                    .toolbar {
                        ToolbarItemGroup(placement: .bottomBar) {
                            if variant.contains("text") {
                                Button("Recolor") {}
                                Spacer()
                                Button("Delete 2 Steps", role: .destructive) {}
                            } else {
                                Button("Move", systemImage: "folder") {}
                                Spacer()
                                Button("Delete", systemImage: "trash", role: .destructive) {}
                            }
                        }
                    }
                } else {
                    List {
                        ForEach(steps, id: \.self) { step in
                            Text(step)
                        }
                        .onDelete { steps.remove(atOffsets: $0) }
                    }
                }
            }
            .navigationTitle("Steps")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    EditButton()
                }
            }
            .environment(\.editMode, $editMode)
        }
        .task {
            guard variant != "inactive" else { return }
            try? await Task.sleep(for: .milliseconds(700))
            editMode = .active
        }
    }
}
