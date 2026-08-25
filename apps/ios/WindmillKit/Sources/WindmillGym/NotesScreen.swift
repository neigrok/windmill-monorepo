import SwiftUI
import WindmillPlatform

struct NotesDoors {
    let list: () async -> Result<[Note], NotesRefusal>
    let write: (_ id: String, _ write: NoteWrite) async -> Result<Note, NotesRefusal>
    // The sentence when it did not happen, nil when it did.
    let delete: (String) async -> String?
    let reorder: ([String]) async -> Result<[Note], NotesRefusal>
}

// Nothing is stored until the lifter saves: the two placeholder rows are empty rows, never notes.
struct NotesScreen: View {
    let doors: NotesDoors

    @Environment(\.gymSkin) private var skin
    @State private var notes: [Note]?
    @State private var failure: String?
    @State private var editing: NoteDraft?
    @State private var note: String?

    var body: some View {
        VStack(spacing: 0) {
            head
            if let notes {
                list(notes)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                        if let failure { silence(failure) } else { reading }
                    }
                    .padding(WindmillSpace.x4)
                }
            }
        }
        .task { await read() }
        .sheet(item: $editing) { draft in
            NoteEditor(draft: draft, doors: doors,
                       onSaved: { saved in
                           notes = upsert(saved, into: notes ?? [])
                           editing = nil
                       },
                       onDeleted: { id in
                           notes = (notes ?? []).filter { $0.id != id }
                           editing = nil
                       })
                .presentationBackground(skin.canvas)
                .presentationDetents([.large])
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            Text(Notes.honesty)
                .font(WindmillFont.body(15, .semibold))
                .foregroundStyle(skin.ink)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            Text(Notes.purpose)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, WindmillSpace.x4)
        .padding(.top, WindmillSpace.x6)
        .padding(.bottom, WindmillSpace.x3)
        .overlay(alignment: .bottom) { Rectangle().fill(skin.line).frame(height: 1) }
    }

    private func list(_ notes: [Note]) -> some View {
        List {
            if notes.isEmpty {
                ForEach(Notes.placeholders, id: \.self) { title in
                    Button { editing = NoteDraft(placeholder: title) } label: { placeholderRow(title) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(rowInsets)
                }
            } else {
                ForEach(notes) { stored in
                    Button { editing = NoteDraft(editing: stored) } label: { row(stored) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(rowInsets)
                }
                .onMove { from, to in Task { await move(from: from, to: to) } }
            }
            foot(count: notes.count)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(rowInsets)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, GymTap.minimum)
        // A handle appears with the second note, beside the caption that says what dragging decides.
        .environment(\.editMode, .constant(notes.count > 1 ? .active : .inactive))
    }

    private var rowInsets: EdgeInsets {
        EdgeInsets(top: 4, leading: WindmillSpace.x4, bottom: 4, trailing: WindmillSpace.x4)
    }

    private func row(_ stored: Note) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(stored.title)
                .font(WindmillFont.body(15, .bold))
                .foregroundStyle(skin.ink)
                .lineLimit(1)
            if !stored.firstLine.isEmpty {
                Text(stored.firstLine)
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
                    .lineLimit(1)
            }
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
        .contentShape(Rectangle())
    }

    private func placeholderRow(_ title: String) -> some View {
        Text(title)
            .font(WindmillFont.body(15))
            .foregroundStyle(skin.inkFaint)
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                .strokeBorder(skin.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
            .contentShape(Rectangle())
    }

    @ViewBuilder
    private func foot(count: Int) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            if Notes.canAdd(count) {
                Button { editing = NoteDraft() } label: {
                    Text(Notes.add)
                        .font(WindmillFont.body(15, .semibold))
                        .foregroundStyle(skin.accent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
                .buttonStyle(.plain)
            } else {
                Text(Notes.full)
                    .font(WindmillFont.body(15))
                    .foregroundStyle(skin.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if count > 1 {
                Text(Notes.precedence)
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
            }
            if let note {
                Text(note)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.alarmInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, WindmillSpace.x2)
    }

    private var reading: some View {
        Text(Notes.reading)
            .font(GymType.numeral(13))
            .foregroundStyle(skin.inkFaint)
    }

    private func silence(_ line: String) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(line)
                .font(GymType.numeral(13))
                .foregroundStyle(skin.inkFaint)
            Button { Task { await read() } } label: {
                Text("Try again")
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
        }
    }

    private func read() async {
        failure = nil
        switch await doors.list() {
        case .success(let found): notes = found.sorted { $0.position < $1.position }
        case .failure(let why): failure = why.line
        }
    }

    // Drawn in the new order at once; the server's reply is what stands, and a refusal restores the old order.
    private func move(from: IndexSet, to: Int) async {
        guard let standing = notes else { return }
        var reordered = standing
        reordered.move(fromOffsets: from, toOffset: to)
        notes = reordered
        note = nil
        switch await doors.reorder(reordered.map(\.id)) {
        case .success(let served): notes = served.sorted { $0.position < $1.position }
        case .failure(let why):
            notes = standing
            note = why.line
        }
    }

    private func upsert(_ saved: Note, into standing: [Note]) -> [Note] {
        guard let place = standing.firstIndex(where: { $0.id == saved.id }) else {
            return standing + [saved]
        }
        var kept = standing
        kept[place] = saved
        return kept
    }
}

struct NoteDraft: Identifiable, Equatable {
    let id: String
    var title: String
    var body: String
    let stored: Bool

    init() {
        id = Notes.mintNoteId()
        title = ""
        body = ""
        stored = false
    }

    init(placeholder: String) {
        id = Notes.mintNoteId()
        title = placeholder
        body = ""
        stored = false
    }

    init(editing note: Note) {
        id = note.id
        title = note.title
        body = note.body
        stored = true
    }
}

struct NoteEditor: View {
    @State var draft: NoteDraft
    let doors: NotesDoors
    let onSaved: (Note) -> Void
    let onDeleted: (String) -> Void

    @Environment(\.gymSkin) private var skin
    @Environment(\.dismiss) private var dismiss
    @State private var refusal: String?
    @State private var working = false
    @State private var confirmingDelete = false
    @FocusState private var focused: Field?

    private enum Field { case title, body }

    var body: some View {
        VStack(spacing: 0) {
            editorHead
            ScrollView {
                VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                    titleField
                    if let counter = Notes.counter(characters: Notes.titleCharacters(draft.title)) {
                        Text(counter)
                            .font(GymType.numeral(11.5))
                            .foregroundStyle(Notes.titleCharacters(draft.title) > Notes.maxTitleCharacters
                                             ? skin.alarmInk : skin.inkFaint)
                    }
                    bodyField
                    if let counter = Notes.counter(bytes: Notes.bodyBytes(draft.body)) {
                        Text(counter)
                            .font(GymType.numeral(11.5))
                            .foregroundStyle(Notes.bodyBytes(draft.body) > Notes.maxBodyBytes
                                             ? skin.alarmInk : skin.inkFaint)
                    }
                    if let refusal {
                        Text(refusal)
                            .font(GymType.numeral(12.5))
                            .foregroundStyle(skin.alarmInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if draft.stored { deleteRow }
                }
                .padding(.horizontal, WindmillSpace.x4)
                .padding(.vertical, WindmillSpace.x4)
            }
        }
        .task { focused = draft.title.isEmpty ? .title : .body }
        .onChange(of: draft) { refusal = nil }
        .confirmationDialog(Notes.deleteTitle, isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button(Notes.deleteConfirm, role: .destructive) { Task { await remove() } }
            Button(Notes.keep, role: .cancel) {}
        }
    }

    private var editorHead: some View {
        HStack(spacing: WindmillSpace.x3) {
            Button("Cancel") { dismiss() }
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .frame(minHeight: GymTap.minimum)
            Spacer(minLength: 0)
            Button { Task { await save() } } label: {
                Text(Notes.save)
                    .font(WindmillFont.body(15, .bold))
                    .foregroundStyle(skin.onAccent)
                    .padding(.horizontal, WindmillSpace.x4)
                    .frame(minHeight: GymTap.minimum - 8)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.accent))
            }
            // Never disabled for bounds: an over-limit tap is refused in place, in the server's sentence.
            .disabled(working)
        }
        .padding(.horizontal, WindmillSpace.x4)
        .padding(.top, WindmillSpace.x4)
        .padding(.bottom, WindmillSpace.x2)
    }

    private var titleField: some View {
        TextField(Notes.titleField, text: $draft.title)
            .font(WindmillFont.body(17, .semibold))
            .foregroundStyle(skin.ink)
            .focused($focused, equals: .title)
            .submitLabel(.next)
            .onSubmit { focused = .body }
            .padding(.horizontal, WindmillSpace.x3)
            .frame(minHeight: GymTap.minimum + 4)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(Notes.titleCharacters(draft.title) > Notes.maxTitleCharacters ? skin.alarmInk : skin.lineStrong,
                              lineWidth: 1))
    }

    private var bodyField: some View {
        TextField(Notes.bodyField, text: $draft.body, axis: .vertical)
            .font(WindmillFont.body(15))
            .foregroundStyle(skin.ink)
            .lineSpacing(4)
            .lineLimit(6...20)
            .focused($focused, equals: .body)
            .padding(WindmillSpace.x3)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(Notes.bodyBytes(draft.body) > Notes.maxBodyBytes ? skin.alarmInk : skin.lineStrong,
                              lineWidth: 1))
    }

    private var deleteRow: some View {
        Button { confirmingDelete = true } label: {
            Text(Notes.delete)
                .font(WindmillFont.body(15, .semibold))
                .foregroundStyle(skin.alarmInk)
                .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
        }
        .disabled(working)
        .padding(.top, WindmillSpace.x4)
    }

    // Refused in place with the server's sentence, whether it was this screen or the server that refused.
    private func save() async {
        guard !working else { return }
        if let why = Notes.refusal(title: draft.title, body: draft.body) {
            refusal = why
            return
        }
        guard let write = Notes.write(title: draft.title, body: draft.body) else { return }
        working = true
        defer { working = false }
        refusal = nil
        switch await doors.write(draft.id, write) {
        case .success(let saved): onSaved(saved)
        case .failure(let why): refusal = why.line
        }
    }

    private func remove() async {
        guard !working else { return }
        working = true
        defer { working = false }
        refusal = nil
        guard let why = await doors.delete(draft.id) else {
            onDeleted(draft.id)
            return
        }
        refusal = why
    }
}

struct NotesSignedOutStance: View {
    let onSignIn: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            Text(Notes.title)
                .font(WindmillFont.display(19))
                .foregroundStyle(skin.ink)
                .padding(.top, WindmillSpace.x6)
            Text(Notes.needsSignIn)
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onSignIn) {
                Text(Notes.signIn)
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum + 6)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, WindmillSpace.x4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
