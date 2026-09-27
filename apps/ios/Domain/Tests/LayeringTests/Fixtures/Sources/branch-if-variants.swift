// module: GymDomain
// expect: 4: branch #if
// expect: 6: branch #elseif
#if !os(macOS)
let restSeconds = 120
#elseif targetEnvironment(simulator) || !canImport(AppKit)
let restSeconds = 90
#endif
