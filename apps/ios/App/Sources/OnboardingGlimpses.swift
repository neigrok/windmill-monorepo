import SwiftUI
import DomainKit
import GymDomain
import SyncCore

struct OnboardingGlimpse: View {
  let page: OnboardingPage
  let active: Bool
  let visit: UUID
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @State var bands = [1.0, 1.0, 1.0]
  @State var travel = 1.0
  @State var ignition = 1.0
  @State var glow = 1.0
  @State var press = 1.0
  @State var logged = 1.0
  @State var breathing = false
  @State var travelling = false
  var body: some View {
    // One picture scaled uniformly into the column between the gutters, centred in it.
    GeometryReader { geometry in
      let scale = min(geometry.size.width / 354, geometry.size.height / page.glimpseHeight)
      Group {
        switch page {
        case .windmill: rooms
        case .roadmap: roadmap
        case .journal: journal
        case .gym: gym
        }
      }.frame(width: 354, height: page.glimpseHeight)
        .scaleEffect(scale)
        .frame(width: 354 * scale, height: page.glimpseHeight * scale)
        .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
        .accessibilityHidden(true)
    }.environment(\.dynamicTypeSize, .large)
      .task(id: active ? visit : nil) {
        guard active else { rest(); return }
        do {
          try await Task.sleep(for: .milliseconds(100))
          switch page {
          case .windmill:
            bands = [0, 0, 0]
            try await Task.sleep(for: .milliseconds(16))
            for index in 0..<3 {
              withAnimation(.timingCurve(0.2, 0, 0.2, 1, duration: 0.28)) { bands[index] = 1 }
              try await Task.sleep(for: .milliseconds(320))
            }
          case .roadmap:
            travel = 0; ignition = 0; travelling = !reduceMotion
            try await Task.sleep(for: .milliseconds(16))
            withAnimation(.timingCurve(0.2, 0, 0, 1, duration: reduceMotion ? 0.15 : 0.42)) { travel = 1 }
            try await Task.sleep(for: .milliseconds(reduceMotion ? 0 : 357))
            withAnimation(.easeInOut(duration: reduceMotion ? 0.15 : 0.28)) { ignition = 1 }
            if !reduceMotion { try await Task.sleep(for: .milliseconds(63)); travelling = false }
            if !reduceMotion { withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) { breathing = true } }
          case .journal:
            glow = 0
            try await Task.sleep(for: .milliseconds(16))
            withAnimation(.timingCurve(0.22, 0.61, 0.36, 1, duration: reduceMotion ? 0.15 : 0.48)) { glow = 1 }
          case .gym:
            logged = 0
            try await Task.sleep(for: .milliseconds(16))
            if !reduceMotion {
              withAnimation(.easeInOut(duration: 0.15)) { press = 0.97 }
              try await Task.sleep(for: .milliseconds(150))
              withAnimation(.easeInOut(duration: 0.15)) { press = 1 }
            }
            withAnimation(.easeInOut(duration: reduceMotion ? 0.15 : 0.32)) { logged = 1 }
          }
        } catch { rest() }
      }
  }

  func rest() {
    withAnimation(.easeOut(duration: 0.15)) { bands = [1, 1, 1]; travel = 1; ignition = 1; glow = 1; press = 1; logged = 1; breathing = false; travelling = false }
  }

  func card<Content: View>(_ ground: Color, _ line: Color, radius: CGFloat = 24, @ViewBuilder content: () -> Content) -> some View {
    content().frame(width: 354, height: radius == 20 ? 100 : 340, alignment: .topLeading)
      .background(ground).clipShape(RoundedRectangle(cornerRadius: radius))
      .overlay(RoundedRectangle(cornerRadius: radius).stroke(line, lineWidth: 1))
  }
  func caption(_ ink: Color) -> some View {
    Text("EXAMPLE").font(OnboardingSpecimenType.caption).tracking(1.2).foregroundStyle(ink)
      .frame(width: 80, alignment: .trailing).offset(x: 258, y: 14)
  }
  func text(_ value: String, _ font: Font, _ color: Color, x: CGFloat, y: CGFloat, width: CGFloat = 306) -> some View {
    Text(value).font(font).foregroundStyle(color).frame(width: width, alignment: .leading).fixedSize(horizontal: false, vertical: true).offset(x: x, y: y)
  }

  var rooms: some View {
    VStack(spacing: 10) {
      ForEach(0..<3, id: \.self) { index in
        let ground = index == 0 ? ShellPalette.canvas : index == 1 ? JournalPalette.canvas : GymPalette.canvas
        let line = index == 0 ? ShellPalette.line : index == 1 ? JournalPalette.line : GymPalette.line
        let ink = index == 0 ? ShellPalette.ink : index == 1 ? JournalPalette.ink : GymPalette.ink
        let dim = index == 0 ? ShellPalette.inkDim : index == 1 ? JournalPalette.inkDim : GymPalette.inkDim
        card(ground, line, radius: 20) {
          ZStack(alignment: .topLeading) {
            Circle().fill(index == 0 ? OnboardingSpecimen.clayKind : index == 1 ? JournalPalette.lamp : GymPalette.accent).frame(width: 7, height: 7).offset(x: 20, y: 29)
            text(["Roadmap", "Journal", "Gym"][index], OnboardingSpecimenType.roomTitle, ink, x: 36, y: 22, width: 210)
            text(["Map what you're learning", "Notice what happened", "Keep a training log"][index], OnboardingSpecimenType.roomLine, dim, x: 36, y: 50, width: 218)
            if index == 0 { miniatureTree }
            if index == 1 {
              RadialGradient(colors: [JournalPalette.glimpseGlow, .clear], center: .bottomTrailing, startRadius: 0, endRadius: 140)
              ForEach(0..<3, id: \.self) { row in
                Capsule().fill(row == 2 ? ink : OnboardingSpecimen.journalPastLine).frame(width: [72.0, 46, 60][row], height: 3).offset(x: 254, y: [30.0, 40, 61][row])
              }
              Rectangle().fill(JournalPalette.lamp).frame(width: 2, height: 14).offset(x: 320, y: 56)
            }
            if index == 2 {
              text("100", OnboardingSpecimenType.miniWeight, ink, x: 239, y: 24, width: 65)
              text("kg × 5", OnboardingSpecimenType.miniUnit, dim, x: 240, y: 65, width: 65)
              Circle().fill(GymPalette.accent).frame(width: 22, height: 22).overlay(Text("✓").font(OnboardingSpecimenType.miniCheck).foregroundStyle(GymPalette.onAccent)).offset(x: 316, y: 39)
            }
          }
        }.opacity(bands[index]).offset(y: reduceMotion ? 0 : 8 * (1 - bands[index]))
      }
    }
  }

  var miniatureTree: some View {
    ZStack(alignment: .topLeading) {
      Path { path in
        path.move(to: CGPoint(x: 258, y: 50)); path.addQuadCurve(to: CGPoint(x: 302, y: 32), control: CGPoint(x: 280, y: 39)); path.addLine(to: CGPoint(x: 332, y: 20))
        path.move(to: CGPoint(x: 258, y: 50)); path.addQuadCurve(to: CGPoint(x: 302, y: 68), control: CGPoint(x: 280, y: 66)); path.addLine(to: CGPoint(x: 332, y: 80))
      }.stroke(OnboardingSpecimen.branch, lineWidth: 1.5)
      Circle().fill(OnboardingSpecimen.halo).frame(width: 30, height: 30).offset(x: 243, y: 35)
      Circle().fill(OnboardingSpecimen.completed).overlay(Circle().stroke(OnboardingSpecimen.completedOutline, lineWidth: 2)).frame(width: 18, height: 18).offset(x: 249, y: 41)
      Circle().fill(ShellPalette.canvas).overlay(Circle().stroke(OnboardingSpecimen.skyKind, lineWidth: 2)).frame(width: 12, height: 12).offset(x: 296, y: 26)
      Circle().fill(OnboardingSpecimen.clayKind).overlay(Circle().stroke(OnboardingSpecimen.clayOpenOutline, lineWidth: 1.5)).frame(width: 12, height: 12).offset(x: 296, y: 62)
      Circle().fill(OnboardingSpecimen.skyLockedFill).overlay(Circle().stroke(OnboardingSpecimen.skyLockedOutline)).frame(width: 11, height: 11).offset(x: 326, y: 14)
      Circle().fill(OnboardingSpecimen.goldLockedFill).overlay(Circle().stroke(OnboardingSpecimen.goldLockedOutline)).frame(width: 11, height: 11).offset(x: 326, y: 74)
    }
  }

  var roadmap: some View {
    card(ShellPalette.canvas, ShellPalette.line) {
      ZStack(alignment: .topLeading) {
        Path { path in
          for (child, end) in zip([87.0, 171, 255], [63.0, 147, 231]) {
            path.move(to: CGPoint(x: 175, y: child)); path.addCurve(to: CGPoint(x: 281, y: end), control1: CGPoint(x: 220, y: child), control2: CGPoint(x: 246, y: end))
          }
        }.stroke(OnboardingSpecimen.lockedEdge, lineWidth: 1.5)
        Path { path in
          for child in [87.0, 171, 255] {
            path.move(to: CGPoint(x: 71, y: 171)); path.addCurve(to: CGPoint(x: 175, y: child), control1: CGPoint(x: 116, y: 171), control2: CGPoint(x: 131, y: child))
          }
        }.stroke(OnboardingSpecimen.openEdge, lineWidth: 2).opacity(reduceMotion ? 0.5 + travel * 0.5 : 1)
        Circle().fill(OnboardingSpecimen.completed).opacity(reduceMotion ? 0.28 : breathing ? 0.18 : 0.28).frame(width: 52, height: 52).offset(x: 45, y: 145)
        Circle().fill(OnboardingSpecimen.completed).overlay(Circle().stroke(OnboardingSpecimen.completedOutline, lineWidth: 2)).frame(width: 30, height: 30).offset(x: 56, y: 156)
        if !reduceMotion && travelling { Circle().fill(ShellPalette.ink).frame(width: 7, height: 7).offset(x: 67.5 + 104 * travel, y: 167.5) }
        Text("Learn to sail").font(OnboardingSpecimenType.treeTitle).foregroundStyle(ShellPalette.ink).frame(width: 100).offset(x: 21, y: 192)
        ForEach(0..<3, id: \.self) { index in
          let kind = index == 0 ? OnboardingSpecimen.clayKind : index == 1 ? OnboardingSpecimen.skyKind : OnboardingSpecimen.goldKind
          Circle().fill(index == 0 ? kind : ShellPalette.canvas).overlay(Circle().stroke(index == 0 ? OnboardingSpecimen.clayOpenOutline : kind, lineWidth: 2)).frame(width: 26, height: 26).opacity(index == 1 ? 0.5 + ignition * 0.5 : 1).offset(x: 162, y: 74 + CGFloat(index) * 84)
          Text(["Knots & lines", "Rig the mast", "Points of sail"][index]).font(OnboardingSpecimenType.treeNode).foregroundStyle(ShellPalette.ink).frame(width: 100).offset(x: 125, y: 106 + CGFloat(index) * 84)
          Circle().fill(index == 0 ? OnboardingSpecimen.clayLockedFill : index == 1 ? OnboardingSpecimen.skyLockedFill : OnboardingSpecimen.goldLockedFill)
            .overlay(Circle().stroke(index == 0 ? OnboardingSpecimen.clayLockedOutline : index == 1 ? OnboardingSpecimen.skyLockedOutline : OnboardingSpecimen.goldLockedOutline, lineWidth: 1.5)).frame(width: 22, height: 22).offset(x: 270, y: 52 + CGFloat(index) * 84)
          Text(["Capsize drill", "Reefing", "Read the wind"][index]).font(OnboardingSpecimenType.treeNode).foregroundStyle(ShellPalette.inkFaint).frame(width: 100).offset(x: 231, y: 80 + CGFloat(index) * 84)
        }
        caption(ShellPalette.inkFaint)
      }
    }
  }

  var journal: some View {
    let ink = JournalPalette.ink
    let dim = JournalPalette.inkDim
    let faint = JournalPalette.inkFaint
    return card(JournalPalette.canvas, JournalPalette.line) {
      ZStack(alignment: .topLeading) {
        RadialGradient(colors: [JournalPalette.glimpseGlow, .clear], center: .init(x: 0.5, y: 1.15), startRadius: 0, endRadius: 240).opacity(glow)
        text("YESTERDAY", OnboardingSpecimenType.caption, faint, x: 24, y: 22).tracking(1.2)
        text("Walked before work. Slept better than the week before.", OnboardingSpecimenType.journalPast, dim, x: 24, y: 42).lineSpacing(4)
        Circle().fill(JournalPalette.lamp).frame(width: 6, height: 6).offset(x: 24, y: 122)
        text("Tonight", OnboardingSpecimenType.journalTitle, ink, x: 38, y: 116)
        text("Finished the chapter I kept avoiding.\nLighter than expected", OnboardingSpecimenType.journalBody, ink, x: 24, y: 142).lineSpacing(4)
        TimelineView(.periodic(from: .now, by: 0.6)) { context in
          Rectangle().fill(JournalPalette.lamp).frame(width: 2, height: 22)
            .opacity(!active || Int(context.date.timeIntervalSince1970 / 0.6).isMultiple(of: 2) ? 1 : 0)
        }.offset(x: 203, y: 169)
        VStack(alignment: .leading, spacing: 10) {
          ForEach(0..<2, id: \.self) { row in
            HStack(spacing: 8) {
              Text(row == 0 ? "Mood" : "Energy").font(OnboardingSpecimenType.scaleLabel).frame(width: 48, alignment: .leading)
              ForEach(0..<(row == 0 ? 7 : 5), id: \.self) { _ in Circle().stroke(OnboardingSpecimen.unasked, lineWidth: 1).frame(width: 10, height: 10) }
            }
          }
        }.foregroundStyle(OnboardingSpecimen.unasked).offset(x: 24, y: 236)
        text("saved", OnboardingSpecimenType.caption, faint, x: 278, y: 310, width: 60).tracking(0.6)
        caption(faint)
      }
    }
  }

  // The rack as the workout draws it, from its own ledger rows and numeral; Log set checks the current row and the next one takes its dot.
  var gym: some View {
    let squat = ID<Exercise>("back-squat"), session = ID<Session>("onboarding-glimpse")
    let sets = (0..<(logged < 1 ? 1 : 2)).map { index in
      TrainingSet(id: ID(RecordID("onboarding-glimpse-\(index)")), sessionId: session, exerciseId: squat, weightKg: 100, reps: 5, completedAt: Instant(ms: 0))
    }
    let ledger = MovementLedger(sets: sets, plan: RoutineEntry(exerciseId: squat, sets: Array(repeating: SetTarget(reps: 5, weightKg: 100), count: 3)),
                                lastTime: LastTime(exerciseId: squat))
    return card(GymPalette.canvas, GymPalette.line) {
      ZStack(alignment: .topLeading) {
        VStack(spacing: 8) {
          Text("Squat").font(.title2.weight(.bold)).foregroundStyle(GymPalette.ink)
          VStack(spacing: 0) {
            ForEach(ledger.rows) { row in
              if row.id > 0 { Divider().overlay(GymPalette.line) }
              WorkoutLedgerRow(row: row, unsent: false)
            }
          }.padding(.horizontal, RoomSpace.inset).background(GymPalette.card, in: .card)
          HStack(alignment: .firstTextBaseline, spacing: RoomSpace.related) {
            Text("100").modifier(GymNumeral()).foregroundStyle(GymPalette.ink)
            Text("kg").font(.title3).foregroundStyle(GymPalette.inkDim)
          }
          Text("Log set").font(.body).foregroundStyle(GymPalette.onAccent)
            .frame(maxWidth: .infinity, minHeight: RoomSpace.minimumTarget).background(GymPalette.accent, in: Capsule()).scaleEffect(press)
        }.padding(.horizontal, 20).padding(.vertical, 12)
        caption(GymPalette.inkFaint)
      }
    }
  }
}

