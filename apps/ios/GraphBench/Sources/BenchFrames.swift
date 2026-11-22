import Foundation
import QuartzCore

// The frames one stretch of the script was given, as the display's own link saw them: the room's `GraphFrames`
// (`RoadmapGraph.swift`) with the script's hand on each tick where the room has a finger's. Of each frame it keeps the
// wait for the next one, which a frame that held the main actor too long makes a late one; how long the tick's handler
// took, which is the camera moved and the captions placed; how long the canvas's draw closure took; and how long the
// main actor worked in all, from its run loop waking to its resting again, its commit to the screen included.
@MainActor
final class BenchFrames: NSObject {
  // A stretch's frames, each list in their order, in milliseconds.
  struct Stretch {
    let gapsMs: [Double]
    let tickMs: [Double]
    let drawMs: [Double]
    let workMs: [Double]
    // How many times the canvas drew.
    let draws: Int
    // The rate the link was ticking at when the stretch ended.
    let linkHz: Double
  }

  // What the canvas's draw closure took since the last tick and how often it ran, and the moment it first drew.
  var drawn = (ms: 0.0, draws: 0)
  var first: CFTimeInterval?
  var link: CADisplayLink?
  var watching: [CFRunLoopObserver] = []
  var move: ((TimeInterval) -> Bool)?
  var ended: CheckedContinuation<Stretch, Never>?
  var stamps: [CFTimeInterval] = []
  var ticks: [Double] = []
  var drawnEach: [(ms: Double, draws: Int)] = []
  var work: [Double] = []
  var woke: CFTimeInterval?
  var worked = 0.0

  // Runs the link until `move` says the stretch is over. Each frame `move` is given the seconds since the stretch's
  // first frame, and moves the camera to where a finger would have brought it by then.
  func drive(_ move: @escaping (TimeInterval) -> Bool) async -> Stretch {
    await withCheckedContinuation { (ended: CheckedContinuation<Stretch, Never>) in
      (self.move, self.ended) = (move, ended)
      (stamps, ticks, drawnEach, work, worked, woke) = ([], [], [], [], 0, CACurrentMediaTime())
      link = CADisplayLink(target: self, selector: #selector(tick))
      link?.add(to: .main, forMode: .common)
      // The run loop is seen waking before anything else is, and resting after everything else has, the commit too.
      let waking = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue, true, .min) { [weak self] _, _ in
        MainActor.assumeIsolated { self?.woke = CACurrentMediaTime() }
      }
      let resting = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, .max) { [weak self] _, _ in
        MainActor.assumeIsolated {
          guard let self, let woke = self.woke else { return }
          (self.worked, self.woke) = (self.worked + (CACurrentMediaTime() - woke) * 1_000, nil)
        }
      }
      watching = [waking, resting].compactMap { $0 }
      for observer in watching { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
    }
  }

  @objc func tick(_ link: CADisplayLink) {
    let began = CACurrentMediaTime()
    stamps.append(link.timestamp)
    work.append(worked)
    worked = 0
    drawnEach.append(drawn)
    drawn = (0, 0)
    let moving = move?(link.timestamp - stamps[0]) ?? false
    ticks.append((CACurrentMediaTime() - began) * 1_000)
    guard !moving else { return }
    link.invalidate()
    self.link = nil
    for observer in watching { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
    watching = []
    // A frame's draw and its work are read at the tick after it, and its gap is the wait for that tick. The last tick
    // moved nothing and is no frame of the stretch.
    let later = drawnEach.dropFirst()
    ended?.resume(returning: Stretch(
      gapsMs: zip(stamps.dropFirst(), stamps).map { ($0 - $1) * 1_000 }, tickMs: Array(ticks.dropLast()), drawMs: later.map(\.ms),
      workMs: Array(work.dropFirst()), draws: later.reduce(0) { $0 + $1.draws }, linkHz: 1 / (link.targetTimestamp - link.timestamp)))
    (move, ended) = (nil, nil)
  }

  // One draw of the picture, which began at `began` and has just ended.
  func drew(since began: CFTimeInterval) {
    let ended = CACurrentMediaTime()
    drawn = (drawn.ms + (ended - began) * 1_000, drawn.draws + 1)
    first = first ?? ended
  }
}
