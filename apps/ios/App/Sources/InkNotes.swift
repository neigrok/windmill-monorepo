import SwiftUI
import UIKit
import CoreText

struct InkNotes: View {
  let frames: [String: CGRect]
  let visible: Bool
  @Environment(\.dynamicTypeSize) var typeSize
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @ScaledMetric(relativeTo: .body) var handSize = JournalType.handSize
  @State var reveals = Array(repeating: 0.0, count: 6)
  @State var opacity = 0.0
  @State var liftBlur = 0.0
  var body: some View {
    GeometryReader { geo in
      if let date = frames["date"], let caret = frames["caret"] {
        let large = typeSize.isAccessibilitySize
        let compact = geo.size.height < 700
        let fontSize = min(40, handSize)
        let dateLabel = CGPoint(x: geo.size.width * (large ? 0.5 : 0.64), y: max(compact && !large ? 160 : 200, date.minY - (large ? 235 : compact ? 190 : 242)))
        let typingLabel = CGPoint(x: 30, y: max(compact && !large ? 210 : 190, caret.minY - (large ? 185 : compact ? 105 : 145)))
        let typingText = large ? "Just start\ntyping" : "Just start typing"
        let typingFrame = labelFrame(typingText, at: typingLabel, size: fontSize, in: geo.size)
        let dateFrame = labelFrame("Today’s page", at: CGPoint(x: dateLabel.x - 45, y: dateLabel.y), size: fontSize, in: geo.size)
        let title = frames["title"] ?? .zero
        let titleLabel = CGPoint(x: geo.size.width * 0.38, y: title.maxY + 40)
        let titleFrame = labelFrame("Your journal", at: titleLabel, size: fontSize, in: geo.size)
        let you = frames["you"] ?? .zero
        let youSize = labelFrame("You, and settings", at: CGPoint(x: geo.size.width * 0.50, y: 0), size: fontSize, in: geo.size).size
        let youLabel = CGPoint(x: geo.size.width * 0.50, y: max(you.maxY + 16, min(you.maxY + (compact ? 76 : 113), dateFrame.minY - youSize.height - 12)))
        let youFrame = CGRect(origin: youLabel, size: youSize)
        let write = frames["write"] ?? .zero
        let writeSize = labelFrame("Tap to write", at: CGPoint(x: 24, y: 0), size: fontSize, in: geo.size).size
        let writeLabel = CGPoint(x: max(24, write.minX - writeSize.width - 38), y: write.midY - writeSize.height / 2)
        let writeFrame = CGRect(origin: writeLabel, size: writeSize)
        let bounds = CGRect(origin: .zero, size: geo.size).insetBy(dx: 12, dy: 8)
        let primaryFrames = [typingFrame, dateFrame]
        let showWrite = !large && frames["write"] != nil && fits(writeFrame, in: bounds, avoiding: primaryFrames)
        let showYou = showWrite && frames["you"] != nil && fits(youFrame, in: bounds, avoiding: primaryFrames + [writeFrame])
        let showTitle = showYou && frames["title"] != nil && fits(titleFrame, in: bounds, avoiding: primaryFrames + [youFrame, writeFrame])
        let savingSize = min(40, fontSize * 5 / 6)
        let savingLabel = CGPoint(x: dateLabel.x - 40, y: dateFrame.maxY + 6)
        let savingFrame = labelFrame("Saves as you go.", at: savingLabel, size: savingSize, in: geo.size)
        let showSaving = !large && !compact && fits(savingFrame, in: bounds, avoiding: [dateFrame, typingFrame, titleFrame, youFrame, writeFrame])
        if !dateFrame.isEmpty && fits(typingFrame, in: bounds, avoiding: [dateFrame]) && typingFrame.maxY < caret.minY {
        ZStack(alignment: .topLeading) {
          if showTitle {
            note("Your journal", at: titleLabel, size: fontSize, index: 0, in: geo.size)
            stroke(index: 0) { p in
              let tip = CGPoint(x: title.midX, y: title.maxY + 10)
              p.move(to: CGPoint(x: geo.size.width * 0.37, y: title.maxY + 59))
              p.addCurve(to: CGPoint(x: tip.x + 9, y: tip.y + 33), control1: CGPoint(x: tip.x + 30, y: tip.y + 95), control2: CGPoint(x: tip.x - 1, y: tip.y + 52))
              p.addCurve(to: CGPoint(x: tip.x + 28, y: tip.y + 16), control1: CGPoint(x: tip.x + 33, y: tip.y + 24), control2: CGPoint(x: tip.x + 33, y: tip.y + 2))
              p.addCurve(to: tip, control1: CGPoint(x: tip.x + 4, y: tip.y - 4), control2: CGPoint(x: tip.x - 5, y: tip.y + 61))
              arrow(&p, tip, dx: 0, dy: -1)
            }
          }
          if showYou {
            note("You, and settings", at: youLabel, size: fontSize, index: 1, in: geo.size)
            stroke(index: 1) { p in
              let tip = CGPoint(x: you.midX, y: you.maxY + 10)
              p.move(to: CGPoint(x: geo.size.width * 0.75, y: youLabel.y - 3))
              p.addCurve(to: tip, control1: CGPoint(x: you.midX, y: youLabel.y - 13), control2: CGPoint(x: you.midX + 5, y: you.maxY + 42))
              arrow(&p, tip, dx: 0, dy: -1)
            }
          }
          note("Today’s page", at: dateFrame.origin, size: fontSize, index: 2, in: geo.size)
          if showSaving { note("Saves as you go.", at: savingLabel, size: savingSize, index: 2, in: geo.size, dim: true) }
          stroke(index: 2) { p in
            let start = CGPoint(x: dateLabel.x, y: (showSaving ? savingFrame.maxY : dateFrame.maxY) + 4)
            let tip = CGPoint(x: date.maxX + 10, y: date.midY)
            p.move(to: start)
            p.addCurve(to: tip, control1: CGPoint(x: start.x + 73, y: start.y + 139), control2: CGPoint(x: start.x + 12, y: date.minY - 12))
            arrow(&p, tip, dx: -1, dy: 0)
          }
          note(typingText, at: typingLabel, size: fontSize, index: 3, in: geo.size)
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
          if showWrite {
            note("Tap to write", at: writeLabel, size: fontSize, index: 5, in: geo.size)
            stroke(index: 5) { p in
              let tip = CGPoint(x: write.minX - 8, y: write.midY)
              p.move(to: CGPoint(x: writeFrame.maxX + 6, y: write.midY + 9))
              p.addQuadCurve(to: tip, control: CGPoint(x: tip.x - 17, y: tip.y + 15))
              arrow(&p, tip, dx: 1, dy: 0)
            }
          }
        }.opacity(opacity).blur(radius: reduceMotion ? 0 : liftBlur)
        }
      }
    }.allowsHitTesting(false).accessibilityElement(children: .ignore).accessibilityHidden(true)
      .task(id: visible) {
        if !visible {
          withAnimation(.easeOut(duration: 0.36)) { opacity = 0; liftBlur = reduceMotion ? 0 : 3 }; return
        }
        reveals = Array(repeating: reduceMotion ? 1 : 0, count: 6)
        liftBlur = 0
        withAnimation(.easeOut(duration: reduceMotion ? 0.2 : 0)) { opacity = 1 }
        if reduceMotion { return }
        for index in 0..<6 {
          try? await Task.sleep(for: .milliseconds(index == 0 ? 200 : 150))
          guard !Task.isCancelled else { return }
          withAnimation(.easeOut(duration: 0.32)) { reveals[index] = 1 }
        }
      }
  }

