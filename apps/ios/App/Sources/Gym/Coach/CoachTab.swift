import SwiftUI
import UIKit
import PhotosUI
import DomainKit
import GymDomain

private enum CoachDestination: Hashable { case history, notes, connectedLog }

// Coach's room: the Coach tab, or a sheet over the open workout (08.54), which closes from its bar and leaves the account
// to the tabs.
struct CoachTab: View {
  let gym: GymModel
  var escapeSetup: ((CoachSetupChoice) -> Void)?
  var close: (() -> Void)?
  @Binding var handoff: CoachHandoff?
  // A proposal whose card the conversation scrolls to, from its Routines row.
  @Binding var revealedProposal: String?
  @State var coach: CoachConversation
  @State var fixturePrepared = false
  @State private var destination: CoachDestination?
  @State var sources: CoachReading?
  @State var photo: PhotosPickerItem?
  @State var preparing = false
  @State var choosePhoto = false
  @State var atLatest = true
  @Environment(\.coachOpenAccount) var openAccount
  @Environment(\.coachKeepRoutines) var keepRoutines
  @Environment(\.coachOpenRoutine) var openRoutine
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.openURL) var openURL
  @FocusState var composing: Bool
  init(gym: GymModel, handoff: Binding<CoachHandoff?> = .constant(nil), revealedProposal: Binding<String?> = .constant(nil),
       coach: CoachConversation? = nil, escapeSetup: ((CoachSetupChoice) -> Void)? = nil, close: (() -> Void)? = nil) {
    self.gym = gym; self.escapeSetup = escapeSetup; self.close = close; _handoff = handoff; _revealedProposal = revealedProposal
    _coach = State(initialValue: coach ?? CoachConversation(gym: gym))
    _fixturePrepared = State(initialValue: !gym.isAnonymous)
  }

  var body: some View {
    room.modifier(GymPage()).navigationTitle("Coach").accessibilityIdentifier("gym-coach")
      .toolbar {
        if let close {
          ToolbarItem(placement: .cancellationAction) {
            if #available(iOS 26, *) { Button(role: .close, action: close).accessibilityIdentifier("coach-close") }
            else { Button("Close", action: close).accessibilityIdentifier("coach-close") }
          }
        }
        if coach.allowed {
          ToolbarItem(placement: .topBarTrailing) {
            Button("History", systemImage: "clock") { destination = .history }
              .accessibilityIdentifier("coach-history")
          }
          if #available(iOS 26, *), close == nil { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        }
        if close == nil {
          ToolbarItem(placement: .topBarTrailing) { RoomAccountButton(action: { openAccount?() }).disabled(gym.accountTransition) }
        }
      }.roomBar(.gym)
      .navigationDestination(item: $destination) { destination in
        switch destination {
        case .history: CoachHistoryScreen(gym: gym, coach: coach)
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
          if coach.refusal != .absent { composer }
        }
      }
      .sheet(item: $sources) { reading in CoachSourcesSheet(gym: gym, reading: reading) }
      .gymTabBar(hidden: composing)
      .task(id: "\(gym.account ?? ""):\(gym.authPaused):\(gym.accountTransition):\(handoff?.id.uuidString ?? "")") {
        if !CoachFixture.setup, !fixturePrepared { fixturePrepared = await CoachFixture.prepare(gym) }
        await coach.activate(); CoachFixture.seedDraft(coach)
        if let handoff, coach.begin(handoff) { self.handoff = nil; composing = !handoff.send }
        coach.noteOffline()
      }
      .onChange(of: coach.driver?.running?.turn.thread) { _, running in
        if running == nil { CoachFixture.afterTurn(gym, coach) }
        if running == nil, let handoff, coach.begin(handoff) { self.handoff = nil; composing = !handoff.send }
      }
      .onChange(of: coach.offline) { _, offline in
        if offline { coach.noteOffline() } else if coach.error == CoachCopy.offline { coach.error = nil }
        if !offline, coach.refusal == .offline { coach.driver?.refusal = nil }
      }
      .photosPicker(isPresented: $choosePhoto, selection: $photo, matching: .images)
      .onChange(of: photo) { _, value in
        guard let value else { return }
        preparing = true
        let conversation = coach
        let owner = gym.account, thread = conversation.saved.threadId
        Task {
          defer { preparing = false; photo = nil }
          do {
            guard let data = try await value.loadTransferable(type: Data.self) else { throw AppFailure(message: "Choose a supported photo.") }
            guard owner == gym.account, conversation.allowed, conversation.saved.threadId == thread else { return }
            try conversation.addPhoto(data)
          } catch { if conversation.allowed { conversation.error = "Choose a supported photo." } }
        }
      }
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "coach"]) }
  }

  // A room without a seat, while the account changes, keeps the question in the field (08.6); a deployment without Coach
  // states its stance (08.7).
  @ViewBuilder var room: some View {
    if !coach.allowed { CoachUnavailable(symbol: "bubble.left.and.bubble.right", sentence: CoachCopy.accountChanging) }
    else if coach.refusal == .absent { CoachUnavailable(symbol: "exclamationmark.triangle", sentence: CoachCopy.absent) }
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
              CoachSetupView(signedIn: !gym.isAnonymous) { choice in
                guard coach.chooseSetup(choice) else { return }
                if choice == .screenshot { choosePhoto = true }
                else if choice.starter { composing = true }
                else { composing = false; escapeSetup?(choice) }
              }.padding(.bottom, 16)
            }
            ForEach(Array((coach.saved.phoneDrafts ?? []).enumerated()), id: \.offset) { index, draft in
              VStack(alignment: .leading, spacing: RoomSpace.related) {
                Text("Draft kept on this phone").font(.footnote).foregroundStyle(GymPalette.inkDim)
                Text(draft.text)
                Button("Continue saved draft") {
                  var next = coach.saved
                  let previous = CoachPhoneDraft(text: next.text, photo: next.photo, photoData: next.photoData, setupChoice: next.setupChoice)
                  next.text = draft.text; next.photo = draft.photo; next.photoData = draft.photoData; next.setupChoice = draft.setupChoice
                  next.phoneDrafts?.remove(at: index)
                  if !previous.text.isEmpty || previous.photo != nil { next.phoneDrafts?.append(previous) }
                  _ = coach.keep(next, failure: "Your draft couldn’t be opened. Try again.")
                }
              }
            }
            ForEach(coach.saved.onboarding ?? []) { record in onboarding(record) }
            let messages = coach.messages
            let stamps = CoachStamps(times: messages.filter { $0.role == .lifter }.map(\.at.ms))
            let replica = coach.replica
            ForEach(messages, id: \.id) { message in
              if message.role == .lifter { question(message, stamps: stamps) }
              else {
                CoachAnswerView(gym: gym, message: message, elsewhere: message.state == .running && message.replica != replica,
                                offersSignIn: coach.anonymous && message.id == messages.last?.id, signIn: signIn,
                                read: { sources = $0 }, notes: { destination = .notes }).id(message.id.description)
              }
            }
            if coach.sending {
              CoachQuestion(gym: gym, text: coach.saved.text.trimmingCharacters(in: .whitespacesAndNewlines), pictures: [],
                            draft: coach.saved.photo.flatMap { photo in coach.saved.photoData.map { (photo, $0) } })
              CoachTyping()
            }
            if let notice { CoachNoticeView(notice: notice, recover: recover) }
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
        .onChange(of: coach.asking) { _, asking in
          if asking { composing = false }
          proxy.scrollTo("latest", anchor: .bottom)
        }
        .task(id: revealedProposal) {
          guard let id = revealedProposal else { return }
          revealedProposal = nil
          guard let turn = coach.proposalTurn(id) else { return }
          // The answer first, which the lazy stack can always reach, then the card it now holds, from its head.
          await Task.yield()
          proxy.scrollTo(turn, anchor: .bottom)
          await Task.yield()
          withAnimation { proxy.scrollTo(ProposalCard.anchor(id), anchor: .top) }
        }
    }
  }

  // The band keeps this phone's own faults and the stream's reconnects; every refusal is a notice in the conversation,
  // which says the missing connection once a send met it.
  var band: some View {
    let message = coach.refusal == .absent || coach.refusal == .offline ? nil : coach.reconnecting ? "Reconnecting…" : coach.error
    let retry: (() -> Void)? = coach.draftReadable ? nil : { coach.reloadDraft() }
    return VStack(alignment: .leading, spacing: RoomSpace.small) {
      if coach.answeringElsewhere {
        HStack {
          Text("Answer in progress").font(.footnote).foregroundStyle(GymPalette.inkDim)
            .accessibilityIdentifier("coach-answer-in-progress")
          Spacer()
          Button("View chat") { composing = false; _ = coach.viewAnswer() }
            .font(.subheadline.weight(.semibold)).buttonStyle(.bordered).buttonBorderShape(.capsule)
            .frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier("coach-view-answer")
        }.padding(.horizontal, RoomSpace.inset)
      }
      GymTransient(gym: gym, message: message, dismiss: retry != nil || coach.reconnecting ? nil : { coach.error = nil; coach.driver?.error = nil },
                   retryMessage: retry, errorIdentifier: "gym-coach-error")
      .onChange(of: coach.error) { _, error in if let error { UIAccessibility.post(notification: .announcement, argument: error) } }
    }
  }

  // The notice at the conversation's end (brand foundations, Gym: a limit is said once, with the recovery that exists):
  // a question past its bound as it is typed, else the last refused send.
  var notice: CoachNotice? {
    if coach.tooLongBy > 0 {
      return CoachNotice(lines: ["Too long by \(coach.tooLongBy.formatted()) characters. The limit is \(coach.textLimit.formatted())."], identifier: "coach-too-long")
    }
    guard let refusal = coach.refusal, refusal != .absent else { return nil }
    return CoachNotice(refusal, anonymous: coach.anonymous, dates: gym.dates)
  }

  func recover(_ recovery: CoachRecovery) {
    switch recovery {
    case .tryAgain: coach.send()
    case .signIn: signIn()
    case .ownAgent:
      gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "connect"])
      destination = .connectedLog
    case .update: openURL(AppSettings.updateDestination)
    }
  }

  // A round Add photo beside the field; in the field a chosen photo over the question, and in its trailing end Send while
  // there is something to send, or Stop while Coach answers. A chosen photo says where it is kept, once, over the field.
  var composer: some View {
    VStack(spacing: RoomSpace.related) {
      if (preparing || coach.saved.photo != nil) && !coach.asking {
        Text(coach.anonymous ? "Sent to Coach. Saved only on this phone." : "A copy goes to the AI provider to read it. Windmill keeps none. Kept only on this phone.")
          .font(.caption).foregroundStyle(GymPalette.inkDim).multilineTextAlignment(.center)
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
          } else if let photo = coach.saved.photo, let data = coach.saved.photoData, !coach.asking {
            CoachPhotoView(gym: gym, id: photo.id, side: 80, local: (photo, data))
              .overlay(alignment: .topTrailing) {
                Button { coach.removePhoto() } label: {
                  Image(systemName: "xmark.circle.fill").font(.title3).symbolRenderingMode(.palette).foregroundStyle(GymPalette.card, GymPalette.ink)
                    .frame(width: RoomSpace.minimumTarget, height: RoomSpace.minimumTarget).contentShape(Circle())
                }.buttonStyle(.plain).offset(x: 16, y: -16).accessibilityLabel("Remove photo")
              }.padding([.top, .leading], 10)
          }
          HStack(alignment: .bottom, spacing: 0) {
            TextField("Ask about your training", text: Binding(get: { coach.asking ? "" : coach.saved.text }, set: { if !coach.asking { coach.edit($0) } }), axis: .vertical)
              .lineLimit(1...(typeSize.isAccessibilitySize ? 2 : 5)).focused($composing).disabled(coach.asking || !coach.draftReadable || !coach.allowed)
              .accessibilityIdentifier("coach-question")
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
      Button { coach.stopResponse() } label: { circle("stop.fill", fill: GymPalette.ink, ink: GymPalette.canvas, dimmed: coach.stopping || coach.sending) }.buttonStyle(.plain)
        .disabled(coach.stopping || coach.sending).accessibilityLabel("Stop response").accessibilityIdentifier("coach-stop")
    } else if CoachCopy.sendable(coach.saved.text, photo: coach.saved.photo != nil) || coach.tooLongBy > 0 {
      let held = preparing || coach.answeringElsewhere || coach.tooLongBy > 0 || !coach.allowed
      Button { if coach.sendHint == nil { composing = false }; coach.send() } label: {
        circle("arrow.up", fill: GymPalette.accent, ink: GymPalette.onAccent, dimmed: held || coach.sendHint != nil)
      }.buttonStyle(.plain).disabled(held)
        .accessibilityLabel("Ask Coach").accessibilityHint(coach.sendHint ?? "").accessibilityIdentifier("coach-send")
    }
  }

  // A signed-out onboarding answer an earlier version kept: its question, its words, the Sign in it offered, its drafts
  // and what applying them created.
  @ViewBuilder func onboarding(_ record: CoachOnboardingRecord) -> some View {
    let refused = record.response.map { $0.status == "failed" && AiAllowance.refusalCodes.contains($0.errorCode ?? "") } ?? false
    VStack(alignment: .leading, spacing: 16) {
      // A question the allowance refused never reached Coach; it stays in the field.
      if !refused {
        CoachQuestion(gym: gym, text: record.request.question, pictures: [],
          draft: record.photo.flatMap { photo in record.request.image.flatMap { Data(base64Encoded: $0.data).map { (photo, $0) } } })
      }
      if let response = record.response, response.status == "completed" {
        if let message = response.message, !message.isEmpty { CoachAnswerText(text: message) }
        if coach.offersSignIn(record) {
          Button(action: signIn) { Text("Sign in").frame(maxWidth: .infinity) }.buttonStyle(ChangeCardButtonStyle(prominent: true))
            .accessibilityIdentifier("coach-sign-in")
        }
        if record.results.isEmpty, !response.routines.isEmpty {
          CoachDraftsCard(coach: coach, id: record.id, routines: response.routines.map(\.domain))
        }
      }
      if !record.results.isEmpty {
        VStack(spacing: 0) {
          ForEach(record.results) { result in
            Button {
              gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "open_routine"])
              openRoutine?(result.routineId)
            } label: {
              HStack(spacing: 12) {
                Image(systemName: "checkmark.circle").font(.title3).foregroundStyle(GymPalette.ink)
                GymRow(title: result.routineName, meta: "Routine created" + (result.movementCount.map { " · " + GymCount.of($0, "movement") } ?? ""))
                Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(GymPalette.inkFaint)
              }.padding(.vertical, 10).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Open routine · " + result.routineName)
              .accessibilityIdentifier("coach-created-" + result.operationId)
          }
        }.modifier(ChangeCard())
        if gym.isAnonymous {
          Button { gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "keep_routines"]); keepRoutines?() } label: {
            Label("Only on this phone · Keep it", systemImage: "iphone").font(.footnote).frame(minHeight: RoomSpace.minimumTarget)
          }.buttonStyle(.plain).accessibilityIdentifier("coach-keep-routines")
        }
        Label("Read nothing from your log", systemImage: "book.closed").font(.footnote).foregroundStyle(GymPalette.inkDim)
          .accessibilityIdentifier("coach-read-receipt")
      }
      if refused {
        if let allowance = coach.spentAllowance(record) {
          CoachNoticeView(notice: CoachNotice(.allowance(allowance.code), anonymous: coach.anonymous, dates: gym.dates, detail: allowance.detail(gym.dates)), recover: recover)
        }
      } else if let code = record.refusalCode ?? record.response?.errorCode, record.results.isEmpty {
        Text(CoachCopy.refusal(code)).font(.footnote).foregroundStyle(GymPalette.inkDim)
      } else if !record.finished {
        Text(CoachCopy.refusal("expired")).font(.footnote).foregroundStyle(GymPalette.inkDim)
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

  // A question, under the time its group began when it begins one, *Today 18:40* centred over the group.
  func question(_ message: CoachMessage, stamps: CoachStamps) -> some View {
    VStack(spacing: RoomSpace.related) {
      if stamps.starts(message.at.ms) {
        (Text(gym.dates.day(message.at)).fontWeight(.semibold) + Text(" " + gym.dates.time(message.at)))
          .font(.caption).foregroundStyle(GymPalette.inkDim).frame(maxWidth: .infinity)
      }
      CoachQuestion(gym: gym, text: message.text, pictures: message.pictures)
    }
  }

  // Sign in from Coach keeps what this phone holds, where the room can keep it, and opens You otherwise.
  func signIn() {
    gym.telemetry.event("gym_setup_step", properties: ["screen": "coach", "action": "sign_in"])
    if let keepRoutines { keepRoutines() } else { openAccount?() }
  }
}

