import Testing
import GymDomain
@testable import Windmill

struct RoutineTargetsTests {
  let straight = Array(repeating: SetTarget(reps: 8, weightKg: 60), count: 3)

  @Test func opensExistingSchemesWithoutChangingTheirValues() {
    let draft = RoutineTargetDraft(sets: straight)
    #expect(draft.reading == .scheme(straight))
    #expect(draft.countText == "3" && !draft.varyBySet)
    #expect(draft.shared(.reps) == "8" && draft.shared(.weight) == "60")
    #expect(draft.commitLabel == "Set · 3 × 8 · 60")
    let open = RoutineTargetDraft(sets: nil)
    #expect(open.reading == .open && open.visibleRows.isEmpty)
    #expect(open.commitLabel == "Set · open")
  }

  @Test func openAndCountReductionRetainHiddenDraftRows() {
    let original = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100)]
    var draft = RoutineTargetDraft(sets: original)
    draft.type("2", field: .sets)
    #expect(draft.reading == .scheme(Array(original.prefix(2))))
    #expect(draft.rows == original.map(RoutineTargetDraft.Row.init))
    draft.type("", field: .sets)
    #expect(draft.reading == .open && draft.visibleRows.isEmpty)
    #expect(draft.rows == original.map(RoutineTargetDraft.Row.init))
    draft.type("3", field: .sets)
    #expect(draft.reading == .scheme(original) && draft.varyBySet)
    #expect(draft.commitLabel == "Set · 3 sets")
  }

  @Test func sharedTypingReplacesColumnsAndBlankFieldsMeanMaxAndLastTime() {
    var draft = RoutineTargetDraft(sets: [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90)])
    #expect(draft.varies(.reps) && draft.varies(.weight))
    #expect(draft.shared(.reps).isEmpty && draft.shared(.weight).isEmpty)
    draft.type("12", field: .reps)
    draft.type("", field: .weight)
    #expect(draft.reading == .scheme(Array(repeating: SetTarget(reps: 12), count: 2)))
    draft.type("", field: .reps)
    #expect(draft.reading == .scheme(Array(repeating: SetTarget(), count: 2)))
    #expect(!draft.varies(.reps) && !draft.varies(.weight))
  }

  @Test func nativeStepsRespectSetRepAndLoadLimitsAndClearToOpen() {
    var draft = RoutineTargetDraft(sets: [SetTarget(reps: 1, weightKg: 20)])
    draft.step(.reps, direction: -1)
    #expect(draft.reading == .scheme([SetTarget(weightKg: 20)]))
    draft.step(.reps, direction: 1)
    draft.step(.weight, direction: -1)
    #expect(draft.reading == .scheme([SetTarget(reps: 1, weightKg: 19)]))
    draft.step(.sets, direction: -1)
    #expect(draft.reading == .open && draft.rows == [.init(reps: "1", weight: "19")])
    draft.step(.sets, direction: 1)
    #expect(draft.reading == .scheme([SetTarget(reps: 1, weightKg: 19)]))
    draft.type("20", field: .sets)
    draft.type("100", field: .reps)
    draft.type("500", field: .weight)
    draft.step(.sets, direction: 1); draft.step(.reps, direction: 1); draft.step(.weight, direction: 1)
    #expect(draft.reading == .scheme(Array(repeating: SetTarget(reps: 100, weightKg: 500), count: 20)))
    draft.type("−500", field: .weight); draft.step(.weight, direction: -1)
    #expect(draft.shared(.weight) == "−500")
  }

  @Test func steppingCannotReplaceIncompleteOrFractionalWholeFields() {
    var draft = RoutineTargetDraft(sets: straight)
    draft.type("1.5", field: .sets)
    let fractional = draft
    draft.step(.sets, direction: 1)
    #expect(draft == fractional)
    draft.type("3", field: .sets)
    draft.type("−", field: .weight)
    let incomplete = draft
    draft.step(.weight, direction: 1)
    #expect(draft == incomplete)
  }

  @Test func addingRestoresHiddenRowsBeforeCopyingLastAndDeletingFinalOpens() {
    let original = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100)]
    var draft = RoutineTargetDraft(sets: original)
    draft.type("1", field: .sets)
    draft.addSet()
    #expect(draft.reading == .scheme(Array(original.prefix(2))))
    draft.addSet(); draft.addSet()
    #expect(draft.reading == .scheme(original + [original[2]]))
    draft.deleteSet(1)
    #expect(draft.reading == .scheme([original[0], original[2], original[2]]))
    draft.deleteSet(2); draft.deleteSet(1); draft.deleteSet(0)
    #expect(draft.reading == .open && draft.rows.isEmpty)
    draft.addSet()
    #expect(draft.reading == .scheme([SetTarget()]))
  }

  @Test func addingAtTwentyRefusesAndNextEditClearsTheCeilingMessage() {
    var draft = RoutineTargetDraft(sets: Array(repeating: SetTarget(reps: 8), count: 20))
    draft.addSet()
    #expect(draft.atSetCeiling && draft.rows.count == 20 && draft.countText == "20")
    draft.type("9", field: .reps, row: 0)
    #expect(!draft.atSetCeiling && draft.rows.count == 20)
  }

  @Test func signFlipRetainsBlankLastTimeAndFlipsSharedAndIndividualLoad() {
    var draft = RoutineTargetDraft(sets: straight)
    draft.flipSign()
    #expect(draft.reading == .scheme(Array(repeating: SetTarget(reps: 8, weightKg: -60), count: 3)))
    draft.flipSign(row: 1)
    #expect(draft.reading == .scheme([SetTarget(reps: 8, weightKg: -60), SetTarget(reps: 8, weightKg: 60), SetTarget(reps: 8, weightKg: -60)]))
    draft.type("", field: .weight); draft.flipSign()
    #expect(draft.reading == .scheme(Array(repeating: SetTarget(reps: 8), count: 3)))
  }

  @Test(arguments: [
    ("1.2.3", RoutineTargetDraft.onePoint), ("1,2.3", RoutineTargetDraft.onePoint),
    ("−", RoutineTargetDraft.notANumber), ("no", RoutineTargetDraft.notANumber),
    ("NaN", RoutineTargetDraft.notANumber), ("Infinity", RoutineTargetDraft.notANumber),
    ("500.01", RoutineTargetDraft.overWeight), ("−500.01", RoutineTargetDraft.overWeight),
    ("0", RoutineTargetDraft.zeroTarget), ("0.004", RoutineTargetDraft.zeroTarget),
  ])
  func loadRefusalsPreserveTypedInput(typed: String, message: String) {
    var draft = RoutineTargetDraft(sets: straight)
    draft.type(typed, field: .weight)
    #expect(draft.reading == .refused(.init(row: 0, field: .weight, message: message)))
    #expect(draft.headRefusal == draft.refusal && draft.shared(.weight) == typed)
    #expect(draft.commitLabel == "Set")
  }

  @Test(arguments: ["1.5", "−1", "101", "1e100"])
  func repsRefuseOutsideWholeBand(typed: String) {
    var draft = RoutineTargetDraft(sets: straight)
    draft.type(typed, field: .reps)
    #expect(draft.reading == .refused(.init(row: 0, field: .reps, message: RoutineTargetDraft.outsideReps)))
  }

  @Test(arguments: ["1.5", "−1", "21", "1e100"])
  func countsRefuseOutsideWholeBand(typed: String) {
    var draft = RoutineTargetDraft(sets: straight)
    draft.type(typed, field: .sets)
    #expect(draft.reading == .refused(.init(row: nil, field: .sets, message: RoutineTargetDraft.outsideSets)))
    #expect(draft.rows == straight.map(RoutineTargetDraft.Row.init))
  }

  @Test(arguments: [RoutineTargetDraft.Field.sets, .reps, .weight])
  func numericFaultsUseTheSameCopyInEveryField(field: RoutineTargetDraft.Field) {
    var draft = RoutineTargetDraft(sets: straight)
    for (typed, message) in [("0", RoutineTargetDraft.zeroTarget), ("−", RoutineTargetDraft.notANumber), ("1,2.3", RoutineTargetDraft.onePoint)] {
      draft.type(typed, field: field)
      #expect(draft.refusal == .init(row: field == .sets ? nil : 0, field: field, message: message))
      #expect(draft.shared(field) == typed && draft.commitLabel == "Set")
    }
  }

  @Test func refusalOrderIsCountThenRowsWithRepsBeforeWeight() {
    var draft = RoutineTargetDraft(sets: straight)
    draft.type("bad", field: .reps, row: 1)
    draft.type("0", field: .weight, row: 0)
    draft.type("1,2.3", field: .sets)
    #expect(draft.refusal == .init(row: nil, field: .sets, message: RoutineTargetDraft.onePoint))
    draft.type("3", field: .sets)
    #expect(draft.refusal == .init(row: 0, field: .weight, message: RoutineTargetDraft.zeroTarget))
    #expect(draft.headRefusal == nil)
    draft.type("0", field: .reps, row: 0)
    #expect(draft.refusal == .init(row: 0, field: .reps, message: RoutineTargetDraft.zeroTarget))
    draft.type("8", field: .reps, row: 0); draft.type("60", field: .weight, row: 0)
    #expect(draft.refusal == .init(row: 1, field: .reps, message: RoutineTargetDraft.notANumber))
    draft.type("", field: .sets)
    #expect(draft.reading == .open && draft.refusal == nil)
  }

  @Test func commaPointAndUnicodeMinusReadAsSignedKilograms() {
    var draft = RoutineTargetDraft(sets: [SetTarget()])
    draft.type("100", field: .reps); draft.type("−12,345", field: .weight)
    #expect(draft.reading == .scheme([SetTarget(reps: 100, weightKg: -12.35)]))
    draft.type("500", field: .weight)
    #expect(draft.reading == .scheme([SetTarget(reps: 100, weightKg: 500)]))
  }

  @Test func matchFirstOnlyFillsVisibleRowsAndPreservesHiddenTail() {
    let original = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100)]
    var draft = RoutineTargetDraft(sets: original)
    draft.type("2", field: .sets); draft.matchFirst()
    #expect(draft.reading == .scheme([original[0], original[0]]))
    draft.type("3", field: .sets)
    #expect(draft.reading == .scheme([original[0], original[0], original[2]]))
  }

  @Test func rampInterpolatesRepsAndSnapsIntermediateLoadsToPlateGrid() {
    var draft = RoutineTargetDraft(sets: [SetTarget(reps: 10, weightKg: 17), SetTarget(), SetTarget(), SetTarget(), SetTarget(reps: 4, weightKg: 53)])
    #expect(draft.canRamp)
    draft.rampUp()
    #expect(draft.reading == .scheme([
      SetTarget(reps: 10, weightKg: 17), SetTarget(reps: 9, weightKg: 25), SetTarget(reps: 7, weightKg: 35),
      SetTarget(reps: 6, weightKg: 45), SetTarget(reps: 4, weightKg: 53),
    ]))
    #expect(draft.varyBySet && draft.commitLabel == "Set · 5 sets")
    var assisted = RoutineTargetDraft(sets: [SetTarget(weightKg: -10), SetTarget(), SetTarget(weightKg: -13)])
    assisted.rampUp()
    #expect(assisted.reading == .scheme([SetTarget(weightKg: -10), SetTarget(weightKg: -12), SetTarget(weightKg: -13)]))
    var heavy = RoutineTargetDraft(sets: [SetTarget(weightKg: 50), SetTarget(), SetTarget(weightKg: 52.5)])
    heavy.rampUp()
    #expect(heavy.reading == .scheme([SetTarget(weightKg: 50), SetTarget(weightKg: 52.5), SetTarget(weightKg: 52.5)]))
  }

  @Test func rampRequiresThreeDifferingValidEndpointsAndLeavesUnnamedColumnStanding() {
    var straightDraft = RoutineTargetDraft(sets: straight)
    #expect(!straightDraft.canRamp)
    straightDraft.rampUp()
    #expect(straightDraft.reading == .scheme(straight))
    let two = RoutineTargetDraft(sets: [SetTarget(reps: 5), SetTarget(reps: 10)])
    #expect(!two.canRamp)
    var draft = RoutineTargetDraft(sets: [SetTarget(reps: 5), SetTarget(reps: 8, weightKg: 40), SetTarget(reps: 10, weightKg: 60)])
    draft.rampUp()
    #expect(draft.reading == .scheme([SetTarget(reps: 5), SetTarget(reps: 8, weightKg: 40), SetTarget(reps: 10, weightKg: 60)]))
    draft.type("−", field: .weight, row: 2)
    #expect(!draft.canRamp)
    let invalid = draft
    draft.rampUp()
    #expect(draft == invalid)
  }

  @Test func invalidCountDisablesOtherFieldsUntilAValidCountRestoresTheDraft() {
    var draft = RoutineTargetDraft(sets: nil)
    #expect(!draft.canEditTargets)
    for typed in ["0", "21", "1.5", "−", "1..2"] {
      draft.type(typed, field: .sets)
      #expect(!draft.canEditTargets && draft.rows.isEmpty && draft.refusal?.field == .sets)
    }
    draft.type("3", field: .sets)
    #expect(draft.canEditTargets && draft.reading == .scheme(Array(repeating: SetTarget(), count: 3)))
    draft.type("8", field: .reps); draft.type("60", field: .weight)
    draft.type("21", field: .sets)
    #expect(!draft.canEditTargets && draft.rows == straight.map(RoutineTargetDraft.Row.init))
    draft.type("3", field: .sets)
    #expect(draft.canEditTargets && draft.reading == .scheme(straight))
  }

  @Test func restoredIndividualRefusalCanReopenItsFieldsWithoutLosingInput() {
    let original = [SetTarget(reps: 5, weightKg: 60), SetTarget(reps: 3, weightKg: 90), SetTarget(reps: 1, weightKg: 100)]
    var draft = RoutineTargetDraft(sets: original)
    draft.type("bad", field: .reps, row: 2)
    #expect(!draft.canChangeVariation && draft.varyBySet)
    draft.type("2", field: .sets)
    #expect(draft.canChangeVariation && draft.refusal == nil)
    draft.varyBySet = false
    draft.type("3", field: .sets)
    #expect(!draft.varyBySet && draft.canChangeVariation && draft.canEditTargets)
    #expect(draft.refusal == .init(row: 2, field: .reps, message: RoutineTargetDraft.notANumber))
    #expect(draft.rows[2].reps == "bad")
    draft.varyBySet = true
    #expect(!draft.canChangeVariation)
    draft.type("1", field: .reps, row: 2)
    #expect(draft.canChangeVariation && draft.reading == .scheme(original))
  }

  @Test func rampCannotDiscardAnInvalidIntermediateFieldOrInvalidCount() {
    let original = [SetTarget(reps: 5), SetTarget(reps: 8, weightKg: 40), SetTarget(reps: 10, weightKg: 60)]
    var draft = RoutineTargetDraft(sets: original)
    draft.type("bad", field: .weight, row: 1)
    #expect(!draft.canRamp)
    let invalidMiddle = draft
    draft.rampUp()
    #expect(draft == invalidMiddle && draft.rows[1] == .init(reps: "8", weight: "bad"))
    draft.type("40", field: .weight, row: 1)
    draft.type("21", field: .sets)
    #expect(!draft.canRamp)
    let invalidCount = draft
    draft.rampUp()
    #expect(draft == invalidCount)
    draft.type("3", field: .sets)
    #expect(draft.canRamp)
    draft.rampUp()
    #expect(draft.reading == .scheme(original))
  }
}
