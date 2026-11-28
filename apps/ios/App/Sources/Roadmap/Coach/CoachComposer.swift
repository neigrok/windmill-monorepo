import SwiftUI
import DomainKit
import RoadmapDomain

// The composer (Roadmap · iOS 11.1, 11.2, 11.17, 11.19a to 11.21): at rest a field in a capsule; focused, up to three
// suggestions as small glass buttons above it; while a turn runs, the turn's step line in the field's place and Stop in the
// send slot. A notice of what the AI service lets this phone ask stands in the band slot right above it, until the question is
// sent, the field is cleared or the state changes. It stands at the foot of the Board, the Graph and a step's page, and at the
// sheet's foot while a conversation is open: one place at a time.
struct CoachComposer: View {
  @Bindable var coach: RoadmapCoach
  let entry: RoadmapCoach.Entry
  // The room the composer stands in, a roadmap gone into among them, whose roadmap it asks about; none in the sheet, which
  // goes on with its conversation.
  var room: RoadmapModel?
  // The step a step's page asks about; none at the foot of the Board and the Graph, which ask about the roadmap.
  var step: (id: String, label: String)?
  @Environment(AppModel.self) private var app
  @FocusState private var focus: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      if let notice = coach.notice { CoachNoticeBand(notice: notice, coach: coach, app: app) }
      if coach.focused, coach.running == nil, coach.field.isEmpty { suggestions }
      HStack(alignment: .bottom, spacing: RoomSpace.related) {
        if let running = coach.running { line(running) } else { field }
      }
    }
      .onChange(of: coach.focused, initial: true) { _, focused in focus = focused }
      .onChange(of: focus) { _, focused in
        if focused && !coach.focused, let room { coach.open(in: room, about: step, from: entry) }
        coach.focused = focused
      }
  }

  // The field, which sends on return, and Send at its trailing end while it holds a question, in a capsule with a hairline
  // edge that reads on daylight's bar as on dark's (11.1).
  var field: some View {
    HStack(alignment: .bottom, spacing: 0) {
      // A field that grows takes return as a new line, so return is caught here and sends what was typed before it.
      TextField(placeholder, text: $coach.field, axis: .vertical)
        .lineLimit(1...5).focused($focus).submitLabel(.send)
        .onChange(of: coach.field) { _, typed in
          guard typed.contains("\n") else { return }
          coach.field = typed.replacingOccurrences(of: "\n", with: "")
          Task { await coach.send() }
        }
        .padding(.leading, 16).padding(.vertical, 11)
        .accessibilityIdentifier("roadmap-coach-field")
      if !TextSpec.isBlank(coach.field) {
        Button { Task { await coach.send() } } label: {
          Image(systemName: "arrow.up.circle.fill").font(.title2).foregroundStyle(RoadmapPalette.accent)
        }.padding(6).accessibilityLabel(Text("Send")).accessibilityIdentifier("roadmap-coach-send")
      }
    }.background(Capsule().fill(RoadmapPalette.raised)).overlay(Capsule().strokeBorder(RoadmapPalette.line)).frame(maxWidth: .infinity)
  }

  // 11.2: the turn's step line, from the catalog and never the model, and Stop.
  func line(_ running: RoadmapCoach.Running) -> some View {
    HStack(spacing: 0) {
      Text(running.line).foregroundStyle(RoadmapPalette.inkDim).lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 16).padding(.vertical, 11)
        .accessibilityIdentifier("roadmap-coach-line")
      Button("Stop", systemImage: "stop.fill") { coach.stop() }.labelStyle(.iconOnly)
        .buttonStyle(.borderedProminent).buttonBorderShape(.circle).tint(RoadmapPalette.accent).padding(4)
        .accessibilityIdentifier("roadmap-coach-stop")
    }.background(Capsule().fill(RoadmapPalette.raised))
  }

  // The field's prompt: what the composer asks about (11.17), and in the sheet of a conversation about a step, the change it
  // most often makes there (11.6c).
  var placeholder: String {
    let open = String(localized: "Ask or make a change…", comment: "The Coach composer's prompt")
    guard let label = coach.about?.stepLabel else { return open }
    if entry == .sheet {
      return String(localized: "Ask or add a subtask…", comment: "The Coach composer's prompt in a conversation about one step")
    }
    if coach.focused || entry == .row || entry == .step {
      return String(localized: "Ask about \(label)…", comment: "The Coach composer's prompt about one step: the step's name")
    }
    return open
  }

  // Up to three suggestions, which send their words as the question (11.1, 11.17).
  var suggestions: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: RoomSpace.related) {
        ForEach(Self.suggestions(about: coach.about?.step != nil), id: \.self) { words in
          Button(words) { Task { await coach.send(words) } }.modifier(GlassSuggestion())
            .accessibilityIdentifier("roadmap-coach-suggestion")
        }
      }
    }.scrollClipDisabled()
  }

  static func suggestions(about step: Bool) -> [String] {
    step ? [String(localized: "How do I start?"), String(localized: "Add a subtask"), String(localized: "What does it open?")]
      : [String(localized: "What’s next?"), String(localized: "Is this realistic?"), String(localized: "Review links")]
  }
}

