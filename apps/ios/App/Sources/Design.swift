import SwiftUI
import UIKit

struct JournalBackdrop: View {
  var body: some View {
    GeometryReader { proxy in
      ZStack {
        JournalPalette.canvas
        RadialGradient(colors: [JournalPalette.lamp.opacity(0.09), .clear], center: .init(x: 0.5, y: 1.12), startRadius: 0, endRadius: proxy.size.width * 0.85)
      }
    }.ignoresSafeArea()
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
  @State var trackWidth: CGFloat = 0
  var color: Color { name == "Mood" ? JournalPalette.mood(value ?? 7) : JournalPalette.energy }
  var body: some View {
    let travel = max(1, trackWidth - 18)
    let offset = CGFloat(value ?? 0) / 10 * travel
    HStack(spacing: 14) {
      Text(name.uppercased()).font(ShellType.caption).foregroundStyle(JournalPalette.inkDim).fixedSize().frame(width: labelWidth, alignment: .leading)
      ZStack(alignment: .leading) {
        Capsule().fill(JournalPalette.line).frame(height: 3)
        ForEach(0...10, id: \.self) { index in
          Circle().fill(JournalPalette.inkFaint).frame(width: 2.5, height: 2.5).offset(x: CGFloat(index) / 10 * travel + 8)
        }
        Capsule().fill(color).frame(width: value == nil || value == 0 ? 0 : offset + 8, height: 4)
        if value == 10 && name == "Energy" {
          Capsule().fill(LinearGradient(colors: [.clear, JournalPalette.ink.opacity(0.28), .clear], startPoint: .top, endPoint: .bottom)).frame(width: offset + 8, height: 4)
        }
        if value == 0 && name == "Energy" { Rectangle().fill(color).frame(height: 1).offset(y: 7) }
        if name == "Mood" {
          Circle().fill(value == nil ? JournalPalette.canvas : color)
            .overlay(Circle().stroke(value == nil ? JournalPalette.inkFaint : JournalPalette.ink.opacity(0.78), lineWidth: 1.3))
            .frame(width: value == nil ? 12 : 16, height: value == nil ? 12 : 16)
            .shadow(color: value == nil ? .clear : color.opacity(value == 10 ? 0.78 : 0.45), radius: value == 10 ? 6 : 4).offset(x: offset)
        } else {
          Capsule().fill(value == nil ? JournalPalette.canvas : color)
            .overlay(Capsule().stroke(value == nil ? JournalPalette.inkFaint : JournalPalette.ink.opacity(0.78), lineWidth: 1.3))
            .frame(width: value == nil ? 5 : 8, height: value == nil ? 13 : 18)
            .shadow(color: value == nil ? .clear : color.opacity(value == 10 ? 0.78 : 0.45), radius: value == 10 ? 6 : 4).offset(x: offset + 5)
        }
        if value == 0 && name == "Mood" { Circle().stroke(JournalPalette.ink.opacity(0.78), lineWidth: 1).frame(width: 28, height: 28).offset(x: offset - 6) }
      }.frame(maxWidth: .infinity, minHeight: 44, maxHeight: 44, alignment: .leading).contentShape(Rectangle())
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { trackWidth = $0 }
        .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
          let next = min(10, max(0, Int(((gesture.location.x - 9) / travel * 10).rounded())))
          if next != value { set(next) }
        })
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(name)
      .accessibilityValue(value.map { "\($0) of 10" } ?? "Not answered")
      .accessibilityAdjustableAction { direction in
        set(min(10, max(0, (value ?? 0) + (direction == .increment ? 1 : -1))))
      }
      .accessibilityAction(named: "Clear \(name.lowercased())") { set(nil) }
      Button { set(nil) } label: {
        Text(value.map(String.init) ?? "–").font(ShellType.secondaryAction).monospacedDigit().foregroundStyle(value == nil ? JournalPalette.inkFaint : JournalPalette.ink).frame(width: 44, height: 44)
      }.buttonStyle(.plain).accessibilityLabel("Clear \(name.lowercased())").disabled(value == nil)
    }.sensoryFeedback(trigger: value) { _, next in
      guard let next else { return nil }
      return .impact(weight: .light, intensity: 0.25 + Double(abs(next - 5)) / 5 * 0.5)
    }
  }
}
