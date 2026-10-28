# iOS Domain crash diagnostics

The complete Domain Swift test command remains the authoritative CI gate, with its existing
parallel scheduling and no test filter. A failed gate triggers one 300-second LLDB reproduction
of the already-built Domain bundle through the selected toolchain's Swift Testing helper. A
330-second outer watchdog and seven-minute workflow limit bound setup and debugger execution.
A successful reproduction run does not turn the original failure green.

On macOS, SwiftPM uses `swiftpm-testing-helper --test-bundle-path … --testing-library swift-testing`.
The helper receives the selected macOS platform's framework/library paths, matching SwiftPM's
runtime environment setup. The diagnostic collector accepts a helper-named IPS only when its
loaded images include the exact Domain test bundle. References:
[Swift Testing debugging](https://github.com/swiftlang/swift-testing/blob/main/Documentation/CommandlineDebugging.md)
and [SwiftPM 6.2.3 test environment](https://github.com/swiftlang/swift-package-manager/blob/swift-6.2.3-RELEASE/Sources/Commands/Utilities/TestingSupport.swift).
The environment reference is SwiftPM 6.2.3; the Xcode 26.3 CI diagnostic records Swift 6.2.4.

The wait loop continues bootstrap, exec and reason-free stops until an exit, meaningful stop or
the original deadline. A signal or exception is captured even before the Domain bundle loads.
Stop classification reads at most 128 threads; an excess is captured rather than resumed on
incomplete evidence. A transient launch stop with only helper/dyld images and no frames is not a
crash diagnosis.

The debugger exports only bounded technical stack fields: numeric stop reasons/data, program
counters, function symbols, source basenames/lines and image basenames/UUIDs. It reads no locals,
arguments, environment dump, heap or core. Inferior stdout/stderr go to the null device. Limits are
128 threads, 64 frames per thread, 512 images and 8 MiB per report; artifacts expire after three
days. Missing bundles/helpers, no report, setup failure, process exit and timeout are explicit
outcomes. The debugger terminates its owned process, numeric PID/PPID descendants and process group after
capture. Descendant discovery is bounded to 8192 process rows, 512 children and 32 generations;
an unavailable or excessive snapshot records incomplete cleanup instead of guessing identities.

Eleven deterministic checks cover report filtering/privacy, bounded stacks, missing bundle behavior,
bootstrap-to-exit/signal/exception transitions, the fixed deadline and failure-only wiring. All 54
App Tools checks pass; the workflow wiring is unchanged.
Local Xcode 27.1 / Swift 6.4 probes verify a complete passing Swift Testing
entry point, synthetic SIGBUS stop data with stack capture, and bounded timeout. Printed synthetic
content is absent from debugger artifacts. This validates the diagnostic mechanism; it does not
reproduce or explain the Xcode 26.3 CI Domain crash. The CI cause remains unresolved until a real
failing stack is collected.
