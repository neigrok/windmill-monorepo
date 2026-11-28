import SwiftUI
import DomainKit
import RoadmapDomain

// The conversation (Roadmap · iOS 11.5 to 11.8): a sheet at medium over the live room, which pulls up to large and is large
// while the keyboard is up; Close, Coach over the conversation's scope, and History and New Chat in one capsule; the thread,
// with each answer's steps as links, its line of what Coach read, and each direct write's receipt; the composer at its foot.
// History and What Coach Read are pushed inside it, with no composer.
struct CoachSheet: View {
  enum Page: Hashable {
    case history
    case read(ID<CoachMessage>)
  }

  @Bindable var coach: RoadmapCoach
  let roadmap: RoadmapModel
  @State private var path: [Page] = []
  @State private var detent = PresentationDetent.medium

  var body: some View {
    NavigationStack(path: $path) {
      CoachThreadView(coach: coach, roadmap: roadmap)
        .modifier(CoachSheetTitle(title: String(localized: "Coach"), subtitle: scope))
        .toolbar {
          // The bar's controls are neutral, as the boards draw them; the accent stays with the thread's links.
          ToolbarItem(placement: .topBarLeading) {
            Button { coach.sheet = false } label: { Image(systemName: "xmark") }.accessibilityLabel(Text("Close"))
              .tint(RoadmapPalette.ink).accessibilityIdentifier("roadmap-coach-close")
          }
          ToolbarItemGroup(placement: .topBarTrailing) {
            Button("History", systemImage: "clock.arrow.circlepath") { path.append(.history) }.tint(RoadmapPalette.ink)
              .accessibilityIdentifier("roadmap-coach-history")
            Button("New Chat", systemImage: "square.and.pencil") { coach.newChat() }.tint(RoadmapPalette.ink)
              .accessibilityIdentifier("roadmap-coach-new-chat")
          }
        }
        .navigationDestination(for: Page.self) { page in
          switch page {
          case .history: CoachHistoryView(coach: coach, roadmap: roadmap) { path.removeAll() }
          case .read(let message): WhatCoachRead(coach: coach, roadmap: roadmap, message: message)
          }
        }
        .safeAreaInset(edge: .bottom) {
          CoachComposer(coach: coach, entry: .sheet).padding(.horizontal, RoomSpace.inset).padding(.vertical, 6).background(RoadmapPalette.canvas)
        }
    }
    .tint(RoadmapPalette.accent)
    .presentationDetents([.medium, .large], selection: $detent)
    .presentationBackgroundInteraction(.enabled(upThrough: .medium))
    .onChange(of: coach.focused) { _, focused in if focused { detent = .large } }
  }

  // The scope, written only here (11.5): what the conversation is about, the roadmap's name, About the step it started from,
  // or All roadmaps.
  var scope: String {
    _ = coach.revision
    guard let treeId = coach.about?.treeId else { return String(localized: "All roadmaps") }
    if let step = coach.about?.step, let label = roadmap.label(of: step, in: treeId) {
      return String(localized: "About \(label)", comment: "The scope of a Coach conversation started from a step: the step's name")
    }
    return roadmap.title(of: treeId)
  }
}

// Coach over its subtitle: the system's own title and subtitle on iOS 26, and both in the principal slot before it.
struct CoachSheetTitle: ViewModifier {
  let title: String
  let subtitle: String

  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content.navigationTitle(title).navigationSubtitle(subtitle).navigationBarTitleDisplayMode(.inline)
    } else {
      content.navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .principal) {
          VStack(spacing: 0) {
            Text(title).font(.headline)
            Text(subtitle).font(.caption).foregroundStyle(RoadmapPalette.inkDim)
          }
        }
      }
    }
  }
}

// The thread (11.5, 11.6, 11.6b, 11.6c): each question as a bubble, each answer as text with its steps as links, its line of
// what Coach read, and its receipts, one row each, Undone where its write was taken back. A short thread starts under the
// bar; one that overflows keeps its bottom in view.
struct CoachThreadView: View {
  let coach: RoadmapCoach
  let roadmap: RoadmapModel

