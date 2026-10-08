import SwiftUI
import UIKit
import PhotosUI
import GymDomain

private enum CoachDestination: Hashable { case history, notes, connections, settings }

struct CoachTab: View {
  let gym: GymModel
  @Binding var handoff: CoachHandoff?
  @State var coach: CoachConversation
  @State var history: CoachHistory
  @State var fixturePrepared = false
  @State private var destination: CoachDestination?
  @State private var showMenu = false
  @State var review: ProposalReviewID?
  @State var photo: PhotosPickerItem?
  @State var preparing = false
  @State var atLatest = true
  @State var accountHint = false
  @Environment(\.coachOpenAccount) var openAccount
  @Environment(\.scenePhase) var phase
  @FocusState var composing: Bool
  init(gym: GymModel, handoff: Binding<CoachHandoff?> = .constant(nil), coach: CoachConversation? = nil) { self.gym = gym; _handoff = handoff; let rest = coach?.rest ?? CoachFixture.rest(gym)
    _coach = State(initialValue: coach ?? CoachConversation(gym: gym, rest: rest)); _history = State(initialValue: CoachHistory(gym: gym, rest: rest)) }

  var body: some View {
    VStack(spacing: 0) {
      NavigationLink { NotesScreen(gym: gym) } label: {
        HStack {
          Text("Notes"); Text("what you write for Coach").font(.callout).foregroundStyle(.secondary)
          Spacer(); Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        }.padding(.horizontal, 16).frame(minHeight: 44).background(CoachPalette.surface)
      }.buttonStyle(.plain)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 20) {
            if !coach.allowed { Text(CoachCopy.signedOut).foregroundStyle(.secondary) }
            else if coach.saved.thread == nil, coach.saved.request == nil {
              Text("Ask about your training. Coach can create routines and propose changes — you decide on the diff.")
              Text("Every conversation is kept so you can read it back, and yours to delete.").font(.callout).foregroundStyle(.secondary)
            }
            if coach.allowed {
            if coach.reading { ProgressView("Reading your conversation…") }
            if coach.saved.thread?.nextCursor != nil { Button("Earlier messages") { Task { await coach.open(coach.saved.threadId, earlier: true) } }.disabled(coach.reading || coach.asking) }
            ForEach(coach.visibleTurns) { turn in
              if turn.from == "lifter" { question(turn.text, attachments: turn.attachments) }
              else {
                CoachAnswerView(gym: gym, thread: coach.saved.threadId, text: turn.text, receipt: turn.receipt, steps: turn.receipt?.steps ?? [], results: turn.results, review: { review = ProposalReviewID(id: $0) })
                if turn.status == "failed" || turn.status == "stopped" { Text(turn.status == "failed" ? CoachCopy.interrupted : CoachCopy.stopped).font(.callout).foregroundStyle(.secondary) }
              }
            }
            ForEach(coach.saved.exchanges) { generation in generationView(generation) }
            if let generation = coach.activeGeneration { generationView(generation) }
            else if let request = coach.saved.request {
              question(request.question, attachments: coach.saved.photo.map { [$0] } ?? [])
              if coach.asking { ProgressView("reading your log…") }
            }
            if let error = coach.error {
              Text(error).font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("coach-error")
                .onChange(of: error, initial: true) { _, error in UIAccessibility.post(notification: .announcement, argument: error) }
            }
            if coach.retryable { Button("Retry") { composing = false; coach.retry() }.accessibilityIdentifier("coach-retry") }
            if !coach.draftReadable { Button("Try again") { coach.reloadDraft() } }
            if !coach.canCompose, coach.allowed {
              if case .fresh = coach.refusal { Button("Ask something new") { coach.newChat() } }
              NavigationLink("Connect your own") { ConnectedLogScreen(gym: gym) }
              NavigationLink("Notes") { NotesScreen(gym: gym) }
            }
            }
            if accountHint { Text("Open You and settings in the top bar.").font(.callout).foregroundStyle(.secondary) }
            Color.clear.frame(height: 1).id("latest")
          }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }.defaultScrollAnchor(.bottom, for: .sizeChanges).scrollDismissesKeyboard(.interactively)
          .onScrollGeometryChange(for: Bool.self) { geometry in geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 40 } action: { _, latest in atLatest = latest }
          .overlay(alignment: .bottomTrailing) {
            if !atLatest { Button("Jump to latest") { withAnimation { proxy.scrollTo("latest", anchor: .bottom) } }.buttonStyle(.bordered).padding(16).background(.ultraThinMaterial, in: Capsule()) }
          }
          .onChange(of: coach.saved.request?.requestId) { _, request in
            if request != nil { composing = false }
            proxy.scrollTo("latest", anchor: .bottom)
          }
      }
    }.navigationTitle("Coach").modifier(CoachPage()).accessibilityIdentifier("gym-coach")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button { showMenu = true } label: { Label("More", systemImage: "ellipsis.circle") }.accessibilityIdentifier("coach-more")
        }
      }
      .confirmationDialog("Coach", isPresented: $showMenu, titleVisibility: .hidden) {
        Button("History") { destination = .history }
        Button("Notes") { destination = .notes }
        Button("Connected log") { destination = .connections }
        Button("Gym settings") { destination = .settings }
        if coach.saved.request != nil || coach.saved.thread != nil { Button("New chat") { coach.newChat() }.disabled(coach.asking) }
        Button("Account") { if let openAccount { openAccount() } else { accountHint = true } }
      }
      .navigationDestination(item: $destination) { destination in
        switch destination {
        case .history: CoachHistoryScreen(gym: gym, coach: coach, history: history)
        case .notes: NotesScreen(gym: gym)
        case .connections: ConnectedLogScreen(gym: gym)
        case .settings: GymSettingsScreen(gym: gym)
        }
      }
      .safeAreaInset(edge: .bottom) { VStack(spacing: 0) { composer; CoachNoticeBand(gym: gym) } }
      .sheet(item: $review) { id in
        ProposalReviewSheet(gym: gym, proposalId: id.id) { name in composing = coach.newChat(seed: "Tell me about the proposal for \(name).") }
      }
      .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition):\(handoff?.id.uuidString ?? "")") {
        if !fixturePrepared { fixturePrepared = true; await CoachFixture.prepare(gym) }
        history.resetOwner(); await coach.activate()
        if let handoff, coach.begin(handoff) { self.handoff = nil; composing = !handoff.send }
      }
      .onChange(of: coach.asking) { _, asking in
        if !asking, let handoff, coach.begin(handoff) { self.handoff = nil; composing = !handoff.send }
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

  @ViewBuilder var composer: some View {
    if coach.canCompose || coach.asking {
      VStack(alignment: .leading, spacing: 8) {
        Text("Ten questions a day, three back to back.").font(.caption.monospaced()).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        if preparing { ProgressView("Preparing photo…") }
        if coach.uploading { ProgressView("Photo upload").accessibilityLabel("Photo upload") }
        if let photo = coach.saved.photo, !coach.asking {
          HStack {
            CoachPhotoView(gym: gym, thread: coach.saved.threadId, attachment: photo, local: coach.saved.photoData)
            Button("Remove photo") { coach.removePhoto() }
          }
        }
        if composing {
          HStack {
            Spacer()
            Button { composing = false } label: { Text("Done").frame(minWidth: 44, minHeight: 44) }
              .accessibilityIdentifier("coach-keyboard-done")
          }.frame(minHeight: 44)
        }
        HStack(alignment: .bottom, spacing: 10) {
          PhotosPicker(selection: $photo, matching: .images) { Image(systemName: "photo.badge.plus").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("Add photo").disabled(coach.asking || preparing)
          TextField("Ask about your training", text: Binding(get: { coach.saved.text }, set: { coach.edit($0) }), axis: .vertical)
            .lineLimit(1...5).focused($composing).disabled(coach.asking).accessibilityIdentifier("coach-question")
            .id(coach.asking)
          if coach.asking {
            Button { coach.stopResponse() } label: { Image(systemName: "stop.fill").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel(coach.uploading ? "Cancel upload" : "Stop response").disabled(coach.stopping).accessibilityIdentifier("coach-stop")
          } else {
            Button { composing = false; coach.send() } label: { Image(systemName: "arrow.up").foregroundStyle(CoachPalette.onAccent).frame(minWidth: 44, minHeight: 44) }
              .buttonStyle(.borderedProminent).clipShape(Circle()).accessibilityLabel("Ask Coach").accessibilityIdentifier("coach-send")
              .disabled(!CoachCopy.sendable(coach.saved.text, photo: coach.saved.photo != nil) || preparing)
          }
        }
        if coach.saved.text.utf8.count > 1000 { Text("Keep your question within 1000 bytes.").font(.caption).foregroundStyle(.red) }
      }.padding(12).background(CoachPalette.surface).tint(CoachPalette.accent)
    }
  }
  func question(_ text: String, attachments: [CoachAttachment]) -> some View {
    HStack {
      Spacer(minLength: 24)
      VStack(alignment: .leading, spacing: 8) {
        if !text.isEmpty { Text(text).textSelection(.enabled).contextMenu { Button("Copy question") { UIPasteboard.general.string = text } } }
        ForEach(attachments) { attachment in CoachPhotoView(gym: gym, thread: coach.saved.threadId, attachment: attachment, local: nil) }
      }.padding(12).background(CoachPalette.accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 16))
    }
  }
  func generationView(_ generation: CoachGeneration) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      question(generation.question, attachments: generation.attachments)
      if generation.answer.isEmpty, generation.status == "running" { ProgressView("reading your log…") }
      CoachAnswerView(gym: gym, thread: coach.saved.threadId, text: generation.answer, receipt: generation.receipt,
                      steps: generation.steps, results: generation.results, review: { review = ProposalReviewID(id: $0) })
    }
  }
}

