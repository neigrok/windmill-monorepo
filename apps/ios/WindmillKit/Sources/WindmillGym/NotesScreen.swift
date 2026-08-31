import SwiftUI
import WindmillPlatform

struct NotesDoors {
    let list: () async -> Result<[Note], NotesRefusal>
    let write: (_ id: String, _ write: NoteWrite) async -> Result<Note, NotesRefusal>
    // Withheld: the row leaves the drawn list and the DELETE waits out the window on the room's transient.
    let delete: (String) -> Void
    let reorder: ([String]) async -> Result<[Note], NotesRefusal>
}

// Nothing is stored until the lifter saves: the two placeholder rows are empty rows, never notes.
struct NotesScreen: View {
    let doors: NotesDoors
    // A note whose delete is still withheld comes out of what is DRAWN and walks back in when the undo
    // lands; a note whose delete has LANDED leaves the store's list as well. `standing` is what the
    // store holds and `drawn` is what the list shows, so `Add a note` never stands over a store that
    // will refuse, and the cap line never goes on standing over a store that would take one.
    @ObservedObject var withheld: WithheldWindow

    @Environment(\.gymSkin) private var skin
    @State private var notes: [Note]?
    @State private var failure: String?
    @State private var editing: NoteDraft?
    @State private var note: String?

    var body: some View {
        VStack(spacing: 0) {
            head
            if let notes {
                list(standing: Self.standing(notes, outside: withheld))
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

    // What the STORE holds, which is what the cap counts and what the empty stance reads. A note
    // inside its window is still stored — `Add a note` may not stand over a store that will refuse —
    // and one whose delete has LANDED is not: the register is the only thing that knows the
    // difference, so the count asks it. Read off the last list the server served, ten notes stay ten
    // for the rest of the visit, and `10 of 10 notes. Delete one to add another.` goes on standing
    // over nine rows, naming a way out the lifter has already taken.
    @MainActor
    static func standing(_ notes: [Note], outside withheld: WithheldWindow) -> [Note] {
        notes.filter { !withheld.settled(.note, $0.id) }
    }

    private func drawn(_ standing: [Note]) -> [Note] {
        standing.filter { !withheld.hides(.note, $0.id) }
    }

    // What the STORE holds decides the state — the empty stance, the cap; the window decides only which
    // rows are drawn.
    private func list(standing: [Note]) -> some View {
        let rows = drawn(standing)
        let count = standing.count
        return List {
            if count == 0 {
                ForEach(Notes.placeholders, id: \.self) { title in
                    Button { editing = NoteDraft(placeholder: title) } label: { placeholderRow(title) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(rowInsets)
                }
            } else {
                ForEach(rows) { stored in
                    Button { editing = NoteDraft(editing: stored) } label: { row(stored) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(rowInsets)
                }
                .onMove { from, to in Task { await move(from: from, to: to) } }
            }
            foot(stored: count)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(rowInsets)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, GymTap.minimum)
        // A handle appears with the second note, beside the caption that says what dragging decides.
        .environment(\.editMode, .constant(rows.count > 1 ? .active : .inactive))
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

    // Counted off the STORE, never the drawn rows: a note inside its undo window is still a note, and the
    // cap line has to stand while it is true.
    @ViewBuilder
    private func foot(stored count: Int) -> some View {
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
    // The drag is over the DRAWN rows, so the order the log is told is the standing list with those rows
    // resequenced in it: a note inside its window was not draggable and keeps the place it had.
    private func move(from: IndexSet, to: Int) async {
        guard let held = notes else { return }
        let standing = Self.standing(held, outside: withheld)
        var moved = drawn(standing)
        moved.move(fromOffsets: from, toOffset: to)
        let reordered = resequenced(standing, drawn: moved)
        notes = reordered
        note = nil
        switch await doors.reorder(reordered.map(\.id)) {
        case .success(let served): notes = served.sorted { $0.position < $1.position }
        case .failure(let why):
            notes = standing
            note = why.line
        }
    }

    private func resequenced(_ standing: [Note], drawn moved: [Note]) -> [Note] {
        var queue = moved
        return standing.map { withheld.hides(.note, $0.id) || queue.isEmpty ? $0 : queue.removeFirst() }
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

    @Environment(\.gymSkin) private var skin
    @Environment(\.dismiss) private var dismiss
    @State private var refusal: String?
    @State private var working = false
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

    // Withhold, then leave the editor in the same handler: the sheet renders over the room's transient and
    // would hide the only Undo there is. A refusal after the window is said on the room's own line.
    private var deleteRow: some View {
        Button { remove() } label: {
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

    private func remove() {
        guard !working else { return }
        doors.delete(draft.id)
        dismiss()
    }
}

struct NotesSignedOutStance: View {
    let onSignIn: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            Text(Notes.needsSignIn)
                .padding(.top, WindmillSpace.x6)
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
