import SwiftUI
import UIKit
import WindmillPlatform

// The room names its navigation bar's side margin instead of inheriting one, because the one it
// inherits is wrong on the first root a lifter sees.
//
// Measured on iOS 26.3 (iPhone 17): the tab the room opens on gets a navigation controller whose view
// carries `systemMinimumLayoutMargins.leading == 0`, so its bar — which preserves its superview's —
// draws the large title hard against the bezel at 0, while every root shown after a tab change gets
// the platform's 16. It never settles: not on a scroll, not after ten seconds, only on a tab change.
// Both paths into the room reproduce it (restored straight in, and entered from the hub).
//
// So the margin is stated, and stated as the one the room's own cards and reach band already use,
// which is what a large title is supposed to line up with.
struct NavigationBarMargin: UIViewRepresentable {
    let inset: CGFloat

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        let wanted = inset
        // A view is not in the responder chain until the hierarchy has it, which is a turn away.
        DispatchQueue.main.async {
            var walker: UIResponder? = view
            while let next = walker?.next {
                guard let bar = (next as? UINavigationController)?.navigationBar else {
                    walker = next
                    continue
                }
                guard bar.directionalLayoutMargins.leading != wanted else { return }
                bar.preservesSuperviewLayoutMargins = false
                bar.directionalLayoutMargins = NSDirectionalEdgeInsets(
                    top: bar.directionalLayoutMargins.top, leading: wanted,
                    bottom: bar.directionalLayoutMargins.bottom, trailing: wanted)
                return
            }
        }
    }
}

extension View {
    func navigationBarMargin(_ inset: CGFloat = WindmillSpace.x5) -> some View {
        background(NavigationBarMargin(inset: inset).frame(width: 0, height: 0))
    }
}
