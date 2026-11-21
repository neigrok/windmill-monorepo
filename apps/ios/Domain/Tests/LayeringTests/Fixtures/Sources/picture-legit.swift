// module: RoadmapLayout
// expect: pass
struct Seat: Hashable {
  let x: Double
  let y: Double
  func hash(into hasher: inout Hasher) { hasher.combine(x) }
}
let ring = (56 * 2.8).squareRoot().rounded(.down)
let imported = "import Foundation"
