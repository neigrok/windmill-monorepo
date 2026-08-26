import SwiftUI
import WindmillPlatform

struct ThreadDoors {
    let list: () async -> Result<[AskThread], AskRefusal>
    // A success carrying nil is a conversation that is gone, not a failure.
    let read: (String) async -> Result<AskThread?, AskRefusal>
    // The sentence when it did not happen, nil when it did.
    let delete: (String) async -> String?
    let openThread: (String) -> Void
    let openProposal: (String) -> Void
    let askSomethingNew: () -> Void
}

struct ThreadsScreen: View {
    let doors: ThreadDoors

    @Environment(\.gymSkin) private var skin
    @State private var threads: [AskThread]?
    @State private var failure: AskRefusal?

    var body: some View {
        VStack(spacing: 0) {
            head
            ScrollView {
                VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                    if let threads {
                        if threads.isEmpty { empty } else { months(of: threads) }
                    } else if let failure {
                        silence(failure.line)
                    } else {
                        Text(AskThreads.reading)
                            .font(GymType.numeral(13))
                            .foregroundStyle(skin.inkFaint)
                    }
                }
                .padding(.horizontal, WindmillSpace.x4)
                .padding(.vertical, WindmillSpace.x4)
            }
            foot
        }
        .task { await read() }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(AskThreads.title)
                .font(WindmillFont.display(19))
                .foregroundStyle(skin.ink)
            if let threads {
                Text(AskThreads.meta(threads.count))
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, WindmillSpace.x4)
        .padding(.top, WindmillSpace.x6)
        .padding(.bottom, WindmillSpace.x3)
        .overlay(alignment: .bottom) { Rectangle().fill(skin.line).frame(height: 1) }
    }

    private func months(of threads: [AskThread]) -> some View {
        ForEach(AskThreads.months(of: threads, now: nowMs)) { month in
            VStack(alignment: .leading, spacing: WindmillSpace.x2) {
                Text(month.label)
                    .font(GymType.numeral(10.5, .bold))
                    .textCase(.uppercase)
                    .kerning(0.9)
                    .foregroundStyle(skin.inkFaint)
                ForEach(month.threads) { thread in
                    Button { doors.openThread(thread.id) } label: { row(thread) }
                }
            }
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

    private var empty: some View {
        Text(AskThreads.empty)
            .font(WindmillFont.body(14.5))
            .foregroundStyle(skin.inkDim)
            .lineSpacing(5)
            .fixedSize(horizontal: false, vertical: true)
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
        .padding(.top, WindmillSpace.x3)
    }

    private func read() async {
        failure = nil
        switch await doors.list() {
        case .success(let found): threads = found
        case .failure(let why): failure = why
        }
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

// A stored turn is `{from, text, at}` and carries no accounting to print.
struct ThreadScreen: View {
    let threadId: String
    let doors: ThreadDoors
    let onDeleted: () -> Void
    // Receipt lines by proposal id, this visit's only; a reopened thread carries none.
    let receipts: [String: String]
    let undecided: Set<String>

    @Environment(\.gymSkin) private var skin
    @State private var thread: AskThread?
    @State private var failure: String?
    @State private var deleting = false
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
                    delete
                } else if gone {
                    Text("that conversation is gone")
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkFaint)
                } else if let failure {
                    silence(failure)
                } else {
                    Text(AskThreads.reading)
                        .font(GymType.numeral(13))
                        .foregroundStyle(skin.inkFaint)
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

    private var delete: some View {
        VStack(spacing: WindmillSpace.x2) {
            Button { Task { await remove() } } label: {
                Text(AskThreads.delete)
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.alarmInk)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
            }
            .disabled(deleting)
            Text(AskThreads.deleteNote)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            if let failure {
                Text(failure)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.alarmInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, WindmillSpace.x4)
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

    // The screen only leaves once the log says it is gone.
    private func remove() async {
        guard !deleting else { return }
        deleting = true
        defer { deleting = false }
        failure = nil
        guard let why = await doors.delete(threadId) else {
            onDeleted()
            return
        }
        failure = why
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
