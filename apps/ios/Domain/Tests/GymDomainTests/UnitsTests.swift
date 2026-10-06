import DomainKit
import DomainKitTesting
import GymDomain
import SyncCore
import Testing

struct UnitsTests {
  @Test(arguments: try Contract.vectors("gym/domain/units.json"))
  func vector(_ vector: Vector) throws {
    let input = vector.input
    let value = try input.member("value").asDouble()
    let result: JSON
    switch try input.member("operation").asString() {
    case "ladder":
      result = ["labels": .array(WeightLadder.labels(value).map { .string($0) }),
                "down": .of(WeightLadder.bump(value, direction: -1)), "downBig": .of(WeightLadder.bump(value, direction: -1, big: true)),
                "up": .of(WeightLadder.bump(value, direction: 1)), "upBig": .of(WeightLadder.bump(value, direction: 1, big: true))]
    case "round": result = ["rounded": .of(WeightLadder.round(value))]
    case "grid": result = ["rounded": .of(WeightLadder.onGrid(value))]
    case "reps": result = ["down": JSON(WeightLadder.bumpReps(Int(value), direction: -1)), "up": JSON(WeightLadder.bumpReps(Int(value), direction: 1))]
    case "display": result = ["value": .of(GymUnits(reading: try input["units"]?.asString()).display(value))]
    case "input": result = ["value": .of(GymUnits(reading: try input["units"]?.asString()).kilograms(from: value))]
    case "estimate": result = ["text": .string(Readout.estimate(value, units: GymUnits(reading: try input["units"]?.asString())))]
    case "weight": result = ["text": .string(Readout.weight(value, units: GymUnits(reading: try input["units"]?.asString())))]
    default: throw ContractError("unknown units vector \(vector)")
    }
    #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)\n  expect \(vector.expect.jcsText)")
  }

  @Test func ladderDirectlyRunsTheSharedCrossSurfaceContract() throws {
    let file = try Contract.json("gym-ladder.json")
    for item in try file.member("weightCases").asArray() {
      let value = try item.member("weight").asDouble()
      #expect(WeightLadder.labels(value) == (try item.member("labels").asArray().map { try $0.asString() }))
      #expect(WeightLadder.bump(value, direction: -1) == (try item.member("down").asDouble()))
      #expect(WeightLadder.bump(value, direction: -1, big: true) == (try item.member("downBig").asDouble()))
      #expect(WeightLadder.bump(value, direction: 1) == (try item.member("up").asDouble()))
      #expect(WeightLadder.bump(value, direction: 1, big: true) == (try item.member("upBig").asDouble()))
    }
    for item in try file.member("roundCases").asArray() { #expect(WeightLadder.round(try item.member("value").asDouble()) == (try item.member("rounded").asDouble())) }
    for item in try file.member("repCases").asArray() {
      let reps = Int(try item.member("reps").asInteger())
      #expect(WeightLadder.bumpReps(reps, direction: -1) == (try item.member("down").asInteger()))
      #expect(WeightLadder.bumpReps(reps, direction: 1) == (try item.member("up").asInteger()))
    }
  }
}
