import SwiftUI

struct InkNotes: View {
  let frames: [String: CGRect]
  let visible: Bool
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @ScaledMetric(relativeTo: .body) var handSize = 24.0
  @State var reveals = Array(repeating: 0.0, count: 5)
  @State var opacity = 0.0
  @State var liftBlur = 0.0
  var body: some View {
    GeometryReader { geo in
      if let date = frames["date"], let caret = frames["caret"] {
        let large = typeSize.isAccessibilitySize
        let fontSize = min(40, handSize)
        let dateLabel = CGPoint(x: geo.size.width * (large ? 0.5 : 0.64), y: max(200, date.minY - (large ? 235 : 242)))
        let typingLabel = CGPoint(x: 30, y: max(190, caret.minY - (large ? 185 : 145)))
        ZStack(alignment: .topLeading) {
          if !large, let room = frames["room"], let you = frames["you"] {
            note("Switch rooms here", at: CGPoint(x: geo.size.width * 0.38, y: room.maxY + 40), size: fontSize, index: 0)
            stroke(index: 0) { p in
              let tip = CGPoint(x: room.midX - 12, y: room.maxY + 10)
              p.move(to: CGPoint(x: geo.size.width * 0.37, y: room.maxY + 59))
              p.addCurve(to: CGPoint(x: tip.x + 9, y: tip.y + 33), control1: CGPoint(x: tip.x + 30, y: tip.y + 95), control2: CGPoint(x: tip.x - 1, y: tip.y + 52))
              p.addCurve(to: CGPoint(x: tip.x + 28, y: tip.y + 16), control1: CGPoint(x: tip.x + 33, y: tip.y + 24), control2: CGPoint(x: tip.x + 33, y: tip.y + 2))
              p.addCurve(to: tip, control1: CGPoint(x: tip.x + 4, y: tip.y - 4), control2: CGPoint(x: tip.x - 5, y: tip.y + 61))
              arrow(&p, tip, dx: 0, dy: -1)
            }
            note("You, and settings", at: CGPoint(x: geo.size.width * 0.50, y: you.maxY + 113), size: fontSize, index: 1)
            stroke(index: 1) { p in
              let tip = CGPoint(x: you.midX, y: you.maxY + 10)
              p.move(to: CGPoint(x: geo.size.width * 0.75, y: you.maxY + 110))
              p.addCurve(to: tip, control1: CGPoint(x: you.midX, y: you.maxY + 100), control2: CGPoint(x: you.midX + 5, y: you.maxY + 42))
              arrow(&p, tip, dx: 0, dy: -1)
            }
          }
          note("Today’s page", at: CGPoint(x: dateLabel.x - 45, y: dateLabel.y), size: fontSize, index: 2)
          if !large { note("Saves as you go.", at: CGPoint(x: dateLabel.x - 40, y: dateLabel.y + 30), size: 20, index: 2, dim: true) }
          stroke(index: 2) { p in
            let start = CGPoint(x: dateLabel.x, y: dateLabel.y + (large ? 44 : 57))
            let tip = CGPoint(x: date.maxX + 10, y: date.midY)
            p.move(to: start)
            p.addCurve(to: tip, control1: CGPoint(x: start.x + 73, y: start.y + 139), control2: CGPoint(x: start.x + 12, y: date.minY - 12))
            arrow(&p, tip, dx: -1, dy: 0)
          }
          note(large ? "Just start\ntyping" : "Just start typing", at: typingLabel, size: fontSize, index: 3)
          stroke(index: 3) { p in
            let tip = CGPoint(x: caret.minX - 5, y: caret.minY + min(22, caret.height / 2))
            p.move(to: CGPoint(x: typingLabel.x + 17, y: typingLabel.y + (large ? 86 : 33)))
            p.addCurve(to: tip, control1: CGPoint(x: 0, y: typingLabel.y + 75), control2: CGPoint(x: 4, y: caret.minY - 18))
            arrow(&p, tip, dx: 1, dy: 0)
          }
          if let privacy = frames["privacy"] {
            stroke(index: 4) { p in
              p.move(to: CGPoint(x: privacy.minX, y: privacy.minY + min(privacy.height, large ? 43 : 19)))
              p.addQuadCurve(to: CGPoint(x: privacy.minX + (large ? 117 : 60), y: privacy.minY + min(privacy.height, large ? 43 : 19) - 2), control: CGPoint(x: privacy.minX + 33, y: privacy.minY + min(privacy.height, large ? 43 : 19) + 3))
            }
          }
        }.opacity(opacity).blur(radius: reduceMotion ? 0 : liftBlur)
      }
    }.allowsHitTesting(false).accessibilityElement(children: .ignore).accessibilityHidden(true)
      .task(id: visible) {
        if !visible {
          withAnimation(.easeOut(duration: 0.36)) { opacity = 0; liftBlur = reduceMotion ? 0 : 3 }; return
        }
        reveals = Array(repeating: reduceMotion ? 1 : 0, count: 5)
        liftBlur = 0
        withAnimation(.easeOut(duration: reduceMotion ? 0.2 : 0)) { opacity = 1 }
        if reduceMotion { return }
        for index in 0..<5 {
          try? await Task.sleep(for: .milliseconds(index == 0 ? 200 : 150))
          guard !Task.isCancelled else { return }
          withAnimation(.easeOut(duration: 0.32)) { reveals[index] = 1 }
        }
      }
  }

  func note(_ text: String, at point: CGPoint, size: CGFloat, index: Int, dim: Bool = false) -> some View {
    InkLabel(text: text, size: size, index: index, dim: dim, visible: visible)
      .offset(x: point.x, y: point.y).accessibilityHidden(true)
  }

  func stroke(index: Int, _ draw: (inout Path) -> Void) -> some View {
    var path = Path(); draw(&path)
    return path.trim(from: 0, to: reveals[index]).stroke(Design.lamp, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
  }

  func arrow(_ path: inout Path, _ tip: CGPoint, dx: CGFloat, dy: CGFloat) {
    path.move(to: CGPoint(x: tip.x - dx * 8 - dy * 4, y: tip.y - dy * 8 + dx * 4))
    path.addLine(to: tip)
    path.addLine(to: CGPoint(x: tip.x - dx * 8 + dy * 4, y: tip.y - dy * 8 - dx * 4))
  }
}

private struct InkLabel: View {
  let text: String
  let size: CGFloat
  let index: Int
  let dim: Bool
  let visible: Bool
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @State var shown = false
  var body: some View {
    Text(text).font(.custom("Caveat-Regular", fixedSize: size)).foregroundStyle(dim ? Design.dim : Design.lamp)
      .fixedSize(horizontal: false, vertical: true).frame(maxWidth: 230, alignment: .leading)
      .opacity(shown ? 1 : 0).task(id: visible) {
        guard visible else { withAnimation(.easeOut(duration: 0.18)) { shown = false }; return }
        if !reduceMotion {
          try? await Task.sleep(for: .milliseconds(520 + index * 150))
          guard !Task.isCancelled else { return }
        }
        withAnimation(.easeOut(duration: reduceMotion ? 0.2 : 0.16)) { shown = true }
      }
  }
}
