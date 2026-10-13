import SwiftUI
import UIKit
import PhotosUI
import GymDomain

private enum CoachDestination: Hashable { case history, notes, connections }

// What one answer read, opened from its receipt row into the What Coach read sheet.
struct CoachSources: Identifiable {
  let id = UUID()
  let receipt: CoachReceipt
  let steps: [CoachStep]
}

struct CoachTab: View {
  let gym: GymModel
  @Binding var handoff: CoachHandoff?
  @State var coach: CoachConversation
  @State var history: CoachHistory
  @State var fixturePrepared = false
  @State private var destination: CoachDestination?
  @State var review: ProposalReviewID?
  @State var sources: CoachSources?
  @State var photo: PhotosPickerItem?
  @State var preparing = false
  @State var atLatest = true
  @Environment(\.coachOpenAccount) var openAccount
  @Environment(\.scenePhase) var phase
  @FocusState var composing: Bool
  init(gym: GymModel, handoff: Binding<CoachHandoff?> = .constant(nil), coach: CoachConversation? = nil) { self.gym = gym; _handoff = handoff; let rest = coach?.rest ?? CoachFixture.rest(gym)
    _coach = State(initialValue: coach ?? CoachConversation(gym: gym, rest: rest)); _history = State(initialValue: CoachHistory(gym: gym, rest: rest)) }