  var body: some View {
    let _ = coach.revision
    let conversation = coach.conversation
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        ForEach(conversation?.messages ?? [], id: \.id) { message in
          if message.isCoach { answer(message, in: conversation) } else { question(message) }
        }
      }.padding(.horizontal, RoomSpace.inset).padding(.vertical, 12)
    }
    .defaultScrollAnchor(.top, for: .alignment)
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .background(RoadmapPalette.canvas)
    .environment(\.openURL, OpenURLAction { url in
      guard url.scheme == "windmill-step", let step = url.host() else { return .systemAction }
      roadmap.openStep(step, from: coach)
      return .handled
    })
  }

  func question(_ message: CoachMessage) -> some View {
    HStack {
      Spacer(minLength: 48)
      Text(message.text).foregroundStyle(RoadmapPalette.ink).padding(.horizontal, 14).padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(RoadmapPalette.accentSoft))
        .accessibilityIdentifier("roadmap-coach-question")
    }
  }

  @ViewBuilder func answer(_ message: CoachMessage, in conversation: Conversation?) -> some View {
    let text = coach.live?.message == message.id ? coach.live?.text ?? message.text : message.text
    VStack(alignment: .leading, spacing: 8) {
      if !text.isEmpty {
        Text(linked(text, treeId: conversation?.thread.treeId)).foregroundStyle(RoadmapPalette.ink).tint(RoadmapPalette.accent)
          .textSelection(.enabled).accessibilityIdentifier("roadmap-coach-answer")
      }
      let fates = Set((conversation?.fates ?? []).filter { $0.messageId == message.id && $0.fate == "undone" }.map(\.receipt))
      // Each receipt in its place, the index its fate names; one in a shape this build does not read is drawn as nothing.
      ForEach(Array((message.receipts ?? []).enumerated()), id: \.offset) { index, held in
        if let receipt = held.receipt {
          let undone = fates.contains(index)
          Label(CoachReceiptLine.words(receipt, undone: undone), systemImage: undone ? "arrow.counterclockwise" : "checkmark")
            .font(.footnote).foregroundStyle(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-coach-receipt")
        }
      }
      // A direct write's answer is its receipt alone (11.6c); an answer in words says what Coach read for it.
      if !text.isEmpty, let read = Self.readLine(message.calls) {
        NavigationLink(value: CoachSheet.Page.read(message.id)) {
          Label { Text(read) + Text(" ›") } icon: { Image(systemName: "doc.text") }
        }.font(.footnote).foregroundStyle(RoadmapPalette.inkDim).accessibilityIdentifier("roadmap-coach-read")
      }
      if message.state == .running && coach.running?.turn.coach != message.id {
        Text("Answering on another device…").font(.footnote).foregroundStyle(RoadmapPalette.inkDim)
      }
    }
  }

  // The line under an answer (11.5): what Coach was told and read, which opens What Coach Read.
  static func readLine(_ calls: [CoachCall]?) -> String? {
    guard let context = calls?.first(where: { $0.ability == CoachCall.context }), context.outcome == "ok" else { return nil }
    let steps = context.steps ?? 0
    if context.treeId == nil { return String(localized: "Read your roadmaps · \(steps)", locale: .copy, comment: "Under a Coach answer: how many roadmaps Coach read") }
    return String(localized: "Read your roadmap · \(steps) steps", locale: .copy, comment: "Under a Coach answer: how many steps Coach read")
  }

  // The answer's words with each step of the conversation's roadmap it names as a link to the step's page (11.5), the
  // longest names first so a name inside another links once.
  func linked(_ text: String, treeId: String?) -> AttributedString {
    var linked = AttributedString(text)
    guard let treeId else { return linked }
    for (id, label) in roadmap.steps(of: treeId).sorted(by: { $0.label.count > $1.label.count }) where label.count > 2 {
      var from = linked.startIndex
      while let range = linked[from...].range(of: label), linked[range].link == nil {
        linked[range].link = URL(string: "windmill-step://\(id)")
        from = range.upperBound
      }
    }
    return linked
  }
}

// History (11.7): one list of every conversation, the open roadmap's first, each tagged with its roadmap, All roadmaps or the
// step it is about, with the proposal it minted, and its day by the phone's clock; the title menu filters by roadmap, and a
// swipe deletes, held with the room's band and its Undo at the foot. No composer.
struct CoachHistoryView: View {
  let coach: RoadmapCoach
  let roadmap: RoadmapModel
  let opened: () -> Void
  @State private var only: String?

