import SwiftUI
import UIKit
import PhotosUI
import DomainKit
import GymDomain

private enum CoachDestination: Hashable { case history, notes }

// What one answer read, as its receipt row and What Coach read say it. It counts only the workouts it lists, so the two add up.
struct CoachReading: Identifiable {
  let id = UUID()
  let workouts: [CoachObservation]
  let weeks: Int
  let notes: Bool
  let nothing: Bool
  let stats: Bool
  init(_ receipt: CoachReceipt, steps: [CoachStep], dates: GymDate) {
    workouts = receipt.workouts.sorted { $0.startedAt > $1.startedAt }
    weeks = Set(workouts.compactMap { workout in
      dates.calendar.dateInterval(of: .weekOfYear, for: dates.noon(LocalDay(Instant(ms: workout.startedAt), in: dates.moment.zone)))?.start
    }).count
    notes = steps.contains { $0.tool == "list_notes" && !$0.failed }
    nothing = receipt.read.nothing
    stats = steps.contains { $0.tool == "get_stats" && !$0.failed }
  }
  var count: String { GymCount.of(workouts.count, "workout") + " · " + GymCount.of(weeks, "week") }
  // The receipt row: what the sheet lists, else what it read in words with no number; none when it read what no line can say.
  var line: String? {
    if !workouts.isEmpty { return "Read " + count }
    if nothing { return "Read nothing from your log" }
    return stats ? "Read your movement history" : nil
  }
}

struct CoachTab: View {
  let gym: GymModel
  var escapeSetup: ((CoachSetupChoice) -> Void)?
  @Binding var handoff: CoachHandoff?
  @State var coach: CoachConversation
  @State var history: CoachHistory
  @State var fixturePrepared = false
  @State private var destination: CoachDestination?
  @State var review: ProposalReviewID?
  @State var sources: CoachReading?
  @State var photo: PhotosPickerItem?
  @State var preparing = false
  @State var choosePhoto = false
  @State var atLatest = true
  @Environment(\.coachOpenAccount) var openAccount
  @Environment(\.coachKeepRoutines) var keepRoutines
  @Environment(\.scenePhase) var phase
  @Environment(\.dynamicTypeSize) var typeSize
  @FocusState var composing: Bool
  init(gym: GymModel, handoff: Binding<CoachHandoff?> = .constant(nil), coach: CoachConversation? = nil, escapeSetup: ((CoachSetupChoice) -> Void)? = nil) { self.gym = gym; self.escapeSetup = escapeSetup; _handoff = handoff; let rest = coach?.rest ?? CoachFixture.rest(gym)
    _coach = State(initialValue: coach ?? CoachConversation(gym: gym, rest: rest)); _history = State(initialValue: CoachHistory(gym: gym, rest: rest))
    _fixturePrepared = State(initialValue: !gym.isAnonymous) }

