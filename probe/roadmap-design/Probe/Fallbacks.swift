import SwiftUI

// Each iOS 26 part the probes draw, and the stand-in apps/ios/App draws for it before iOS 26, so one build shows both
// systems: glass buttons are bordered, glass is the regular material, a safe-area bar is an inset on the bar material,
// a minimized search keeps the classic field, and the subtitle stacks under the title in the bar's principal slot.
extension View {
    @ViewBuilder func glassButton() -> some View {
        if #available(iOS 26.0, *) { buttonStyle(.glass) } else { buttonStyle(.bordered) }
    }

    @ViewBuilder func glassProminentButton() -> some View {
        if #available(iOS 26.0, *) { buttonStyle(.glassProminent) } else { buttonStyle(.borderedProminent) }
    }

    @ViewBuilder func glassCapsule() -> some View {
        if #available(iOS 26.0, *) { glassEffect(.regular, in: .capsule) } else { background(.regularMaterial, in: .capsule) }
    }

    @ViewBuilder func bar<Bar: View>(edge: VerticalEdge, @ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26.0, *) { safeAreaBar(edge: edge, content: bar) } else { safeAreaInset(edge: edge) { bar().background(.bar) } }
    }

    @ViewBuilder func minimizedSearch() -> some View {
        if #available(iOS 26.0, *) { searchToolbarBehavior(.minimize) } else { self }
    }

    @ViewBuilder func subtitle(_ subtitle: String, under title: String) -> some View {
        if #available(iOS 26.0, *) {
            navigationSubtitle(subtitle)
        } else {
            toolbar {
                ToolbarItem(placement: .principal) { PrincipalTitle(title: title, subtitle: subtitle) }
            }
        }
    }
}

struct PrincipalTitle: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 0) {
            Text(title).font(.headline)
            Text(subtitle).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

// The sheet's close and the form's two commitments: the system's role circles on iOS 26, words before it.
struct CloseButton: View {
    var body: some View {
        if #available(iOS 26.0, *) { Button(role: .close) {} } else { Button("Close") {} }
    }
}

struct CancelButton: View {
    var body: some View {
        if #available(iOS 26.0, *) { Button(role: .cancel) {} } else { Button("Cancel", role: .cancel) {} }
    }
}

struct ConfirmButton: View {
    var body: some View {
        if #available(iOS 26.0, *) { Button(role: .confirm) {} } else { Button("Create") {} }
    }
}
