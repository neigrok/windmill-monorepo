import SwiftUI
import UIKit
import PhotosUI
import WindmillPlatform

// `ask` is the room's one send path (`GymRoom.ask`): the composer, the retry and the finish receipt's
// first question all go through it, so nothing here settles an exchange or reads a refusal's flags.
struct AskDoors {
    let ask: (_ question: String, _ replacing: String?) -> Void
    let openThreads: () -> Void
    let openNotes: () -> Void
    let connect: () -> Void
    let openProposal: (String) -> Void
    var openRoutine: (String) -> Void = { _ in }
    var newChat: () -> Void = {}
    var account: () -> Void = {}
    var older: () -> Void = {}
    var stop: () -> Void = {}
    var addPhoto: (Data, String) -> Void = { _, _ in }
    var removePhoto: () -> Void = {}
    var retryPhoto: () -> Void = {}
    var cancelPhoto: () -> Void = {}
    var readPhoto: (String, String) async throws -> Data = { _, _ in throw CocoaError(.fileReadNoSuchFile) }
}

struct AskScreen: View {
    @ObservedObject var store: TrainingStore
    @Binding var conversation: AskConversation
    let doors: AskDoors
    // Receipt lines by proposal id, the room's for this visit only: not stored, gone on reopening.
    let receipts: [String: String]
    // Proposals whose review was closed without a decision this visit.
    let undecided: Set<String>
    var photo: CoachPhotoDraft? = nil
    var photoData: Data? = nil
    var photoBusy = false
    var uploadProgress: Double? = nil
    var photoFailure: String? = nil