// A suggestion: a small button of the system's glass, bordered before iOS 26, in the room's accent.
struct GlassSuggestion: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) { content.buttonStyle(.glass).controlSize(.small).tint(RoadmapPalette.accent) }
    else { content.buttonStyle(.bordered).controlSize(.small).tint(RoadmapPalette.accent) }
  }
}

// The notice in the band slot (11.19a to 11.21, the NOTE's one rule): the board's words, and the one way on where there is
// one, as glass buttons; offline is one line with none, since Send is the retry.
struct CoachNoticeBand: View {
  let notice: RoadmapCoach.Notice
  let coach: RoadmapCoach
  let app: AppModel

  var body: some View {
    VStack(alignment: .leading, spacing: RoomSpace.related) {
      Text(words).foregroundStyle(RoadmapPalette.ink).fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("roadmap-coach-notice")
      if let way {
        HStack {
          Spacer()
          Button(way.title) { way.action() }.modifier(GlassSuggestion()).controlSize(.large)
            .accessibilityIdentifier("roadmap-coach-notice-action")
        }
      }
    }.font(.subheadline).padding(16).frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(RoadmapPalette.raised))
  }

  var words: String {
    switch notice {
    case .offline: String(localized: "Asking needs a connection.")
    case .allowanceUsed(let signedIn, let renews):
      if !signedIn { String(localized: "You have used all of your AI allowance. Sign in to continue.") }
      else if let renews {
        String(localized: "You have used all of your AI allowance. It renews on \(Date(timeIntervalSince1970: Double(renews.ms) / 1_000).formatted(.dateTime.day().month(.wide))).",
               comment: "Coach's notice when the allowance is spent, signed in: the day it renews")
      } else { String(localized: "You have used all of your AI allowance.") }
    case .capacityUsed: String(localized: "Coach’s shared free AI capacity is unavailable for today. Signing in does not bypass this limit.")
    case .busy: String(localized: "You can ask again later.")
    case .signIn: String(localized: "This phone is linked to an account. Sign in to ask Coach.")
    case .update: String(localized: "This version can’t ask Coach any more. Update Windmill to continue.")
    case .switchedOff: String(localized: "This Windmill does not have Coach. You can still read your roadmap.")
    case .didNotAnswer: String(localized: "Coach didn’t answer. Try again in a moment")
    }
  }

  // The one way on: Sign In signed out, Use Your Agent where the allowance or the shared capacity is spent signed in.
  var way: (title: String, action: () -> Void)? {
    switch notice {
    case .allowanceUsed(signedIn: false, _), .signIn: (String(localized: "Sign In"), { app.openYou() })
    case .allowanceUsed(signedIn: true, _), .capacityUsed: (String(localized: "Use Your Agent"), { app.openYou() })
    case .update: (String(localized: "Update"), { UIApplication.shared.open(AppSettings.updateDestination) })
    default: nil
    }
  }
}
