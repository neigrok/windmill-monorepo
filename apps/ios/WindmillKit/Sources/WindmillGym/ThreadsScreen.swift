import SwiftUI
import WindmillPlatform

// THREADS, DRAWN (§O screen 33) and the one conversation a row opens. Both are AWAY screens on the
// room's own stack, reached from Ask's header and from a routine's History row — never from the
// rail, because a list of past conversations is not one of the three places a lifter stands.
//
// THE LIST IS NOT AN INBOX and this file is where that would be lost first. There is no unread
// count, no badge, no dot, no notification and nothing that resurfaces a thread on its own; there is
// no search, no filter, no folder and no pin. A row is the lifter's own words and what came of them,
// grouped by the month it was last asked in, and that is the whole surface.
//
// EVERY DETAIL ON A ROW IS THE SERVER'S OBSERVATION — the count and the routine off the ledger, the
// state off the log. Nothing here says why anybody did anything, because nothing observes why: see
// the head of AskThreads.swift for the one line of the board this refuses to draw.

// What the room lends these two screens, already bound to one account — the same shape `AskDoors`
// and `CoachDoors` take, and for the same reason: a screen holding the API could reach the log in
// ways its own copy does not describe.
struct ThreadDoors {
    let list: () async -> Result<[AskThread], AskRefusal>
    // Absent is `nil` rather than a failure: a conversation deleted from the web while this room was
    // open is gone, and the screen says so instead of offering a retry at something that will never
    // come back.
    let read: (String) async -> Result<AskThread?, AskRefusal>
    // The sentence when it did not happen, and nothing when it did.
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
        // Re-read every time this screen appears rather than cached: a conversation deleted on
        // another surface, or a proposal applied from the routine screen since, must not still be
        // drawn here with the outcome it had an hour ago.
        .task { await read() }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(AskThreads.title)
                .font(WindmillFont.display(19))
                .foregroundStyle(skin.ink)
            // The count is what was actually read and never a promise about what is there: before
            // the read lands there is no number to print, so none is — and a full page says `200+`
            // rather than asserting a total the reply does not carry (`AskThreads.meta`).
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

    // THE ROW: the question in the lifter's own words, then what came of it. The title is drawn as
    // it was typed — no clipping to a neat length, no case change, no quotation marks added around
    // somebody's sentence — and it wraps rather than trailing off, because the words are the point.
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

// ONE CONVERSATION, READ BACK. It is the turns as they were sent, byte for byte, the proposals it
// minted as doors onto their diffs, and the delete.
//
// IT IS READ-ONLY, AND THAT IS A DECISION. The wire would take another question into this thread,
// and §O does not draw one being asked here — the foot of the list says `Ask something new`, which
// is a new conversation. So this screen carries no composer: what it is for is coming back to
// something, and a chat box on a six-week-old evening is a different product from the one drawn.
//
// AND NO RECEIPT LINE UNDER A RECALLED ANSWER. The server stores the turns and not the accounting
// for them — a stored turn is `{from, text, at}` — so there is no `read 214 sets` to print, and
// printing one this screen worked out would be the exact tally §L exists to refuse.
struct ThreadScreen: View {
    let threadId: String
    let doors: ThreadDoors
    let onDeleted: () -> Void

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
                    ForEach(thread.proposals) { minted in proposal(minted) }
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
    }

    // THE TITLE IS THE FIRST MESSAGE AND IT IS DRAWN VERBATIM — the same string the row printed, so
    // a lifter arriving here recognises what they tapped rather than meeting a second name for it.
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

    // The conversation as it was said. A lifter's turn keeps the shape it has in the live stream —
    // indented, in the accent's wash — so reading a thread back and asking one look the same.
    private func turns(_ thread: AskThread) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            ForEach(Array((thread.turns ?? []).enumerated()), id: \.offset) { _, turn in
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

    // A door onto the diff, which is the only place a pending one can be applied. The state beside
    // it is the log's word and not this screen's memory of what was tapped.
    private func proposal(_ minted: ThreadProposal) -> some View {
        Button { doors.openProposal(minted.id) } label: {
            HStack(spacing: WindmillSpace.x2) {
                Text(minted.line)
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

    // Destructive, in the room's alarm ink, with the sentence that makes it honest under it — the
    // same shape the one other delete in this product takes, and no dialog: what it does and what it
    // does not do are both on screen before the tap rather than in a sheet after it.
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

    // THE SCREEN ONLY LEAVES ONCE THE LOG SAYS IT IS GONE. A delete drawn as done on the strength of
    // a request that never landed would tell a lifter a conversation had been deleted when it had
    // not — which on this screen is the one claim that has to be true.
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
