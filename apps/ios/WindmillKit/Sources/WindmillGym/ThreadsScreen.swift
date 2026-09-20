import SwiftUI
import WindmillPlatform

struct ThreadDoors {
    // Withheld: the row leaves the list and the DELETE waits out the window on the room's transient.
    let delete: (AskThread) -> Void
    let openThread: (String) -> Void
    let askSomethingNew: () -> Void
    let page: (String?) async -> Result<CoachThreadPage, AskRefusal>
}

struct ThreadsScreen: View {
    let doors: ThreadDoors
    // Hidden rows return on Undo; settled deletes also leave the account’s visible history.
    @ObservedObject var withheld: WithheldWindow

    @Environment(\.gymSkin) private var skin
    @State private var served: [AskThread]?
    @State private var failure: AskRefusal?
    @State private var nextCursor: String?
    @State private var isLoading = false

    // What the ACCOUNT holds, which is what the empty stance reads. A conversation inside its window
    // is still on the log; one whose delete has LANDED is not, and the register is the only thing
    // that knows the difference. Read off the served list alone, the stance would stay suppressed for
    // the rest of the visit — the delete has to leave the READ and not only the drawn rows.
    @MainActor
    static func standing(_ threads: [AskThread], outside withheld: WithheldWindow) -> [AskThread] {
        threads.filter { !withheld.settled(.thread, $0.id) }
    }

    private func drawn(_ standing: [AskThread]) -> [AskThread] {
        standing.filter { !withheld.hides(.thread, $0.id) }
    }

    var body: some View {
        List {
            if let served {
                let standing = Self.standing(served, outside: withheld)
                let rows = drawn(standing)
                if standing.isEmpty {
                    Section { empty }.modifier(ThreadRow())
                } else {
                    months(of: rows)
                    if nextCursor != nil {
                        Button("Load older conversations") { Task { await read(older: true) } }
                            .frame(minHeight: GymTap.minimum)
                            .disabled(isLoading)
                    }
                    if let failure { silence(failure.line) }
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
        .padding(.horizontal, GymLayout.cardInset)
        .padding(.vertical, WindmillSpace.x3)
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
            .frame(minHeight: WindmillSpace.x5)
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
        VStack(alignment: .leading, spacing: GymLayout.blockGap) {
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
        .padding(.horizontal, GymLayout.gutter)
        .padding(.bottom, WindmillSpace.x2)
    }

    private func read(older: Bool = false) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        failure = nil
        switch await doors.page(older ? nextCursor : nil) {
            case .success(let found):
                let retained = older ? served ?? [] : []
                let known = Set(retained.map(\.id))
                served = retained + found.threads.filter { !known.contains($0.id) }
                nextCursor = found.nextCursor
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

// The room's own card frame, kept under a List that would otherwise draw its own.
private struct ThreadRow: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: GymLayout.cardGap / 2, leading: GymLayout.gutter,
                                      bottom: GymLayout.cardGap / 2, trailing: GymLayout.gutter))
    }
}
