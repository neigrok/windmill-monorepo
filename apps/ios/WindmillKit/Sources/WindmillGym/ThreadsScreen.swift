import SwiftUI
import WindmillPlatform

struct ThreadDoors {
    let list: () async -> Result<[AskThread], AskRefusal>
    // A success carrying nil is a conversation that is gone, not a failure.
    let read: (String) async -> Result<AskThread?, AskRefusal>
    // Withheld: the row leaves the list and the DELETE waits out the window on the room's transient.
    let delete: (AskThread) -> Void
    let openThread: (String) -> Void
    let openProposal: (String) -> Void
    let askSomethingNew: () -> Void
}

struct ThreadsScreen: View {
    let doors: ThreadDoors
    // The list is read from the server and never crossed out locally, so a row whose delete is still
    // withheld comes out of what is DRAWN — and walks straight back in when the undo lands.
    @ObservedObject var withheld: WithheldWindow

    @Environment(\.gymSkin) private var skin
    @State private var served: [AskThread]?
    @State private var failure: AskRefusal?

    private var threads: [AskThread]? {
        served?.filter { !withheld.hides(.thread, $0.id) }
    }

    var body: some View {
        List {
            if let threads {
                if threads.isEmpty {
                    Section { empty }.modifier(ThreadRow())
                } else {
                    Section { meta(threads.count) }.modifier(ThreadRow())
                    months(of: threads)
                }
            } else if let failure {
                Section { silence(failure.line) }.modifier(ThreadRow())
            } else {
                Section {
                    ProgressView(AskThreads.reading)
                        .font(GymType.numeral(13))
                        .tint(skin.inkFaint)
                        .foregroundStyle(skin.inkFaint)
                        .frame(maxWidth: .infinity)
                }
                .modifier(ThreadRow())
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 1)
        .safeAreaInset(edge: .bottom) { foot }
        .task { await read() }
    }

    private func meta(_ count: Int) -> some View {
        Text(AskThreads.meta(count))
            .font(GymType.numeral(11))
            .foregroundStyle(skin.inkFaint)
    }

    private func months(of threads: [AskThread]) -> some View {
        ForEach(AskThreads.months(of: threads, now: nowMs)) { month in
            Section {
                ForEach(month.threads) { thread in
                    Button { doors.openThread(thread.id) } label: { row(thread) }
                        .buttonStyle(.plain)
                        // The delete block inside the conversation came off; this is its one home.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) { hold(thread) } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                }
            } header: {
                Text(month.label)
                    .font(GymType.numeral(10.5, .bold))
                    .textCase(.uppercase)
                    .kerning(0.9)
                    .foregroundStyle(skin.inkFaint)
            }
            .modifier(ThreadRow())
        }
    }

    private func row(_ thread: AskThread) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(thread.title)
                .font(WindmillFont.body(14.5, .bold))
                .foregroundStyle(skin.ink)
                .lineSpacing(3)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: WindmillSpace.x2) {
                if let word = thread.outcome.word { chip(word, lit: thread.outcome.changedTheProgram) }
                Text(thread.outcome.line)
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(thread.outcome.changedTheProgram ? skin.inkDim : skin.inkFaint)
                Spacer(minLength: WindmillSpace.x2)
                Text(Readout.when(thread.askedAtMs, now: nowMs))
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .padding(WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
            .strokeBorder(thread.outcome.changedTheProgram ? skin.accent : skin.line, lineWidth: 1))
    }

    private func chip(_ word: String, lit: Bool) -> some View {
        Text(word)
            .font(GymType.numeral(10, .bold))
            .textCase(.uppercase)
            .kerning(0.5)
            .foregroundStyle(lit ? skin.accent : skin.inkDim)
            .padding(.horizontal, WindmillSpace.x2)
            .frame(minHeight: 20)
            .background(Capsule().fill(lit ? skin.accentSoft : skin.raised))
    }

    // No action fits here — the way to start one is the button pinned in the reach band below. The
    // head is the STATE and never the screen's own name: the navigation bar already says `Threads`,
    // and a pushed screen says its title once.
    private var empty: some View {
        ContentUnavailableView {
            Label(AskThreads.emptyHead, systemImage: "bubble.left.and.bubble.right")
                .foregroundStyle(skin.inkDim)
        } description: {
            Text(AskThreads.empty)
                .foregroundStyle(skin.inkFaint)
        }
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

    private var foot: some View {
        Button(action: doors.askSomethingNew) {
            Text(AskThreads.askSomethingNew)
                .font(WindmillFont.body(16.5, .bold))
                .foregroundStyle(skin.onAccent)
                .frame(maxWidth: .infinity, minHeight: GymTap.primary)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
        }
        .padding(.horizontal, WindmillSpace.x4)
        .padding(.bottom, WindmillSpace.x2)
    }

    private func read() async {
        failure = nil
        switch await doors.list() {
        case .success(let found): served = found
        case .failure(let why): failure = why
        }
    }

    // The row leaves the drawn list here and now; the DELETE goes only when the window closes, which
    // is the whole reason an undo is possible — a send cannot be taken back.
    private func hold(_ thread: AskThread) {
        GymConfirm.revealed()
        doors.delete(thread)
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

// A stored turn is `{from, text, at}` and carries no accounting to print.
struct ThreadScreen: View {
    let threadId: String
    let doors: ThreadDoors
    // Receipt lines by proposal id, this visit's only; a reopened thread carries none.
    let receipts: [String: String]
    let undecided: Set<String>

    @Environment(\.gymSkin) private var skin
    @State private var thread: AskThread?
    @State private var failure: String?
    @State private var gone = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WindmillSpace.x4) {
                if let thread {
                    head(thread)
                    turns(thread)
                    ForEach(thread.proposals) { minted in
                        proposal(minted)
                        if let receipt = receipts[minted.id] { self.receipt(receipt) }
                    }
                } else if gone {
                    Text("that conversation is gone")
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkFaint)
                } else if let failure {
                    silence(failure)
                } else {
                    ProgressView(AskThreads.reading)
                        .font(GymType.numeral(13))
                        .tint(skin.inkFaint)
                        .foregroundStyle(skin.inkFaint)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, WindmillSpace.x5)
            .padding(.top, WindmillSpace.x10)
            .padding(.bottom, WindmillSpace.x8)
        }
        .task { await read() }
        .onChange(of: receipts) { _, _ in Task { await read() } }
        .onChange(of: undecided) { _, _ in Task { await read() } }
    }

    private func head(_ thread: AskThread) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            Text(thread.title)
                .font(WindmillFont.display(24))
                .foregroundStyle(skin.ink)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            Text([Readout.when(thread.createdAtMs, now: nowMs), thread.outcome.line]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · "))
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
        }
    }