  var body: some View {
    let _ = coach.revision
    let history = coach.history()
    let now = coach.now()
    let keep = { (row: CoachHistory.Row) in only == nil || row.thread.treeId == only }
    List {
      Section { ForEach((history?.current ?? []).filter(keep)) { line($0, now: now) } }
      let other = (history?.other ?? []).filter(keep)
      if !other.isEmpty { Section("Other conversations") { ForEach(other) { line($0, now: now) } } }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(RoadmapPalette.canvas)
      .navigationTitle("History").navigationBarTitleDisplayMode(.inline)
      .toolbarTitleMenu {
        Picker("Roadmap", selection: $only) {
          Text("Every roadmap").tag(String?.none)
          ForEach(roadmap.roadmaps, id: \.id) { listed in Text(listed.name).tag(Optional(listed.id)) }
        }
      }
      .roadmapFoot(roadmap, inSheet: true) {}
  }

  // A row opens its conversation in the sheet, a chevron at its trailing end as a row that opens one shows.
  func line(_ row: CoachHistory.Row, now: Instant?) -> some View {
    Button {
      coach.show(row.thread.id)
      opened()
    } label: {
      HStack {
        LabeledContent {
          Text(row.at.map { Self.day($0, now: now) } ?? "")
        } label: {
          Text(row.thread.title).foregroundStyle(RoadmapPalette.ink).lineLimit(1)
          Text(tag(row)).font(.caption).foregroundStyle(RoadmapPalette.inkDim).lineLimit(1)
        }
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(RoadmapPalette.inkFaint)
      }
    }.listRowBackground(RoadmapPalette.card).accessibilityIdentifier("roadmap-coach-history-row")
      .swipeActions(edge: .trailing) {
        Button("Delete", role: .destructive) { coach.delete(row.thread.id) }
      }
  }

  // A row's tag: what the conversation is about, and the proposal it minted, its changes counted and its state where it is
  // not pending.
  func tag(_ row: CoachHistory.Row) -> String {
    let about: String
    if let treeId = row.thread.treeId, let step = row.thread.stepId, let label = roadmap.label(of: step, in: treeId) {
      about = String(localized: "About \(label)", comment: "The scope of a Coach conversation started from a step: the step's name")
    } else if let treeId = row.thread.treeId {
      about = roadmap.title(of: treeId)
    } else {
      about = String(localized: "All roadmaps")
    }
    guard let proposal = row.proposal else { return about }
    var parts = [about, String(localized: "\(proposal.changes) changes", locale: .copy, comment: "A History row: how many changes the conversation's proposal holds")]
    switch proposal.state {
    case .applied: parts.append(proposal.undone ? String(localized: "Undone") : String(localized: "Applied"))
    case .rejected: parts.append(String(localized: "Rejected"))
    case .stale: parts.append(String(localized: "Out of date"))
    case .replaced: parts.append(String(localized: "Replaced"))
    case .pending: break
    }
    return parts.joined(separator: " · ")
  }

  // A conversation's day by the phone's clock: Today, Yesterday, or the day and month.
  static func day(_ at: Instant, now: Instant?) -> String {
    let date = Date(timeIntervalSince1970: Double(at.ms) / 1_000)
    let today = now.map { Date(timeIntervalSince1970: Double($0.ms) / 1_000) } ?? .now
    if Calendar.current.isDate(date, inSameDayAs: today) { return String(localized: "Today") }
    if let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: today), Calendar.current.isDate(date, inSameDayAs: yesterday) {
      return String(localized: "Yesterday")
    }
    return date.formatted(.dateTime.day().month(.abbreviated))
  }
}

// What Coach Read (11.8): one row per thing Coach used for that answer, in order, a step read twice once, each saying only
// what its record holds; a step the copy no longer holds is left out, and no id is ever shown.
struct WhatCoachRead: View {
  let coach: RoadmapCoach
  let roadmap: RoadmapModel
  let message: ID<CoachMessage>

