import JournalDomain
import SwiftUI
import WindmillPlatform

struct PageScreen: View {
  let page: Page

  var body: some View { Text(page.day) }
}
