import SwiftUI
import WindmillPlatform

// ASK, DRAWN (§L screens 26–27). It is an AWAY screen: the room's plain bar carries the way back and
// no rail is under it, because a chat is not a place you live and never a fourth tab.
//
// THE HEADER CARRIES NO `One` CHIP, and the design draws one. Ask ships OPEN to everyone with a hard
// cost cap and a plainly-worded daily limit (contract §4) — Windmill One cannot be bought today, so a
// chip advertising it, a price, or a locked face would all point at a checkout that answers 503. When
// the gate arms it arms on the server, and the chip comes back with it.
//
// THE THREAD LIVES IN THE ROOM. Opening a proposal tears this view down — the room mounts one screen
// at a time — so the conversation is bound from `GymRoom` and survives the walk to the diff and
// back. It still dies with the room, and since §O that costs nothing: the server keeps the
// conversation, so what this visit forgets is on the Threads list the next time anybody looks.
//
// THE HEADER CARRIES THE WAY INTO THE PAST (§O). One question goes out at a time now, with the id of
// the thread it belongs to, and the server assembles the prompt from what it stored — so this screen
// no longer composes a history to send, and the comment that used to say it did is gone with the
// code.
//
// NOTHING HERE SPEAKS FIRST. The empty state is a description of the surface, in the room's voice,
// and the only thing on this screen that Ask itself wrote is the answer under a question somebody
// asked for.
//
// WHAT §L DRAWS AND THIS SCREEN DOES NOT — named here rather than left to be found as a hole, because
// all three want the SAME missing wire field and none of them can be closed by this surface alone.
// `POST /v1/gym/ask` answers `answer` / `steps` / `read` / `proposals` and nothing else
// (backend/products/gym/adapters/http/AskApi.cpp):
//
//   · THE ROWS UNDER AN ANSWER. §L puts the training rows the answer reasoned from between the prose
//     and the read line, so a claim is checkable without trusting it. The wire carries no rows, and
//     reading them back off the log HERE would be a second account of the same answer — the exact
//     thing the receipt rule refuses. What is drawn instead is the true thing we do have: which tools
//     were called, in call order, under their own MCP names.
//   · THE REFUSAL CARD. §L answers "fix Tuesday's squat" with a card naming that exact set and an
//     `Open ›` into the fix path. The refusal itself is the model's prose and nothing on the wire says
//     WHICH set it was about; matching the sentence to a set here would be this screen guessing at a
//     reference the server never sent, and a card that opened the wrong workout is worse than a
//     sentence with no card.
//   · THE FOLLOW-UP CHIPS. In §L they are the model's own suggestions. Nothing carries them either,
//     and three chips this client wrote would be the room speaking first — in the one product whose
//     chat is defined by not doing that.

// The doors the room lends this screen, already bound to one account — the same shape `CoachDoors`
// takes, and for the same reason: a screen holding the store could reach the log in ways its own copy
// does not describe.
struct AskDoors {
    let send: (_ thread: String, _ question: String) async -> Result<AskAnswer, AskRefusal>
    // §O — every conversation this account has had, which is a screen and not a badge: nothing
    // counts them, nothing marks this door, and nothing behind it asks to be looked at.
    let openThreads: () -> Void
    // The free door (contract §5): the lifter's own assistant, reading this log over MCP. It lands
    // on the room's invitation (ConnectedLog) rather than out in a browser — the pitch, the
    // precondition and then the recipe, in that order.
    let connect: () -> Void
    let openProposal: (String) -> Void
    // Told once, when the deployment answers 404: there is no Ask here, so the entry goes.
    let absent: () -> Void
}

struct AskScreen: View {
    @ObservedObject var store: TrainingStore
    @Binding var conversation: AskConversation
    let doors: AskDoors

    @Environment(\.gymSkin) private var skin
    @State private var question = ""
    @State private var sending = false
    // The diffs behind the ids an answer minted. Re-read every time this screen appears rather than
    // cached across the walk to the diff: a proposal the lifter just applied must not still be
    // offering a Review, and the state chip is the log's answer and not this stream's memory.
    @State private var minted: [String: Proposal] = [:]