  var body: some View {
    room.modifier(GymPage()).navigationTitle("Coach").accessibilityIdentifier("gym-coach")
      .toolbar {
        if !gym.isAnonymous {
          ToolbarItem(placement: .topBarTrailing) {
            Button("History", systemImage: "clock") { destination = .history }
              .accessibilityIdentifier("coach-history")
          }
          if #available(iOS 26, *) { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        }
        ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) }
      }.roomBar(.gym)
      .navigationDestination(item: $destination) { destination in
        switch destination {
        case .history: CoachHistoryScreen(gym: gym, coach: coach, history: history)
        case .notes: NotesScreen(gym: gym)
        }
      }
      .safeAreaInset(edge: .bottom) {
        VStack(spacing: 0) {
          band
          if composing {
            Button { composing = false } label: { glassSymbol("keyboard.chevron.compact.down") }.buttonStyle(RoomSeatStyle(diameter: 36))
              .accessibilityLabel("Done").accessibilityIdentifier("coach-keyboard-done")
              .frame(maxWidth: .infinity, alignment: .trailing).padding(.horizontal, 12)
          }
          if coach.allowed, coach.refusal != .absent { composer }
        }
      }
      .sheet(item: $review) { id in
        ProposalReviewSheet(gym: gym, proposalId: id.id) { name in composing = coach.newChat(seed: "Tell me about the proposal for \(name).") }
      }
      .sheet(item: $sources) { reading in CoachSourcesSheet(gym: gym, reading: reading) }
      .gymTabBar(hidden: composing)
      .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition):\(handoff?.id.uuidString ?? "")") {
        if !CoachFixture.setup, !fixturePrepared { fixturePrepared = await CoachFixture.prepare(gym) }
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
        if phase == .background { coach.work?.cancel(); coach.stopWork?.cancel() }
        if phase == .active { Task { await coach.activate() } }
      }
      .photosPicker(isPresented: $choosePhoto, selection: $photo, matching: .images)
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
    if !coach.allowed { CoachUnavailable(symbol: "bubble.left.and.bubble.right", sentence: CoachCopy.signedOut, signIn: openAccount) }
    else if coach.refusal == .absent { CoachUnavailable(symbol: "bubble.left.and.bubble.right", sentence: CoachCopy.absent) }
    else { conversation }
  }

  var conversation: some View {
    ScrollViewReader { proxy in
      ScrollView {
        ZStack(alignment: .bottom) {
          Color.clear.containerRelativeFrame(.vertical)
          LazyVStack(alignment: .leading, spacing: 20) {
            if coach.saved.purpose == .routineSetup, coach.saved.request == nil, coach.saved.thread == nil, coach.saved.exchanges.isEmpty, (coach.saved.onboarding ?? []).isEmpty {
              CoachSetupView { choice in
                guard coach.chooseSetup(choice) else { return }
                if choice == .screenshot { choosePhoto = true }
                else if choice.starter { composing = true }
                else { composing = false; escapeSetup?(choice) }
              }.padding(.bottom, 16)
            }
            if coach.reading { progress("Reading your conversation…") }
            if coach.saved.thread?.nextCursor != nil {
              Button("Earlier messages") { Task { await coach.open(coach.saved.threadId, earlier: true) } }
                .font(.subheadline).frame(minHeight: RoomSpace.minimumTarget).disabled(coach.reading || coach.asking)
            }
            if coach.anonymous, let allowance = coach.installationAllowance {
              VStack(alignment: .leading, spacing: RoomSpace.small) {
                Text("One-time AI setup allowance").font(.footnote.weight(.semibold))
                if let detail = allowance.detail { Text(detail).font(.footnote) }
              }.foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("coach-installation-allowance")
            }
            ForEach(Array((coach.saved.phoneDrafts ?? []).enumerated()), id: \.offset) { index, draft in
              VStack(alignment: .leading, spacing: RoomSpace.related) {
                Text("Draft kept on this phone").font(.footnote).foregroundStyle(GymPalette.inkDim)
                Text(draft.text)
                Button("Continue saved draft") {
                  var next = coach.saved
                  let previous = CoachPhoneDraft(text: next.text, photo: next.photo, photoData: next.photoData, setupChoice: next.setupChoice, choices: next.choices)
                  next.text = draft.text; next.photo = draft.photo; next.photoData = draft.photoData; next.purpose = .routineSetup; next.setupChoice = draft.setupChoice; next.choices = draft.choices
                  next.phoneDrafts?.remove(at: index)
                  if !previous.text.isEmpty || previous.photo != nil { next.phoneDrafts?.append(previous) }
                  _ = coach.keep(next, failure: "Your draft couldn’t be opened. Try again.")
                }
              }
            }
            ForEach(coach.saved.onboarding ?? []) { record in onboarding(record) }
            ForEach(coach.visibleTurns) { turn in
              if turn.from == "lifter" { question(turn.text, attachments: turn.attachments) }
              else {
                answer(turn.text, receipt: turn.clarification != nil && turn.clarification?.id == coach.activeClarification?.id ? nil : turn.receipt, steps: turn.receipt?.steps ?? [], results: turn.results)
                if let allowance = turn.allowanceRefusal { allowanceMessage(allowance) }
                else if turn.status == "failed" || turn.status == "stopped" {
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
            if let clarification = coach.activeClarification {
              CoachChoicesView(coach: coach, clarification: clarification)
              let receipt = coach.activeGeneration != nil ? coach.activeGeneration?.receipt : coach.saved.thread?.turns.last?.receipt
              if let receipt { answer("", receipt: receipt, steps: [], results: []) }
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
            Button { withAnimation { proxy.scrollTo("latest", anchor: .bottom) } } label: { glassSymbol("chevron.down") }
              .buttonStyle(RoomSeatStyle(diameter: 36)).accessibilityLabel("Jump to latest").accessibilityIdentifier("coach-jump-to-latest").padding(12)
          }
        }
        .onChange(of: coach.saved.request?.requestId) { _, request in
          if request != nil { composing = false }
          proxy.scrollTo("latest", anchor: .bottom)
        }
    }
  }

  var band: some View {
    let tooLong = coach.saved.text.utf8.count > coach.textLimit
    let message = tooLong ? "Keep your message within \(coach.textLimit) bytes." : coach.refusal == .absent ? nil : coach.error ?? (coach.retryable ? CoachCopy.interrupted : nil)
    let retry: (() -> Void)? = tooLong ? nil : coach.retryable ? { composing = false; coach.retry() } : coach.draftReadable ? nil : { coach.reloadDraft() }
    return GymTransient(gym: gym, message: message, dismiss: tooLong || retry != nil ? nil : { coach.error = nil }, retryMessage: retry,
                        errorIdentifier: "gym-coach-error")
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
        Text(coach.anonymous ? "Sent to our AI provider when you send. Windmill keeps this photo only on this phone." : "Sent to Coach when you send. Kept privately with this chat.").font(.caption).foregroundStyle(GymPalette.inkDim)
          .padding(.horizontal, RoomSpace.inset)
      }
      HStack(alignment: .bottom, spacing: 0) {
        let target = RoomSpace.minimumTarget
        PhotosPicker(selection: $photo, matching: .images) {
          Image(systemName: "photo.badge.plus").dynamicTypeSize(...DynamicTypeSize.xxxLarge).frame(width: target, height: target)
        }.accessibilityLabel("Add photo").disabled(coach.asking || preparing || !coach.draftReadable)
        TextField(coach.anonymous ? "Describe your program" : "Ask about your training", text: Binding(get: { coach.saved.text }, set: { coach.edit($0) }), axis: .vertical)
          .lineLimit(1...(typeSize.isAccessibilitySize ? 2 : 5)).focused($composing).disabled(coach.asking || !coach.draftReadable).accessibilityIdentifier("coach-question")
          .id(coach.asking).padding(.vertical, 11)
        send
      }
    }.padding(4).background(GymPalette.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
      .padding(.horizontal, RoomSpace.inset).padding(.bottom, RoomSpace.related)
  }

  @ViewBuilder var send: some View {
    if coach.asking {
      Button { coach.stopResponse() } label: { circle("stop.fill", dimmed: coach.stopping) }.buttonStyle(.plain)
        .disabled(coach.stopping).accessibilityLabel(coach.anonymous ? "Stop waiting" : coach.uploading ? "Cancel upload" : "Stop response").accessibilityIdentifier("coach-stop")
    } else {
      let empty = (!CoachCopy.sendable(coach.saved.text, photo: coach.saved.photo != nil) && !coach.anonymousRetryable) || preparing || coach.saved.text.utf8.count > coach.textLimit
      Button { if coach.blockedReason == nil { composing = false }; coach.send() } label: { circle("arrow.up", dimmed: empty || coach.blockedReason != nil) }
        .buttonStyle(.plain).disabled(empty)
        .accessibilityLabel(coach.anonymousRetryable ? "Check response" : "Ask Coach").accessibilityHint(coach.blockedReason ?? "").accessibilityIdentifier("coach-send")
    }
  }

  @ViewBuilder func onboarding(_ record: CoachOnboardingRecord) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      CoachQuestion(gym: gym, thread: coach.saved.threadId, text: record.request.question, attachments: record.photo.map { [$0] } ?? [],
        draft: record.photo.flatMap { photo in record.request.image.flatMap { Data(base64Encoded: $0.data).map { (photo.id, $0) } } })
      if !record.results.isEmpty {
        CoachAnswerView(gym: gym, text: "", receipt: nil, steps: [], results: record.results,
          review: { _ in }, read: { _ in }, notes: {})
        if gym.isAnonymous {
          Button { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "keep_routines"]); keepRoutines?() } label: {
            Label("Only on this phone · Keep it", systemImage: "iphone").font(.footnote).frame(minHeight: RoomSpace.minimumTarget)
          }.buttonStyle(.plain).accessibilityIdentifier("coach-keep-routines")
        }
        Label("Read nothing from your log", systemImage: "book.closed").font(.footnote).foregroundStyle(GymPalette.inkDim)
          .accessibilityIdentifier("coach-read-receipt")
      } else if coach.asking, record.id == coach.anonymousRequest?.id {
        progress(coach.savingOnboarding ? "Saving your routines…" : "Making your routines…")
      } else if !coach.anonymous, record.results.isEmpty {
        Text("This setup stayed on this phone. Your saved draft can continue with your account’s AI allowance.").font(.footnote).foregroundStyle(GymPalette.inkDim)
      } else if !record.finished, record.stopped || record.response?.status != "failed" {
        Button("Check response") { coach.resumeOnboarding() }.accessibilityIdentifier("coach-check-response")
      }
      if let response = record.response, response.status == "failed", AiAllowance.refusalCodes.contains(response.errorCode ?? "") {
        allowanceMessage(response.allowance)
      } else if record.finished, record.results.isEmpty, let code = record.refusalCode ?? record.response?.errorCode {
        Text(CoachConversation.onboardingRefusalMessage(code)).font(.footnote).foregroundStyle(GymPalette.inkDim)
      }
    }
  }

  func circle(_ symbol: String, dimmed: Bool) -> some View {
    Image(systemName: symbol).font(.body.weight(.semibold)).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(GymPalette.onAccent)
      .frame(width: 36, height: 36).background(GymPalette.accent, in: Circle()).opacity(dimmed ? 0.4 : 1)
      .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
  }

  // The symbol of the room's two 36 pt "down" seats: Jump to latest, and the keyboard's Done while typing.
  func glassSymbol(_ symbol: String) -> some View { Image(systemName: symbol).font(.body.weight(.semibold)).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(GymPalette.ink) }

  func progress(_ label: String) -> some View {
    HStack(spacing: RoomSpace.related) { ProgressView(); Text(label).font(.footnote).foregroundStyle(GymPalette.inkDim) }
  }

  func question(_ text: String, attachments: [CoachAttachment]) -> some View {
    CoachQuestion(gym: gym, thread: coach.saved.threadId, text: text, attachments: attachments,
                  draft: coach.saved.photo.flatMap { photo in coach.saved.photoData.map { (photo.id, $0) } }, uploading: coach.uploading)
  }

  func answer(_ text: String, receipt: CoachReceipt?, steps: [CoachStep], results: [CoachResult]) -> some View {
    CoachAnswerView(gym: gym, text: text, receipt: receipt, steps: steps, results: results,
                    review: { review = ProposalReviewID(id: $0) }, read: { sources = $0 }, notes: { destination = .notes })
  }

  func allowanceMessage(_ allowance: AiAllowance) -> some View {
    VStack(alignment: .leading, spacing: RoomSpace.small) {
      Text(allowance.message)
      if let detail = allowance.detail { Text(detail) }
    }.font(.footnote).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("coach-allowance")
  }

  func generationView(_ generation: CoachGeneration) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      question(generation.question, attachments: generation.attachments)
      if generation.answer.isEmpty, generation.status == "running" { progress("reading your log…") }
      answer(generation.answer, receipt: generation.clarification != nil && generation.clarification?.id == coach.activeClarification?.id ? nil : generation.receipt, steps: generation.steps, results: generation.results)
      if let allowance = generation.allowanceRefusal { allowanceMessage(allowance) }
    }
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

