import SwiftUI
import UIKit

// Figma iOS first-run tokens.
enum Design {
  static let canvas = Color(hex: 0x0b0e16)
  static let shell = Color(hex: 0x0b0b0c)
  static let ink = Color(hex: 0xf1f0ec)
  static let dim = Color(hex: 0xb6b5b0)
  static let faint = Color(hex: 0x737476)
  static let line = Color(hex: 0x20232b)
  static let lamp = Color(hex: 0xe0b972)
  static let mood = Color(hex: 0xc9a75f)
  static let moodRamp: [UInt32] = [0x5e4d2e, 0x6e5a34, 0x7f673a, 0x8f7440, 0xa08247, 0xb08f4e, 0xbd9b57, 0xc9a75f, 0xd5b069, 0xe0b972, 0xecc27c]
  static let energy = Color(hex: 0x9aa859)
  static let brand = Color(hex: 0xd08a5e)
  static let card = Color(hex: 0x171719)
  static func text(_ size: CGFloat = 16) -> Font { .custom("Inter-Regular", size: size, relativeTo: .body) }
  static func strong(_ size: CGFloat = 16) -> Font { .custom("Inter-SemiBold", size: size, relativeTo: .body) }
  static func title(_ size: CGFloat = 28) -> Font { .custom("Nunito-ExtraBold", size: size, relativeTo: .title) }
  static func mono(_ size: CGFloat = 11) -> Font { .custom("JetBrainsMono-Regular", size: size, relativeTo: .caption) }
  static func hand(_ size: CGFloat = 24) -> Font { .custom("Caveat-Regular", size: size, relativeTo: .body) }
}

extension Color {
  init(hex: UInt32) { self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1) }
}

struct Glass: ViewModifier {
  var capsule = true
  func body(content: Content) -> some View {
    content.background(.white.opacity(0.10), in: capsule ? AnyShape(Capsule()) : AnyShape(Circle()))
      .overlay { (capsule ? AnyShape(Capsule()) : AnyShape(Circle())).stroke(.white.opacity(0.18), lineWidth: 0.7) }
  }
}

struct JournalBackdrop: View {
  var body: some View {
    GeometryReader { proxy in
      ZStack {
        Design.canvas
        RadialGradient(colors: [Design.lamp.opacity(0.09), .clear], center: .init(x: 0.5, y: 1.12), startRadius: 0, endRadius: proxy.size.width * 0.85)
      }
    }.ignoresSafeArea()
  }
}

struct YouGlyph: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    path.addEllipse(in: CGRect(x: 0.8, y: 0.8, width: 16.4, height: 16.4))
    path.addEllipse(in: CGRect(x: 6, y: 3.5, width: 6, height: 6))
    path.move(to: CGPoint(x: 3.7, y: 15))
    path.addCurve(to: CGPoint(x: 14.3, y: 15), control1: CGPoint(x: 4.1, y: 10.1), control2: CGPoint(x: 13.9, y: 10.1))
    return path.applying(CGAffineTransform(scaleX: rect.width / 18, y: rect.height / 18))
  }
}

extension View {
  func inkAnchor(_ name: String, enabled: Bool, frames: Binding<[String: CGRect]>) -> some View {
    onGeometryChange(for: CGRect.self) { geometry in
      enabled ? geometry.frame(in: .global) : .zero
    } action: { frame in
      if enabled { frames.wrappedValue[name] = frame }
    }
  }
}

struct ScaleRow: View {
  let name: String
  let value: Int?
  let set: (Int?) -> Void
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @ScaledMetric(relativeTo: .caption) var labelWidth = 50.0
  var color: Color { name == "Mood" ? Color(hex: Design.moodRamp[min(10, max(0, value ?? 7))]) : Design.energy }
  var body: some View {
    HStack(spacing: 14) {
      Text(name.uppercased()).font(Design.mono(9)).tracking(1).foregroundStyle(Design.dim).fixedSize().frame(width: labelWidth, alignment: .leading)
      GeometryReader { geo in
        let travel = max(1, geo.size.width - 18)
        let offset = CGFloat(value ?? 0) / 10 * travel
        ZStack(alignment: .leading) {
          Capsule().fill(Design.line).frame(height: 3)
          ForEach(0...10, id: \.self) { index in
            Circle().fill(Design.faint).frame(width: 2.5, height: 2.5).offset(x: CGFloat(index) / 10 * travel + 8)
          }
          Capsule().fill(color).frame(width: value == nil || value == 0 ? 0 : offset + 8, height: 4)
          if value == 10 && name == "Energy" {
            Capsule().fill(LinearGradient(colors: [.clear, Design.ink.opacity(0.28), .clear], startPoint: .top, endPoint: .bottom)).frame(width: offset + 8, height: 4)
          }
          if value == 0 && name == "Energy" { Rectangle().fill(color).frame(height: 1).offset(y: 7) }
          if name == "Mood" {
            Circle().fill(value == nil ? Design.canvas : color)
              .overlay(Circle().stroke(value == nil ? Design.faint : Design.ink.opacity(0.78), lineWidth: 1.3))
              .frame(width: value == nil ? 12 : 16, height: value == nil ? 12 : 16)
              .shadow(color: value == nil ? .clear : color.opacity(value == 10 ? 0.78 : 0.45), radius: value == 10 ? 6 : 4).offset(x: offset)
          } else {
            Capsule().fill(value == nil ? Design.canvas : color)
              .overlay(Capsule().stroke(value == nil ? Design.faint : Design.ink.opacity(0.78), lineWidth: 1.3))
              .frame(width: value == nil ? 5 : 8, height: value == nil ? 13 : 18)
              .shadow(color: value == nil ? .clear : color.opacity(value == 10 ? 0.78 : 0.45), radius: value == 10 ? 6 : 4).offset(x: offset + 5)
          }
          if value == 0 && name == "Mood" { Circle().stroke(Design.ink.opacity(0.78), lineWidth: 1).frame(width: 28, height: 28).offset(x: offset - 6) }
        }.frame(height: 44).contentShape(Rectangle())
          .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
            let next = min(10, max(0, Int(((gesture.location.x - 9) / travel * 10).rounded())))
            if next != value { set(next) }
          })
      }.frame(height: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
        .accessibilityValue(value.map { "\($0) of 10" } ?? "Not answered")
        .accessibilityAdjustableAction { direction in
          set(min(10, max(0, (value ?? 0) + (direction == .increment ? 1 : -1))))
        }
        .accessibilityAction(named: "Clear \(name.lowercased())") { set(nil) }
      Button { set(nil) } label: {
        Text(value.map(String.init) ?? "–").font(Design.strong(14)).foregroundStyle(value == nil ? Design.faint : Design.ink).frame(width: 44, height: 44)
      }.buttonStyle(.plain).accessibilityLabel("Clear \(name.lowercased())").disabled(value == nil)
    }.sensoryFeedback(trigger: value) { _, next in
      guard let next else { return nil }
      return .impact(weight: .light, intensity: 0.25 + Double(abs(next - 5)) / 5 * 0.5)
    }
  }
}