struct CoachAnswerView: View {
  let gym: GymModel
  let thread: String
  let text: String
  let receipt: CoachReceipt?
  let steps: [CoachStep]
  let results: [CoachResult]
  let review: (String) -> Void
  @Environment(\.coachOpenRoutine) var openRoutine
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      CoachMarkdown(text: text).contextMenu { Button("Copy answer") { UIPasteboard.general.string = text } }
      if let receipt {
        DisclosureGroup(receipt.read.line) {
          ForEach(Array(steps.enumerated()), id: \.offset) { _, step in if let phrase = step.phrase { Text(phrase).font(.callout).foregroundStyle(.secondary) } }
          ForEach(receipt.workouts) { source in
            DisclosureGroup(source.routine ?? "Workout") {
              Text(Date(timeIntervalSince1970: Double(source.startedAt) / 1000).formatted(date: .abbreviated, time: .shortened))
              if let workout = source.workout {
                Text("\(workout.workingSetCount) working sets · \(workout.tonnageKg.formatted()) kg")
                if let duration = workout.durationMs { Text("\(duration / 60_000) min") }
              }
              CoachSourceWorkout(gym: gym, id: source.sessionId)
            }.font(.callout)
          }
        }.font(.caption.monospaced()).foregroundStyle(.secondary)
        ForEach(receipt.proposals, id: \.self) { id in
          VStack(alignment: .leading, spacing: 12) {
            if let p = gym.proposals.first(where: { $0.id.record.string == id }) {
              Text("PROPOSAL · " + (p.baseName ?? p.proposedName)).font(.caption.weight(.semibold)).foregroundStyle(CoachPalette.accent)
              Text(p.summary.isEmpty ? "Proposal" : p.summary)
              Text(p.intent == "remove" ? "a removal" : "\(p.changeCount ?? p.changes.filter { $0.kind != "kept" }.count) changes").font(.caption.monospaced()).foregroundStyle(.secondary)
              Text(p.state == "pending" ? "still waiting" : p.state == "dismissed" ? "turned down" : p.state).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            Button("Review") { review(id) }.frame(minHeight: 44)
            if gym.proposals.first(where: { $0.id.record.string == id })?.state == "pending" { Text(CoachCopy.promise).font(.caption).foregroundStyle(.secondary) }
          }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(CoachPalette.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(CoachPalette.accent))
        }
      }
      ForEach(results.filter { $0.kind == "routine-created" }) { result in
        Button { openRoutine?(result.routineId) } label: { Label("Open routine · " + result.routineName, systemImage: "list.bullet.rectangle") }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
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

struct CoachSourceWorkout: View {
  let gym: GymModel
  let id: String
  @Environment(\.coachOpenSession) var openSession
  var body: some View {
    if let session = gym.sessions.first(where: { $0.id.record.string == id }) {
      ForEach(gym.sets.filter { $0.sessionId == session.id }, id: \.id) { set in
        Text("\(gym.catalogue.find(set.exerciseId)?.name ?? "Movement unavailable") · \(Readout.effort(weightKg: set.weightKg, reps: set.reps)) kg").font(.callout.monospaced())
      }
      Button("Open workout") { openSession?(id) }
    } else { Text("This workout is no longer available.") }
  }
}

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
  @State var enlarged = false
  var body: some View {
    Group {
      if owner == gym.account, gym.coachAccountAvailable, (local != nil || loadedOwner == gym.account), let data = data ?? local, let image = UIImage(data: data) {
        Button { enlarged = true } label: { Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 140, maxHeight: 100).clipShape(RoundedRectangle(cornerRadius: 12)) }.accessibilityLabel("Enlarge photo")
      } else if failed { Button("Photo unavailable · Retry") { Task { await load() } } }
      else { ProgressView("Reading photo…") }
    }.task(id: "\(gym.account ?? ""):\(thread):\(attachment.id)") { data = nil; if local == nil { await load() } }
      .sheet(isPresented: $enlarged) {
        NavigationStack {
          Group { if owner == gym.account, gym.coachAccountAvailable, (local != nil || loadedOwner == gym.account), let data = data ?? local, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().padding() } }
            .navigationTitle("Photo").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { enlarged = false } } }
        }
      }
  }
  func load() async {
    let owner = gym.account; failed = false
    do {
      let loaded = try await CoachFixture.rest(gym).coachRequest("/v1/gym/threads/\(CoachCopy.escaped(thread))/attachments/\(CoachCopy.escaped(attachment.id))", expectedAccount: owner)
      guard owner == gym.account, !gym.accountTransition else { return }
      guard UIImage(data: loaded) != nil else { throw URLError(.cannotDecodeContentData) }
      loadedOwner = owner; data = loaded
    } catch { if owner == gym.account, !(error is CancellationError) { failed = true } }
  }
}
