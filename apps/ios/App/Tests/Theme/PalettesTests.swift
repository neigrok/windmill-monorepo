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
  // WCAG 2 contrast of two opaque colours in one appearance.
  func contrast(_ text: Color, on fill: Color, _ style: UIUserInterfaceStyle) -> Double {
    func luminance(_ color: Color) -> Double {
      var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
      UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
      let linear = [red, green, blue].map { $0 <= 0.04045 ? Double($0) / 12.92 : pow((Double($0) + 0.055) / 1.055, 2.4) }
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }
    let lighter = max(luminance(text), luminance(fill)), darker = min(luminance(text), luminance(fill))
    return (lighter + 0.05) / (darker + 0.05)
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

  // A room's primary — the band's button, a sheet's checkmark — draws on-accent on the accent fill, which reads at 4.5:1 or
  // more in both appearances.
  @Test @MainActor func primaryLabelsReadOnTheirFillInBothAppearances() {
    let rooms: [(String, RoomColors)] = [("gym", .gym), ("shell", .shell), ("journal", .journal)]
    let table = rooms.flatMap { name, room in
      [("dark", UIUserInterfaceStyle.dark), ("light", .light)].map { look, style in
        "\(name) \(look) \(String(format: "%.1f", contrast(room.onAccent, on: room.accent, style)))"
      }
    }
    #expect(table == ["gym dark 9.5", "gym light 6.4", "shell dark 6.5", "shell light 5.2", "journal dark 10.4", "journal light 4.8"])
    #expect(rooms.allSatisfy { _, room in [.dark, .light].allSatisfy { contrast(room.onAccent, on: room.accent, $0) >= 4.5 } })
  }
}