// Coach's answer keeps creation doors above its read receipt; proposals keep their review cards.
struct CoachAnswerView: View {
  let gym: GymModel
  let text: String
  let receipt: CoachReceipt?
  let steps: [CoachStep]
  let results: [CoachResult]
  let review: (String) -> Void
  let read: (CoachReading) -> Void
  let notes: () -> Void
  @Environment(\.coachOpenRoutine) var openRoutine
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if !text.isEmpty { CoachMarkdown(text: text).contextMenu { Button("Copy answer") { UIPasteboard.general.string = text } } }
      let created = results.filter { $0.kind == "routine-created" }
      if let receipt, created.isEmpty { receiptRow(receipt) }
      ForEach(receipt?.proposals ?? [], id: \.self) { id in CoachProposalCard(gym: gym, id: id) { review(id) } }
      if !created.isEmpty {
        VStack(spacing: 0) {
          ForEach(Array(created.enumerated()), id: \.element.id) { index, result in
            if index > 0 { Divider().overlay(GymPalette.line).padding(.leading, 48) }
            Button {
              gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "open_routine"])
              openRoutine?(result.routineId)
            } label: {
              HStack(spacing: 12) {
                Image(systemName: "checkmark.circle").font(.title3).foregroundStyle(GymPalette.accent)
                GymRow(title: result.routineName, meta: "Routine created" + (result.movementCount.map { " · " + GymCount.of($0, "movement") } ?? ""))
                Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(GymPalette.inkFaint)
              }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 14).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Open routine · " + result.routineName)
              .accessibilityIdentifier("coach-created-" + result.operationId)
          }
        }.background(GymPalette.card, in: RoundedRectangle(cornerRadius: 22))
          .overlay(RoundedRectangle(cornerRadius: 22).stroke(GymPalette.line, lineWidth: 1))
      }
      if let receipt, !created.isEmpty { receiptRow(receipt) }
      if let saved = CoachCopy.noteSave(steps) { door("note.text", saved, action: notes).accessibilityIdentifier("coach-saved-note") }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  // What Coach wrote besides answering, one row each: its symbol in accent, what it did, and the door to it.
  func door(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      GymRow(title: title, leading: .symbol(symbol, GymPalette.accent), trailing: .door)
        .frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(title)
  }
  // The receipt row, a door to What Coach read while there are workouts to list.
  @ViewBuilder func receiptRow(_ receipt: CoachReceipt) -> some View {
    let reading = CoachReading(receipt, steps: steps, dates: gym.dates)
    if let line = reading.line {
      let row = HStack(spacing: RoomSpace.related) {
        Label(line, systemImage: "book.closed")
        Spacer(minLength: 0)
        if !reading.workouts.isEmpty { DoorChevron(room: .gym) }
      }.font(.footnote).monospacedDigit().foregroundStyle(GymPalette.inkDim).frame(minHeight: RoomSpace.minimumTarget)
      if reading.workouts.isEmpty { row.accessibilityElement(children: .ignore).accessibilityLabel(line).accessibilityIdentifier("coach-read-receipt") }
      else {
        Button { read(reading) } label: { row.contentShape(Rectangle()) }.buttonStyle(.plain)
          .accessibilityLabel(line).accessibilityIdentifier("coach-read-receipt")
      }
    }
  }
}

