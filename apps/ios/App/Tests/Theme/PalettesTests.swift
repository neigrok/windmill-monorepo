import SwiftUI
import UIKit
import Testing
@testable import Windmill

@Suite struct PalettesTests {
  func hex(_ color: Color, _ style: UIUserInterfaceStyle) -> String {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    let rgb = String(format: "#%02X%02X%02X", Int((red * 255).rounded()), Int((green * 255).rounded()), Int((blue * 255).rounded()))
    return alpha < 1 ? rgb + String(format: "@%.0f%%", alpha * 100) : rgb
  }

  // The 00.2 board and ios-redesign.md §2, role by role, Dark then Daylight.
  @Test func gymRolesResolveToTheirHexInBothAppearances() {
    let roles: [(String, Color)] = [
      ("canvas", GymPalette.canvas), ("card", GymPalette.card), ("line", GymPalette.line), ("ink", GymPalette.ink),
      ("ink-dim", GymPalette.inkDim), ("ink-faint", GymPalette.inkFaint), ("accent", GymPalette.accent),
      ("accent-soft", GymPalette.accentSoft), ("on-accent", GymPalette.onAccent), ("done", GymPalette.done),
      ("record", GymPalette.record), ("alarm", GymPalette.alarm),
    ]
    let table = roles.map { "gym/\($0.0) \(hex($0.1, .dark)) \(hex($0.1, .light))" }.joined(separator: "\n")
    #expect(table == """
      gym/canvas #0B1111 #EBE7E3
      gym/card #161C1D #F8F6F4
      gym/line #202627 #D0CAC5
      gym/ink #F1F0EB #1A1918
      gym/ink-dim #B6B5AF #4C4744
      gym/ink-faint #727771 #625C58
      gym/accent #5FCDB4 #106B5F
      gym/accent-soft #5FCDB4@16% #106B5F@12%
      gym/on-accent #1B1408 #FFFFFF
      gym/done #9AA859 #7D8C43
      gym/record #D9B04C #6E5217
      gym/alarm #D08268 #A84E35
      """)
  }
}
