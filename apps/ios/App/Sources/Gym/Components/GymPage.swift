import SwiftUI

struct GymPage: ViewModifier {
  var titleDisplayMode: NavigationBarItem.TitleDisplayMode = .inline

  func body(content: Content) -> some View {
    content
      .scrollContentBackground(.hidden)
      .background(GymPalette.canvas)
      .tint(GymPalette.accent)
      .navigationBarTitleDisplayMode(titleDisplayMode)
  }
}