    private func turns(_ thread: AskThread) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            ForEach(Array((thread.turns ?? []).filter(\.isDrawn).enumerated()), id: \.offset) { _, turn in
                if turn.from == .lifter {
                    HStack {
                        Spacer(minLength: WindmillSpace.x8)
                        Text(turn.text)
                            .font(WindmillFont.body(14.5))
                            .foregroundStyle(skin.ink)
                            .lineSpacing(4)
                            .padding(WindmillSpace.x3)
                            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                                .fill(skin.accentSoft))
                            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                                .strokeBorder(skin.accent, lineWidth: 1))
                    }
                } else {
                    Text(turn.text)
                        .font(WindmillFont.body(14.5))
                        .foregroundStyle(skin.ink)
                        .lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func proposal(_ minted: ThreadProposal) -> some View {
        Button { doors.openProposal(minted.id) } label: {
            HStack(spacing: WindmillSpace.x2) {
                Text(minted.line(undecided: undecided.contains(minted.id)))
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkDim)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(skin.inkFaint)
            }
            .padding(.horizontal, WindmillSpace.x3)
            .frame(minHeight: GymTap.minimum)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md)
                .strokeBorder(skin.line, lineWidth: 1))
        }
    }

    private func receipt(_ line: String) -> some View {
        Text(line)
            .font(GymType.numeral(12.5, .bold))
            .foregroundStyle(skin.inkDim)
            .padding(.horizontal, WindmillSpace.x3)
            .frame(minHeight: 30)
            .background(Capsule().fill(skin.raised))
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
        switch await doors.read(threadId) {
        case .success(let found):
            thread = found
            gone = found == nil
        case .failure(let why):
            failure = why.line
        }
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

// The room's own card frame, kept under a List that would otherwise draw its own.
private struct ThreadRow: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: WindmillSpace.x4,
                                      bottom: 4, trailing: WindmillSpace.x4))
    }
}
