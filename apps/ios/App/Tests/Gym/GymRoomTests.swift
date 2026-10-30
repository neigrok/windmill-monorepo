import Testing
import DomainKit
import GymDomain
@testable import Windmill

@Suite @MainActor struct GymRoomTests {
  // The hidden workout's accessory goes where the tab bar goes (Figma Gym · iOS 03.5), by the one rule both iOS 26 branches
  // draw from: never on a tab whose front screen hides the bar, never without a hidden workout.
  @Test func theAccessoryStandsOnlyWhereTheTabBarDoes() {
    let tabs: [GymRoom.Tab] = [.routines, .log, .coach]
    #expect(tabs.map { GymRoom.accessoryStands(workoutHidden: true, tab: $0, hiddenTabBars: [.log]) } == [true, false, true])
    #expect(tabs.map { GymRoom.accessoryStands(workoutHidden: true, tab: $0, hiddenTabBars: []) } == [true, true, true])
    #expect(tabs.map { GymRoom.accessoryStands(workoutHidden: false, tab: $0, hiddenTabBars: []) } == [false, false, false])
  }

  // A receipt hands the finished workout on: Done to its detail, Keep it to its detail under Keep your log, and the
  // written program to Coach's composer unsent, or to You while there is no account to ask with.
  @Test func aReceiptHandsTheWorkoutOn() {
    var routing = GymRoomRouting()
    let session = ID<Session>("finished")
    #expect(routing.receive(.detail(session), needsSignIn: false, signedOut: false) == [.log(session: session)])
    #expect(routing.receive(.detail(nil), needsSignIn: true, signedOut: true) == [.log(session: nil)])
    #expect(routing.receive(.keep(session), needsSignIn: true, signedOut: true) == [.log(session: session), .keep])
    #expect(routing.receive(.writtenProgram, needsSignIn: true, signedOut: true) == [.openYou])
    #expect(routing.receive(.writtenProgram, needsSignIn: false, signedOut: false)
            == [.ask("Help me turn my written program into a routine.", send: false)])
    #expect(routing == GymRoomRouting())
  }

  // A door Coach opened over the workout opens once the workout is hidden: Keep with the routines it made, You, the routine
  // it made, or a new routine in Routines, signed in or out.
  @Test func aDoorCoachOpenedOverTheWorkoutOpensBehindIt() {
    var routing = GymRoomRouting()
    let routine = ID<Routine>("coach-made")
    for signedOut in [true, false] {
      #expect([WorkoutHandoff.keepRoutines, .you, .routine(routine), .buildRoutine].map { routing.receive($0, needsSignIn: signedOut, signedOut: signedOut) }
              == [[.keepRoutines], [.openYou], [.routine(routine)], [.buildRoutine]])
    }
    #expect(routing == GymRoomRouting())
  }

  // Share with Coach asks at once with an account; without one it opens Keep your log and asks once, when that sheet closes
  // signed in, and never after a sheet that closed signed out, even when a later sign-in succeeds.
  @Test func shareWithCoachWaitsForTheSignInItOpened() {
    var signedIn = GymRoomRouting()
    #expect(signedIn.receive(.coach, needsSignIn: false, signedOut: false) == [.ask("Check my last workout.", send: true)])

    var adopted = GymRoomRouting()
    #expect(adopted.receive(.coach, needsSignIn: true, signedOut: true) == [.keep])
    #expect(adopted.accountClosed(needsSignIn: false) == [.ask("Check my last workout.", send: true)])
    #expect(adopted.accountClosed(needsSignIn: false) == [])

    var cancelled = GymRoomRouting()
    #expect(cancelled.receive(.coach, needsSignIn: true, signedOut: true) == [.keep])
    #expect(cancelled.accountClosed(needsSignIn: true) == [])
    #expect(cancelled.accountClosed(needsSignIn: false) == [])
  }

  // Sign in to share closes the share into You; You closing signed in brings the same share back, once.
  @Test func signInToShareReturnsToTheShare() {
    var routing = GymRoomRouting()
    let session = ID<Session>("shared")
    #expect(routing.shareClosed() == [])
    routing.signInToShare(session)
    #expect(routing.shareClosed() == [.openYou])
    #expect(routing.accountClosed(needsSignIn: false) == [.share(session)])
    #expect(routing.accountClosed(needsSignIn: false) == [])

    routing.signInToShare(session)
    #expect(routing.accountClosed(needsSignIn: true) == [])
    #expect(routing.shareClosed() == [])
  }

  // A proposal's Routines row opens the conversation at its card when the conversation holds it, and its card on a sheet
  // when it does not.
  @Test func aProposalsRowOpensItsCardWhereItStands() {
    #expect(GymRoomRouting.review("proposal", inConversation: true) == .revealProposal("proposal"))
    #expect(GymRoomRouting.review("proposal", inConversation: false) == .proposalSheet("proposal"))
  }
}
