import RoadmapLayout
import Testing

// The arithmetic's own values, arithmetic.json: each function at the edge of every branch, a double to either side of
// it, and across seeded samples.
struct ArithmeticTests {
  @Test func everyVectorIsTheWebsBitForBit() throws {
    let vectors = try Fixtures.read(ArithmeticFixture.self, "arithmetic")
    #expect(try vectors.sin.map { [$0[0], Number(try Arithmetic.sin($0[0].value))] } == vectors.sin)
    #expect(try vectors.cos.map { [$0[0], Number(try Arithmetic.cos($0[0].value))] } == vectors.cos)
    #expect(vectors.asin.map { [$0[0], Number(Arithmetic.asin($0[0].value))] } == vectors.asin)
    #expect(vectors.atan.map { [$0[0], Number(Arithmetic.atan($0[0].value))] } == vectors.atan)
    #expect(vectors.atan2.map { [$0[0], $0[1], Number(Arithmetic.atan2($0[0].value, $0[1].value))] } == vectors.atan2)
    #expect(vectors.hypot.map { [$0[0], $0[1], Number(Arithmetic.hypot($0[0].value, $0[1].value))] } == vectors.hypot)
    let counts = [vectors.sin.count, vectors.cos.count, vectors.asin.count, vectors.atan.count, vectors.atan2.count, vectors.hypot.count]
    #expect(counts == [445, 445, 254, 262, 304, 304])
  }

  // The vectors hold finite values only, and a file writes a negative zero as `0`.
  @Test func zerosInfinitiesAndWhatIsNotANumberComeBackAsFdlibmReturnsThem() throws {
    let pi = Arithmetic.pi
    let half = 1.5707963267948966
    let quarter = 0.7853981633974483
    let infinity = Double.infinity
    let nan = Double.nan

    let angles: [Double] = [0, -0.0, infinity, nan, 1e-9, half, pi, -pi]
    let sines: [Double] = [0, -0.0, nan, nan, 1e-9, 1, 1.2246467991473532e-16, -1.2246467991473532e-16]
    #expect(try angles.map { try Arithmetic.sin($0).bitPattern } == sines.map(\.bitPattern))
    let turns: [Double] = [0, -0.0, -infinity, nan, 1e-9, half, pi]
    let cosines: [Double] = [1, 1, nan, nan, 1, 6.123233995736766e-17, -1]
    #expect(try turns.map { try Arithmetic.cos($0).bitPattern } == cosines.map(\.bitPattern))

    let ratios: [Double] = [0, -0.0, 1, -1, 1.0000000000000002, nan, 0.5]
    let arcsines: [Double] = [0, -0.0, half, -half, nan, nan, 0.5235987755982989]
    #expect(ratios.map { Arithmetic.asin($0).bitPattern } == arcsines.map(\.bitPattern))
    let slopes: [Double] = [0, -0.0, 1, -1, infinity, -infinity, nan]
    let arctangents: [Double] = [0, -0.0, quarter, -quarter, half, -half, nan]
    #expect(slopes.map { Arithmetic.atan($0).bitPattern } == arctangents.map(\.bitPattern))

    let points: [[Double]] = [
      [0, 0], [-0.0, 0], [0, -0.0], [-0.0, -0.0], [0, 1], [0, -1], [-0.0, -1], [1, 0], [-1, -0.0],
      [1, 1], [1, -1], [-1, -1], [-1, 1], [3, 2], [nan, 1], [1, nan],
      [infinity, infinity], [-infinity, -infinity], [1, infinity], [-1, infinity], [1, -infinity], [infinity, 1], [1e300, 1e-300],
      [1e-300, -1e300],
    ]
    let bearings: [Double] = [
      0, -0.0, pi, -pi, 0, pi, -pi, half, -half,
      quarter, 2.356194490192345, -2.356194490192345, -quarter, 0.982793723247329, nan, nan,
      quarter, -2.356194490192345, 0, -0.0, pi, half, half, pi,
    ]
    #expect(points.map { Arithmetic.atan2($0[0], $0[1]).bitPattern } == bearings.map(\.bitPattern))

    let sides: [[Double]] = [[3, 4], [-3, 4], [0, 0], [-0.0, 0], [5, 0], [1e200, 1e200], [1e-200, 1e-200], [infinity, nan], [nan, 1]]
    let lengths: [Double] = [5, 5, 0, 0, 5, 1.414213562373095e200, 1.414213562373095e-200, infinity, nan]
    #expect(sides.map { Arithmetic.hypot($0[0], $0[1]).bitPattern } == lengths.map(\.bitPattern))
  }

  @Test func anAngleOf1647100OrMoreIsRefusedByThrowing() throws {
    #expect(try Arithmetic.sin(1647099.9999999998).bitPattern == (0.6216400377390442).bitPattern)
    #expect(try Arithmetic.cos(-1647099.9999999998).bitPattern == (0.7833030470257343).bitPattern)
    #expect(throws: Arithmetic.AngleOutsideTheArithmetic.self) { try Arithmetic.sin(Arithmetic.reducibleBelow) }
    #expect(throws: Arithmetic.AngleOutsideTheArithmetic.self) { try Arithmetic.cos(-1e300) }
  }
}