  var body: some View {
    room.modifier(GymPage()).navigationTitle("Coach").accessibilityIdentifier("gym-coach")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { more }
        if #available(iOS 26, *) { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) }
      }
      .navigationDestination(item: $destination) { destination in
        switch destination {
        case .history: CoachHistoryScreen(gym: gym, coach: coach, history: history)
        case .notes: NotesScreen(gym: gym)
        case .connections: ConnectedLogScreen(gym: gym)
        }
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 0) {
          band
          if composing {
            Button { composing = false } label: {
              Image(systemName: "keyboard.chevron.compact.down").font(.body.weight(.semibold)).foregroundStyle(GymPalette.ink)
                .frame(width: 36, height: 36).modifier(GlassCircle())
                .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
            }.buttonStyle(.plain).accessibilityLabel("Done").accessibilityIdentifier("coach-keyboard-done")
              .frame(maxWidth: .infinity, alignment: .trailing).padding(.horizontal, 12)
          }
          if coach.allowed, coach.refusal != .absent { composer }
        }
      }
      .sheet(item: $review) { id in
        ProposalReviewSheet(gym: gym, proposalId: id.id) { name in composing = coach.newChat(seed: "Tell me about the proposal for \(name).") }
      }
      .sheet(item: $sources) { sources in CoachSourcesSheet(gym: gym, sources: sources) }
      .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition):\(handoff?.id.uuidString ?? "")") {
        if !fixturePrepared { fixturePrepared = true; await CoachFixture.prepare(gym) }
        history.resetOwner(); await coach.activate()
        if let handoff, coach.begin(handoff) { self.handoff = nil; composing = !handoff.send }
        coach.noteOffline()
      }
      .onChange(of: coach.asking) { _, asking in
        if !asking, let handoff, coach.begin(handoff) { self.handoff = nil; composing = !handoff.send }
      }
      .onChange(of: coach.offline) { _, offline in
        if offline { coach.noteOffline() } else if coach.error == CoachCopy.offline, !coach.retryable { coach.error = nil }
      }
      .onChange(of: phase) { _, phase in
        if phase == .background { coach.work?.cancel(); coach.stopWork?.cancel(); history.abandon() }
        if phase == .active { Task { await coach.activate() } }
      }
      .onChange(of: photo) { _, value in
        guard let value else { return }
        preparing = true
        let owner = gym.account, thread = coach.saved.threadId
        Task {
          defer { preparing = false; photo = nil }
          do {
            guard let data = try await value.loadTransferable(type: Data.self) else { throw AppFailure(message: "Choose a supported photo.") }
            guard owner == gym.account, coach.saved.threadId == thread else { return }
            try coach.addPhoto(data)
          } catch { coach.error = "Choose a supported photo." }
        }
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "coach"]) }
  }

  @ViewBuilder var room: some View {
    if !coach.allowed { CoachUnavailable(sentence: CoachCopy.signedOut, signIn: openAccount) }
    else if coach.refusal == .absent { CoachUnavailable(sentence: CoachCopy.absent) }
    else { conversation }
  }

  var more: some View {
    Menu {
      if coach.saved.request != nil || coach.saved.thread != nil {
        Section { Button("New chat") { coach.newChat() }.disabled(coach.asking).accessibilityIdentifier("coach-menu-new-chat") }
      }
      Section {
        Button("History") { destination = .history }.accessibilityIdentifier("coach-menu-history")
        Button("Notes") { destination = .notes }.accessibilityIdentifier("coach-menu-notes")
        Button("Connected log") { destination = .connections }.accessibilityIdentifier("coach-menu-connections")
      }
    } label: { Label("More", systemImage: "ellipsis.circle") }
      .labelStyle(.iconOnly).accessibilityIdentifier("coach-more")
  }

  var conversation: some View {
    ScrollViewReader { proxy in
      ScrollView {
        ZStack(alignment: .bottom) {
          Color.clear.containerRelativeFrame(.vertical)
          LazyVStack(alignment: .leading, spacing: 20) {
            if coach.reading { progress("Reading your conversation…") }
            if coach.saved.thread?.nextCursor != nil {
              Button("Earlier messages") { Task { await coach.open(coach.saved.threadId, earlier: true) } }
                .font(.subheadline).frame(minHeight: RoomSpace.minimumTarget).disabled(coach.reading || coach.asking)
            }
            ForEach(coach.visibleTurns) { turn in
              if turn.from == "lifter" { question(turn.text, attachments: turn.attachments) }
              else {
                answer(turn.text, receipt: turn.receipt, steps: turn.receipt?.steps ?? [], results: turn.results)
                if turn.status == "failed" || turn.status == "stopped" {
                  Text(turn.status == "failed" ? CoachCopy.interrupted : CoachCopy.stopped).font(.footnote).foregroundStyle(GymPalette.inkDim)
                }
              }
            }
            ForEach(coach.saved.exchanges) { generation in generationView(generation) }
            if let generation = coach.activeGeneration { generationView(generation) }
            else if let request = coach.saved.request {
              question(request.question, attachments: coach.saved.photo.map { [$0] } ?? [])
              if coach.asking { progress("reading your log…") }
            }
            Color.clear.frame(height: 1).id("latest")
          }.padding(RoomSpace.inset).frame(maxWidth: .infinity, alignment: .leading)
        }.contentShape(Rectangle()).onTapGesture { composing = false }
      }.defaultScrollAnchor(.bottom, for: .sizeChanges).scrollDismissesKeyboard(.interactively)
        .onScrollGeometryChange(for: Bool.self) { geometry in
          geometry.visibleRect.maxY - geometry.contentInsets.bottom >= geometry.contentSize.height - 40
        } action: { _, latest in atLatest = latest }
        .overlay(alignment: .bottomTrailing) {
          if !atLatest, !composing {
            Button { withAnimation { proxy.scrollTo("latest", anchor: .bottom) } } label: {
              Image(systemName: "chevron.down").font(.body.weight(.semibold)).foregroundStyle(GymPalette.ink)
                .frame(width: 36, height: 36).modifier(GlassCircle())
                .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
            }.buttonStyle(.plain).accessibilityLabel("Jump to latest").accessibilityIdentifier("coach-jump-to-latest").padding(12)
          }
        }
        .onChange(of: coach.saved.request?.requestId) { _, request in
          if request != nil { composing = false }
          proxy.scrollTo("latest", anchor: .bottom)
        }
    }
  }

  var band: some View {
    let tooLong = coach.saved.text.utf8.count > 1000
    let message = tooLong ? "Keep your question within 1000 bytes." : coach.refusal == .absent ? nil : coach.error ?? (coach.retryable ? CoachCopy.interrupted : nil)
    let retry: (() -> Void)? = tooLong ? nil : coach.retryable ? { composing = false; coach.retry() } : coach.draftReadable ? nil : { coach.reloadDraft() }
    return GymTransient(gym: gym, message: message, dismiss: tooLong || retry != nil ? nil : { coach.error = nil }, retryMessage: retry,
                        errorIdentifier: "gym-coach-error", undoIdentifier: "coach-engine-undo")
      .onChange(of: coach.error) { _, error in if let error { UIAccessibility.post(notification: .announcement, argument: error) } }
  }

  // One capsule: Add photo, the question, and Send, which dims and never reshapes when it cannot go (ios-redesign.md §6).
  var composer: some View {
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      if preparing {
        CoachPhotoView.tile(ProgressView()).accessibilityLabel("Preparing photo").padding(.leading, RoomSpace.minimumTarget).padding(.top, RoomSpace.related)
      }
      else if let photo = coach.saved.photo, !coach.asking {
        CoachPhotoView(gym: gym, thread: coach.saved.threadId, attachment: photo, local: coach.saved.photoData)
          .overlay(alignment: .topTrailing) {
            Button { coach.removePhoto() } label: {
              Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.palette).foregroundStyle(GymPalette.card, GymPalette.inkDim)
                .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
            }.buttonStyle(.plain).offset(x: 18, y: -18).accessibilityLabel("Remove photo")
          }.padding(.leading, RoomSpace.minimumTarget).padding(.top, RoomSpace.related)
      }
      HStack(alignment: .bottom, spacing: 0) {
        let target = RoomSpace.minimumTarget
        PhotosPicker(selection: $photo, matching: .images) { Image(systemName: "photo.badge.plus").frame(width: target, height: target) }.accessibilityLabel("Add photo").disabled(coach.asking || preparing || !coach.draftReadable)
        TextField("Ask about your training", text: Binding(get: { coach.saved.text }, set: { coach.edit($0) }), axis: .vertical)
          .lineLimit(1...5).focused($composing).disabled(coach.asking || !coach.draftReadable).accessibilityIdentifier("coach-question")
          .id(coach.asking).padding(.vertical, 11)
        send
      }
    }.padding(4).background(GymPalette.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
      .padding(.horizontal, RoomSpace.inset).padding(.bottom, RoomSpace.related)
  }

  @ViewBuilder var send: some View {
    if coach.asking {
      Button { coach.stopResponse() } label: { circle("stop.fill", dimmed: coach.stopping) }.buttonStyle(.plain)
        .disabled(coach.stopping).accessibilityLabel(coach.uploading ? "Cancel upload" : "Stop response").accessibilityIdentifier("coach-stop")
    } else {
      let empty = !CoachCopy.sendable(coach.saved.text, photo: coach.saved.photo != nil) || preparing
      Button { if coach.blockedReason == nil { composing = false }; coach.send() } label: { circle("arrow.up", dimmed: empty || coach.blockedReason != nil) }
        .buttonStyle(.plain).disabled(empty)
        .accessibilityLabel("Ask Coach").accessibilityHint(coach.blockedReason ?? "").accessibilityIdentifier("coach-send")
    }
  }

  func circle(_ symbol: String, dimmed: Bool) -> some View {
    Image(systemName: symbol).font(.body.weight(.semibold)).foregroundStyle(GymPalette.onAccent)
      .frame(width: 36, height: 36).background(GymPalette.accent, in: Circle()).opacity(dimmed ? 0.4 : 1)
      .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
  }

  func progress(_ label: String) -> some View {
    HStack(spacing: RoomSpace.related) { ProgressView(); Text(label).font(.footnote).foregroundStyle(GymPalette.inkDim) }
  }

  func question(_ text: String, attachments: [CoachAttachment]) -> some View {
    CoachQuestion(gym: gym, thread: coach.saved.threadId, text: text, attachments: attachments,
                  draft: coach.saved.photo.flatMap { photo in coach.saved.photoData.map { (photo.id, $0) } }, uploading: coach.uploading)
  }

  func answer(_ text: String, receipt: CoachReceipt?, steps: [CoachStep], results: [CoachResult]) -> some View {
    CoachAnswerView(gym: gym, text: text, receipt: receipt, steps: steps, results: results,
                    review: { review = ProposalReviewID(id: $0) }, read: { sources = $0 })
  }

  func generationView(_ generation: CoachGeneration) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      question(generation.question, attachments: generation.attachments)
      if generation.answer.isEmpty, generation.status == "running" { progress("reading your log…") }
      answer(generation.answer, receipt: generation.receipt, steps: generation.steps, results: generation.results)
    }
  }
}

