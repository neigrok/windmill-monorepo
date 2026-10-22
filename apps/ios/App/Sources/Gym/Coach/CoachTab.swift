import SwiftUI
import UIKit
import PhotosUI
import DomainKit
import GymDomain

private enum CoachDestination: Hashable { case history, notes, connectedLog }

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
        case .connectedLog: ConnectedLogScreen(gym: gym)
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
        }.background { Rectangle().fill(.bar).ignoresSafeArea(edges: .bottom) }
      }
      .sheet(item: $sources) { reading in CoachSourcesSheet(gym: gym, reading: reading) }
      .gymTabBar(hidden: composing)
      .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition):\(handoff?.id.uuidString ?? "")") {
        if !CoachFixture.setup, !fixturePrepared { fixturePrepared = await CoachFixture.prepare(gym) }
        history.resetOwner(); await coach.activate(); CoachFixture.seedDraftPhoto(coach)
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
    else if coach.refusal == .absent { CoachUnavailable(symbol: "exclamationmark.triangle", sentence: CoachCopy.absent) }
    else { conversation }
  }

  // A capped question never reached Coach: it stays in the field, not in the conversation.
  var capped: Bool { switch coach.refusal { case .daily, .ceiling, .allowance: true; default: false } }

  // The greeting stands for a gym Coach has nothing to build on yet; one that holds routines opens on an empty canvas.
  var greets: Bool { coach.showsGreeting && (gym.isAnonymous || gym.routines.isEmpty) }

  var conversation: some View {
    ScrollViewReader { proxy in
      ScrollView {
        ZStack(alignment: .bottom) {
          if !greets { Color.clear.containerRelativeFrame(.vertical) }
          LazyVStack(alignment: .leading, spacing: 20) {
            if greets {
              CoachSetupView(signedIn: !gym.isAnonymous) { choice in
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
              if turn.from == "lifter" { question(turn.text, attachments: turn.attachments, at: turn.at, stamps: stamps) }
              else {
                answer(turn.text, receipt: turn.clarification != nil && turn.clarification?.id == coach.activeClarification?.id ? nil : turn.receipt, steps: turn.receipt?.steps ?? [], results: turn.results, requestId: turn.requestId)
                routineDrafts(turn.routineDrafts, requestId: turn.requestId)
                if let allowance = turn.allowanceRefusal { allowanceMessage(allowance, current: false) }
                else if turn.status == "failed" || turn.status == "stopped" {
                  Text(turn.status == "failed" ? CoachCopy.interrupted : CoachCopy.stopped).font(.footnote).foregroundStyle(GymPalette.inkDim)
                }
              }
            }
            ForEach(coach.saved.exchanges) { generation in generationView(generation, stamps: stamps) }
            if let generation = coach.activeGeneration { generationView(generation, stamps: stamps) }
            else if let request = coach.saved.request, !capped {
              question(request.question, attachments: coach.saved.photo.map { [$0] } ?? [], at: stamps.asked, stamps: stamps)
              if coach.asking { CoachTyping() }
            }
            if let clarification = coach.activeClarification {
              CoachChoicesView(coach: coach, clarification: clarification)
              let receipt = coach.activeGeneration != nil ? coach.activeGeneration?.receipt : coach.saved.thread?.turns.last?.receipt
              if let receipt { answer("", receipt: receipt, steps: [], results: [], requestId: nil) }
            }
            if case .daily(let sentence) = coach.refusal { dailyCap(sentence) }
            if case .allowance(let allowance) = coach.refusal, coach.transcriptAllowance == nil { allowanceMessage(allowance, current: true) }
            Color.clear.frame(height: 1).id("latest")
          }.padding(RoomSpace.inset).frame(maxWidth: .infinity, alignment: .leading)
        }.contentShape(Rectangle()).onTapGesture { composing = false }
      }.defaultScrollAnchor(greets ? .top : .bottom, for: .sizeChanges).scrollDismissesKeyboard(.interactively)
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
    // The day's cap and a spent allowance speak in the conversation; the band keeps everything else.
    let spoken = { switch coach.refusal { case .daily, .allowance: true; default: false } }()
    let message = tooLong ? "Keep your message within \(coach.textLimit) bytes." : coach.refusal == .absent || spoken ? nil : coach.error ?? (coach.retryable ? CoachCopy.interrupted : nil)
    let retry: (() -> Void)? = tooLong ? nil : coach.retryable ? { composing = false; coach.retry() } : coach.draftReadable ? nil : { coach.reloadDraft() }
    let recovery = tooLong || spoken ? nil : CoachRecovery(coach.refusal, anonymous: coach.anonymous)
    return VStack(alignment: .leading, spacing: RoomSpace.small) {
      if let recovery {
        VStack(alignment: .leading, spacing: RoomSpace.small) { accessRecovery(recovery) }
          .font(.footnote).foregroundStyle(GymPalette.inkDim).padding(.horizontal, RoomSpace.inset)
      }
      GymTransient(gym: gym, message: message, dismiss: tooLong || retry != nil ? nil : { coach.error = nil }, retryMessage: retry,
                        errorIdentifier: "gym-coach-error")
      .onChange(of: coach.error) { _, error in if let error { UIAccessibility.post(notification: .announcement, argument: error) } }
    }
  }

  // A round Add photo beside the field; in the field a chosen photo over the question, and in its trailing end Send while
  // there is something to send, or Stop while Coach answers. A chosen photo says where it is kept, once, over the field.
  var composer: some View {
    VStack(spacing: RoomSpace.related) {
      if (preparing || coach.saved.photo != nil) && !coach.asking {
        Text(coach.anonymous ? "Sent to Coach. Saved only on this phone." : "Saved only in this chat.").font(.caption).foregroundStyle(GymPalette.inkDim)
          .accessibilityIdentifier("coach-photo-caption")
      }
      HStack(alignment: .bottom, spacing: RoomSpace.related) {
        PhotosPicker(selection: $photo, matching: .images) {
          Image(systemName: "plus").font(.body.weight(.semibold)).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(GymPalette.ink)
        }.buttonStyle(RoomSeatStyle(diameter: 40))
          .accessibilityLabel("Add photo").disabled(coach.asking || preparing || !coach.draftReadable)
        VStack(alignment: .leading, spacing: 0) {
          if preparing && !coach.asking {
            ProgressView().frame(width: 60, height: 80).background(GymPalette.line, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
              .accessibilityLabel("Preparing photo").padding([.top, .leading], 10)
          } else if let photo = coach.saved.photo, !coach.asking {
            CoachPhotoView(gym: gym, thread: coach.saved.threadId, attachment: photo, local: coach.saved.photoData, side: 80)
              .overlay(alignment: .topTrailing) {
                Button { coach.removePhoto() } label: {
                  Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.palette).foregroundStyle(GymPalette.card, GymPalette.ink)
                    .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
                }.buttonStyle(.plain).offset(x: 16, y: -16).accessibilityLabel("Remove photo")
              }.padding([.top, .leading], 10)
          }
          HStack(alignment: .bottom, spacing: 0) {
            TextField("Ask about your training", text: Binding(get: { coach.asking ? "" : coach.saved.text }, set: { if !coach.asking { coach.edit($0) } }), axis: .vertical)
              .lineLimit(1...(typeSize.isAccessibilitySize ? 2 : 5)).focused($composing).disabled(coach.asking || !coach.draftReadable).accessibilityIdentifier("coach-question")
              .id(coach.asking).padding(.leading, 14).padding(.trailing, 4).padding(.vertical, 9)
            send
          }
        }.frame(minHeight: 40).background(GymPalette.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(GymPalette.line, lineWidth: 1))
          .padding(.vertical, 2)
      }
    }.padding(.horizontal, RoomSpace.inset - 2).padding(.bottom, RoomSpace.related)
  }

  @ViewBuilder var send: some View {
    if coach.asking {
      Button { coach.stopResponse() } label: { circle("stop.fill", fill: GymPalette.ink, ink: GymPalette.canvas, dimmed: coach.stopping) }.buttonStyle(.plain)
        .disabled(coach.stopping).accessibilityLabel(coach.anonymous ? "Stop waiting" : coach.uploading ? "Cancel upload" : "Stop response").accessibilityIdentifier("coach-stop")
    } else if CoachCopy.sendable(coach.saved.text, photo: coach.saved.photo != nil) || coach.anonymousRetryable {
      let held = preparing || coach.saved.text.utf8.count > coach.textLimit
      Button { if coach.blockedReason == nil { composing = false }; coach.send() } label: {
        circle("arrow.up", fill: GymPalette.accent, ink: GymPalette.onAccent, dimmed: held || coach.blockedReason != nil)
      }.buttonStyle(.plain).disabled(held)
        .accessibilityLabel(coach.anonymousRetryable ? "Check response" : "Ask Coach").accessibilityHint(coach.blockedReason ?? "").accessibilityIdentifier("coach-send")
    }
  }

  @ViewBuilder func onboarding(_ record: CoachOnboardingRecord) -> some View {
    let refused = record.response.map { $0.status == "failed" && AiAllowance.refusalCodes.contains($0.errorCode ?? "") } ?? false
    VStack(alignment: .leading, spacing: 16) {
      // A question the allowance refused never reached Coach; it stays in the field.
      if !refused {
        CoachQuestion(gym: gym, thread: coach.saved.threadId, text: record.request.question, attachments: record.photo.map { [$0] } ?? [],
          draft: record.photo.flatMap { photo in record.request.image.flatMap { Data(base64Encoded: $0.data).map { (photo.id, $0) } } })
      }
      if let response = record.response, response.status == "completed" {
        if let message = response.message, !message.isEmpty { CoachAnswerText(text: message) }
        if response.needsAccount == true, record.id == coach.anonymousRequest?.id {
          Button {
            gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "sign_in"])
            if let keepRoutines { keepRoutines() } else { openAccount?() }
          } label: { Text("Sign in").frame(maxWidth: .infinity) }.buttonStyle(ChangeCardButtonStyle(prominent: true))
            .accessibilityIdentifier("coach-sign-in")
        }
        if record.results.isEmpty, !response.routines.isEmpty {
          CoachDraftsCard(coach: coach, id: record.id, routines: response.routines.map(\.domain),
                          saves: [CoachRoutineReview(id: record.id, requestId: record.id, drafts: response.routines.map(\.domain), operationId: nil)])
        }
      }
      if !record.results.isEmpty {
        CoachAnswerView(gym: gym, text: "", receipt: nil, steps: [], results: record.results, read: { _ in }, notes: {})
        if gym.isAnonymous {
          Button { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "keep_routines"]); keepRoutines?() } label: {
            Label("Only on this phone · Keep it", systemImage: "iphone").font(.footnote).frame(minHeight: RoomSpace.minimumTarget)
          }.buttonStyle(.plain).accessibilityIdentifier("coach-keep-routines")
        }
        Label("Read nothing from your log", systemImage: "book.closed").font(.footnote).foregroundStyle(GymPalette.inkDim)
          .accessibilityIdentifier("coach-read-receipt")
      } else if coach.asking, record.id == coach.anonymousRequest?.id {
        CoachTyping()
      } else if !record.finished, record.stopped || record.response?.status != "failed" {
        Button("Check response") { coach.resumeOnboarding() }.accessibilityIdentifier("coach-check-response")
      }
      if let response = record.response, response.status == "failed", AiAllowance.refusalCodes.contains(response.errorCode ?? "") {
        allowanceMessage(response.allowance, current: record.id == coach.anonymousRequest?.id)
      } else if record.finished, record.results.isEmpty, let code = record.refusalCode ?? record.response?.errorCode {
        Text(CoachConversation.onboardingRefusalMessage(code)).font(.footnote).foregroundStyle(GymPalette.inkDim)
      }
    }
  }

  // The field's 30 pt round button, in a 40 pt target that keeps the field's height.
  func circle(_ symbol: String, fill: Color, ink: Color, dimmed: Bool) -> some View {
    Image(systemName: symbol).font(.subheadline.weight(.bold)).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(ink)
      .frame(width: 30, height: 30).background(fill, in: Circle()).opacity(dimmed ? 0.4 : 1)
      .frame(width: 40, height: 40).contentShape(Circle())
  }

  // The symbol of the room's two 36 pt "down" seats: Jump to latest, and the keyboard's Done while typing.
  func glassSymbol(_ symbol: String) -> some View { Image(systemName: symbol).font(.body.weight(.semibold)).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(GymPalette.ink) }

  func progress(_ label: String) -> some View {
    HStack(spacing: RoomSpace.related) { ProgressView(); Text(label).font(.footnote).foregroundStyle(GymPalette.inkDim) }
  }

  // A question, under the time its group began when it begins one.
  func question(_ text: String, attachments: [CoachAttachment], at: Int64, stamps: CoachStamps) -> some View {
    VStack(spacing: RoomSpace.related) {
      if stamps.starts(at) { CoachStamp(dates: gym.dates, instant: Instant(ms: at)) }
      CoachQuestion(gym: gym, thread: coach.saved.threadId, text: text, attachments: attachments,
                    draft: coach.saved.photo.flatMap { photo in coach.saved.photoData.map { (photo.id, $0) } }, uploading: coach.uploading)
    }
  }
  // When each of the conversation's questions was asked, in order: a question an hour or more after the one before starts a group.
  var stamps: CoachStamps {
    let asked = coach.saved.request != nil && coach.activeGeneration == nil ? gym.dates.moment.now.ms : nil
    let times = coach.visibleTurns.filter { $0.from == "lifter" }.map(\.at) + coach.saved.exchanges.map(\.at) + [coach.activeGeneration?.at, asked].compactMap { $0 }
    return CoachStamps(times: times, asked: asked ?? 0)
  }

  func answer(_ text: String, receipt: CoachReceipt?, steps: [CoachStep], results: [CoachResult], requestId: String?) -> some View {
    CoachAnswerView(gym: gym, text: text, receipt: receipt, steps: steps, results: results, held: requestId.flatMap { coach.heldAtSend[$0] },
                    read: { sources = $0 }, notes: { destination = .notes })
  }

  // The drafts an answer still holds, on one card; Apply saves each by its operation.
  @ViewBuilder func routineDrafts(_ drafts: [CoachRoutineDraft], requestId: String?) -> some View {
    let pending = drafts.filter { $0.state == "pending" }
    if let first = pending.first {
      CoachDraftsCard(coach: coach, id: requestId ?? first.operationId, routines: pending.map(\.routine),
                      saves: pending.map { CoachRoutineReview(id: $0.id, requestId: requestId, drafts: [$0.routine], operationId: $0.operationId) })
    }
  }

  // The day's cap, centred at the conversation's end, with the lifter's own AI agent as the way on.
  func dailyCap(_ sentence: String) -> some View {
    VStack(spacing: RoomSpace.related) {
      Text(sentence).font(.footnote).foregroundStyle(GymPalette.inkDim).multilineTextAlignment(.center)
      Button("Use your own AI agent") {
        gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "connect"])
        destination = .connectedLog
      }.font(.subheadline.weight(.semibold)).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(GymPalette.accent)
        .accessibilityIdentifier("coach-own-agent")
    }.frame(maxWidth: .infinity).padding(.top, 40).accessibilityIdentifier("coach-daily-cap")
  }

  // A spent allowance, centred where the refused question would have gone: why, when Coach answers again, and, where it can
  // help, Sign in. Only the refusal the conversation ends on offers its recovery.
  func allowanceMessage(_ allowance: AiAllowance, current: Bool) -> some View {
    VStack(spacing: RoomSpace.small) {
      Text(allowance.message)
      if let detail = allowance.detail { Text(detail) }
      if current, let recovery = CoachRecovery(code: allowance.code, anonymous: coach.anonymous) { accessRecovery(recovery) }
    }.font(.footnote).foregroundStyle(GymPalette.inkDim).multilineTextAlignment(.center).frame(maxWidth: .infinity)
      .padding(.top, 40).accessibilityElement(children: .contain).accessibilityIdentifier("coach-allowance")
  }

  @ViewBuilder func accessRecovery(_ recovery: CoachRecovery) -> some View {
    switch recovery {
    case .signIn:
      Text(CoachCopy.signInToContinue)
      Button("Sign in") {
        gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "sign_in"])
        if let keepRoutines { keepRoutines() } else { openAccount?() }
      }.font(.subheadline.weight(.semibold)).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(GymPalette.accent)
        .frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier("coach-sign-in")
    }
  }

  func generationView(_ generation: CoachGeneration, stamps: CoachStamps) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      if generation.allowanceRefusal == nil { question(generation.question, attachments: generation.attachments, at: generation.at, stamps: stamps) }
      if generation.answer.isEmpty, generation.status == "running" { CoachTyping() }
      answer(generation.answer, receipt: generation.clarification != nil && generation.clarification?.id == coach.activeClarification?.id ? nil : generation.receipt, steps: generation.steps, results: generation.results, requestId: generation.requestId)
      routineDrafts(generation.routineDrafts, requestId: generation.requestId)
      if let allowance = generation.allowanceRefusal { allowanceMessage(allowance, current: generation.id == coach.activeGeneration?.id) }
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
    }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
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
