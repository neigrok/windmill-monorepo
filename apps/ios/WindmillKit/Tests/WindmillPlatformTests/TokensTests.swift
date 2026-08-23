import SwiftUI
import UIKit
import XCTest
@testable import WindmillPlatform

final class TokensTests: XCTestCase {
    func testTheInkOnGoldIsReadableInBothAppearances() {
        XCTAssertGreaterThanOrEqual(contrast(WindmillColor.onAccent, on: WindmillColor.gold400, in: .light), 4.5)
        XCTAssertGreaterThanOrEqual(contrast(WindmillColor.onAccent, on: WindmillColor.gold400, in: .dark), 4.5)
    }

    func testTheInkOnGoldIsFixedRatherThanAdaptive() {
        XCTAssertEqual(channels(WindmillColor.onAccent, .light), channels(WindmillColor.onAccent, .dark))
        XCTAssertEqual(channels(WindmillColor.gold400, .light), channels(WindmillColor.gold400, .dark))
    }

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
