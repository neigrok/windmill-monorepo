// module: GymDomain
// expect: 10: token ContinuousClock
// expect: 11: token SuspendingClock
// expect: 12: token continuous
// expect: 13: token CommandLine
// expect: 14: token readLine
// expect: 15: token debugPrint
// expect: 15: token dump
// expect: 15: token print
let now = ContinuousClock.now
let s = SuspendingClock()
func clocks() -> some Clock<Duration> { .continuous }
let args = CommandLine.arguments
let line = readLine()
func log(_ x: Int) { print(x); debugPrint(x); dump(x) }