  var body: some View {
    let _ = coach.revision
    let calls = coach.conversation?.messages.first { $0.id == message }?.calls ?? []
    List {
      Section {
        ForEach(Array(rows(calls).enumerated()), id: \.offset) { _, row in
          LabeledContent {
            EmptyView()
          } label: {
            Text(row.title).foregroundStyle(RoadmapPalette.ink)
            Text(row.detail).font(.caption).foregroundStyle(RoadmapPalette.inkDim)
          }.listRowBackground(RoadmapPalette.card).accessibilityIdentifier("roadmap-coach-read-row")
        }
      } footer: { Text("A step read twice counts once.") }
    }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(RoadmapPalette.canvas)
      .navigationTitle("What Coach Read").navigationBarTitleDisplayMode(.inline)
  }

  func rows(_ calls: [CoachCall]) -> [(title: String, detail: String)] {
    var seen = Set<String>()
    return calls.filter { $0.outcome == "ok" }.flatMap { call -> [(title: String, detail: String)] in
      let treeId = call.treeId ?? ""
      switch call.ability {
      case CoachCall.context where call.treeId == nil, "list_trees":
        return [(String(localized: "Your roadmaps"), String(localized: "\(call.steps ?? 0) roadmaps", locale: .copy, comment: "What Coach Read: how many roadmaps"))]
      case CoachCall.context, "get_tree":
        guard let done = call.done else {
          return [(roadmap.title(of: treeId), String(localized: "\(call.steps ?? 0) steps", locale: .copy, comment: "What Coach Read: a roadmap's steps, where the read kept no count of the done ones"))]
        }
        return [(roadmap.title(of: treeId), String(localized: "\(call.steps ?? 0) steps · \(done) done", locale: .copy, comment: "What Coach Read: a roadmap's steps, and how many are done"))]
      case "get_progress":
        return [(String(localized: "Your progress"), String(localized: "\(call.steps ?? 0) steps done", locale: .copy, comment: "What Coach Read: how many steps the person has done"))]
      case "find_nodes":
        return [(String(localized: "A search of your roadmap"), String(localized: "\(call.steps ?? 0) steps found", locale: .copy, comment: "What Coach Read: how many steps a search found"))]
      case "get_diagnostics":
        return [(String(localized: "Problems in your roadmap"), String(localized: "Loops, missing links and smells"))]
      case "get_nodes":
        return (call.nodeIds ?? []).filter { seen.insert($0).inserted }.compactMap { id in
          roadmap.label(of: id, in: treeId).map { ($0, Self.fields(call.fields)) }
        }
      default: return []
      }
    }
  }

  // What Coach asked of a step it read: its fields in words, its line where it asked for none.
  static func fields(_ fields: [String]?) -> String {
    guard let fields, !fields.isEmpty else { return String(localized: "Its line on the Board") }
    let named: [String: String] = ["description": String(localized: "Description"), "links": String(localized: "Links"),
                                   "subtasks": String(localized: "Subtasks"), "prerequisites": String(localized: "What it needs"),
                                   "opens": String(localized: "What it opens")]
    let words = fields.compactMap { named[$0] }
    return words.isEmpty ? String(localized: "Its line on the Board") : words.joined(separator: " · ")
  }
}

// Coach's sheet over the room, while a conversation is open (11.5).
struct CoachSheets: ViewModifier {
  let roadmap: RoadmapModel
  let app: AppModel

  func body(content: Content) -> some View {
    if let coach = roadmap.coach {
      content.sheet(isPresented: Binding(get: { coach.sheet }, set: { coach.sheet = $0 })) {
        CoachSheet(coach: coach, roadmap: roadmap).environment(app)
      }
    } else {
      content
    }
  }
}

// What Coach's screens read of the person's roadmaps from the room's last read of the copy.
extension RoadmapModel {
  // A roadmap's name as the room's list shows it.
  func title(of treeId: String) -> String {
    roadmaps.first { $0.id == treeId }?.name ?? ListedRoadmap.name(of: account.location(of: treeId).title)
  }

  // The steps a roadmap shows, each by its name.
  func steps(of treeId: String) -> [(id: String, label: String)] {
    (account.trees.first { $0.id == treeId }?.nodes ?? []).filter(\.present).map { ($0.id, $0.label) }
  }

  func label(of step: String, in treeId: String) -> String? {
    account.trees.first { $0.id == treeId }?.nodes.first { $0.id == step }?.label
  }

  // A step an answer names opens on its page in the room, under the sheet, which settles at medium.
  func openStep(_ step: String, from coach: RoadmapCoach) {
    guard let open = shown, open.step(step) != nil else { return }
    path = [.step(step, by: .link)]
  }
}