// Illustration roles frozen for the glimpses; the journal glimpse draws with the journal palette itself.
enum OnboardingSpecimen {
  static let completed = Color("onboarding/completed")
  static let completedOutline = Color("onboarding/completed-outline")
  static let clayKind = Color("onboarding/clay-kind")
  static let skyKind = Color("onboarding/sky-kind")
  static let skyLockedFill = Color("onboarding/sky-locked-fill")
  static let skyLockedOutline = Color("onboarding/sky-locked-outline")
  static let goldKind = Color("onboarding/gold-kind")
  static let goldLockedFill = Color("onboarding/gold-locked-fill")
  static let goldLockedOutline = Color("onboarding/gold-locked-outline")
  static let clayOpenOutline = Color("onboarding/clay-open-outline")
  static let clayLockedFill = Color("onboarding/clay-locked-fill")
  static let clayLockedOutline = Color("onboarding/clay-locked-outline")
  static let openEdge = Color("onboarding/open-edge")
  static let lockedEdge = Color("onboarding/locked-edge")
  static let branch = Color("onboarding/branch")
  // Faded specimens: the journal card's written lines, the completed step's halo, the scales nobody has answered.
  static let journalPastLine = JournalPalette.inkDim.opacity(0.45)
  static let halo = completed.opacity(0.28)
  static let unasked = JournalPalette.inkFaint.opacity(0.55)
}

enum OnboardingSpecimenType {
  static let wordmark = Font.custom("Baloo2-Bold", fixedSize: 30)
  static let roomTitle = Font.custom("Nunito-ExtraBold", fixedSize: 18)
  static let roomLine = Font.custom("Inter-Regular", fixedSize: 13)
  static let miniWeight = Font.system(size: 30, weight: .bold, design: .rounded).monospacedDigit()
  static let miniUnit = Font.system(size: 13)
  static let miniCheck = Font.custom("Inter-SemiBold", fixedSize: 13)
  static let caption = Font.custom("JetBrainsMono-Regular", fixedSize: 10)
  static let treeTitle = Font.custom("Inter-SemiBold", fixedSize: 12)
  static let treeNode = Font.custom("Inter-Regular", fixedSize: 12)
  static let journalPast = Font.custom("Inter-Regular", fixedSize: 15)
  static let journalTitle = Font.custom("Nunito-ExtraBold", fixedSize: 14)
  static let journalBody = Font.custom("Inter-Regular", fixedSize: 17)
  static let scaleLabel = Font.custom("Inter-Regular", fixedSize: 11)
}
