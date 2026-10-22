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
  @State var routineReview: CoachRoutineReview?
  @State var showWindmillOne = false
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
        }.background { Rectangle().fill(.bar).ignoresSafeArea(edges: .bottom) }
      }
      .sheet(item: $routineReview) { review in CoachRoutineReviewSheet(coach: coach, review: review) }
      .sheet(isPresented: $showWindmillOne) {
        NavigationStack {
          VStack(alignment: .leading, spacing: RoomSpace.related) {
            Text("Subscriptions aren’t available yet.").font(.body)
            Text("Your conversation and draft are kept.").font(.subheadline).foregroundStyle(GymPalette.inkDim)
            Spacer()
          }.padding(RoomSpace.inset).navigationTitle("Windmill One").modifier(GymPage())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { showWindmillOne = false } } }
        }.presentationDetents([.medium])
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

  // The greeting stands for a gym Coach has nothing to build on yet; one that holds routines opens on an empty canvas.
  var greets: Bool { coach.showsGreeting && (gym.isAnonymous || gym.routines.isEmpty) }

  var conversation: some View {
    ScrollViewReader { proxy in
      ScrollView {
        ZStack(alignment: .bottom) {
          if !greets { Color.clear.containerRelativeFrame(.vertical) }
          LazyVStack(alignment: .leading, spacing: 20) {
            if greets {
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
                answer(turn.text, receipt: turn.clarification != nil && turn.clarification?.id == coach.activeClarification?.id ? nil : turn.receipt, steps: turn.receipt?.steps ?? [], results: turn.results)
                routineDrafts(turn.routineDrafts, requestId: turn.requestId)
                if let allowance = turn.allowanceRefusal { allowanceMessage(allowance, current: false) }
                else if turn.status == "failed" || turn.status == "stopped" {
                  Text(turn.status == "failed" ? CoachCopy.interrupted : CoachCopy.stopped).font(.footnote).foregroundStyle(GymPalette.inkDim)
                }
              }
            }
            ForEach(coach.saved.exchanges) { generation in generationView(generation, stamps: stamps) }
            if let generation = coach.activeGeneration { generationView(generation, stamps: stamps) }
            else if let request = coach.saved.request {
              question(request.question, attachments: coach.saved.photo.map { [$0] } ?? [], at: stamps.asked, stamps: stamps)
              if coach.asking { CoachTyping() }
            }
            if let clarification = coach.activeClarification {
              CoachChoicesView(coach: coach, clarification: clarification)
              let receipt = coach.activeGeneration != nil ? coach.activeGeneration?.receipt : coach.saved.thread?.turns.last?.receipt
              if let receipt { answer("", receipt: receipt, steps: [], results: []) }
            }
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
    let transcribed = coach.transcriptAllowance != nil && { if case .allowance = coach.refusal { true } else { false } }()
    let message = tooLong ? "Keep your message within \(coach.textLimit) bytes." : coach.refusal == .absent || transcribed ? nil : coach.error ?? (coach.retryable ? CoachCopy.interrupted : nil)
    let retry: (() -> Void)? = tooLong ? nil : coach.retryable ? { composing = false; coach.retry() } : coach.draftReadable ? nil : { coach.reloadDraft() }
    let detail: String? = tooLong || transcribed ? nil : { if case .allowance(let allowance) = coach.refusal { allowance.detail } else { nil } }()
    let recovery = tooLong || transcribed ? nil : CoachRecovery(coach.refusal, anonymous: coach.anonymous)
    return VStack(alignment: .leading, spacing: RoomSpace.small) {
      if detail != nil || recovery != nil {
        VStack(alignment: .leading, spacing: RoomSpace.small) {
          if let detail { Text(detail) }
          if let recovery { accessRecovery(recovery) }
        }.font(.footnote).foregroundStyle(GymPalette.inkDim).padding(.horizontal, RoomSpace.inset)
      }
      GymTransient(gym: gym, message: message, dismiss: tooLong || retry != nil ? nil : { coach.error = nil }, retryMessage: retry,
                        errorIdentifier: "gym-coach-error")
      .onChange(of: coach.error) { _, error in if let error { UIAccessibility.post(notification: .announcement, argument: error) } }
    }
  }

  // A round Add photo beside the field, the question in the field, and in its trailing end Send while there is something to
  // send, or Stop while Coach answers.
  var composer: some View {
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      if preparing {
        ProgressView().frame(width: 56, height: 56).background(GymPalette.line, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
          .accessibilityLabel("Preparing photo").padding(.leading, 52).padding(.top, RoomSpace.related)
      }
      else if let photo = coach.saved.photo, !coach.asking {
        CoachPhotoView(gym: gym, thread: coach.saved.threadId, attachment: photo, local: coach.saved.photoData)
          .overlay(alignment: .topTrailing) {
            Button { coach.removePhoto() } label: {
              Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.palette).foregroundStyle(GymPalette.card, GymPalette.inkDim)
                .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
            }.buttonStyle(.plain).offset(x: 18, y: -18).accessibilityLabel("Remove photo")
          }.padding(.leading, 52).padding(.top, RoomSpace.related)
        Text(coach.anonymous ? "Sent to our AI provider when you send. Windmill keeps this photo only on this phone." : "Sent to Coach when you send. Kept privately with this chat.").font(.caption).foregroundStyle(GymPalette.inkDim)
      }
      HStack(alignment: .bottom, spacing: RoomSpace.related) {
        PhotosPicker(selection: $photo, matching: .images) {
          Image(systemName: "plus").font(.body.weight(.semibold)).dynamicTypeSize(...DynamicTypeSize.xxxLarge).foregroundStyle(GymPalette.ink)
        }.buttonStyle(RoomSeatStyle(diameter: 40))
          .accessibilityLabel("Add photo").disabled(coach.asking || preparing || !coach.draftReadable)
        HStack(alignment: .bottom, spacing: 0) {
          TextField("Ask about your training", text: Binding(get: { coach.asking ? "" : coach.saved.text }, set: { coach.edit($0) }), axis: .vertical)
            .lineLimit(1...(typeSize.isAccessibilitySize ? 2 : 5)).focused($composing).disabled(coach.asking || !coach.draftReadable).accessibilityIdentifier("coach-question")
            .id(coach.asking).padding(.leading, 14).padding(.trailing, 4).padding(.vertical, 9)
          send
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
    VStack(alignment: .leading, spacing: 16) {
      CoachQuestion(gym: gym, thread: coach.saved.threadId, text: record.request.question, attachments: record.photo.map { [$0] } ?? [],
        draft: record.photo.flatMap { photo in record.request.image.flatMap { Data(base64Encoded: $0.data).map { (photo.id, $0) } } })
      if let response = record.response, response.status == "completed" {
        if let message = response.message, !message.isEmpty { CoachAnswerText(text: message) }
        if record.results.isEmpty, !response.routines.isEmpty {
          Button {
            routineReview = CoachRoutineReview(id: record.id, requestId: record.id, drafts: response.routines.map(\.domain), operationId: nil)
          } label: {
            VStack(alignment: .leading, spacing: RoomSpace.small) {
              ForEach(Array(response.routines.enumerated()), id: \.offset) { _, routine in
                Text(routine.name).font(.headline)
                Text(GymCount.of(routine.entries.count, "movement")).font(.subheadline).foregroundStyle(GymPalette.inkDim)
              }
              Label("Review", systemImage: "chevron.right").frame(minHeight: RoomSpace.minimumTarget)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(RoomSpace.inset).contentShape(Rectangle())
          }.buttonStyle(.bordered).accessibilityIdentifier("coach-review-routines")
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

  func answer(_ text: String, receipt: CoachReceipt?, steps: [CoachStep], results: [CoachResult]) -> some View {
    CoachAnswerView(gym: gym, text: text, receipt: receipt, steps: steps, results: results, read: { sources = $0 }, notes: { destination = .notes })
  }

  @ViewBuilder func routineDrafts(_ drafts: [CoachRoutineDraft], requestId: String?) -> some View {
    ForEach(drafts.filter { $0.state == "pending" }) { draft in
      Button {
        routineReview = CoachRoutineReview(id: draft.id, requestId: requestId, drafts: [draft.routine], operationId: draft.operationId)
      } label: {
        HStack {
          GymRow(title: draft.name, meta: GymCount.of(draft.entries.count, "movement"))
          Label("Review", systemImage: "chevron.right").font(.subheadline)
        }.padding(RoomSpace.inset).contentShape(Rectangle())
      }.buttonStyle(.bordered).accessibilityIdentifier("coach-review-routine-" + draft.operationId)
    }
  }

  // A refusal's reason and reset stay with its turn; only the refusal the conversation ends on offers its recovery.
  func allowanceMessage(_ allowance: AiAllowance, current: Bool) -> some View {
    VStack(alignment: .leading, spacing: RoomSpace.small) {
      Text(allowance.message)
      if let detail = allowance.detail { Text(detail) }
      if current, let recovery = CoachRecovery(code: allowance.code, tier: allowance.tier, anonymous: coach.anonymous) { accessRecovery(recovery) }
    }.font(.footnote).foregroundStyle(GymPalette.inkDim).accessibilityIdentifier("coach-allowance")
  }

  @ViewBuilder func accessRecovery(_ recovery: CoachRecovery) -> some View {
    switch recovery {
    case .signIn:
      Text(CoachCopy.signInToContinue)
      Button("Sign in") {
        gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "sign_in"])
        if let keepRoutines { keepRoutines() } else { openAccount?() }
      }.frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier("coach-sign-in")
    case .windmillOne:
      Button("Windmill One") {
        gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "windmill_one"])
        showWindmillOne = true
      }.frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier("coach-windmill-one")
    }
  }

  func generationView(_ generation: CoachGeneration, stamps: CoachStamps) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      question(generation.question, attachments: generation.attachments, at: generation.at, stamps: stamps)
      if generation.answer.isEmpty, generation.status == "running" { CoachTyping() }
      answer(generation.answer, receipt: generation.clarification != nil && generation.clarification?.id == coach.activeClarification?.id ? nil : generation.receipt, steps: generation.steps, results: generation.results)
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