// The 36 pt glass circle of the room's two "down" controls: Jump to latest, and the keyboard's Done while typing.
struct GlassCircle: ViewModifier {
  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOS 26.0, *) { content.glassEffect(.regular.interactive(), in: Circle()) }
    else { content.background(.regularMaterial, in: Circle()) }
  }
}

// The lifter's turn: a bubble at most 78 % wide, its photos as thumbnails under it, both against the trailing edge.
struct CoachQuestion: View {
  let gym: GymModel
  let thread: String
  let text: String
  let attachments: [CoachAttachment]
  var draft: (id: String, data: Data)?
  var uploading = false
  var body: some View {
    VStack(alignment: .trailing, spacing: RoomSpace.related) {
      if !text.isEmpty {
        Text(text).textSelection(.enabled).padding(.horizontal, 14).padding(.vertical, 10)
          .background(GymPalette.accentSoft, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
          .contextMenu { Button("Copy question") { UIPasteboard.general.string = text } }
      }
      ForEach(attachments) { attachment in
        let local = draft?.id == attachment.id ? draft?.data : nil
        CoachPhotoView(gym: gym, thread: thread, attachment: attachment, local: local)
          .overlay { if uploading, local != nil { ProgressView().accessibilityLabel("Photo upload") } }
      }
    }.frame(maxWidth: .infinity, alignment: .trailing)
      .containerRelativeFrame(.horizontal, alignment: .trailing) { length, _ in length * 0.78 }
      .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

// Coach's turn: prose on the canvas, then one receipt row, any proposal cards and any routine it created.
struct CoachAnswerView: View {
  let gym: GymModel
  let text: String
  let receipt: CoachReceipt?
  let steps: [CoachStep]
  let results: [CoachResult]
  let review: (String) -> Void
  let read: (CoachSources) -> Void
  @Environment(\.coachOpenRoutine) var openRoutine
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if !text.isEmpty { CoachMarkdown(text: text).contextMenu { Button("Copy answer") { UIPasteboard.general.string = text } } }
      if let receipt {
        if receipt.workouts.isEmpty, steps.allSatisfy({ $0.phrase == nil }) {
          Text(receipt.read.line).font(.footnote.monospaced()).foregroundStyle(GymPalette.inkDim)
        } else {
          Button { read(CoachSources(receipt: receipt, steps: steps)) } label: {
            HStack(spacing: RoomSpace.related) {
              Text(receipt.read.line).multilineTextAlignment(.leading)
              Spacer(minLength: 0)
              Image(systemName: "chevron.right").fontWeight(.semibold)
            }.font(.footnote.monospaced()).foregroundStyle(GymPalette.inkDim).frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
          }.buttonStyle(.plain).accessibilityLabel(receipt.read.line).accessibilityIdentifier("coach-read-receipt")
        }
      }
      ForEach(receipt?.proposals ?? [], id: \.self) { id in CoachProposalCard(gym: gym, id: id) { review(id) } }
      ForEach(results.filter { $0.kind == "routine-created" }) { result in
        Button { openRoutine?(result.routineId) } label: {
          HStack(spacing: 12) {
            Image(systemName: "list.bullet.rectangle").foregroundStyle(GymPalette.accent)
            Text("Open routine · " + result.routineName).foregroundStyle(GymPalette.ink)
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.inkDim)
          }.frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel("Open routine · " + result.routineName)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

// What a proposal would change, as up to three fact rows, and its one door: the Review row, carrying the state.
struct CoachProposalCard: View {
  let gym: GymModel
  let id: String
  let review: () -> Void
  var body: some View {
    let proposal = gym.proposals.first { $0.id.record.string == id }
    let facts = proposal.map(gym.coachProposalFacts) ?? []
    let label = proposal.map { $0.intent == "remove" ? "Review removal" : "Review " + GymCount.of(gym.coachChangeCount($0), "change") } ?? "Review proposal"
    let state = proposal.map { ["pending": "still waiting", "dismissed": "turned down"][$0.state] ?? $0.state }
    VStack(alignment: .leading, spacing: 12) {
      Text("Proposal" + (proposal.map { " · " + ($0.baseName ?? $0.proposedName) } ?? ""))
        .font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(GymPalette.accent)
      if let proposal, !proposal.summary.isEmpty { Text(proposal.summary) }
      if !facts.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(Array(facts.prefix(3).enumerated()), id: \.offset) { _, fact in
            HStack(alignment: .firstTextBaseline, spacing: 12) {
              Text(fact.title).font(.subheadline).foregroundStyle(GymPalette.ink)
              Spacer(minLength: 0)
              Text(fact.fact).font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim).multilineTextAlignment(.trailing)
            }
          }
          if facts.count > 3 { Text("+ \(facts.count - 3) more").font(.footnote).foregroundStyle(GymPalette.inkFaint) }
        }
      }
      Button(action: review) {
        HStack(spacing: RoomSpace.related) {
          Text(label).foregroundStyle(GymPalette.accent)
          Spacer(minLength: 0)
          if let state { Text(state).font(.footnote).foregroundStyle(GymPalette.inkDim) }
          Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.inkDim)
        }.frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityLabel(label).accessibilityValue(state ?? "").accessibilityIdentifier("coach-review")
    }.padding(RoomSpace.inset).frame(maxWidth: .infinity, alignment: .leading)
      .background(GymPalette.card, in: RoundedRectangle(cornerRadius: RoomSpace.cardRadius))
      .overlay(RoundedRectangle(cornerRadius: RoomSpace.cardRadius).stroke(GymPalette.accent, lineWidth: 1))
  }
}

struct CoachMarkdown: View {
  let text: String
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(Array(text.components(separatedBy: "\n\n").enumerated()), id: \.offset) { _, block in
        if block.hasPrefix("```") { Text(block.replacingOccurrences(of: "```", with: "")).font(.body.monospaced()).textSelection(.enabled) }
        else if block.hasPrefix("#") { Text(block.drop(while: { $0 == "#" || $0 == " " })).font(.headline).accessibilityAddTraits(.isHeader) }
        else { Text((try? AttributedString(markdown: block, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block)).textSelection(.enabled) }
      }
    }
  }
}

// The sources behind one answer: what Coach read, then each workout as a door to it.
struct CoachSourcesSheet: View {
  let gym: GymModel
  let sources: CoachSources
  @Environment(\.dismiss) var dismiss
  @Environment(\.coachOpenSession) var openSession
  var body: some View {
    NavigationStack {
      List {
        let phrases = sources.steps.compactMap(\.phrase)
        if !phrases.isEmpty {
          Section { ForEach(phrases, id: \.self) { phrase in Text(phrase.prefix(1).uppercased() + phrase.dropFirst()) } }
            .listRowBackground(GymPalette.card)
        }
        if !sources.receipt.workouts.isEmpty {
          Section("Workouts") { ForEach(sources.receipt.workouts) { source in workout(source) } }
            .listRowBackground(GymPalette.card)
        }
      }.listStyle(.insetGrouped).navigationTitle("What Coach read").modifier(GymPage())
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }.presentationDetents([.medium, .large])
      .accessibilityIdentifier("gym-coach-sources")
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "sources"]) }
  }
  func workout(_ source: CoachObservation) -> some View {
    let available = gym.sessions.contains { $0.id.record.string == source.sessionId }
    let facts = source.workout.map { [GymCount.of($0.workingSetCount, "working set"), Readout.weight($0.tonnageKg) + " kg"] } ?? []
    return Button { dismiss(); openSession?(source.sessionId) } label: {
      HStack(spacing: RoomSpace.related) {
        VStack(alignment: .leading, spacing: RoomSpace.small) {
          Text(source.routine ?? "Workout").font(.body.weight(.semibold)).foregroundStyle(GymPalette.ink)
          Text(available ? ([CoachCopy.day(source.startedAt)] + facts).joined(separator: " · ") : "no longer available")
            .font(.subheadline).monospacedDigit().foregroundStyle(GymPalette.inkDim)
        }
        Spacer(minLength: 0)
        if available { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(GymPalette.inkDim) }
      }.frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
    }.buttonStyle(.plain).disabled(!available).accessibilityIdentifier("coach-source-" + source.sessionId)
  }
}

