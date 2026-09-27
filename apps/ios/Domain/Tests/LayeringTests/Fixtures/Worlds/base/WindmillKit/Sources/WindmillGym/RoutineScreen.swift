import GymDomain
import SwiftUI
import WindmillPlatform

struct RoutineScreen: View {
  let routine: Routine

  var body: some View { Text(routine.name) }
}
