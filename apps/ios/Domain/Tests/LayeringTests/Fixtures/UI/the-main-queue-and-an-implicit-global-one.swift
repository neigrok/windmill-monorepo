// expect: 11: dispatch-queue .global(…)
import Dispatch
import SwiftUI

// The main queue's closures are main-actor code; a coordinate space named `.global` is no queue; an implicit global queue is.
final class MainQueueModel {
  let group = DispatchGroup()
  func paused() { DispatchQueue.main.async {} }
  func later() { DispatchQueue.main.asyncAfter(deadline: .now() + 1) {} }
  func frame(_ geometry: GeometryProxy) -> CGRect { geometry.frame(in: .global) }
  func notify() { group.notify(queue: .global()) {} }
}