  func labelWidth(at point: CGPoint, in screen: CGSize) -> CGFloat {
    max(1, min(screen.width * 0.6, screen.width - point.x - 16))
  }

  func labelFrame(_ text: String, at point: CGPoint, size: CGFloat, in screen: CGSize) -> CGRect {
    CGRect(origin: point, size: InkLabel.textSize(text, size: size, width: labelWidth(at: point, in: screen)))
  }

  func fits(_ frame: CGRect, in bounds: CGRect, avoiding others: [CGRect]) -> Bool {
    !frame.isEmpty && bounds.contains(frame) && !others.contains { $0.insetBy(dx: -6, dy: -6).intersects(frame) }
  }

  func note(_ text: String, at point: CGPoint, size: CGFloat, index: Int, in screen: CGSize, dim: Bool = false) -> some View {
    InkLabel(text: text, size: size, width: labelWidth(at: point, in: screen), index: index, dim: dim, visible: visible)
      .offset(x: point.x, y: point.y).accessibilityHidden(true)
  }

  func stroke(index: Int, _ draw: (inout Path) -> Void) -> some View {
    var path = Path(); draw(&path)
    return path.trim(from: 0, to: reveals[index]).stroke(JournalPalette.lamp, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
  }

  func arrow(_ path: inout Path, _ tip: CGPoint, dx: CGFloat, dy: CGFloat) {
    path.move(to: CGPoint(x: tip.x - dx * 8 - dy * 4, y: tip.y - dy * 8 + dx * 4))
    path.addLine(to: tip)
    path.addLine(to: CGPoint(x: tip.x - dx * 8 + dy * 4, y: tip.y - dy * 8 - dx * 4))
  }
}

struct InkLabel: View {
  let text: String
  let size: CGFloat
  let width: CGFloat
  let index: Int
  let dim: Bool
  let visible: Bool
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @State var shown = false
  static func textSize(_ text: String, size: CGFloat, width: CGFloat) -> CGSize {
    let font = JournalType.handFont(size: size) as CTFont
    let setter = CTFramesetterCreateWithAttributedString(NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
    let bounds = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(), nil,
      CGSize(width: max(1, width - size / 2), height: .greatestFiniteMagnitude), nil)
    let path = CGPath(rect: CGRect(x: 0, y: 0, width: max(1, width - size / 2), height: ceil(bounds.height)), transform: nil)
    guard CFArrayGetCount(CTFrameGetLines(CTFramesetterCreateFrame(setter, CFRange(), path, nil))) <= 2 else { return .zero }
    return CGSize(width: ceil(bounds.width) + size / 2, height: ceil(bounds.height) + size / 4)
  }
  var lettering: some View {
    let measured = Self.textSize(text, size: size, width: width)
    let font = JournalType.handFont(size: size) as CTFont
    let setter = CTFramesetterCreateWithAttributedString(NSAttributedString(string: text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): UIColor(dim ? JournalPalette.inkDim : JournalPalette.lamp).cgColor,
    ]))
    // CoreText preserves Caveat's overhang when native Text is rasterized.
    return Canvas { context, _ in
      context.withCGContext { cg in
        cg.textMatrix = .identity
        cg.translateBy(x: 0, y: measured.height)
        cg.scaleBy(x: 1, y: -1)
        let path = CGPath(rect: CGRect(x: size / 4, y: size / 8,
          width: max(1, width - size / 2), height: measured.height - size / 4), transform: nil)
        CTFrameDraw(CTFramesetterCreateFrame(setter, CFRange(), path, nil), cg)
      }
    }.frame(width: measured.width, height: measured.height)
  }
  var body: some View {
    lettering.opacity(shown ? 1 : 0).task(id: visible) {
        guard visible else { withAnimation(.easeOut(duration: 0.18)) { shown = false }; return }
        if !reduceMotion {
          try? await Task.sleep(for: .milliseconds(520 + index * 150))
          guard !Task.isCancelled else { return }
        }
        withAnimation(.easeOut(duration: reduceMotion ? 0.2 : 0.16)) { shown = true }
      }
  }
}