// What a refused send says at the conversation's end: its sentences, and the one door it offers.
struct CoachNotice: Equatable {
  var lines: [String]
  var recovery: CoachRecovery?
  var identifier: String

  init(lines: [String], recovery: CoachRecovery? = nil, identifier: String) {
    self.lines = lines; self.recovery = recovery; self.identifier = identifier
  }

  // A refusal's notice: its sentence, the day a paused shared pool comes back where the server named it, the allowance's
  // own detail, and *Sign in to continue.* over the sign-in a spent allowance offers (01.10).
  init(_ refusal: CoachTurnRefusal, anonymous: Bool, dates: GymDate, detail: String? = nil) {
    recovery = refusal.recovery(anonymous: anonymous)
    var lines = [refusal.sentence]
    if case .freeMonthExhausted(let reset?) = refusal {
      let day = dates.draw(LocalDay(Instant(ms: reset), in: dates.moment.zone), .dateTime.day().month(.abbreviated))
      lines = ["\(refusal.sentence) It comes back on \(day)."]
    }
    if let detail { lines.append(detail) }
    if case .allowance = refusal, recovery == .signIn { lines.append("Sign in to continue.") }
    self.lines = lines
    identifier = switch refusal {
    case .rateLimited: "coach-daily-cap"
    case .allowance: "coach-allowance"
    default: "coach-notice"
    }
  }
}