    @Environment(\.gymSkin) private var skin
    @State private var minted: [String: Proposal] = [:]
    // Exchanges whose step list is open; the receipt above it is drawn either way.
    @State private var opened: Set<String> = []
    @State private var selection: PhotosPickerItem?
    @State private var pickerBusy = false
    @State private var pickerFailure: String?
    @State private var followLatest = true
    @State private var userScroll = false
    @State private var bottomY: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            messages
            composer
        }
        .toolbar { navigation }
        .task { await readMinted() }
        .task(id: selection) {
            guard let selection else { return }
            let thread = conversation.threadId
            pickerBusy = true
            pickerFailure = nil
            defer { pickerBusy = false; self.selection = nil }
            do {
                if let data = try await selection.loadTransferable(type: Data.self) {
                    try Task.checkCancellation()
                    doors.addPhoto(data, thread)
                }
                else { pickerFailure = "Choose a supported photo." }
            } catch { if !Task.isCancelled { pickerFailure = "Photo could not be opened. Try again." } }
        }
        // The room settles the exchanges; an answer that lands carries the proposals to read.
        .onChange(of: proposalIds) { _, _ in Task { await readMinted() } }
        // A receipt is a settled proposal: the card under it redraws from the log.
        .onChange(of: receipts) { _, _ in Task { await readMinted() } }
        .onChange(of: undecided) { _, _ in Task { await readMinted() } }
    }

    private var messages: some View {
        GeometryReader { viewport in
            ScrollViewReader { reader in
                ScrollView {
                    messageList
                    Color.clear.frame(height: 1).id("latest")
                        .background(GeometryReader { proxy in
                            Color.clear.preference(key: CoachBottom.self,
                                value: proxy.frame(in: .named("coach-scroll")).maxY)
                        })
                }
                .coordinateSpace(name: "coach-scroll")
                .defaultScrollAnchor(.bottom)
                .onPreferenceChange(CoachBottom.self) { y in
                    bottomY = y
                    if userScroll { followLatest = y <= viewport.size.height + 64 }
                }
                .simultaneousGesture(DragGesture(minimumDistance: 2)
                    .onChanged { _ in userScroll = true; followLatest = false }
                    .onEnded { _ in
                        followLatest = bottomY <= viewport.size.height + 64
                        userScroll = false
                    })
                .onChange(of: conversation.exchanges) { _, _ in
                    if followLatest {
                        DispatchQueue.main.async { reader.scrollTo("latest", anchor: .bottom) }
                    }
                }
                .onChange(of: conversation.threadId) { _, _ in
                    selection = nil
                    followLatest = true
                    reader.scrollTo("latest", anchor: .bottom)
                }
                .overlay(alignment: .bottomTrailing) {
                    if !followLatest {
                        Button("Jump to latest") {
                            followLatest = true
                            reader.scrollTo("latest", anchor: .bottom)
                        }
                        .font(.caption).padding(12)
                        .background(skin.surface, in: Capsule())
                        .padding(.trailing, GymLayout.gutter)
                    }
                }
            }
        }
    }

    private var messageList: some View {
        VStack(alignment: .leading, spacing: GymLayout.sectionGap) {
            if conversation.nextCursor != nil {
                Button("Load earlier messages") { followLatest = false; doors.older() }
                    .frame(minHeight: GymTap.minimum).disabled(conversation.isLoading)
            }
            if conversation.isLoading { ProgressView() }
            if let failure = conversation.historyFailure {
                Text(failure).foregroundStyle(skin.inkDim)
                Button("Try again", action: doors.older).frame(minHeight: GymTap.minimum)
            }
            ForEach(conversation.exchanges) { exchange in
                VStack(alignment: .leading, spacing: GymLayout.blockGap) {
                    ForEach(exchange.attachments) { attachment in
                        CoachPhotoView(attachment: attachment, thread: conversation.threadId, read: doors.readPhoto)
                            .id("\(conversation.threadId):\(attachment.id)")
                    }
                    if !exchange.question.isEmpty { asked(exchange.question) }
                    outcome(of: exchange)
                }
                .id(exchange.id)
            }
            ForEach(unattachedProposals, id: \.self) { id in
                proposal(id)
                if let receipt = receipts[id] { self.receipt(receipt) }
            }
        }
        .padding(.horizontal, GymLayout.gutter)
        .padding(.top, GymLayout.contentTop)
        .padding(.bottom, WindmillSpace.x4)
    }

    @ToolbarContentBuilder
    private var navigation: some ToolbarContent {

            ToolbarItem(placement: .topBarTrailing) {
                Button(AskThreads.door, action: doors.openThreads)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Notes", action: doors.openNotes)
                    Button("Connected log", action: doors.connect)
                    if !conversation.exchanges.isEmpty { Button("New chat", action: doors.newChat) }
                    Button("Account", action: doors.account)
                } label: {
                    Image(systemName: "ellipsis").frame(minWidth: GymTap.minimum, minHeight: GymTap.minimum)
                }
                .accessibilityLabel("More")
            }
    }

    private func asked(_ text: String) -> some View {
        HStack {
            Spacer(minLength: WindmillSpace.x8)
            CoachMessageText(text: text)
                .font(WindmillFont.body(14.5))
                .foregroundStyle(skin.ink)
                .lineSpacing(4)
                .multilineTextAlignment(.leading)
                .padding(.horizontal, GymLayout.rowInset)
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
            if let snapshot = exchange.snapshot { answered(snapshot, of: exchange) }
            if exchange.snapshot?.answer.isEmpty ?? true { ProgressView(Ask.waiting)
                .font(GymType.numeral(12.5))
                .tint(skin.inkFaint)
                .foregroundStyle(skin.inkFaint)
            }
        case .answered(let answer):
            answered(answer, of: exchange)
        case .refused(let why) where why.capReached:
            if let snapshot = exchange.snapshot { answered(snapshot, of: exchange) }
        case .refused(let why):
            if let snapshot = exchange.snapshot { answered(snapshot, of: exchange) }
            refused(why, of: exchange)
        }
    }

    // The receipt is always visible; the steps sit behind it and open on one tap.
    private func answered(_ answer: AskAnswer, of exchange: AskExchange) -> some View {
        let lines = Ask.stepLines(answer.steps)
        let open = opened.contains(exchange.id)
        return VStack(alignment: .leading, spacing: GymLayout.blockGap) {
            if !answer.answer.isEmpty { CoachMessageText(text: answer.answer)
                .font(WindmillFont.body(14.5))
                .foregroundStyle(skin.ink)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(answer.results.filter { $0.kind == "routine-created" }) { result in
                VStack(alignment: .leading, spacing: WindmillSpace.x1) {
                    Text("Routine created").font(.caption).foregroundStyle(skin.inkDim)
                    Button { doors.openRoutine(result.routineId) } label: {
                        Label(result.routineName, systemImage: "arrow.up.right")
                            .frame(minHeight: GymTap.minimum, alignment: .leading)
                    }
                    .accessibilityLabel("Open routine, \(result.routineName)")
                }
            }
            ForEach(answer.proposals, id: \.self) { id in
                proposal(id)
                if let receipt = receipts[id] { self.receipt(receipt) }
            }
            if answer.hasReceipt { Button {
                if open { opened.remove(exchange.id) } else { opened.insert(exchange.id) }
            } label: {
                HStack(spacing: WindmillSpace.x1) {
                    Text(answer.read.line)
                        .font(GymType.numeral(11))
                        .foregroundStyle(skin.inkFaint)
                    if !lines.isEmpty {
                        Image(systemName: open ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(skin.inkFaint)
                    }
                }
                .frame(minHeight: GymTap.minimum)
                .contentShape(Rectangle())
            }
            .disabled(lines.isEmpty)
            .accessibilityLabel(answer.read.line)
            .accessibilityHint(lines.isEmpty ? "" : (open ? "Hides what it read" : "Shows what it read"))
            if open, !lines.isEmpty { steps(lines) }
            }
        }
    }

    private func steps(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x1) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
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
        VStack(alignment: .leading, spacing: GymLayout.blockGap) {
            HStack(spacing: WindmillSpace.x2) {
                Circle()
                    .fill(skin.accent)
                    .frame(width: 6, height: 6)
                Text(found.map { "Proposal · \($0.baseName)" } ?? "Proposal")
                    .font(GymType.numeral(10.5, .bold))
                    .textCase(.uppercase)
                    .kerning(0.9)
                    .foregroundStyle(skin.accent)
                    .lineLimit(1)
                Spacer(minLength: WindmillSpace.x2)
                if let found {
                    Text(found.state == .pending
                            ? "\(found.head.changes) · \(undecided.contains(id) ? Proposal.stillWaiting : Proposal.waiting)"
                            : found.state.word)
                        .font(GymType.numeral(11))
                        .foregroundStyle(skin.inkFaint)
                }
            }
            if let found, !found.head.summary.isEmpty {
                Text(found.head.summary)
                    .font(WindmillFont.body(14))
                    .foregroundStyle(skin.ink)
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button { doors.openProposal(id) } label: {
                Text(Proposal.review)
                    .font(WindmillFont.body(14.5, .bold))
                    .foregroundStyle(skin.onAccent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.accent))
            }
            // A promise about what Apply will do is spent by the DECISION and by nothing else: taken
            // or turned down, it goes; unread — the read has not landed, or failed, or the row has
            // left the log — the card still offers Review, so the promise stands. What survives the
            // decision is the door to the rows the card counted, which is above.
            if (found?.state ?? .pending) == .pending {
                Text(Ask.proposalNote)
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(GymLayout.cardInset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.accent, lineWidth: 1))
    }

    // Derived from the server's reply and ephemeral: nothing pretends it is history.
    private func receipt(_ line: String) -> some View {
        Text(line)
            .font(GymType.numeral(12.5, .bold))
            .foregroundStyle(skin.inkDim)
            .padding(.horizontal, GymLayout.rowInset)
            .frame(minHeight: WindmillSpace.x8)
            .background(Capsule().fill(skin.raised))
            .accessibilityLabel(line)
    }

    private func refused(_ why: AskRefusal, of exchange: AskExchange) -> some View {
        VStack(alignment: .leading, spacing: GymLayout.blockGap) {
            Text(why.line)
                .font(WindmillFont.body(14))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
            if why.mayRetry {
                Button { doors.ask(exchange.question, exchange.id) } label: {
                    Text("Try again")
                        .font(WindmillFont.body(14, .semibold))
                        .foregroundStyle(skin.inkDim)
                        .padding(.horizontal, WindmillSpace.x4)
                        .frame(minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.md)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
                .disabled(conversation.waiting)
            }
        }
        .padding(WindmillSpace.x3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.md).strokeBorder(skin.line, lineWidth: 1))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            if photo != nil && conversation.unresolved == nil { photoDraft }
            if pickerBusy { ProgressView("Opening photo…") }
            if let failure = pickerFailure ?? photoFailure { Text(failure).font(.caption).foregroundStyle(skin.inkDim) }
            if let why = conversation.cappedRefusal {
                Text(why.line).font(.callout).foregroundStyle(skin.inkDim)
                if let exchange = conversation.exchanges.last, why.mayRetry {
                    Button("Try again") { doors.ask(exchange.question, exchange.id) }
                        .frame(minHeight: GymTap.minimum)
                }
                Button("Connected log", action: doors.connect).frame(minHeight: GymTap.minimum)
            } else {
                input
            }
        }
        .padding(.horizontal, GymLayout.gutter)
        .padding(.vertical, WindmillSpace.x2)
    }

    private var input: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x2) {
            HStack(spacing: WindmillSpace.x2) {
                PhotosPicker(selection: $selection, matching: .images) {
                    Image(systemName: "photo.badge.plus")
                        .frame(width: GymTap.minimum, height: GymTap.minimum)
                }
                .accessibilityLabel("Add photo")
                .disabled(conversation.unresolved != nil || photoBusy || pickerBusy)
                TextField(Ask.placeholder, text: $conversation.draft, axis: .vertical)
                    .font(WindmillFont.body(15))
                    .foregroundStyle(skin.ink)
                    .lineLimit(1...4)
                    .padding(.horizontal, WindmillSpace.x4)
                    .frame(minHeight: GymTap.secondary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.raised))
                    .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
                Button(action: conversation.waiting ? doors.stop : send) {
                    Image(systemName: conversation.waiting ? "stop.fill" : "arrow.up")
                        .font(.system(size: 19, weight: .bold))
                        .foregroundStyle(skin.onAccent)
                        .frame(width: GymTap.secondary, height: GymTap.secondary)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.accent))
                }
                .accessibilityLabel(conversation.waiting ? "Stop" : "Send")
                .disabled(!conversation.waiting && !canSend)
                .opacity(conversation.waiting || canSend ? 1 : 0.5)
            }
            if !Ask.fits(conversation.draft) {
                Text(Ask.tooLong)
                    .font(GymType.numeral(11.5))
                    .foregroundStyle(skin.inkFaint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var photoDraft: some View {
        HStack(spacing: 12) {
            if let photoData, let image = UIImage(data: photoData) {
                Image(uiImage: image).resizable().scaledToFit().frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityLabel("Photo attachment")
            }
            if let uploadProgress { ProgressView(value: uploadProgress).accessibilityLabel("Photo upload") }
            Spacer(minLength: 0)
            if photoBusy {
                Button("Cancel upload", action: doors.cancelPhoto).frame(minHeight: GymTap.minimum)
            } else {
                if photo?.uploaded == false {
                    Button("Retry upload", action: doors.retryPhoto).frame(minHeight: GymTap.minimum)
                }
                Button("Remove photo", systemImage: "xmark", action: doors.removePhoto)
                    .labelStyle(.iconOnly).frame(width: GymTap.minimum, height: GymTap.minimum)
            }
        }
    }

    private var canSend: Bool {
        !conversation.waiting && !conversation.isLoading && conversation.unresolved == nil
            && !photoBusy && !pickerBusy && Ask.fits(conversation.draft)
            && (Ask.question(from: conversation.draft) != nil || photo?.uploaded == true)
            && (photo == nil || photo?.uploaded == true)
    }

    private func send() {
        guard canSend else { return }
        doors.ask(conversation.draft, nil)
    }

    private var unattachedProposals: [String] {
        let attached = Set(conversation.exchanges.flatMap { exchange in
            if case .answered(let answer) = exchange.outcome { return answer.proposals }
            return exchange.snapshot?.proposals ?? []
        })
        return conversation.historyProposals.map(\.id).filter { !attached.contains($0) }
    }

    private var proposalIds: [String] {
        let referenced = conversation.exchanges.flatMap { exchange in
            if case .answered(let answer) = exchange.outcome { return answer.proposals }
            return exchange.snapshot?.proposals ?? []
        }
        return Set(referenced + conversation.historyProposals.map(\.id)).sorted()
    }

    private func readMinted() async {
        for id in proposalIds {
            if case .success(let found) = await store.proposal(id) { minted[id] = found }
        }
    }

}

struct AskSignedOutStance: View {
    let onSignIn: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: GymLayout.sectionGap) {
            Text(Ask.needsSignIn)
                .font(GymType.numeral(12.5))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onSignIn) {
                Text(Ask.signIn)
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.secondary)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, GymLayout.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// Notes stay reachable here: a connected agent reads them whether or not this Windmill carries Coach.
struct AskAbsentStance: View {
    let onNotes: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        VStack(alignment: .leading, spacing: GymLayout.sectionGap) {
            Text(Ask.absentLine)
                .font(WindmillFont.body(15))
                .foregroundStyle(skin.inkDim)
                .lineSpacing(5)
                .fixedSize(horizontal: false, vertical: true)
            NotesDoorRow(action: onNotes)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, GymLayout.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// A row, never a third icon in the top bar: the notes are the lifter's, not Coach's.
struct NotesDoorRow: View {
    let action: () -> Void

    @Environment(\.gymSkin) private var skin

    var body: some View {
        Button(action: action) {
            HStack(spacing: WindmillSpace.x3) {
                Text(Ask.notesDoor)
                    .font(WindmillFont.body(14.5, .semibold))
                    .foregroundStyle(skin.ink)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(skin.inkFaint)
            }
            .padding(.horizontal, GymLayout.gutter)
            .frame(maxWidth: .infinity, minHeight: GymTap.minimum, alignment: .leading)
            .contentShape(Rectangle())
        }
        .overlay(alignment: .bottom) { Rectangle().fill(skin.line).frame(height: 1) }
    }
}

struct CoachMessageText: View {
    let text: String

    var body: some View {
        Text(text)
            .textSelection(.enabled)
            .contextMenu {
                if !text.isEmpty {
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                }
            }
            .accessibilityAction(named: "Copy") { if !text.isEmpty { UIPasteboard.general.string = text } }
    }
}

private struct CoachBottom: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct CoachPhotoView: View {
    let attachment: CoachAttachment
    let thread: String
    let read: (String, String) async throws -> Data
    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0
    @State private var expanded = false

    var body: some View {
        Group {
            if let image {
                Button { expanded = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 220)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .accessibilityLabel("Open photo")
                .sheet(isPresented: $expanded) {
                    NavigationStack {
                        Image(uiImage: image).resizable().scaledToFit()
                            .toolbar { Button("Done") { expanded = false } }
                    }
                }
            } else if failed {
                Button("Photo could not load. Retry") { attempt += 1 }.frame(minHeight: GymTap.minimum)
            } else { ProgressView().accessibilityLabel("Photo") }
        }
        .task(id: "\(thread):\(attachment.id):\(attempt)") {
            failed = false
            do {
                let bytes = try await read(attachment.id, thread)
                try Task.checkCancellation()
                image = UIImage(data: bytes)
                failed = image == nil
            } catch { if !Task.isCancelled { failed = true } }
        }
    }
}