// A sent or drafted photo: a 56 pt thumbnail that opens full size.
struct CoachPhotoView: View {
  let gym: GymModel
  let thread: String
  let attachment: CoachAttachment
  let local: Data?
  let owner: String?
  init(gym: GymModel, thread: String, attachment: CoachAttachment, local: Data?) {
    self.gym = gym; self.thread = thread; self.attachment = attachment; self.local = local; owner = gym.account
  }
  @State var data: Data?
  @State var loadedOwner: String?
  @State var failed = false
  @State var connectionRequired = false
  @State var enlarged = false
  var image: UIImage? {
    guard owner == gym.account, gym.coachAccountAvailable, local != nil || loadedOwner == gym.account else { return nil }
    return (data ?? local).flatMap(UIImage.init(data:))
  }
  var body: some View {
    Group {
      if let image {
        Button { enlarged = true } label: {
          Image(uiImage: image).resizable().scaledToFill().frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }.buttonStyle(.plain).accessibilityLabel("Enlarge photo")
      } else if failed {
        Button { Task { await load() } } label: { Self.tile(Image(systemName: "arrow.clockwise").foregroundStyle(GymPalette.accent)) }
          .buttonStyle(.plain).accessibilityLabel(connectionRequired ? "Photo needs a connection. Retry" : "Photo unavailable. Retry")
      } else { Self.tile(ProgressView()).accessibilityLabel("Reading photo") }
    }.task(id: "\(gym.account ?? ""):\(thread):\(attachment.id)") { data = nil; if local == nil { await load() } }
      .sheet(isPresented: $enlarged) {
        NavigationStack {
          ZStack { if let image { Image(uiImage: image).resizable().scaledToFit().padding() } }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .modifier(GymPage()).navigationTitle("Photo").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { enlarged = false } } }
        }.presentationDetents([.large])
      }
  }
  // The thumbnail's place while a photo is read, prepared or needs a retry.
  static func tile(_ content: some View) -> some View {
    content.frame(width: 56, height: 56).background(GymPalette.line, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
  func load() async {
    let owner = gym.account; failed = false; connectionRequired = false
    do {
      let loaded = try await CoachFixture.rest(gym).coachRequest("/v1/gym/threads/\(CoachCopy.escaped(thread))/attachments/\(CoachCopy.escaped(attachment.id))", expectedAccount: owner)
      guard owner == gym.account, !gym.accountTransition else { return }
      guard UIImage(data: loaded) != nil else { throw URLError(.cannotDecodeContentData) }
      loadedOwner = owner; data = loaded
    } catch {
      if owner == gym.account, !(error is CancellationError) {
        failed = true; connectionRequired = GymRESTClient.needsConnection(error)
      }
    }
  }
}
