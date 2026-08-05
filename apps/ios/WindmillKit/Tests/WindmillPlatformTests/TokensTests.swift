import SwiftUI
import UIKit
import XCTest
@testable import WindmillPlatform

// The gold capsule is the only place the brand puts a label on a bright fill, and the ink on it is
// the one colour in the file that must NOT follow the appearance: the adaptive ramp's dark end is a
// warm near-white, which on gold is 1.77:1 — a primary button that is simply not there. Every gold
// capsule in the app carried exactly that until this wave, so the ink is pinned here.
//
// The bar is 4.5:1, WCAG AA for body text, not the 3:1 large-text allowance: these labels are 15 and
// 16pt semibold, and large starts at 18pt (or 14pt bold).

final class TokensTests: XCTestCase {
    func testTheInkOnGoldIsReadableInBothAppearances() {
        XCTAssertGreaterThanOrEqual(contrast(WindmillColor.onAccent, on: WindmillColor.gold400, in: .light), 4.5)
        XCTAssertGreaterThanOrEqual(contrast(WindmillColor.onAccent, on: WindmillColor.gold400, in: .dark), 4.5)
    }

    // The fill is the same gold in both skins, so an ink that answers the traits is wrong even when
    // both of its answers happen to pass: it would be reading a question the fill never asked.
    func testTheInkOnGoldIsFixedRatherThanAdaptive() {
        XCTAssertEqual(channels(WindmillColor.onAccent, .light), channels(WindmillColor.onAccent, .dark))
        XCTAssertEqual(channels(WindmillColor.gold400, .light), channels(WindmillColor.gold400, .dark))
    }

    // The defect itself, kept executable: textPrimary is the obvious thing to reach for on any label,
    // it passes in light, and it is unreadable in dark. If the dark ramp is ever re-authored, this
    // fails and whoever did it reads the two tests above before putting the token back on a capsule.
    func testTheAdaptiveRampCannotStandInForIt() {
        XCTAssertGreaterThanOrEqual(contrast(WindmillColor.textPrimary, on: WindmillColor.gold400, in: .light), 4.5)
        XCTAssertLessThan(contrast(WindmillColor.textPrimary, on: WindmillColor.gold400, in: .dark), 4.5)
    }

    private func contrast(_ ink: Color, on fill: Color, in style: UIUserInterfaceStyle) -> Double {
        let inkLuminance = luminance(channels(ink, style))
        let fillLuminance = luminance(channels(fill, style))
        return (max(inkLuminance, fillLuminance) + 0.05) / (min(inkLuminance, fillLuminance) + 0.05)
    }

    private func channels(_ color: Color, _ style: UIUserInterfaceStyle) -> [Double] {
        let resolved = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return [Double(red), Double(green), Double(blue)]
    }

    private func luminance(_ channels: [Double]) -> Double {
        let linear = channels.map { channel in
            channel <= 0.03928 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }
}