    var body: some View {
        VStack(spacing: 0) {
            head
            ScrollView {
                VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                    if conversation.exchanges.isEmpty { opening }
                    ForEach(conversation.exchanges) { exchange in
                        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                            asked(exchange.question)
                            outcome(of: exchange)
                        }
                    }
                }
                .padding(.horizontal, WindmillSpace.x4)
                .padding(.vertical, WindmillSpace.x4)
            }
            // The stream grows downward and the newest exchange is the one being read, so it sits
            // where the thumb already is rather than at the top of a scroll nobody asked to take.
            .defaultScrollAnchor(.bottom)
            composer
        }
        .task { await readMinted() }
    }

    private var head: some View {
        HStack(spacing: WindmillSpace.x3) {
            VStack(alignment: .leading, spacing: 1) {
                Text(Ask.title)
                    .font(WindmillFont.display(19))
                    .foregroundStyle(skin.ink)
                Text(Ask.subtitle)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.inkFaint)
            }
            Spacer(minLength: 0)
            // THE DOOR ONTO THE PAST, and it is a word rather than a count: a number here would be
            // the first badge in this product, on the one screen §O says must never grow one.
            Button(action: doors.openThreads) {
                Text(AskThreads.door)
                    .font(WindmillFont.body(13.5, .bold))
                    .foregroundStyle(skin.accent)
                    .frame(minHeight: GymTap.minimum)
            }
        }
        .padding(.horizontal, WindmillSpace.x4)
        .padding(.top, WindmillSpace.x6)
        .padding(.bottom, WindmillSpace.x3)
        .overlay(alignment: .bottom) {
            Rectangle().fill(skin.line).frame(height: 1)
        }
    }

    // What Ask is, what it costs a day, and — in the same breath — how to stop needing it. Neither
    // of the last two is a footnote: the cap is a design artifact and is stated BEFORE it is hit
    // rather than met as a refusal, and a lifter who already pays for an agent gets a better answer
    // from it than from us, because it knows the rest of their life.
    private var opening: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            Text(Ask.scope)
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            Text(Ask.dailyLimit)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: WindmillSpace.x3) {
                Text(Ask.freeDoor)
                    .font(GymType.numeral(12.5))
                    .foregroundStyle(skin.inkFaint)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: doors.connect) {
                    Text(Ask.connect)
                        .font(WindmillFont.body(15, .semibold))
                        .foregroundStyle(skin.accent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
            }
            .padding(WindmillSpace.x4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
            .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                .strokeBorder(skin.line, lineWidth: 1))
        }
    }

    private func asked(_ text: String) -> some View {
        HStack {
            Spacer(minLength: WindmillSpace.x8)
            Text(text)
                .font(WindmillFont.body(14.5))
                .foregroundStyle(skin.ink)
                .lineSpacing(4)
                .multilineTextAlignment(.leading)
                .padding(.horizontal, WindmillSpace.x3)
                .padding(.vertical, WindmillSpace.x3)
                .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accentSoft))
                .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                    .strokeBorder(skin.accent, lineWidth: 1))
        }
    }

    @ViewBuilder
    private func outcome(of exchange: AskExchange) -> some View {
        switch exchange.outcome {
        case .waiting:
            Text(Ask.waiting)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkFaint)
        case .answered(let answer):
            answered(answer)
        case .refused(let why):
            refused(why, of: exchange)
        }
    }

    // The prose, then what it was steered by, then the read line — in that order, because the claim
    // comes first and the evidence under it is what makes the claim checkable without trusting it.
    private func answered(_ answer: AskAnswer) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(answer.answer)
                .font(WindmillFont.body(14.5))
                .foregroundStyle(skin.ink)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            if !answer.steps.isEmpty { steps(answer.steps) }
            ForEach(answer.proposals, id: \.self) { id in proposal(id) }
            // NEVER COMPUTED HERE. The three counts are the server's, deduped where the ids are, and
            // this line only spells them — which is the whole reason a lifter can check a claim
            // against it instead of taking the model's word for the reading.
            Text(answer.read.line)
                .font(GymType.numeral(11))
                .foregroundStyle(skin.inkFaint)
        }
    }

    // WHAT THE ANSWER WAS STEERED BY, off the wire, in call order. §L draws the training rows the
    // model reasoned from here; the wire carries no rows — only which tools were called — and reading
    // them back off the log to fill the card would be a SECOND account of the same answer, which §3
    // refuses by name. So the card holds the true thing we have, in the tools' own MCP names, and the
    // rows arrive the wave the server hands them over.
    private func steps(_ called: [AskStep]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(called.enumerated()), id: \.offset) { _, step in
                Text(step.line)
                    .font(GymType.numeral(12))
                    .foregroundStyle(step.failed ? skin.alarmInk : skin.inkDim)
            }
        }
        .padding(WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(skin.line, lineWidth: 1))
    }

    // A PROPOSAL, IN THE STREAM. It is a preview and never the decision: the tap that changes a
    // program happens on the diff screen, all-or-none, and the sentence under the button says so
    // before the lifter has walked there.
    //
    // A diff this screen could not read still draws its card, because the MINT happened whatever this
    // device managed to fetch — hiding it would lose the only notice the lifter gets that something
    // is waiting on their routine.
    @ViewBuilder
    private func proposal(_ id: String) -> some View {
        let found = minted[id]
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            HStack(spacing: WindmillSpace.x2) {
                Circle()
                    .fill(skin.accent)
                    .frame(width: 6, height: 6)
                Text(found.map { "Proposal · \($0.baseName)" } ?? "Proposal")
                    .font(GymType.numeral(10.5, .bold))
                    .textCase(.uppercase)
                    .kerning(0.9)
                    .foregroundStyle(skin.accent)
                Spacer(minLength: WindmillSpace.x2)
                if let found {
                    // The count while it waits, the outcome once it is settled — because a card in a
                    // transcript outlives the decision taken on it, and one that still said "4
                    // changes" over a proposal the lifter applied an hour ago would be describing a
                    // document that no longer waits for anything.
                    Text(found.state == .pending ? found.head.changes : found.state.word)
                        .font(GymType.numeral(11))
                        .foregroundStyle(skin.inkFaint)
                }
            }
            if let found {
                let rows = Ask.diffRows(of: found, in: store.catalog)
                ForEach(Array(rows.prefix(3).enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .top, spacing: WindmillSpace.x2) {
                        Text(row.name)
                            .foregroundStyle(skin.inkFaint)
                            .frame(width: 92, alignment: .leading)
                        Text(row.change)
                            .foregroundStyle(skin.ink)
                        Spacer(minLength: 0)
                    }
                    .font(GymType.numeral(12.5))
                }
                if rows.count > 3 {
                    Text("+ \(rows.count - 3) more")
                        .font(GymType.numeral(12))
                        .foregroundStyle(skin.inkFaint)
                }
            }
            Button { doors.openProposal(id) } label: {
                Text(found?.head.reviewLabel ?? "Review it")
                    .font(WindmillFont.body(14.5, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.accent))
            }
            Text(Ask.proposalNote)
                .font(GymType.numeral(11.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.accent, lineWidth: 1))
    }

    // THE SERVER'S OWN SENTENCE, and nothing sold against it. The daily limit and the AI ceiling both
    // land here, and both say what is true — that Ask answers again later — with no price, no
    // checkout and no upgrade beside them.
    //
    // IT IS NOT DRAWN IN THE ALARM INK, and the room reserves that colour for exactly three things: a
    // write that failed, a read that failed, and the one destructive control. A question nobody
    // answered is none of them — nothing was lost, the question is still on screen, and painting a
    // designed daily limit in danger red would tell a lifter their gym is broken when it is working
    // as written. This is the room's own quiet note voice instead.
    private func refused(_ why: AskRefusal, of exchange: AskExchange) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(why.line)
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
            // Offered only where trying again could honestly land differently — a silence, or a body
            // this build could not read. A refusal the server MEANT is not retried into.
            if why.mayRetry {
                Button { Task { await ask(exchange.question, replacing: exchange.id) } } label: {
                    Text("Try again")
                        .font(WindmillFont.body(14, .semibold))
                        .foregroundStyle(skin.inkDim)
                        .padding(.horizontal, WindmillSpace.x4)
                        .frame(minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
                .disabled(sending)
            }
        }
        .padding(WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(skin.line, lineWidth: 1))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            HStack(spacing: WindmillSpace.x2) {
                TextField(Ask.placeholder, text: $question, axis: .vertical)
                    .font(WindmillFont.body(15))
                    .foregroundStyle(skin.ink)
                    .lineLimit(1...4)
                    .padding(.horizontal, 15)
                    .frame(minHeight: 54)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.raised))
                    .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
                Button { Task { await ask(question, replacing: nil) } } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 19, weight: .bold))
                        .foregroundStyle(skin.onAccent)
                        .frame(width: 54, height: 54)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
                }
                .accessibilityLabel("Send")
                .disabled(!canSend)
                .opacity(canSend ? 1 : 0.5)
            }
            // SAID WHILE IT CAN STILL BE EDITED. A question past the server's ceiling is not sent
            // short and is not sent at all — the draft stays exactly as it was typed, and the reason
            // it will not go is on screen next to it rather than arriving later as a refusal.
            if !Ask.fits(question) {
                Text(Ask.tooLong)
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, WindmillSpace.x4)
        .padding(.top, WindmillSpace.x3)
    }

    // A blank question is not a question, one already in flight is not two, and one over the ceiling
    // is a draft rather than a message. `Ask.question(from:)` is exactly what the send path admits,
    // so the button is lit precisely when a tap would send the words on screen unchanged.
    private var canSend: Bool {
        !sending && Ask.question(from: question) != nil
    }

    // ONE QUESTION AT A TIME, and since §O ONE QUESTION IS ALL THAT GOES OUT: the thread id travels
    // with it and the server assembles the prompt from the turns it stored, so this composes no
    // history and a retry cannot send a different context from the attempt it repeats.
    //
    // A RETRY IS SAFE TO SEND INTO THE SAME THREAD. Turns land only once an answer has, so a
    // question that was refused is not in the conversation and asking it again appends it once.
    //
    // WHAT THE LIFTER TYPED, WHOLE OR NOT AT ALL. Clipping here would send a question that stops
    // mid-word and then record it in the thread as the one they asked — and the thread is now kept.
    private func ask(_ asked: String, replacing id: String?) async {
        guard !sending, let text = Ask.question(from: asked) else { return }
        sending = true
        defer { sending = false }

        let standing = id.flatMap { known in conversation.exchanges.firstIndex { $0.id == known } }
        let asking: String
        if let standing {
            conversation.exchanges[standing].outcome = .waiting
            asking = conversation.exchanges[standing].id
        } else {
            let fresh = AskExchange(question: text)
            conversation.exchanges.append(fresh)
            question = ""
            asking = fresh.id
        }

        switch await doors.send(conversation.threadId, text) {
        case .success(let answer):
            settle(asking, .answered(answer))
            await readMinted()
        case .failure(let why):
            settle(asking, .refused(why))
            // The conversation is full, or its id was already somebody's. Both are answered by
            // opening a new thread, so the id is replaced here and the Try again above carries the
            // same question into it — which is exactly what the server's sentence asks for.
            if why.opensAFreshThread { conversation.openAFreshThread() }
            // The deployment has no Ask at all. The sentence stays on the screen the lifter is
            // standing on; the entry onto it does not come back.
            if why.closesTheDoor { doors.absent() }
        }
    }

    // Found by ID and never by index: the conversation is the room's, and the room may have been
    // left and re-entered under the await above.
    private func settle(_ id: String, _ outcome: AskExchange.Outcome) {
        guard let landed = conversation.exchanges.firstIndex(where: { $0.id == id }) else { return }
        conversation.exchanges[landed].outcome = outcome
    }

    private func readMinted() async {
        for exchange in conversation.exchanges {
            guard case .answered(let answer) = exchange.outcome else { continue }
            for id in answer.proposals {
                guard case .success(let found) = await store.proposal(id) else { continue }
                minted[id] = found
            }
        }
    }
}
