import SwiftUI
import WindmillPlatform

struct AskDoors {
    let send: (_ thread: String, _ question: String) async -> Result<AskAnswer, AskRefusal>
    let openThreads: () -> Void
    let connect: () -> Void
    let openProposal: (String) -> Void
    let absent: () -> Void
}

struct AskScreen: View {
    @ObservedObject var store: TrainingStore
    @Binding var conversation: AskConversation
    let doors: AskDoors

    @Environment(\.gymSkin) private var skin
    @State private var question = ""
    @State private var sending = false
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

    private func answered(_ answer: AskAnswer) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(answer.answer)
                .font(WindmillFont.body(14.5))
                .foregroundStyle(skin.ink)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            if !answer.steps.isEmpty { steps(answer.steps) }
            ForEach(answer.proposals, id: \.self) { id in proposal(id) }
            Text(answer.read.line)
                .font(GymType.numeral(11))
                .foregroundStyle(skin.inkFaint)
        }
    }

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

    private func refused(_ why: AskRefusal, of exchange: AskExchange) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(why.line)
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
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

    private var canSend: Bool {
        !sending && Ask.question(from: question) != nil
    }

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
            if why.opensAFreshThread { conversation.openAFreshThread() }
            if why.closesTheDoor { doors.absent() }
        }
    }

    // Found by id, never by index: the room may have been left and re-entered under the await.
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

struct AskSignedOutStance: View {
    let onSignIn: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            AskStanceHead()
            Text(Ask.scope)
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            Text(Ask.needsSignIn)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onSignIn) {
                Text(Ask.signIn)
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

struct AskAbsentStance: View {
    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x4) {
            AskStanceHead()
            Text(Ask.absentLine)
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, WindmillSpace.x4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct AskStanceHead: View {
    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(Ask.title)
                .font(WindmillFont.display(19))
                .foregroundStyle(skin.ink)
            Text(Ask.subtitle)
                .font(GymType.numeral(11))
                .foregroundStyle(skin.inkFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, WindmillSpace.x6)
    }
}
