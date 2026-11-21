// Which layout seats a roadmap, and the fallback: the web's `layout/index.js` and `layout/LayoutEngine.js`.

public enum LayoutName: String, Sendable {
  case bubble
  case radial
}

// An engine seats every step of a tree: one point for each, in the steps' order, in world units with y down.
public protocol LayoutEngine: Sendable {
  var name: LayoutName { get }

  func layout(_ tree: SkillTree) throws -> [Point]
}

// A roadmap's seats and the layout that gave them. The bubble layout is the normal one; a roadmap whose layout throws is
// seated by the radial one, whose angles lie within one turn.
public struct Seating: Sendable {
  public let engine: LayoutName
  public let seats: [Point]

  public init(of tree: SkillTree, by engine: any LayoutEngine = BubbleLayoutEngine()) throws {
    do {
      seats = try engine.layout(tree)
      self.engine = engine.name
    } catch {
      let fallback = RadialLayoutEngine()
      seats = try fallback.layout(tree)
      self.engine = fallback.name
    }
  }
}