// The notice, centred at the conversation's end: its lines in the footnote, then a quiet capsule for its door.
struct CoachNoticeView: View {
  let notice: CoachNotice
  let recover: (CoachRecovery) -> Void
  var body: some View {
    VStack(spacing: RoomSpace.small) {
      ForEach(Array(notice.lines.enumerated()), id: \.offset) { _, line in Text(line) }
      if let recovery = notice.recovery {
        Button(recovery.title) { recover(recovery) }
          .font(.subheadline.weight(.semibold)).buttonStyle(.bordered).buttonBorderShape(.capsule).tint(GymPalette.accent)
          .frame(minHeight: RoomSpace.minimumTarget).accessibilityIdentifier(recovery.identifier)
      }
    }.font(.footnote).foregroundStyle(GymPalette.inkDim).multilineTextAlignment(.center).frame(maxWidth: .infinity)
      .padding(.top, 40).accessibilityElement(children: .contain).accessibilityIdentifier(notice.identifier)
  }
}

extension CoachRecovery {
  var identifier: String {
    switch self {
    case .tryAgain: "coach-try-again"
    case .signIn: "coach-sign-in"
    case .ownAgent: "coach-own-agent"
    case .update: "coach-update"
    }
  }
}

// What Coach read (08.36): one row per ability the turn ran, in order, from its catalog phrase, with what it returned under
// it; the numbers count by identity, so a workout read twice counts once.
struct CoachSourcesSheet: View {
  let gym: GymModel
  let reading: CoachReading
  @Environment(\.dismiss) var dismiss
  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(Array(reading.steps.enumerated()), id: \.offset) { index, step in
            GymRow(title: step.title, meta: step.detail).padding(.vertical, 2).accessibilityIdentifier("coach-step-\(index)")
          }
        } header: { Text("What Coach used, in order").textCase(nil) } footer: { Text("A workout read twice counts once.") }
          .listRowBackground(GymPalette.card)
      }.listStyle(.insetGrouped).navigationTitle("What Coach read").modifier(GymPage())
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
      .accessibilityIdentifier("gym-coach-sources")
      .onAppear { gym.telemetry.event("gym_screen_viewed", properties: ["screen": "sources"]) }
  }
}
