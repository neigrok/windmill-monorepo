import SwiftUI

struct GymPage: ViewModifier {
  var titleDisplayMode: NavigationBarItem.TitleDisplayMode = .inline

  func body(content: Content) -> some View {
    content
      .scrollContentBackground(.hidden)
      .background(GymPalette.canvas)
      .foregroundStyle(GymPalette.ink)
      .tint(GymPalette.accent)
      .navigationBarTitleDisplayMode(titleDisplayMode)
  }
}
