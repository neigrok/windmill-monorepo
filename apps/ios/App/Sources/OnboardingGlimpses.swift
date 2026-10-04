import SwiftUI

struct OnboardingGlimpse: View {
  let page: OnboardingPage
  let active: Bool
  let visit: UUID
  let palette: OnboardingPalette
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @State var bands = [1.0, 1.0, 1.0]
  @State var travel = 1.0
  @State var ignition = 1.0
  @State var glow = 1.0
  @State var press = 1.0
  @State var check = 1.0
  @State var logged = 1.0
  @State var breathing = false
  @State var travelling = false
  var body: some View {
    GeometryReader { geometry in
      let scale = min(geometry.size.width / 354, geometry.size.height / (page == .windmill ? 320 : 340))
      Group {
        switch page {
        case .windmill: rooms
        case .roadmap: roadmap
        case .journal: journal
        case .gym: gym
        }
      }.frame(width: 354, height: page == .windmill ? 320 : 340)
        .scaleEffect(scale, anchor: .topLeading)
        .offset(x: (geometry.size.width - 354 * scale) / 2)
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
            check = 0; logged = 0
            try await Task.sleep(for: .milliseconds(16))
            if !reduceMotion {
              withAnimation(.easeInOut(duration: 0.15)) { press = 0.97 }
              try await Task.sleep(for: .milliseconds(150))
              withAnimation(.easeInOut(duration: 0.15)) { press = 1 }
            }
            withAnimation(.easeInOut(duration: reduceMotion ? 0.15 : 0.32)) { check = 1 }
            try await Task.sleep(for: .milliseconds(120))
            withAnimation(.easeInOut(duration: 0.15)) { logged = 1 }
          }
        } catch { rest() }
      }
  }

  func rest() {
    withAnimation(.easeOut(duration: 0.15)) { bands = [1, 1, 1]; travel = 1; ignition = 1; glow = 1; press = 1; check = 1; logged = 1; breathing = false; travelling = false }
  }

  func card<Content: View>(_ ground: Color, _ line: Color, radius: CGFloat = 24, @ViewBuilder content: () -> Content) -> some View {
    content().frame(width: 354, height: radius == 20 ? 100 : 340, alignment: .topLeading)
      .background(ground).clipShape(RoundedRectangle(cornerRadius: radius))
      .overlay(RoundedRectangle(cornerRadius: radius).stroke(line, lineWidth: 1))
  }
  func caption(_ ink: Color) -> some View {
    Text("EXAMPLE").font(Design.mono(10)).tracking(1.2).foregroundStyle(ink)
      .frame(width: 80, alignment: .trailing).offset(x: 258, y: 14)
  }
  func text(_ value: String, _ font: Font, _ color: Color, x: CGFloat, y: CGFloat, width: CGFloat = 306) -> some View {
    Text(value).font(font).foregroundStyle(color).frame(width: width, alignment: .leading).fixedSize(horizontal: false, vertical: true).offset(x: x, y: y)
  }

  var rooms: some View {
    VStack(spacing: 10) {
      ForEach(0..<3, id: \.self) { index in
        let ground = index == 0 ? palette.ground : index == 1 ? palette.color(0x0b0e16, 0xf7f7f5) : palette.color(0x0b1111, 0xebe7e3)
        let line = index == 0 ? palette.color(0x222224, 0xe5d9c0) : index == 1 ? palette.color(0x20232b, 0xe3e0da) : palette.color(0x2a3133, 0xd0cac5)
        let ink = index == 0 ? palette.ink : index == 1 ? palette.color(0xf1f0ec, 0x2a2118) : palette.color(0xf1f0eb, 0x1a1918)
        let dim = index == 0 ? palette.dim : index == 1 ? palette.color(0xb6b5b0, 0x74654f) : palette.color(0xb6b5af, 0x4c4744)
        card(ground, line, radius: 20) {
          ZStack(alignment: .topLeading) {
            Circle().fill(index == 0 ? palette.brand : index == 1 ? palette.lamp : palette.gym).frame(width: 7, height: 7).offset(x: 20, y: 29)
            text(["Roadmap", "Journal", "Gym"][index], Design.title(18), ink, x: 36, y: 22, width: 210)
            text(["Map what you're learning", "Notice what happened", "Keep a training log"][index], Design.text(13), dim, x: 36, y: 50, width: 218)
            if index == 0 { miniatureTree }
            if index == 1 {
              RadialGradient(colors: [palette.lamp.opacity(0.18), .clear], center: .bottomTrailing, startRadius: 0, endRadius: 140)
              ForEach(0..<3, id: \.self) { row in
                Capsule().fill(row == 2 ? ink : dim.opacity(0.45)).frame(width: [72.0, 46, 60][row], height: 3).offset(x: 254, y: [30.0, 40, 61][row])
              }
              Rectangle().fill(palette.lamp).frame(width: 2, height: 14).offset(x: 320, y: 56)
            }
            if index == 2 {
              text("100", Design.mono(30), ink, x: 239, y: 24, width: 65)
              text("kg × 5", Design.mono(10), dim, x: 240, y: 65, width: 65)
              Circle().fill(palette.gym).frame(width: 22, height: 22).overlay(Text("✓").font(Design.strong(13)).foregroundStyle(palette.dark ? Color(hex: 0x1b1408) : .white)).offset(x: 316, y: 39)
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
      }.stroke(palette.dim.opacity(0.5), lineWidth: 1.5)
      Circle().fill(Color(hex: 0x9aa859).opacity(0.28)).frame(width: 30, height: 30).offset(x: 243, y: 35)
      Circle().fill(palette.color(0x9aa859, 0x7d8c43)).overlay(Circle().stroke(Color(hex: 0xc4d18a), lineWidth: 2)).frame(width: 18, height: 18).offset(x: 249, y: 41)
      Circle().fill(palette.ground).overlay(Circle().stroke(palette.color(0x9dbdca, 0x5f8494), lineWidth: 2)).frame(width: 12, height: 12).offset(x: 296, y: 26)
      Circle().fill(palette.brand).overlay(Circle().stroke(Color(hex: 0xefb58f), lineWidth: 1.5)).frame(width: 12, height: 12).offset(x: 296, y: 62)
      Circle().fill(palette.color(0x293033, 0xd8dedc)).overlay(Circle().stroke(palette.color(0x36464b, 0xa9bdc5))).frame(width: 11, height: 11).offset(x: 326, y: 14)
      Circle().fill(palette.color(0x433619, 0xeee1bd)).overlay(Circle().stroke(palette.color(0x6a5220, 0xe0c880))).frame(width: 11, height: 11).offset(x: 326, y: 74)
    }
  }

  var roadmap: some View {
    card(palette.ground, palette.color(0x222224, 0xe5d9c0)) {
      ZStack(alignment: .topLeading) {
        Path { path in
          for (child, end) in zip([87.0, 171, 255], [63.0, 147, 231]) {
            path.move(to: CGPoint(x: 175, y: child)); path.addCurve(to: CGPoint(x: 281, y: end), control1: CGPoint(x: 220, y: child), control2: CGPoint(x: 246, y: end))
          }
        }.stroke(palette.color(0x2e2e32, 0xe5d9c0), lineWidth: 1.5)
        Path { path in
          for child in [87.0, 171, 255] {
            path.move(to: CGPoint(x: 71, y: 171)); path.addCurve(to: CGPoint(x: 175, y: child), control1: CGPoint(x: 116, y: 171), control2: CGPoint(x: 131, y: child))
          }
        }.stroke(palette.color(0x888780, 0xa7997d), lineWidth: 2).opacity(reduceMotion ? 0.5 + travel * 0.5 : 1)
        Circle().fill(palette.color(0x9aa859, 0x7d8c43)).opacity(reduceMotion ? 0.28 : breathing ? 0.18 : 0.28).frame(width: 52, height: 52).offset(x: 45, y: 145)
        Circle().fill(palette.color(0x9aa859, 0x7d8c43)).overlay(Circle().stroke(palette.color(0xc4d18a, 0xa6b86a), lineWidth: 2)).frame(width: 30, height: 30).offset(x: 56, y: 156)
        if !reduceMotion && travelling { Circle().fill(palette.ink).frame(width: 7, height: 7).offset(x: 67.5 + 104 * travel, y: 167.5) }
        Text("Learn to sail").font(Design.strong(12)).foregroundStyle(palette.ink).frame(width: 100).offset(x: 21, y: 192)
        ForEach(0..<3, id: \.self) { index in
          let kind = index == 0 ? palette.brand : index == 1 ? palette.color(0x9dbdca, 0x5f8494) : palette.color(0xe9c563, 0xc4972f)
          Circle().fill(index == 0 ? kind : palette.ground).overlay(Circle().stroke(index == 0 ? Color(hex: 0xefb58f) : kind, lineWidth: 2)).frame(width: 26, height: 26).opacity(index == 1 ? 0.5 + ignition * 0.5 : 1).offset(x: 162, y: 74 + CGFloat(index) * 84)
          Text(["Knots & lines", "Rig the mast", "Points of sail"][index]).font(Design.text(12)).foregroundStyle(palette.ink).frame(width: 100).offset(x: 125, y: 106 + CGFloat(index) * 84)
          Circle().fill(index == 0 ? palette.color(0x462d1d, 0xefdfd0) : index == 1 ? palette.color(0x293033, 0xd8dedc) : palette.color(0x433619, 0xeee1bd))
            .overlay(Circle().stroke(index == 0 ? palette.color(0x73492f, 0xc8a989) : index == 1 ? palette.color(0x36464b, 0xa9bdc5) : palette.color(0x6a5220, 0xe0c880), lineWidth: 1.5)).frame(width: 22, height: 22).offset(x: 270, y: 52 + CGFloat(index) * 84)
          Text(["Capsize drill", "Reefing", "Read the wind"][index]).font(Design.text(12)).foregroundStyle(palette.color(0x7e7c77, 0x92805f)).frame(width: 100).offset(x: 231, y: 80 + CGFloat(index) * 84)
        }
        caption(palette.color(0x7e7c77, 0x92805f))
      }
    }
  }

  var journal: some View {
    let ink = palette.color(0xf1f0ec, 0x2a2118)
    let dim = palette.color(0xb6b5b0, 0x74654f)
    let faint = palette.color(0x737476, 0x8e8272)
    return card(palette.color(0x0b0e16, 0xf7f7f5), palette.color(0x20232b, 0xe3e0da)) {
      ZStack(alignment: .topLeading) {
        RadialGradient(colors: [palette.lamp.opacity(0.18 * glow), .clear], center: .init(x: 0.5, y: 1.15), startRadius: 0, endRadius: 240)
        text("YESTERDAY", Design.mono(10), faint, x: 24, y: 22).tracking(1.2)
        text("Walked before work. Slept better than the week before.", Design.text(15), dim, x: 24, y: 42).lineSpacing(4)
        Circle().fill(palette.lamp).frame(width: 6, height: 6).offset(x: 24, y: 122)
        text("Tonight", Design.title(14), ink, x: 38, y: 116)
        text("Finished the chapter I kept avoiding.\nLighter than expected", Design.text(17), ink, x: 24, y: 142).lineSpacing(4)
        TimelineView(.periodic(from: .now, by: 0.6)) { context in
          Rectangle().fill(palette.lamp).frame(width: 2, height: 22)
            .opacity(!active || Int(context.date.timeIntervalSince1970 / 0.6).isMultiple(of: 2) ? 1 : 0)
        }.offset(x: 203, y: 169)
        VStack(alignment: .leading, spacing: 10) {
          ForEach(0..<2, id: \.self) { row in
            HStack(spacing: 8) {
              Text(row == 0 ? "Mood" : "Energy").font(Design.text(11)).frame(width: 48, alignment: .leading)
              ForEach(0..<(row == 0 ? 7 : 5), id: \.self) { _ in Circle().stroke(faint, lineWidth: 1).frame(width: 10, height: 10) }
            }
          }
        }.foregroundStyle(faint).opacity(0.55).offset(x: 24, y: 236)
        text("saved", Design.mono(10), faint, x: 278, y: 310, width: 60).tracking(0.6)
        caption(faint)
      }
    }
  }

  var gym: some View {
    let ink = palette.color(0xf1f0eb, 0x1a1918)
    let dim = palette.color(0xb6b5af, 0x4c4744)
    let faint = palette.color(0x727771, 0x625c58)
    let onAccent = palette.dark ? Color(hex: 0x1b1408) : .white
    return card(palette.color(0x0b1111, 0xebe7e3), palette.color(0x2a3133, 0xd0cac5)) {
      ZStack(alignment: .topLeading) {
        text("Squat", Design.title(22), ink, x: 20, y: 18)
        text("set 3 of 5", Design.mono(11), dim, x: 20, y: 48).tracking(0.4)
        text("1   ✓   100 kg × 5", Design.mono(12), dim, x: 28, y: 78)
        text("2   ✓   100 kg × 5", Design.mono(12), dim, x: 28, y: 100)
        RoundedRectangle(cornerRadius: 8).fill(palette.gym.opacity(palette.dark ? 0.16 : 0.12)).frame(width: 314, height: 26).offset(x: 20, y: 120)
        RoundedRectangle(cornerRadius: 2).fill(palette.gym).frame(width: 3, height: 26).offset(x: 20, y: 120)
        text("Set 3 · target 100 × 5", Design.mono(12), ink, x: 32, y: 125)
        text("100", Design.mono(72), ink, x: 18, y: 162, width: 160).tracking(-2)
        text("kg × 5", Design.mono(18), dim, x: 154, y: 208, width: 140)
        text("Last time · 97.5 kg × 5", Design.mono(11), faint, x: 20, y: 252).tracking(0.3)
        Text("Log set").font(Design.title(15)).foregroundStyle(onAccent).padding(.horizontal, 22).frame(height: 44).background(palette.gym, in: Capsule()).scaleEffect(press).offset(x: 237, y: 276)
        Circle().fill(palette.color(0x9aa859, 0x7d8c43)).frame(width: 22, height: 22)
          .overlay {
            if reduceMotion { Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(onAccent).opacity(check) }
            else {
              Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(onAccent)
                .mask { OnboardingCheck().trim(from: 0, to: check).stroke(.white, style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round)) }
            }
          }.offset(x: 20, y: 288)
        text("Set 3 logged", Design.mono(11), dim, x: 50, y: 291, width: 170).opacity(logged)
        caption(faint)
      }
    }
  }
}

struct OnboardingCheck: Shape {
  func path(in rect: CGRect) -> Path {
    Path { path in
      path.move(to: CGPoint(x: rect.minX, y: rect.midY))
      path.addLine(to: CGPoint(x: rect.width * 0.38, y: rect.height * 0.85))
      path.addLine(to: CGPoint(x: rect.maxX, y: rect.height * 0.15))
    }
  }
}