// A proposal in the conversation: its routine, up to three of its Review's lines, and the Review row with how it settled.
struct CoachProposalCard: View {
  let gym: GymModel
  let id: String
  let review: () -> Void
  @Environment(\.dynamicTypeSize) var typeSize
  var body: some View {
    let proposal = gym.proposals.first { $0.id.record.string == id }
    let removal = proposal?.intent == "remove"
    let changes = proposal.map(gym.coachChanges)?.filter { !$0.kept } ?? []
    let settled = proposal.flatMap { gym.coachProposalOutOfDate($0) ? CoachCopy.outOfDate : CoachCopy.settled($0.state, removal: removal) }
    let label = removal ? "Review removal" : "Review changes"
    // At accessibility sizes the settled state sits under the Review row's label.
    let door = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: RoomSpace.small))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: RoomSpace.related))
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      Text("Proposal" + (proposal.map { " · " + ($0.baseName ?? $0.proposedName) } ?? ""))
        .font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(GymPalette.accent)
      if !changes.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(changes.prefix(3).enumerated()), id: \.offset) { _, change in change.row }
          if changes.count > 3 { Text("+ \(changes.count - 3) more").font(.footnote).foregroundStyle(GymPalette.inkFaint) }
        }
      }
      Button(action: review) {
        HStack(spacing: RoomSpace.related) {
          door {
            Text(label).foregroundStyle(GymPalette.ink)
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            if let settled {
              HStack(spacing: RoomSpace.small) {
                if proposal?.state == "applied" { Image(systemName: "checkmark").foregroundStyle(GymPalette.done).accessibilityHidden(true) }
                Text(settled).foregroundStyle(GymPalette.inkDim)
              }.font(.footnote)
            }
          }
          if typeSize.isAccessibilitySize { Spacer(minLength: 0) }
          DoorChevron(room: .gym)
        }.frame(minHeight: RoomSpace.minimumTarget).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityLabel(label).accessibilityValue(settled ?? "").accessibilityIdentifier("coach-review")
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

// What Coach read: every workout the answer read, each a door to it, under the receipt's own numbers.
struct CoachSourcesSheet: View {
  let gym: GymModel
  let reading: CoachReading
  @Environment(\.dismiss) var dismiss
  @Environment(\.coachOpenSession) var openSession
  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(reading.workouts) { source in workout(source) }
        } header: { Text(reading.count) } footer: { if reading.notes { Text("Also read your notes.") } }
          .listRowBackground(GymPalette.card)
      }.listStyle(.insetGrouped).navigationTitle("What Coach read").modifier(GymPage())
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }.presentationDetents([.medium, .large])
      .accessibilityIdentifier("gym-coach-sources")
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "sources"]) }
  }
  // *Push A* over *Sat, Sep 26 · 1 working set · 400 kg*: the day, then the whole workout's facts when the read knew them.
  func workout(_ source: CoachObservation) -> some View {
    let available = gym.sessions.contains { $0.id.record.string == source.sessionId }
    let facts = source.whole.map { [GymCount.of($0.workingSetCount, "working set"), Readout.weight($0.tonnageKg) + " kg"] } ?? []
    return Button { dismiss(); openSession?(source.sessionId) } label: {
      GymRow(title: source.routine ?? Readout.noRoutine, meta: ([gym.dates.subtitle(Instant(ms: source.startedAt))] + facts).joined(separator: " · "),
             trailing: available ? .door : nil).contentShape(Rectangle())
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
  @Namespace var zoom
  var image: UIImage? {
    guard owner == gym.account, (gym.isAnonymous && !gym.accountTransition && local != nil) || (gym.coachAccountAvailable && (local != nil || loadedOwner == gym.account)) else { return nil }
    return (data ?? local).flatMap(UIImage.init(data:))
  }
  var body: some View {
    Group {
      if let image {
        Button { enlarged = true } label: {
          Image(uiImage: image).resizable().scaledToFill().frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }.buttonStyle(.plain).accessibilityLabel("Enlarge photo").matchedTransitionSource(id: attachment.id, in: zoom)
      } else if failed {
        Button { Task { await load() } } label: { Self.tile(Image(systemName: "arrow.clockwise").foregroundStyle(GymPalette.accent)) }
          .buttonStyle(.plain).accessibilityLabel(connectionRequired ? "Photo needs a connection. Retry" : "Photo unavailable. Retry")
      } else { Self.tile(ProgressView()).accessibilityLabel("Reading photo") }
    }.task(id: "\(gym.account ?? ""):\(thread):\(attachment.id)") { data = nil; if local == nil { await load() } }
      .fullScreenCover(isPresented: $enlarged) {
        if let image { CoachPhotoCover(image: image).navigationTransition(.zoom(sourceID: attachment.id, in: zoom)) }
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

// A photo full screen on black, zoomed from its thumbnail: pinch or double-tap to zoom, drag to look around, swipe down to close.
struct CoachPhotoCover: View {
  let image: UIImage
  @State var scale: CGFloat = 1
  @State var offset: CGSize = .zero
  @GestureState var pinch: CGFloat = 1
  @GestureState var drag: CGSize = .zero
  @Environment(\.dismiss) var dismiss
  var body: some View {
    let zoomed = scale > 1
    Image(uiImage: image).resizable().scaledToFit()
      .scaleEffect(max(1, scale * pinch))
      .offset(x: offset.width + (zoomed ? drag.width : 0), y: offset.height + (zoomed ? drag.height : max(0, drag.height)))
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(GymPalette.photoGround)
      .contentShape(Rectangle())
      .gesture(MagnifyGesture().updating($pinch) { value, pinch, _ in pinch = value.magnification }.onEnded { value in
        scale = min(4, max(1, scale * value.magnification)); if scale == 1 { offset = .zero }
      })
      .simultaneousGesture(DragGesture().updating($drag) { value, drag, _ in drag = value.translation }.onEnded { value in
        if zoomed { offset.width += value.translation.width; offset.height += value.translation.height }
        else if value.translation.height > 120 || value.predictedEndTranslation.height > 320 { dismiss() }
      })
      .onTapGesture(count: 2) { withAnimation { scale = zoomed ? 1 : 2; offset = .zero } }
      .animation(.spring, value: drag == .zero)
      .ignoresSafeArea().statusBarHidden()
      .accessibilityElement().accessibilityLabel("Photo").accessibilityAddTraits(.isImage)
      .accessibilityAction(.escape) { dismiss() }.accessibilityAction(named: "Close") { dismiss() }
      .accessibilityIdentifier("coach-photo-cover")
  }
}
