// module: GymDomain
// expect: 7: token random
// expect: 8: token randomElement
// expect: 9: token shuffle
// expect: 10: token shuffled
// expect: 11: token SystemRandomNumberGenerator
let a = Int.random(in: 0...1)
let b = [1, 2].randomElement()
var c = [1, 2]; c.shuffle()
let d = [1, 2].shuffled()
var g = SystemRandomNumberGenerator()
