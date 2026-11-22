import Foundation
import QuartzCore
import SwiftUI

// What the Board measures of itself against §5's budget (Roadmap on iOS §5: a roadmap's first frame under a second, and
// 60 frames a second), on a simulator launch that names a file for its measures: the time from the tap that showed the
// Board to its first frame, and the frames the main actor is given while the list scrolls, from a finger's first move to
// the list at rest, as the display's own link sees them (`GraphFrames`). Where no launch asks for them nothing is
// measured, and nothing is reported: §11 reports the Graph's budget alone.
@MainActor
final class BoardFrames {
  enum Measure: Equatable, Sendable {
    // From the tap that made the Board the room's view to the first frame that draws it.
    case firstFrame(ms: Double, steps: Int)
    // The gaps between the frames a scroll was given, and how long the main actor worked in each.
    case frames(gapsMs: [Double], workMs: [Double], steps: Int)
  }

  // Where each measure goes: the benchmark's file.
  let measured: ((Measure) -> Void)?
  let now: () -> TimeInterval
  let frames = GraphFrames()
  // The tap the next first frame is timed from.
  var opening: TimeInterval?
  var scrolling = false

  init(measured: ((Measure) -> Void)? = nil, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
    self.measured = measured
    self.now = now
  }

  // The switch made the Board the room's view: its first frame is timed from here.
  func opened() {
    guard measured != nil else { return }
    opening = now()
  }

  // The Board's list came on screen: the display's next frame is the first that draws it.
  func appeared(steps: Int) {
    guard let measured, let opening, !scrolling else { return }
    self.opening = nil
    frames.each = { [weak self] in
      guard let self else { return }
      _ = self.frames.end()
      self.frames.each = nil
      measured(.firstFrame(ms: (self.now() - opening) * 1_000, steps: steps))
    }
    frames.begin()
  }

  // The list began to move, or came to rest: the frames between are one scroll's.
  func scroll(moving: Bool, steps: Int) {
    guard let measured, moving != scrolling else { return }
    scrolling = moving
    guard !moving else {
      frames.each = nil
      frames.begin()
      return
    }
    let (gaps, work) = frames.end()
    if !gaps.isEmpty { measured(.frames(gapsMs: gaps, workMs: work, steps: steps)) }
  }
}
